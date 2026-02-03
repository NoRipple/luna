const { app } = require('electron');

class TTSService {
    constructor() {
        this.apiKey = 'sk-api-XJOL8GswTk_pNhggQSTkihM1Gk-rHG7cHruPWX2H0tb3AelI9k6-lW2KZBsj_iJW3BB8e8PC1GJYjCx06y1pIBo7XCUNOewWPCtI5wPhUqvfVUrTVfRQx40';
        this.baseUrl = 'https://api.minimaxi.com/v1/t2a_v2';
        this.voiceId = 'Chinese (Mandarin)_Gentle_Senior'; 
    }

    async speakStream(text, onAudioChunk) {
        if (!text) return;

        const payload = {
            model: "speech-01-turbo",
            text: text,
            stream: true,
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
                body: JSON.stringify(payload)
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
            console.error('TTS Request Failed:', error);
        }
    }
}

module.exports = new TTSService();
