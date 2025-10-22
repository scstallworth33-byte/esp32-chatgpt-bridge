// Suggested server-side helpers for paced+burst audio delivery with handshake and logging.
// Integrate these functions into your existing server code that generates wavBuffer
// Requires: const WebSocket = require('ws'); // if not already present

const BYTES_PER_SAMPLE = 2; // 16-bit PCM -> 2 bytes/sample

function computeChunkIntervalMs(chunkSizeBytes, sampleRateHz, bytesPerSample = BYTES_PER_SAMPLE) {
  // real-time duration in ms for each chunk
  const secondsPerChunk = chunkSizeBytes / (sampleRateHz * bytesPerSample);
  return Math.round(secondsPerChunk * 1000);
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send a wavBuffer to an ESP32 client over ws using:
 * - a handshake: wait for client to send "ready"
 * - a fast burst for the first burstPercent of chunks
 * - paced sending for the remaining chunks using calculated chunkIntervalMs
 *
 * Options:
 *  - chunkSize (bytes)
 *  - sampleRate (Hz)
 *  - bytesPerSample (2 for 16-bit)
 *  - burstPercent (0..1)
 *  - debug (boolean)
 */
async function sendWavBufferToClient(ws, wavBuffer, options = {}) {
  const {
    chunkSize = 2048,
    sampleRate = 24000,
    bytesPerSample = BYTES_PER_SAMPLE,
    burstPercent = 0.8,
    debug = true,
    handshakeTimeoutMs = 5000,
  } = options;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (debug) console.warn('WebSocket not open, abort send');
    return;
  }

  const chunkIntervalMs = computeChunkIntervalMs(chunkSize, sampleRate, bytesPerSample);
  const totalChunks = Math.ceil(wavBuffer.length / chunkSize);
  const burstChunks = Math.max(1, Math.floor(totalChunks * burstPercent));
  const pacedChunks = totalChunks - burstChunks;

  if (debug) {
    console.info(`[sendWav] totalBytes=${wavBuffer.length} totalChunks=${totalChunks} chunkSize=${chunkSize}`);
    console.info(`[sendWav] chunkIntervalMs=${chunkIntervalMs} burstPercent=${burstPercent} burstChunks=${burstChunks} pacedChunks=${pacedChunks}`);
  }

  // Handshake: wait for client 'ready' message
  let clientReady = false;
  function onMessageForHandshake(msg) {
    try {
      const s = (typeof msg === 'string') ? msg : msg.toString();
      if (s === 'ready') {
        clientReady = true;
        if (debug) console.info(`[sendWav] Received 'ready' from client`);
      }
    } catch (e) {}
  }
  ws.on('message', onMessageForHandshake);

  const startWait = Date.now();
  while (!clientReady && (Date.now() - startWait) < handshakeTimeoutMs) {
    if (ws.readyState !== WebSocket.OPEN) break;
    await sleepMs(50);
  }

  if (!clientReady) {
    if (debug) console.warn(`[sendWav] Client did not send 'ready' within ${handshakeTimeoutMs}ms — proceeding cautiously`);
  }

  // Send chunks
  const sendTimestamp = () => (new Date()).toISOString();

  // Helper to safely send a buffer chunk
  function safeSend(chunkBuf, idx) {
    if (ws.readyState !== WebSocket.OPEN) {
      if (debug) console.warn(`[sendWav] ws not open when trying to send chunk ${idx}`);
      return false;
    }
    try {
      ws.send(chunkBuf);
      if (debug) console.info(`[sendWav] sent chunk ${idx} at ${sendTimestamp()} (bytes=${chunkBuf.length})`);
      return true;
    } catch (err) {
      console.error(`[sendWav] send error chunk ${idx}:`, err && err.message ? err.message : err);
      return false;
    }
  }

  // Fast burst
  let chunkIndex = 0;
  const tBurstStart = Date.now();
  for (; chunkIndex < burstChunks; chunkIndex++) {
    const startByte = chunkIndex * chunkSize;
    const endByte = Math.min(startByte + chunkSize, wavBuffer.length);
    const chunkBuf = wavBuffer.slice(startByte, endByte);
    if (!safeSend(chunkBuf, chunkIndex)) break;
    // no sleep during burst (fast loop)
  }
  const tBurstEnd = Date.now();
  if (debug) console.info(`[sendWav] burst finished: sent ${chunkIndex} chunks in ${tBurstEnd - tBurstStart}ms`);

  // Paced send for tail
  const tPacedStart = Date.now();
  for (; chunkIndex < totalChunks; chunkIndex++) {
    const startByte = chunkIndex * chunkSize;
    const endByte = Math.min(startByte + chunkSize, wavBuffer.length);
    const chunkBuf = wavBuffer.slice(startByte, endByte);

    // Wait if socket closed
    if (ws.readyState !== WebSocket.OPEN) {
      if (debug) console.warn(`[sendWav] Socket closed during paced send at chunk ${chunkIndex}`);
      break;
    }

    const before = Date.now();
    if (!safeSend(chunkBuf, chunkIndex)) break;
    const after = Date.now();

    // Sleep the remainder of chunkIntervalMs minus time taken to send
    const elapsed = after - before;
    const sleepFor = Math.max(0, chunkIntervalMs - elapsed);
    if (sleepFor > 0) await sleepMs(sleepFor);
  }
  const tPacedEnd = Date.now();
  if (debug) console.info(`[sendWav] paced finished: sent up to chunk ${chunkIndex} in ${tPacedEnd - tPacedStart}ms`);

  // Final 'done' text message to signal completion
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'done' }));
      if (debug) console.info(`[sendWav] sent done at ${sendTimestamp()}`);
    } else {
      if (debug) console.warn('[sendWav] not sending done: socket not open');
    }
  } catch (e) {
    console.error('[sendWav] error sending done:', e && e.message ? e.message : e);
  }

  // Clean up handshake listener
  try { ws.removeListener('message', onMessageForHandshake); } catch (e) {}
}

module.exports = {
  computeChunkIntervalMs,
  sendWavBufferToClient,
};