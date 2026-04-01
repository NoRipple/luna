/* 主要职责：装配记忆存储与检索单例。 */
const config = require('../../config/runtimeConfig');
const MemoryStoreService = require('./MemoryStoreService');
const MemorySearchService = require('./MemorySearchService');
const MemoryPipelineOrchestrator = require('./MemoryPipelineOrchestrator');
const GraphMemoryService = require('./GraphMemoryService');

const memoryStoreService = new MemoryStoreService({
    enabled: config.memory?.enabled !== false,
    workspaceDir: config.memory?.workspaceDir || config.projectRoot
});

const memorySearchService = new MemorySearchService({
    memoryStoreService,
    enabled: config.memory?.enabled !== false && config.memory?.searchEnabled !== false,
    workspaceDir: config.memory?.workspaceDir || config.projectRoot,
    targetTokens: config.memory?.searchChunkTargetTokens || 400,
    overlapTokens: config.memory?.searchChunkOverlapTokens || 80,
    debounceMs: config.memory?.searchWatchDebounceMs || 1500,
    provider: config.memory?.embeddingProvider || 'local_transformers',
    model: config.memory?.embeddingModel || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    vectorWeight: config.memory?.hybridVectorWeight || 0.7,
    textWeight: config.memory?.hybridTextWeight || 0.3,
    maxResults: config.memory?.searchMaxResults || 5,
    extraPaths: config.memory?.searchExtraPaths || []
});

const graphMemoryService = new GraphMemoryService({
    memoryStoreService,
    dbPath: config.memory?.graphDbPath
        || pathJoinSafe(config.memory?.workspaceDir || config.projectRoot, '.memory-graph/graph-memory.db'),
    dedupThreshold: Number(config.memory?.graphDedupThreshold || 0.9),
    pagerankDamping: Number(config.memory?.graphPagerankDamping || 0.85),
    pagerankIterations: Number(config.memory?.graphPagerankIterations || 20),
    recallMaxNodes: Number(config.memory?.graphRecallMaxNodes || 12),
    recallMaxDepth: Number(config.memory?.graphRecallMaxDepth || 2)
});

function pathJoinSafe(basePath, relativePath) {
    const path = require('path');
    return path.resolve(String(basePath || process.cwd()), String(relativePath || ''));
}

function createMemoryPipelineOrchestrator(dependencies = {}) {
    return new MemoryPipelineOrchestrator({
        ...dependencies,
        memoryStoreService,
        memorySearchService
    });
}

module.exports = {
    memoryStoreService,
    memorySearchService,
    graphMemoryService,
    createMemoryPipelineOrchestrator
};
