/* 主要职责：封装文本转语音服务调用，负责向外提供音频流输出。 */
const { app } = require('electron');
const config = require('../../config/runtimeConfig');

class TTSService {
    constructor() {
        this.apiKey = config.tts.apiKey;
        this.baseUrl = config.tts.baseUrl;
        this.voiceId = config.tts.voiceId;
    }

    async speakStream(text, onAudioChunk, signal) {
        if (!text) return;

        const payload = {
            model: config.tts.model,
            text: text,
            stream: true,
            stream_options: {
                exclude_aggregated_audio: true
            },
            voice_setting: {
                voice_id: this.voiceId,
                speed: 1,
                vol: 1,
                pitch: 0
            },
            audio_setting: {
                format: "mp3",
                sample_rate: 32000,
                channel: 1
            }
        };

        try {
            console.log('Requesting TTS for:', text.substring(0, 20) + '...');
            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: signal // Support cancellation
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error('TTS API Error:', response.status, errText);
                return;
            }

            // Node.js fetch returns a web-standard ReadableStream
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                // Check for immediate JSON error response (not SSE format)
                if (buffer.startsWith('{') && buffer.endsWith('}')) {
                     try {
                        const json = JSON.parse(buffer);
                        if (json.base_resp && json.base_resp.status_code !== 0) {
                            console.error('TTS API Error (JSON):', json.base_resp);
                            return;
                        }
                     } catch (e) {
                         // Not a complete JSON or just a part of it, continue
                     }
                }

                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep the last incomplete line

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine.startsWith('data:')) {
                        try {
                            const jsonStr = trimmedLine.substring(5).trim();
                            // Skip empty data or keep-alive
                            if (!jsonStr) continue;
                            
                            const data = JSON.parse(jsonStr);
                            if (data.data && data.data.audio) {
                                // Pass the hex audio data
                                onAudioChunk(data.data.audio);
                            }
                            
                            if (data.base_resp && data.base_resp.status_code !== 0) {
                                console.error('TTS Stream Error:', data.base_resp);
                            }
                        } catch (e) {
                            console.error('Error parsing TTS chunk:', e, 'Line:', trimmedLine);
                        }
                    }
                }
            }
            console.log('TTS Stream finished');
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('TTS Request Aborted');
            } else {
                console.error('TTS Request Failed:', error);
            }
        }
    }
}

module.exports = new TTSService();

