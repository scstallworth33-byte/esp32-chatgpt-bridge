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

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + buffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * bitDepth / 8, 28);
  header.writeUInt16LE(numChannels * bitDepth / 8, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(buffer.length, 40);

  return Buffer.concat([header, buffer]);
}

// UTILITY: GOOGLE TEXT-TO-SPEECH (TTS)
async function synthesizeSpeechGoogle(text) {
  const request = {
    input: { text },
    voice: { languageCode: 'en-US', ssmlGender: 'FEMALE' },
    audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
  };
  const [response] = await ttsClient.synthesizeSpeech(request);
  const rawPcmBuffer = Buffer.from(response.audioContent, 'base64');
  const wavBuffer = addWavHeader(rawPcmBuffer, { sampleRate: 24000, numChannels: 1, bitDepth: 16 });
  return wavBuffer;
}

// === MAIN WEBSOCKET HANDLER with STREAMING STT ===
wss.on('connection', ws => {
  console.log('WebSocket client connected');

  let recognizeStream = null;
  let sttTranscript = '';
  let sttFinalized = false;

  // Start Google Streaming Recognize
  function startStreamingSTT() {
    sttTranscript = '';
    sttFinalized = false;
    recognizeStream = speechClient
      .streamingRecognize({
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
  }

  // Start STT stream on connect
  startStreamingSTT();

  ws.on('message', async (data, isBinary) => {
    // Binary = audio chunk from ESP32
    if (isBinary && recognizeStream && !sttFinalized) {
      recognizeStream.write(data);
    } else if (!isBinary && data.toString() === "done") {
      // End of utterance
      if (recognizeStream && !sttFinalized) {
        recognizeStream.end();
        sttFinalized = true;
      }

      // Wait a moment for any final STT results
      setTimeout(async () => {
        // Use the STT transcript (could also use interim if needed)
        const transcription = sttTranscript.trim();
        console.log('Final transcription:', transcription);
        if (!transcription) {
          ws.send('No speech detected!');
          return;
        }

        // === 2. CHATGPT (or Gemini) call ===
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
        const CHUNK_SIZE = 2048;
        const chunkIntervalMs = 43;

        let offset = 0;
        const intervalId = setInterval(() => {
          if (offset < wavBuffer.length) {
            const end = Math.min(offset + CHUNK_SIZE, wavBuffer.length);
            ws.send(wavBuffer.slice(offset, end), { binary: true });
            offset = end;
          } else {
            clearInterval(intervalId);
            ws.send('done');
            console.log('Audio reply sent in paced chunks.');
          }
        }, chunkIntervalMs);
      }, 800);
    }
  });

  ws.on('close', () => {
    if (recognizeStream) recognizeStream.destroy();
    console.log('WebSocket client disconnected');
  });
});