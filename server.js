#include <Arduino.h>
#include <WiFi.h>
#include <LittleFS.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>
#include <SD.h>
#include <SPI.h>
#include <algorithm>
#include "esp_heap_caps.h"

// WiFi credentials
#define WIFI_SSID "SpectrumSetup-3E85"
#define WIFI_PASS "othereditor425"

// WebSocket server
#define WS_SERVER_IP "nimbus-backend-guo9.onrender.com"
#define WS_SERVER_PORT 443

// I2S microphone pins
#define I2S_MIC_NUM I2S_NUM_0
#define I2S_MIC_WS 5
#define I2S_MIC_SCK 4
#define I2S_MIC_SD 6

// SPEAKER amplifier (I2S OUT) pins
#define I2S_SPK_BCK 15
#define I2S_SPK_WS  16
#define I2S_SPK_SD  7

#define SAMPLE_RATE 24000
#define CHUNK_SIZE 4096         // 1024 samples * 2 bytes per sample
#define WAV_HEADER_SIZE 44
#define WAV_FILENAME "/audio.wav"
#define SD_FILENAME "/response.wav"
#define VAD_SILENCE_THRESHOLD 500
#define VAD_SILENCE_MS 1000
#define VAD_TIMEOUT_MS 5000

// SD Card SPI pin definitions
#define SD_CS   2
#define SD_SCK  42
#define SD_MOSI 40
#define SD_MISO 39

WebSocketsClient webSocket;
bool audioSent = false;
File audioFileSD;
size_t responseFileSize = 0;

volatile bool playbackTaskStarted = false;
volatile bool playbackTaskFinished = false;

// Streaming buffer settings
#define RAM_STREAM_BUFFER_SIZE (128 * 1024)    // 128KB RAM buffer for streaming
#define RAM_PLAYBACK_START_THRESHOLD (RAM_STREAM_BUFFER_SIZE * 7 / 8) // Buffer at least 87.5% before playing

uint8_t ramStreamBuffer[RAM_STREAM_BUFFER_SIZE];
volatile size_t ramBufWrite = 0;
volatile size_t ramBufRead = 0;
volatile size_t ramBufFill = 0;
volatile bool ramStreamPlaybackActive = false;
volatile bool ramBufferReady = false;
volatile bool ramStreamDone = false;

TaskHandle_t playbackTaskHandle = NULL;

unsigned long lastHeapPrint = 0;

// RAM usage monitoring
void printFreeRam(const char* tag = "") {
    Serial.printf("[RAM] %s Free heap: %u bytes, Min free heap: %u bytes\n", tag, ESP.getFreeHeap(), ESP.getMinFreeHeap());
    Serial.printf("[RAM] %s DRAM free: %u bytes, IRAM free: %u bytes\n", tag,
        heap_caps_get_free_size(MALLOC_CAP_8BIT),
        heap_caps_get_free_size(MALLOC_CAP_32BIT));
}

// Forward declarations
void sendAudioFile();
void i2sMicInit();
void writeWavHeader(File &file, int sampleRate, int bitsPerSample, int channels, int dataSize);
void replayResponseFromSD();

// --- I2S Speaker Output ---
void i2sSpeakerInit() {
    i2s_config_t i2s_config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
        .sample_rate = SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = 0,
        .dma_buf_count = 8,
        .dma_buf_len = 512,
        .use_apll = false
    };
    i2s_pin_config_t pin_config = {
        .bck_io_num = I2S_SPK_BCK,
        .ws_io_num = I2S_SPK_WS,
        .data_out_num = I2S_SPK_SD,
        .data_in_num = I2S_PIN_NO_CHANGE
    };
    i2s_driver_install(I2S_MIC_NUM, &i2s_config, 0, NULL);
    i2s_set_pin(I2S_MIC_NUM, &pin_config);
}

// --- RAM Streaming Playback Task ---
void ramStreamingPlaybackTask(void *param) {
    i2sSpeakerInit();
    float volume = 2.0;

    printFreeRam("Before playback start");

    // Wait until buffer is 87.5% full before starting playback
    while (ramBufFill < RAM_PLAYBACK_START_THRESHOLD && !ramStreamDone) {
        vTaskDelay(10);
    }

    printFreeRam("Buffer full, starting playback");

    // Skip WAV header
    size_t headerBytesToSkip = WAV_HEADER_SIZE;
    while (headerBytesToSkip > 0) {
        if (ramBufFill >= 1) {
            ramBufRead = (ramBufRead + 1) % RAM_STREAM_BUFFER_SIZE;
            ramBufFill -= 1;
            headerBytesToSkip -= 1;
        } else {
            vTaskDelay(1);
        }
    }

    // Main playback loop
    while (!ramStreamDone || ramBufFill > 0) {
        // Print RAM usage every 5 seconds
        if (millis() - lastHeapPrint > 5000) {
            printFreeRam("Playback loop");
            Serial.printf("[BUFFER] Fill: %d bytes\n", ramBufFill);
            lastHeapPrint = millis();
        }

        if (ramBufFill >= CHUNK_SIZE) {
            size_t playLen = CHUNK_SIZE;
            uint8_t temp[CHUNK_SIZE];
            size_t tillEnd = RAM_STREAM_BUFFER_SIZE - ramBufRead;
            if (tillEnd >= playLen) {
                memcpy(temp, ramStreamBuffer + ramBufRead, playLen);
                ramBufRead = (ramBufRead + playLen) % RAM_STREAM_BUFFER_SIZE;
            } else {
                memcpy(temp, ramStreamBuffer + ramBufRead, tillEnd);
                memcpy(temp + tillEnd, ramStreamBuffer, playLen - tillEnd);
                ramBufRead = playLen - tillEnd;
            }
            ramBufFill -= playLen;

            int16_t* samples = (int16_t*)temp;
            size_t sampleCount = playLen / 2;
            for (size_t i = 0; i < sampleCount; i++) {
                int32_t boosted = (int32_t)(samples[i] * volume);
                if (boosted > INT16_MAX) boosted = INT16_MAX;
                else if (boosted < INT16_MIN) boosted = INT16_MIN;
                samples[i] = (int16_t)boosted;
            }
            size_t written;
            i2s_write(I2S_MIC_NUM, (const char *)temp, playLen, &written, portMAX_DELAY);

            // Pace playback for real time
            vTaskDelay(pdMS_TO_TICKS(43)); // 43ms per chunk at 24kHz for 1024 samples (2048 bytes)
        } else {
            // Not enough buffer, wait for new data
            vTaskDelay(10);
        }
    }

    printFreeRam("Playback finished");
    i2s_driver_uninstall(I2S_MIC_NUM);
    Serial.println("RAM Streaming playback finished!");
    playbackTaskFinished = true;
    ramStreamPlaybackActive = false;
    vTaskDelete(NULL);
}

// --- Replay last response from SD card ---
void replayResponseFromSD() {
    File file = SD.open(SD_FILENAME, FILE_READ);
    if (!file) {
        Serial.println("Failed to open response.wav for replay!");
        return;
    }
    i2sSpeakerInit();
    file.seek(WAV_HEADER_SIZE, SeekSet);

    float volume = 2.0;
    uint8_t buf[CHUNK_SIZE];
    while (file.available()) {
        size_t bytesRead = file.read(buf, sizeof(buf));
        int16_t* samples = (int16_t*)buf;
        size_t sampleCount = bytesRead / 2;
        for (size_t i = 0; i < sampleCount; i++) {
            int32_t boosted = (int32_t)(samples[i] * volume);
            if (boosted > INT16_MAX) boosted = INT16_MAX;
            else if (boosted < INT16_MIN) boosted = INT16_MIN;
            samples[i] = (int16_t)boosted;
        }
        size_t written;
        i2s_write(I2S_MIC_NUM, (const char *)buf, bytesRead, &written, portMAX_DELAY);

        // Pace playback here too
        vTaskDelay(pdMS_TO_TICKS(43)); // 43ms per chunk for 2048 bytes
    }
    i2s_driver_uninstall(I2S_MIC_NUM);
    file.close();
    Serial.println("Replay finished!");
}

// --- WebSocket event handler: RAM streaming and SD archival ---
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
    switch(type) {
        case WStype_BIN:
        case (WStype_t)7: { // Fragment or BIN
            // Fill RAM buffer (circular)
            size_t bytesToCopy = length;
            size_t space = RAM_STREAM_BUFFER_SIZE - ramBufFill;
            if (bytesToCopy > space) bytesToCopy = space; // Prevent overflow!
            size_t tillEnd = RAM_STREAM_BUFFER_SIZE - ramBufWrite;
            if (tillEnd >= bytesToCopy) {
                memcpy(ramStreamBuffer + ramBufWrite, payload, bytesToCopy);
                ramBufWrite = (ramBufWrite + bytesToCopy) % RAM_STREAM_BUFFER_SIZE;
            } else {
                memcpy(ramStreamBuffer + ramBufWrite, payload, tillEnd);
                memcpy(ramStreamBuffer, payload + tillEnd, bytesToCopy - tillEnd);
                ramBufWrite = bytesToCopy - tillEnd;
            }
            ramBufFill += bytesToCopy;

            // Start RAM playback when buffer is 87.5% full
            if (!ramStreamPlaybackActive && ramBufFill > RAM_PLAYBACK_START_THRESHOLD + WAV_HEADER_SIZE) {
                ramBufferReady = true;
                ramStreamPlaybackActive = true;
                Serial.println("Starting RAM streaming playback...");
                printFreeRam("Before xTaskCreate");
                xTaskCreatePinnedToCore(ramStreamingPlaybackTask, "ramStreamingPlaybackTask", 8192, NULL, 1, &playbackTaskHandle, 1);
            }
            break;
        }
        case (WStype_t)8: { // Final fragment
            // Final fragment: fill RAM buffer, mark streaming done
            size_t bytesToCopy = length;
            size_t space = RAM_STREAM_BUFFER_SIZE - ramBufFill;
            if (bytesToCopy > space) bytesToCopy = space;
            size_t tillEnd = RAM_STREAM_BUFFER_SIZE - ramBufWrite;
            if (tillEnd >= bytesToCopy) {
                memcpy(ramStreamBuffer + ramBufWrite, payload, bytesToCopy);
                ramBufWrite = (ramBufWrite + bytesToCopy) % RAM_STREAM_BUFFER_SIZE;
            } else {
                memcpy(ramStreamBuffer + ramBufWrite, payload, tillEnd);
                memcpy(ramStreamBuffer, payload + tillEnd, bytesToCopy - tillEnd);
                ramBufWrite = bytesToCopy - tillEnd;
            }
            ramBufFill += bytesToCopy;
            ramStreamDone = true;
            Serial.println("All fragments received in RAM.");
            // Optional: archive to SD for replay
            File sdOut = SD.open(SD_FILENAME, FILE_WRITE);
            if (sdOut) {
                size_t sdRead = 0;
                while (sdRead < ramBufFill) {
                    size_t copyLen = std::min((size_t)CHUNK_SIZE, ramBufFill - sdRead);
                    size_t bufIndex = (ramBufRead + sdRead) % RAM_STREAM_BUFFER_SIZE;
                    size_t tillEnd = RAM_STREAM_BUFFER_SIZE - bufIndex;
                    if (tillEnd >= copyLen) {
                        sdOut.write(ramStreamBuffer + bufIndex, copyLen);
                    } else {
                        sdOut.write(ramStreamBuffer + bufIndex, tillEnd);
                        sdOut.write(ramStreamBuffer, copyLen - tillEnd);
                    }
                    sdRead += copyLen;
                }
                sdOut.close();
                Serial.println("Archived streamed audio to SD.");
            }
            break;
        }
        case WStype_TEXT: {
            Serial.printf("[WSc] TEXT: %s\n", payload);
            break;
        }
        case WStype_CONNECTED: {
            Serial.println("[WSc] Connected to server.");
            if (!audioSent) {
                sendAudioFile();
                audioSent = true;
            }
            break;
        }
        case WStype_DISCONNECTED: {
            Serial.println("[WSc] Disconnected!");
            break;
        }
        default: {
            Serial.printf("[WSc] Unknown event type: %d\n", type);
            break;
        }
    }
}

// --- Mic recording function ---
void recordAndSaveWavAudioVAD() {
    Serial.println("Initializing I2S microphone...");
    if (LittleFS.exists(WAV_FILENAME)) LittleFS.remove(WAV_FILENAME);
    i2sMicInit();

    File file = LittleFS.open(WAV_FILENAME, FILE_WRITE);
    if (!file) while (1);
    int headerSize = 44;
    for (int i = 0; i < headerSize; i++) file.write((uint8_t)0);

    uint8_t chunk[CHUNK_SIZE];
    size_t bytesRead;
    size_t totalBytes = 0;
    uint32_t silentMs = 0;
    bool firstSound = false;
    uint32_t startMs = millis();

    Serial.println("Starting VAD recording (speak now)...");
    while (true) {
        i2s_read(I2S_MIC_NUM, chunk, CHUNK_SIZE, &bytesRead, portMAX_DELAY);
        size_t samplesInChunk = bytesRead / 4;
        if (bytesRead == 0 || samplesInChunk == 0) continue;

        int32_t* samples = (int32_t*)chunk;
        int64_t sum = 0;
        for (size_t i = 0; i < samplesInChunk; i++)
            sum += abs(samples[i] >> 14);
        int avgAmplitude = samplesInChunk ? (sum / samplesInChunk) : 0;

        Serial.printf("avgAmplitude: %d\n", avgAmplitude);

        if (avgAmplitude > VAD_SILENCE_THRESHOLD) {
            silentMs = 0;
            firstSound = true;
        } else if (firstSound) {
            silentMs += (1000 * CHUNK_SIZE) / (SAMPLE_RATE * 4);
        }

        if (firstSound) {
            int16_t outSamples[samplesInChunk];
            for (size_t i = 0; i < samplesInChunk; i++)
                outSamples[i] = samples[i] >> 14;
            file.write((uint8_t*)outSamples, samplesInChunk * 2);
            totalBytes += samplesInChunk * 2;
        }
        if (firstSound && silentMs >= VAD_SILENCE_MS) {
            Serial.println("Detected silence, ending recording.");
            break;
        }
        if (!firstSound && (millis() - startMs > VAD_TIMEOUT_MS)) {
            Serial.println("No speech detected, timing out.");
            break;
        }
    }
    i2s_driver_uninstall(I2S_MIC_NUM);

    if (totalBytes == 0) {
        Serial.println("No sound detected, not saving WAV file.");
        file.close();
        return;
    }

    file.seek(0, SeekSet);
    writeWavHeader(file, SAMPLE_RATE, 16, 1, totalBytes);
    file.close();
    Serial.printf("Recording complete! WAV file saved! Final size: %d bytes\n", LittleFS.open(WAV_FILENAME, FILE_READ).size());
}

void i2sMicInit() {
    i2s_config_t i2s_config = {
        .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate = SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = 0,
        .dma_buf_count = 4,
        .dma_buf_len = 256,
        .use_apll = false
    };
    i2s_pin_config_t pin_config = {
        .bck_io_num = I2S_MIC_SCK,
        .ws_io_num = I2S_MIC_WS,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num = I2S_MIC_SD
    };
    i2s_driver_install(I2S_MIC_NUM, &i2s_config, 0, NULL);
    i2s_set_pin(I2S_MIC_NUM, &pin_config);
}

void writeWavHeader(File &file, int sampleRate, int bitsPerSample, int channels, int dataSize) {
    file.write((const uint8_t *)"RIFF", 4);
    uint32_t chunkSize = 36 + dataSize;
    file.write((uint8_t*)&chunkSize, 4);
    file.write((const uint8_t *)"WAVE", 4);
    file.write((const uint8_t *)"fmt ", 4);
    uint32_t subChunk1Size = 16;
    file.write((uint8_t*)&subChunk1Size, 4);
    uint16_t audioFormat = 1;
    file.write((uint8_t*)&audioFormat, 2);
    uint16_t channels16 = channels;
    file.write((uint8_t*)&channels16, 2);
    file.write((uint8_t*)&sampleRate, 4);
    uint32_t byteRate = sampleRate * channels * bitsPerSample / 8;
    file.write((uint8_t*)&byteRate, 4);
    uint16_t blockAlign = channels * bitsPerSample / 8;
    file.write((uint8_t*)&blockAlign, 2);
    file.write((uint8_t*)&bitsPerSample, 2);
    file.write((const uint8_t *)"data", 4);
    file.write((uint8_t*)&dataSize, 4);
}

// Send WAV file to server in binary chunks, then signal "done"
void sendAudioFile() {
    File file = LittleFS.open(WAV_FILENAME, FILE_READ);
    if (!file) return;
    uint8_t buf[CHUNK_SIZE];
    while (file.available()) {
        size_t len = file.read(buf, CHUNK_SIZE);
        webSocket.sendBIN(buf, len);
        delay(20);
    }
    file.close();
    webSocket.sendTXT("done");
}

void setup() {
    Serial.begin(115200);

    printFreeRam("Startup");

    if (!LittleFS.begin(true)) while (1);

    SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
    if (!SD.begin(SD_CS)) {
        Serial.println("SD Card Mount Failed!");
        while (1);
    }
    Serial.println("SD Card Initialized!");

    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.print("Connecting to WiFi.");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nWiFi Connected!");

    printFreeRam("After WiFi");

    recordAndSaveWavAudioVAD();

    printFreeRam("After Record");

    webSocket.beginSSL(WS_SERVER_IP, WS_SERVER_PORT, "/");
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(5000);
}

void loop() {
    webSocket.loop();
    // Serial replay: type 'r' in Serial Monitor and hit Enter
    if (Serial.available()) {
        char c = Serial.read();
        if (c == 'r') {
            replayResponseFromSD();
        }
    }

    // Print RAM stats every 5 seconds
    static unsigned long lastLoopHeapPrint = 0;
    if (millis() - lastLoopHeapPrint > 5000) {
        printFreeRam("Main loop");
        lastLoopHeapPrint = millis();
    }
}