/* 主要职责：统一解析环境变量并输出项目运行时配置，供核心模块和基础设施层共享。 */
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

const projectRoot = path.resolve(__dirname, '../../');

module.exports = {
    projectRoot,
    llm: {
        apiKey: process.env.LLM_API_KEY || 'sk-4cd47b2fdb4a48c0ac31b731072c4ba0',
        baseUrl: process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        textModel: process.env.LLM_TEXT_MODEL || 'deepseek-v3.2',
        visionModel: process.env.LLM_VISION_MODEL || 'qwen3-vl-flash',
        visionThinkingBudget: readNumberEnv('LLM_VISION_THINKING_BUDGET', 2048),
        visionMaxOutputTokens: readNumberEnv('LLM_VISION_MAX_OUTPUT_TOKENS', 240),
        debugMessages: String(process.env.LLM_DEBUG_MESSAGES || 'false').toLowerCase() === 'true',
        maxToolRounds: readNumberEnv('LLM_MAX_TOOL_ROUNDS', 12)
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
        ttsSpeakTimeoutMs: readNumberEnv('TTS_SPEAK_TIMEOUT_MS', 25000),
        autonomousSleepMinSeconds: readNumberEnv('AGENT_SLEEP_MIN_SECONDS', 5),
        autonomousSleepMaxSeconds: readNumberEnv('AGENT_SLEEP_MAX_SECONDS', 60)
    },
    perception: {
        captureIntervalMs: readNumberEnv('SCREEN_CAPTURE_INTERVAL_MS', 30000)
    },
    vision: {
        phashSize: readNumberEnv('VISION_PHASH_SIZE', 32),
        lowFreqSize: readNumberEnv('VISION_LOW_FREQ_SIZE', 8),
        phashMinorThreshold: readNumberEnv('VISION_PHASH_MINOR_THRESHOLD', 10),
        cooldownMs: readNumberEnv('VISION_COOLDOWN_MS', 40 * 1000),
        debugLogs: readBooleanEnv('VISION_DEBUG_LOGS', false),
        cacheMaxAgeMs: readNumberEnv('VISION_CACHE_MAX_AGE_MS', 5000),
        backgroundIntervalMs: readNumberEnv('VISION_BACKGROUND_INTERVAL_MS', 10000),
        stateFilePath: process.env.VISION_STATE_FILE_PATH
            || path.resolve(projectRoot, 'workspace/CompanionAgent/memory/perception-state.json'),
        stateHistoryLimit: readNumberEnv('VISION_STATE_HISTORY_LIMIT', 120)
    },
    live2d: {
        modelJsonPath: process.env.LIVE2D_MODEL_JSON_PATH || 'assets/Azue Lane(JP)/beierfasite_2/beierfasite_2.model3.json'
    },
    debug: {
        uiPerf: readBooleanEnv('UI_PERF_DEBUG', false),
        uiPerfSlowMs: readNumberEnv('UI_PERF_SLOW_MS', 32)
    }
};

