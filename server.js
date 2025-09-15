import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { OpenAI } from 'openai';
import tmp from 'tmp';
import fs from 'fs/promises';
import { createReadStream } from 'fs'; // <-- Correct import for streams
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
    if (!isBinary) return;
    audioChunks.push(data);
  });

  ws.on('close', async () => {
    console.log('WebSocket client disconnected, assembling WAV file...');
    if (audioChunks.length === 0) return;

    // Save the received WAV file to a temp location
    const wavFile = tmp.tmpNameSync({ postfix: '.wav' });
    await fs.writeFile(wavFile, Buffer.concat(audioChunks));

    try {
      // Transcribe using OpenAI Whisper
      const transcription = await openai.audio.transcriptions.create({
        file: createReadStream(wavFile), // <-- FIXED here
        model: 'whisper-1'
      });
      console.log('Transcription:', transcription.text);

      // Get ChatGPT response
      const chatRes = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'user', content: transcription.text }
        ]
      });
      const replyText = chatRes.choices[0].message.content;
      console.log('ChatGPT reply:', replyText);

      // Generate TTS audio using OpenAI (WAV format)
      const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: replyText,
          voice: 'onyx', // you can use 'nova', 'shimmer', etc.
          response_format: 'wav'
        })
      });

      if (!ttsRes.ok) {
        const errorText = await ttsRes.text();
        throw new Error('TTS failed: ' + errorText);
      }
      const wavBuffer = Buffer.from(await ttsRes.arrayBuffer());

      // Send WAV back as binary over WebSocket
      wss.clients.forEach(client => {
        if (client.readyState === ws.OPEN) {
          client.send(wavBuffer, { binary: true });
        }
      });

      // Clean up temp file
      await fs.unlink(wavFile);
      console.log('Audio reply sent.');
    } catch (err) {
      if (err.response && err.response.text) {
        err.response.text().then(text => console.error('API Error:', text));
      } else {
        console.error('Error:', err);
      }
    }
  });
});