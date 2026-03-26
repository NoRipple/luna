const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function readNumberEnv(name, defaultValue) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

function readBooleanEnv(name, defaultValue) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    return String(raw).toLowerCase() === 'true';
}

module.exports = {
    projectRoot: path.resolve(__dirname, '../../'),
    llm: {
        apiKey: process.env.LLM_API_KEY || 'sk-4cd47b2fdb4a48c0ac31b731072c4ba0',
        baseUrl: process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        textModel: process.env.LLM_TEXT_MODEL || 'deepseek-v3.2',
        visionModel: process.env.LLM_VISION_MODEL || 'qwen3-vl-plus',
        debugMessages: String(process.env.LLM_DEBUG_MESSAGES || 'false').toLowerCase() === 'true',
        maxToolRounds: readNumberEnv('LLM_MAX_TOOL_ROUNDS', 4)
    },
    tts: {
        apiKey: process.env.TTS_API_KEY || 'sk-api-XJOL8GswTk_pNhggQSTkihM1Gk-rHG7cHruPWX2H0tb3AelI9k6-lW2KZBsj_iJW3BB8e8PC1GJYjCx06y1pIBo7XCUNOewWPCtI5wPhUqvfVUrTVfRQx40',
        baseUrl: process.env.TTS_BASE_URL || 'https://api.minimaxi.com/v1/t2a_v2',
        model: process.env.TTS_MODEL || 'speech-01-turbo',
        voiceId: process.env.TTS_VOICE_ID || 'Chinese (Mandarin)_Gentle_Senior'
    },
    api: {
        port: readNumberEnv('CONTROL_API_PORT', 3001)
    },
    core: {
        globalMousePollIntervalMs: readNumberEnv('GLOBAL_MOUSE_POLL_INTERVAL_MS', 16),
        ttsHardTimeoutMs: readNumberEnv('TTS_HARD_TIMEOUT_MS', 70000),
        ttsPlaybackEndedFallbackMs: readNumberEnv('TTS_PLAYBACK_ENDED_FALLBACK_MS', 60000),
        ttsSpeakTimeoutMs: readNumberEnv('TTS_SPEAK_TIMEOUT_MS', 25000)
    },
    perception: {
        captureIntervalMs: readNumberEnv('SCREEN_CAPTURE_INTERVAL_MS', 30000)
    },
    vision: {
        phashSize: readNumberEnv('VISION_PHASH_SIZE', 32),
        lowFreqSize: readNumberEnv('VISION_LOW_FREQ_SIZE', 8),
        phashMinorThreshold: readNumberEnv('VISION_PHASH_MINOR_THRESHOLD', 10),
        cooldownMs: readNumberEnv('VISION_COOLDOWN_MS', 40 * 1000),
        debugLogs: readBooleanEnv('VISION_DEBUG_LOGS', false)
    },
    live2d: {
        modelJsonPath: process.env.LIVE2D_MODEL_JSON_PATH || 'assets/Azue Lane(JP)/beierfasite_2/beierfasite_2.model3.json'
    }
};
