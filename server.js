import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import tmp from 'tmp';
import WebSocket, { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import fetch from 'node-fetch';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({ port: PORT });

console.log(`WebSocket server listening on port ${PORT}`);

wss.on('connection', ws => {
  console.log('WebSocket client connected');
  let audioChunks = [];

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      audioChunks.push(data);
    } else {
      const msg = data.toString();
      console.log('Received text message:', msg);
      if (msg.trim() === 'done') {
        console.log('Received "done", assembling WAV file...');
        if (audioChunks.length === 0) {
          ws.send('No audio received.', { binary: false });
          return;
        }

        const wavFile = tmp.tmpNameSync({ postfix: '.wav' });
        await fs.writeFile(wavFile, Buffer.concat(audioChunks));

        try {
          // Transcribe using OpenAI Whisper
          const transcription = await openai.audio.transcriptions.create({
            file: createReadStream(wavFile),
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
              voice: 'onyx',
              response_format: 'wav'
            })
          });

          if (!ttsRes.ok) {
            const errorText = await ttsRes.text();
            throw new Error('T
