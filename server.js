require('dotenv').config();

const WebSocket = require('ws');
const fs = require('fs');
const FormData = require('form-data');
const axios = require('axios');

const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', function connection(ws) {
    let audioChunks = [];
    console.log('WebSocket client connected');

    ws.on('message', function incoming(data) {
        if (Buffer.isBuffer(data)) {
            audioChunks.push(data); // Receive and store each binary chunk
        } else {
            console.log('Received text:', data);
        }
    });

    ws.on('close', async function () {
        console.log('WebSocket client disconnected, assembling WAV file...');
        if (audioChunks.length === 0) {
            console.error('No audio received.');
            return;
        }

        // Reassemble the full WAV file from received chunks
        const wavBuffer = Buffer.concat(audioChunks);

        // Optionally save to disk for debugging
        fs.writeFileSync('received_audio.wav', wavBuffer);

        // Send to OpenAI Whisper API
        try {
            const form = new FormData();
            form.append('file', wavBuffer, {
                filename: 'audio.wav',
                contentType: 'audio/wav'
            });
            form.append('model', 'whisper-1');

            const openaiResponse = await axios.post(
                'https://api.openai.com/v1/audio/transcriptions',
                form,
                {
                    headers: {
                        ...form.getHeaders(),
                        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                    }
                }
            );

            console.log('Transcription result:', openaiResponse.data);
            // Optionally send result back to ESP32 client
            // ws.send(JSON.stringify(openaiResponse.data));
        } catch (e) {
            console.error('Error during transcription:', e.response?.data || e.message);
        }
    });
});

console.log('WebSocket server started on ws://localhost:8080');