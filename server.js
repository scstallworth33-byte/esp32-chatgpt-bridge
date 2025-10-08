import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import tmp from 'tmp';
import fs from 'fs/promises';
import { createReadStream } from 'fs';

// === GOOGLE CLOUD CLIENT LIBRARIES ===
import speech from '@google-cloud/speech';
import textToSpeech from '@google-cloud/text-to-speech';

// INSTANTIATE GOOGLE CLOUD CLIENTS
const speechClient = new speech.SpeechClient();
const ttsClient = new textToSpeech.TextToSpeechClient();

const app = express();
const server = app.listen(8080, () => console.log('HTTP server running on port 8080'));
const wss = new WebSocketServer({ server });

app.get('/', (req, res) => res.send('ESP32 ChatGPT Bridge Server Running!'));

// === WAV HEADER UTILITY ===
function addWavHeader(buffer, options = {}) {
  const {
    numChannels = 1,
    sampleRate = 24000,
    bitDepth = 16,
  } = options;

  const header = Buffer.alloc(44);

  header.write('RIFF', 0); // ChunkID
  header.writeUInt32LE(36 + buffer.length, 4); // ChunkSize
  header.write('WAVE', 8); // Format
  header.write('fmt ', 12); // Subchunk1ID
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22); // NumChannels
  header.writeUInt32LE(sampleRate, 24); // SampleRate
  header.writeUInt32LE(sampleRate * numChannels * bitDepth / 8, 28); // ByteRate
  header.writeUInt16LE(numChannels * bitDepth / 8, 32); // BlockAlign
  header.writeUInt16LE(bitDepth, 34); // BitsPerSample
  header.write('data', 36); // Subchunk2ID
  header.writeUInt32LE(buffer.length, 40); // Subchunk2Size

  return Buffer.concat([header, buffer]);
}

// UTILITY: GOOGLE SPEECH-TO-TEXT (STT)
async function recognizeSpeechGoogle(wavFilePath) {
  const audio = {
    content: (await fs.readFile(wavFilePath)).toString('base64'),
  };
  // Adjust encoding/sampleRateHertz if your ESP32 uses a different format!
  const config = {
    encoding: 'LINEAR16',
    sampleRateHertz: 24000, // Match your ESP32 sample rate
    languageCode: 'en-US',
  };
  const request = { audio, config };
  const [response] = await speechClient.recognize(request);
  if (!response.results.length) return '';
  return response.results.map(r => r.alternatives[0].transcript).join('\n');
}

// UTILITY: GOOGLE TEXT-TO-SPEECH (TTS)
async function synthesizeSpeechGoogle(text) {
  const request = {
    input: { text },
    voice: { languageCode: 'en-US', ssmlGender: 'FEMALE' }, // Change voice if needed
    audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 }, // WAV/PCM for ESP32
  };
  const [response] = await ttsClient.synthesizeSpeech(request);
  const rawPcmBuffer = Buffer.from(response.audioContent, 'base64');
  const wavBuffer = addWavHeader(rawPcmBuffer, { sampleRate: 24000, numChannels: 1, bitDepth: 16 });
  return wavBuffer;
}

// === MAIN WEBSOCKET HANDLER ===
wss.on('connection', ws => {
  console.log('WebSocket client connected');
  let audioChunks = [];

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      audioChunks.push(data);
    } else {
      // Expect "done" as a signal to start processing
      if (data.toString() === "done") {
        console.log('Received "done" from client, assembling WAV file...');
        if (audioChunks.length === 0) {
          ws.send('No audio received!');
          return;
        }

        // Save the received WAV file to a temp location
        const wavFile = tmp.tmpNameSync({ postfix: '.wav' });
        await fs.writeFile(wavFile, Buffer.concat(audioChunks));

        try {
          // === 1. TRANSCRIBE AUDIO WITH GOOGLE CLOUD ===
          const transcription = await recognizeSpeechGoogle(wavFile);
          console.log('Transcription:', transcription);

          // === 2. CHATGPT RESPONSE (still uses OpenAI GPT) ===
          // If you want to use Google Gemini, replace this block!
          const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'gpt-3.5-turbo',
              messages: [{ role: 'user', content: transcription }]
            })
          });
          if (!openaiResponse.ok) {
            const errorText = await openaiResponse.text();
            throw new Error('ChatGPT failed: ' + errorText);
          }
          const chatRes = await openaiResponse.json();
          const replyText = chatRes.choices[0].message.content;
          console.log('ChatGPT reply:', replyText);

          // === 3. SYNTHESIZE REPLY WITH GOOGLE TTS and ADD WAV HEADER ===
          const wavBuffer = await synthesizeSpeechGoogle(replyText);

          // ======= PACED CHUNKED DELIVERY =======
          const CHUNK_SIZE = 2048; // Should match ESP32
          const chunkIntervalMs = 43; // ms

          let offset = 0;
          const intervalId = setInterval(() => {
            if (offset < wavBuffer.length) {
              const end = Math.min(offset + CHUNK_SIZE, wavBuffer.length);
              ws.send(wavBuffer.slice(offset, end), { binary: true });
              offset = end;
            } else {
              clearInterval(intervalId);
              ws.send('done'); // Optional: signal end of audio
              console.log('Audio reply sent in paced chunks.');
            }
          }, chunkIntervalMs);

          // Clean up temp file -- can be done after audio finishes
          setTimeout(async () => { await fs.unlink(wavFile); }, 10000);

        } catch (err) {
          if (err.response && err.response.text) {
            err.response.text().then(text => console.error('API Error:', text));
          } else {
            console.error('Error:', err);
          }
          ws.send('Error: ' + err.message);
        }
      }
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    audioChunks = [];
  });
});