import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { OpenAI } from 'openai';
import tmp from 'tmp';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import fetch from 'node-fetch';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const server = app.listen(8080, () => console.log('HTTP server running on port 8080'));
const wss = new WebSocketServer({ server });

app.get('/', (req, res) => res.send('ESP32 ChatGPT Bridge Server Running!'));

wss.on('connection', ws => {
  console.log('WebSocket client connected');
  let audioChunks = [];

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      audioChunks.push(data);
    } else {
      if (data.toString() === "done") {
        console.log('Received "done" from client, assembling WAV file...');
        if (audioChunks.length === 0) {
          ws.send('No audio received!');
          return;
        }

        const wavFile = tmp.tmpNameSync({ postfix: '.wav' });
        await fs.writeFile(wavFile, Buffer.concat(audioChunks));

        try {
          const transcription = await openai.audio.transcriptions.create({
            file: createReadStream(wavFile),
            model: 'whisper-1'
          });
          console.log('Transcription:', transcription.text);

          const chatRes = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'user', content: transcription.text }
            ]
          });
          const replyText = chatRes.choices[0].message.content;
          console.log('ChatGPT reply:', replyText);

          const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'tts-1',
              input: replyText,
              voice: 'nova',
              response_format: 'wav'
            })
          });

          if (!ttsRes.ok) {
            const errorText = await ttsRes.text();
            throw new Error('TTS failed: ' + errorText);
          }
          const wavBuffer = Buffer.from(await ttsRes.arrayBuffer());

          // ======= PACED CHUNKED DELIVERY =======
          const CHUNK_SIZE = 1024; // Reduced chunk size matches ESP32
          const chunkIntervalMs = 43; // Reduced interval matches ESP32

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