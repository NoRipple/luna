/* 主要职责：统一解析环境变量并输出项目运行时配置，供核心模块和基础设施层共享。 */
const path = require('path');
const dotenv = require('dotenv');

const dotenvResult = dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const dotenvFileEnv = dotenvResult?.parsed && typeof dotenvResult.parsed === 'object'
    ? dotenvResult.parsed
    : {};

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

function readCsvEnv(name, defaultValue = []) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return defaultValue;
    return String(raw)
        .split(',')
        .map((item) => String(item || '').trim())
        .filter(Boolean);
}

function readStringEnv(name, defaultValue = '') {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return defaultValue;
    return String(raw).trim();
}

function readStringEnvPreferDotenv(name, defaultValue = '') {
    const fileRaw = dotenvFileEnv[name];
    if (fileRaw !== undefined && fileRaw !== null && String(fileRaw).trim() !== '') {
        return String(fileRaw).trim();
    }
    return readStringEnv(name, defaultValue);
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
        maxToolRounds: readNumberEnv('LLM_MAX_TOOL_ROUNDS', 12),
        toolCallConcurrency: readNumberEnv('LLM_TOOL_CALL_CONCURRENCY', 3),
        maxSubagentToolRounds: readNumberEnv('LLM_MAX_SUBAGENT_TOOL_ROUNDS', 12),
        subagentSummaryMaxChars: readNumberEnv('LLM_SUBAGENT_SUMMARY_MAX_CHARS', 2400),
        subagentToolResultMaxChars: readNumberEnv('LLM_SUBAGENT_TOOL_RESULT_MAX_CHARS', 12000),
        contextCompactThresholdTokens: readNumberEnv('LLM_CONTEXT_COMPACT_THRESHOLD_TOKENS', 50000),
        contextCompactKeepRecentToolMessages: readNumberEnv('LLM_CONTEXT_COMPACT_KEEP_RECENT_TOOL_MESSAGES', 3),
        contextCompactTranscriptMaxChars: readNumberEnv('LLM_CONTEXT_COMPACT_TRANSCRIPT_MAX_CHARS', 80000),
        autoCompactMode: String(process.env.LLM_AUTO_COMPACT_MODE || 'summary').toLowerCase(),
        autoCompactRetryCount: readNumberEnv('LLM_AUTO_COMPACT_RETRY_COUNT', 2),
        autoCompactSummaryMaxTokens: readNumberEnv('LLM_AUTO_COMPACT_SUMMARY_MAX_TOKENS', 6000),
        autoCompactHandoffMaxChars: readNumberEnv('LLM_AUTO_COMPACT_HANDOFF_MAX_CHARS', 32000)
    },
    tts: {
        apiKey: process.env.TTS_API_KEY || 'sk-api-XJOL8GswTk_pNhggQSTkihM1Gk-rHG7cHruPWX2H0tb3AelI9k6-lW2KZBsj_iJW3BB8e8PC1GJYjCx06y1pIBo7XCUNOewWPCtI5wPhUqvfVUrTVfRQx40',
        baseUrl: process.env.TTS_BASE_URL || 'https://api.minimaxi.com/v1/t2a_v2',
        model: process.env.TTS_MODEL || 'speech-01-turbo',
        voiceId: process.env.TTS_VOICE_ID || 'Chinese (Mandarin)_Gentle_Senior',
        localProxyEnabled: readBooleanEnv('TTS_LOCAL_PROXY_ENABLED', false),
        localProxyPath: process.env.TTS_LOCAL_PROXY_PATH || '/v1/t2a_v2',
        localProxyChunkBytes: readNumberEnv('TTS_LOCAL_PROXY_CHUNK_BYTES', 4096),
        localProxyChunkIntervalMs: readNumberEnv('TTS_LOCAL_PROXY_CHUNK_INTERVAL_MS', 0),
        localProxyRequestTimeoutMs: readNumberEnv('TTS_LOCAL_PROXY_REQUEST_TIMEOUT_MS', 120000),
        localProxyOutputDir: process.env.TTS_LOCAL_PROXY_OUTPUT_DIR
            || path.resolve(projectRoot, 'workspace/tts-cache'),
        genieCondaEnv: process.env.TTS_GENIE_CONDA_ENV || 'GenieTTS',
        geniePythonPath: process.env.TTS_GENIE_PYTHON || '',
        genieProjectDir: process.env.TTS_GENIE_PROJECT_DIR || path.resolve(projectRoot, 'Genie-TTS'),
        genieCharacter: process.env.TTS_GENIE_CHARACTER || 'mika',
        genieDataDir: process.env.TTS_GENIE_DATA_DIR || '',
        genieWarmupOnStart: readBooleanEnv('TTS_GENIE_WARMUP_ON_START', true)
    },
    asr: {
        apiKey: readStringEnvPreferDotenv('ASR_API_KEY', '')
            || readStringEnvPreferDotenv('DASHSCOPE_API_KEY', '')
            || readStringEnvPreferDotenv('LLM_API_KEY', ''),
        endpoint: readStringEnvPreferDotenv('ASR_WS_ENDPOINT', 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'),
        model: readStringEnvPreferDotenv('ASR_MODEL', '') || readStringEnvPreferDotenv('ASR_MODE', '') || 'fun-asr-realtime',
        format: readStringEnvPreferDotenv('ASR_FORMAT', 'pcm'),
        sampleRate: readNumberEnv('ASR_SAMPLE_RATE', 16000),
        semanticPunctuationEnabled: readBooleanEnv('ASR_SEMANTIC_PUNCTUATION_ENABLED', false),
        heartbeat: readBooleanEnv('ASR_HEARTBEAT', true),
        maxSentenceSilence: readNumberEnv('ASR_MAX_SENTENCE_SILENCE', 0),
        multiThresholdModeEnabled: readBooleanEnv('ASR_MULTI_THRESHOLD_MODE_ENABLED', false)
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
        autonomousSleepMaxSeconds: readNumberEnv('AGENT_SLEEP_MAX_SECONDS', 60),
        maxSubagentConcurrency: readNumberEnv('AGENT_MAX_SUBAGENT_CONCURRENCY', 2)
    },
    perception: {
        captureIntervalMs: readNumberEnv('SCREEN_CAPTURE_INTERVAL_MS', 30000)
    },
    memory: {
        enabled: readBooleanEnv('MEMORY_ENABLED', true),
        workspaceDir: process.env.MEMORY_WORKSPACE_DIR
            ? path.resolve(projectRoot, process.env.MEMORY_WORKSPACE_DIR)
            : path.resolve(projectRoot, 'workspace/CompanionAgent'),
        searchEnabled: readBooleanEnv('MEMORY_SEARCH_ENABLED', true),
        embeddingProvider: String(process.env.MEMORY_SEARCH_EMBEDDING_PROVIDER || 'local_transformers').trim(),
        embeddingModel: String(process.env.MEMORY_SEARCH_EMBEDDING_MODEL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2').trim(),
        hybridVectorWeight: readNumberEnv('MEMORY_SEARCH_HYBRID_VECTOR_WEIGHT', 0.7),
        hybridTextWeight: readNumberEnv('MEMORY_SEARCH_HYBRID_TEXT_WEIGHT', 0.3),
        searchMaxResults: Math.max(1, readNumberEnv('MEMORY_SEARCH_MAX_RESULTS', 5)),
        searchChunkTargetTokens: Math.max(100, readNumberEnv('MEMORY_SEARCH_CHUNK_TARGET_TOKENS', 400)),
        searchChunkOverlapTokens: Math.max(20, readNumberEnv('MEMORY_SEARCH_CHUNK_OVERLAP_TOKENS', 80)),
        searchWatchDebounceMs: Math.max(100, readNumberEnv('MEMORY_SEARCH_WATCH_DEBOUNCE_MS', 1500)),
        searchExtraPaths: readCsvEnv('MEMORY_SEARCH_EXTRA_PATHS', []),
        graphDbPath: readStringEnv('MEMORY_GRAPH_DB_PATH', ''),
        graphDedupThreshold: readNumberEnv('MEMORY_GRAPH_DEDUP_THRESHOLD', 0.9),
        graphPagerankDamping: readNumberEnv('MEMORY_GRAPH_PAGERANK_DAMPING', 0.85),
        graphPagerankIterations: readNumberEnv('MEMORY_GRAPH_PAGERANK_ITERATIONS', 20),
        graphRecallMaxNodes: readNumberEnv('MEMORY_GRAPH_RECALL_MAX_NODES', 12),
        graphRecallMaxDepth: readNumberEnv('MEMORY_GRAPH_RECALL_MAX_DEPTH', 2),
        flushEnabled: readBooleanEnv('MEMORY_FLUSH_ENABLED', true),
        flushSoftThresholdTokens: Math.max(200, readNumberEnv('MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS', 4000)),
        autoWriteCommandRounds: readBooleanEnv('MEMORY_AUTO_WRITE_COMMAND_ROUNDS', true),
        autoWriteAutonomousRounds: readBooleanEnv('MEMORY_AUTO_WRITE_AUTONOMOUS_ROUNDS', false)
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
    taskGraph: {
        clearOnStartup: readBooleanEnv('TASK_GRAPH_CLEAR_ON_STARTUP', true),
        clearOnExit: readBooleanEnv('TASK_GRAPH_CLEAR_ON_EXIT', true)
    },
    debug: {
        uiPerf: readBooleanEnv('UI_PERF_DEBUG', false),
        uiPerfSlowMs: readNumberEnv('UI_PERF_SLOW_MS', 32)
    }
};

