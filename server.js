const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai'); // Make sure you installed openai@4.x

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Set your OpenAI key in .env or environment
});

const app = express();
app.use(bodyParser.json());

// Endpoint to receive text and return TTS audio
app.post('/api/reply', async (req, res) => {
  try {
    const text = req.body.text;
    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    // Generate speech using OpenAI TTS
    const speechResponse = await openai.audio.speech.create({
      model: 'tts-1',         // or 'tts-1-hd'
      input: text,
      voice: 'nova',          // <--- Female, neutral voice!
      response_format: 'wav', // Use 'wav' for ESP32 playback
    });

    // The OpenAI SDK returns a stream for the audio file
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Disposition': 'inline; filename="reply.wav"',
    });

    // Pipe the audio stream directly to the response
    speechResponse.pipe(res);
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: 'Failed to generate speech' });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TTS server running on port ${PORT}`);
});