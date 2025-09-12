// Load dependencies
const WebSocket = require('ws');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config(); // Load environment variables from .env if present

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY';

// Use PORT from environment for Render compatibility, default to 3000
const PORT = process.env.PORT || 3000;

// Start WebSocket server
const wss = new WebSocket.Server({ port: PORT }, () => {
    console.log(`WebSocket server running on port ${PORT}`);
});

// Handle new client connections
wss.on('connection', ws => {
    console.log('Client connected');

    ws.on('message', async (message, isBinary) => {
        // If message is binary (audio), process it
        if (isBinary) {
            // Save received audio chunk for debugging (optional)
            fs.appendFileSync('received_audio_stream.wav', message);

            try {
                // Prepare multipart/form-data for Whisper API
                const form = new FormData();
                form.append('file', message, {
                    filename: 'audio.wav',
                    contentType: 'audio/wav'
                });
                form.append('model', 'whisper-1');
                form.append('response_format', 'text');

                // Send audio to OpenAI Whisper API
                const response = await axios.post(
                    'https://api.openai.com/v1/audio/transcriptions',
                    form,
                    {
                        headers: {
                            'Authorization': `Bearer ${OPENAI_API_KEY}`,
                            ...form.getHeaders()
                        }
                    }
                );

                const transcript = response.data.text;
                ws.send(transcript || 'No transcription received.');
            } catch (error) {
                console.error('Whisper API error:', error.response ? error.response.data : error.message);
                ws.send('Transcription failed.');
            }
        } else {
            // If message is text, echo it back
            ws.send('Echo: ' + message);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});