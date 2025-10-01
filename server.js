// ... (other imports and setup code)

          // ======= PACED CHUNKED DELIVERY =======
          const CHUNK_SIZE = 2048; // Should match ESP32 (16-bit PCM: 1024 samples * 2 bytes)
          const SAMPLE_RATE = 24000; // Should match ESP32
          const chunkIntervalMs = 43; // ms

          let offset = 0;
          function sendChunk() {
            if (offset < wavBuffer.length) {
              const end = Math.min(offset + CHUNK_SIZE, wavBuffer.length);
              ws.send(wavBuffer.slice(offset, end), { binary: true });
              offset = end;
              setTimeout(sendChunk, chunkIntervalMs);
            } else {
              ws.send('done'); // Optional: signal end of audio
              console.log('Audio reply sent in paced chunks.');
            }
          }
          sendChunk();
          // ======= END PACED CHUNKED DELIVERY =======

// ... (rest of code)