import express from 'express';
import bodyParser from 'body-parser';
import { OpenAI } from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();
app.use(bodyParser.json());

app.post('/api/reply', async (req, res) => {
  try {
    const text = req.body.text;
    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    const speechResponse = await openai.audio.speech.create({
      model: 'tts-1',
      input: text,
      voice: 'nova',
      response_format: 'wav',
    });

    // Use .arrayBuffer() for OpenAI SDK v4+
    const audioBuffer = Buffer.from(await speechResponse.arrayBuffer());
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Disposition': 'inline; filename="reply.wav"',
    });
    res.send(audioBuffer);

  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: 'Failed to generate speech' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`TTS server running on port ${PORT}`);
});