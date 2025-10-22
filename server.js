import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
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

const CHUNK_SIZE = 2048; // must match device CHUNK_SIZE
const BYTES_PER_SAMPLE_DEFAULT = 2; // 16-bit default

function computeChunkIntervalMs(chunkSizeBytes, sampleRateHz, bytesPerSample = BYTES_PER_SAMPLE_DEFAULT) {
  const secondsPerChunk = chunkSizeBytes / (sampleRateHz * bytesPerSample);
  return Math.round(secondsPerChunk * 1000);
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Read WAV header fields (assumes standard 44-byte header)
function parseWavHeader(buffer) {
  if (!buffer || buffer.length < 44) {
    return null;
  }
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  return { channels, sampleRate, bitsPerSample };
}

async function sendWavBufferPaced(ws, wavBuffer, options = {}) {
  const {
    chunkSize = CHUNK_SIZE,
    burstPercent = 0.8,
    debug = true,
    handshakeTimeoutMs = 3000
  } = options;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (debug) console.warn('WebSocket not open, abort send');
    return;
  }

  const header = parseWavHeader(wavBuffer);
  const sampleRate = header ? header.sampleRate : 24000;
  const bitsPerSample = header ? header.bitsPerSample : 16;
  const bytesPerSample = Math.max(1, bitsPerSample / 8);

  const chunkIntervalMs = computeChunkIntervalMs(chunkSize, sampleRate, bytesPerSample);
  const totalChunks = Math.ceil(wavBuffer.length / chunkSize);
  const burstChunks = Math.max(1, Math.floor(totalChunks * burstPercent));

  if (debug) {
    console.info(`[sendWav] totalBytes=${wavBuffer.length} sampleRate=${sampleRate} bits=${bitsPerSample}`);
    console.info(`[sendWav] chunkSize=${chunkSize} totalChunks=${totalChunks} chunkIntervalMs=${chunkIntervalMs} burstChunks=${burstChunks}`);
  }

  // Optional handshake: listen briefly for a client "ready" message
  let readyReceived = false;
  function onMessageForHandshake(msg) {
    try {
      const s = (typeof msg === 'string') ? msg : msg.toString();
      if (s === 'ready') {
        readyReceived = true;
        if (debug) console.info(`[sendWav] Received 'ready' from client`);
      }
    } catch (e) {}
  }
  ws.on('message', onMessageForHandshake);

  const startWait = Date.now();
  while (!readyReceived && (Date.now() - startWait) < handshakeTimeoutMs) {
    if (ws.readyState !== WebSocket.OPEN) break;
    await sleepMs(50);
  }
  if (!readyReceived && debug) {
    console.info(`[sendWav] client did not send 'ready' within ${handshakeTimeoutMs}ms, continuing anyway`);
  }

  // Fast burst for initial portion
  let chunkIndex = 0;
  try {
    for (; chunkIndex < burstChunks; chunkIndex++) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('socket closed during burst');
      const start = chunkIndex * chunkSize;
      const end = Math.min(start + chunkSize, wavBuffer.length);
      const chunkBuf = wavBuffer.slice(start, end);
      ws.send(chunkBuf, { binary: true });
      if (debug) console.info(`[sendWav] burst sent chunk ${chunkIndex} bytes=${chunkBuf.length}`);
    }

    // Paced tail: send each remaining chunk and wait chunkIntervalMs
    for (; chunkIndex < totalChunks; chunkIndex++) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('socket closed during paced send');
      const start = chunkIndex * chunkSize;
      const end = Math.min(start + chunkSize, wavBuffer.length);
      const chunkBuf = wavBuffer.slice(start, end);
      const before = Date.now();
      ws.send(chunkBuf, { binary: true });
      if (debug) console.info(`[sendWav] paced sent chunk ${chunkIndex} bytes=${chunkBuf.length} at ${new Date().toISOString()}`);
      const elapsed = Date.now() - before;
      const toSleep = Math.max(0, chunkIntervalMs - elapsed);
      if (toSleep > 0) await sleepMs(toSleep);
    }

    // send done signal
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'done' }));
      if (debug) console.info('[sendWav] sent done');
    }
  } catch (err) {
    console.warn('[sendWav] send aborted:', err && err.message ? err.message : err);
  } finally {
    try { ws.removeListener('message', onMessageForHandshake); } catch (e) {}
  }
}

wss.on('connection', ws => {
  console.log('WebSocket client connected');
  let audioChunks = [];

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      audioChunks.push(data);
    } else {
      const text = data.toString();
      if (text === "done") {
        console.log('Received "done" from client, assembling WAV file...');
        if (audioChunks.length === 0) {
          ws.send('No audio received!');
          return;
        }

        // Save the received WAV file to a temp location
        const wavFile = tmp.tmpNameSync({ postfix: '.wav' });
        const fullBuf = Buffer.concat(audioChunks);
        await fs.writeFile(wavFile, fullBuf);

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

          // Generate TTS audio using OpenAI (WAV)
          const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'tts-1',
              input: replyText,
              voice: 'nova', // female voice
              response_format: 'wav'
            })
          });

          if (!ttsRes.ok) {
            const errorText = await ttsRes.text();
            throw new Error('TTS failed: ' + errorText);
          }
          const wavBuffer = Buffer.from(await ttsRes.arrayBuffer());

          // Use paced send (sliced) instead of sending whole buffer
          await sendWavBufferPaced(ws, wavBuffer, { chunkSize: CHUNK_SIZE, burstPercent: 0.8, debug: true });

          // Clean up temp file
          await fs.unlink(wavFile);
          console.log('Audio reply sent.');
        } catch (err) {
          if (err.response && err.response.text) {
            err.response.text().then(text => console.error('API Error:', text));
          } else {
            console.error('Error:', err);
          }
          ws.send('Error: ' + (err.message || String(err)));
        } finally {
          audioChunks = [];
        }
      } else if (text === 'ready') {
        console.log('Client reported ready to receive burst.');
      } else {
        console.log(`[WS Text] ${text}`);
      }
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    audioChunks = [];
  });
});