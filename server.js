async function transcribeAudio(audioBuffer) {
    const formData = new FormData();
    // Append the buffer directly, with filename and contentType
    formData.append('file', audioBuffer, {
        filename: 'audio.wav',
        contentType: 'audio/wav'
    });
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