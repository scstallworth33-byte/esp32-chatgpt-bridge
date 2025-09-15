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
          voice: 'onyx',
          response_format: 'wav'
        })
      });

      if (!ttsRes.ok) {
        const errorText = await ttsRes.text();
        throw new Error('TTS failed: ' + errorText);
      }
      const wavBuffer = Buffer.from(await ttsRes.arrayBuffer());

      // === SEND TO ORIGINAL CLIENT ONLY ===
      ws.send(wavBuffer, { binary: true });
      // ================================

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