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

// === STREAMING STT HANDLER ===
wss.on('connection', ws => {
  console.log('WebSocket client connected');

  let sttTranscript = '';
  let sttFinalized = false;

  // Create Google streamingRecognize stream
  const recognizeStream = speechClient.streamingRecognize({
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: 24000,
      languageCode: 'en-US',
    },
    interimResults: true,
    singleUtterance: false,
  })
  .on('error', err => {
    console.error('Google STT error:', err);
    ws.send('STT Error: ' + err.message);
    ws.close();
  })
  .on('data', data => {
    if (data.results[0] && data.results[0].alternatives[0]) {
      const transcript = data.results[0].alternatives[0].transcript;
      ws.send(JSON.stringify({
        type: data.results[0].isFinal ? 'final' : 'interim',
        transcript
      }));
      if (data.results[0].isFinal) {
        sttTranscript += transcript + '\n';
        sttFinalized = true;
      }
    }
  });

  ws.on('message', async (data, isBinary) => {
    if (isBinary && !sttFinalized) {
      recognizeStream.write(data);
    } else if (!isBinary && data.toString() === "done") {
      // End the Google STT stream
      recognizeStream.end();
      sttFinalized = true;

      // Wait a moment for any final STT results to arrive
      setTimeout(async () => {
        const transcription = sttTranscript.trim();
        console.log('Final transcription:', transcription);
        if (!transcription) {
          ws.send('No speech detected!');
          return;
        }

        // === 2. CHATGPT RESPONSE (still uses OpenAI GPT) ===
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

        // ======= IMPROVED PACED CHUNKED DELIVERY WITH BURST =======
        const CHUNK_SIZE = 2048; // Should match ESP32
        const chunkIntervalMs = 39; // ms for pacing
        const BURST_CHUNKS = 60; // Burst first 20 chunks (~860ms at 24kHz)
        let offset = 0;
        let chunkCount = 0;

        function sendNextChunk() {
          if (offset < wavBuffer.length) {
            const end = Math.min(offset + CHUNK_SIZE, wavBuffer.length);
            ws.send(wavBuffer.slice(offset, end), { binary: true });
            offset = end;
            chunkCount++;
            if (chunkCount < BURST_CHUNKS) {
              // Fast burst for first N chunks
              setImmediate(sendNextChunk);
            } else {
              // After burst, pace normally
              setTimeout(sendNextChunk, chunkIntervalMs);
            }
          } else {
            ws.send('done');
            console.log('Audio reply sent in burst + paced chunks.');
          }
        }
        sendNextChunk();

      }, 800);
    }
  });

  ws.on('close', () => {
    recognizeStream.destroy();
    console.log('WebSocket client disconnected');
  });
});