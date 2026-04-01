/* 主要职责：定义记忆工具（memory_search / memory_get / memory_append_log / memory_store）。 */
const { getToolDescriptionConfig } = require('../../config/toolDescriptionConfig');

function createMemorySearchTool({ memorySearchService, memoryEnabled }) {
    const descriptionConfig = getToolDescriptionConfig('memory_search');
    return {
        subagentEnabled: true,
        definition: {
            type: 'function',
            function: {
                name: 'memory_search',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: descriptionConfig.parameters?.query?.description || ''
                        },
                        max_results: {
                            type: 'integer',
                            description: descriptionConfig.parameters?.max_results?.description || ''
                        }
                    },
                    required: ['query']
                }
            }
        },
        execute: async (argumentsObject = {}) => {
            if (!memoryEnabled) {
                return {
                    results: [],
                    reason: 'memory_disabled'
                };
            }
            const query = String(argumentsObject.query || '').trim();
            if (!query) {
                return { results: [] };
            }
            const results = await memorySearchService.search({
                query,
                max_results: argumentsObject.max_results
            });
            return { results };
        }
    };
}

function createMemoryGetTool({ memoryStoreService, memoryEnabled }) {
    const descriptionConfig = getToolDescriptionConfig('memory_get');
    return {
        subagentEnabled: true,
        definition: {
            type: 'function',
            function: {
                name: 'memory_get',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: descriptionConfig.parameters?.path?.description || ''
                        },
                        start_line: {
                            type: 'integer',
                            description: descriptionConfig.parameters?.start_line?.description || ''
                        },
                        limit_lines: {
                            type: 'integer',
                            description: descriptionConfig.parameters?.limit_lines?.description || ''
                        }
                    },
                    required: ['path']
                }
            }
        },
        execute: async (argumentsObject = {}) => {
            if (!memoryEnabled) {
                return {
                    path: String(argumentsObject.path || ''),
                    content: '',
                    start_line: Number(argumentsObject.start_line || 1) || 1,
                    line_count: 0,
                    reason: 'memory_disabled'
                };
            }
            return memoryStoreService.memoryGet({
                path: argumentsObject.path,
                startLine: argumentsObject.start_line,
                limitLines: argumentsObject.limit_lines
            });
        }
    };
}

function createMemoryAppendLogTool({ memoryStoreService, memoryEnabled }) {
    const descriptionConfig = getToolDescriptionConfig('memory_append_log');
    return {
        subagentEnabled: false,
        definition: {
            type: 'function',
            function: {
                name: 'memory_append_log',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        content: {
                            type: 'string',
                            description: descriptionConfig.parameters?.content?.description || ''
                        },
                        source: {
                            type: 'string',
                            description: descriptionConfig.parameters?.source?.description || ''
                        }
                    },
                    required: ['content']
                }
            }
        },
        execute: async (argumentsObject = {}) => {
            if (!memoryEnabled) {
                return {
                    ok: false,
                    tier: 'daily',
                    path: '',
                    appended: false,
                    deduped: false,
                    reason: 'memory_disabled'
                };
            }
            return memoryStoreService.memory_append_log({
                content: argumentsObject.content,
                source: argumentsObject.source
            });
        }
    };
}

function createMemoryStoreTool({ memoryStoreService, memoryEnabled }) {
    const descriptionConfig = getToolDescriptionConfig('memory_store');
    return {
        subagentEnabled: false,
        definition: {
            type: 'function',
            function: {
                name: 'memory_store',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        content: {
                            type: 'string',
                            description: descriptionConfig.parameters?.content?.description || ''
                        },
                        source: {
                            type: 'string',
                            description: descriptionConfig.parameters?.source?.description || ''
                        }
                    },
                    required: ['content']
                }
            }
        },
        execute: async (argumentsObject = {}) => {
            if (!memoryEnabled) {
                return {
                    ok: false,
                    tier: 'longterm',
                    path: '',
                    appended: false,
                    deduped: false,
                    reason: 'memory_disabled'
                };
            }
            return memoryStoreService.memory_store({
                content: argumentsObject.content,
                source: argumentsObject.source
            });
        }
    };
}

function createMemoryTools(dependencies = {}) {
    const memoryEnabled = dependencies.memoryEnabled !== false;
    return [
        createMemorySearchTool({
            memorySearchService: dependencies.memorySearchService,
            memoryEnabled
        }),
        createMemoryGetTool({
            memoryStoreService: dependencies.memoryStoreService,
            memoryEnabled
        }),
        createMemoryAppendLogTool({
            memoryStoreService: dependencies.memoryStoreService,
            memoryEnabled
        }),
        createMemoryStoreTool({
            memoryStoreService: dependencies.memoryStoreService,
            memoryEnabled
        })
    ];
}

module.exports = {
    createMemoryTools
};
