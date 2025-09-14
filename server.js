require('dotenv').config();
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { Blob } = require('buffer'); // <-- Add this line

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY';

// Start WebSocket server
const wss = new WebSocket.Server({ port: PORT }, () => {
    console.log(`WebSocket server running on port ${PORT}`);
});

wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', async (message, isBinary) => {
        console.log('Received message. isBinary:', isBinary);

        if (isBinary) {
            try {
                // Send audio to OpenAI Whisper API
                const transcript = await transcribeAudio(message);
                ws.send(transcript || 'No transcript received.');
            } catch (err) {
                console.error('Error during transcription:', err);
                ws.send('Error during transcription');
            }
        } else {
            // Echo text messages
            ws.send('Echo: ' + message.toString());
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

// Helper function to send audio to OpenAI Whisper API and get transcript
async function transcribeAudio(audioBuffer) {
    const formData = new FormData();
    // Convert binary audioBuffer to Blob for FormData
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });
    formData.append('file', blob, 'audio.wav'); // filename as third arg
    formData.append('model', 'whisper-1');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: formData
    });

    if (!response.ok) {
        console.error('OpenAI API error:', await response.text());
        throw new Error('OpenAI API error');
    }
    
    const data = await response.json();
    return data.text;
}