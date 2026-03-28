/* 主要职责：集中定义 runtime 类工具并导出 createRuntimeTools。 */
function createDetect({ getRuntimeAdapters }) {
    return {
        definition: {
            type: 'function',
            function: {
                name: 'detect',
                description: '获取当前环境状态摘要。该工具优先读取最近一次缓存状态，若缓存过期再执行截图与分析，适合常规状态感知。',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            }
        },
        execute: async () => {
            const adapters = getRuntimeAdapters();
            if (typeof adapters.detect !== 'function') {
                throw new Error('Detect adapter is not configured');
            }
            return adapters.detect();
        }
    };
}

function createLook({ getRuntimeAdapters }) {
    return {
        definition: {
            type: 'function',
            function: {
                name: 'look',
                description: '立即确认用户的最新屏幕状态。该工具会立刻截图并分析（绕过缓存），适合在关键时刻做实时复核。',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            }
        },
        execute: async () => {
            const adapters = getRuntimeAdapters();
            if (typeof adapters.look !== 'function') {
                throw new Error('Look adapter is not configured');
            }
            return adapters.look();
        }
    };
}

function createSpeak({ getRuntimeAdapters }) {
    return {
        definition: {
            type: 'function',
            function: {
                name: 'speak',
                description: '与用户交互。该工具会完成文字播报、TTS 和 Live2D 动作表达。',
                parameters: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: '要说的话。'
                        },
                        motion: {
                            type: 'string',
                            description: '可选动作名。'
                        },
                        expression: {
                            type: 'string',
                            description: '可选表情名。'
                        }
                    },
                    required: ['text']
                }
            }
        },
        execute: async (argumentsObject = {}) => {
            const adapters = getRuntimeAdapters();
            if (typeof adapters.speak !== 'function') {
                throw new Error('Speak adapter is not configured');
            }
            return adapters.speak(argumentsObject);
        }
    };
}

function createSleep({ getRuntimeAdapters }) {
    return {
        definition: {
            type: 'function',
            function: {
                name: 'sleep',
                description: '安排下一次自主苏醒时间，单位为秒。建议范围 5 到 60 秒。',
                parameters: {
                    type: 'object',
                    properties: {
                        seconds: {
                            type: 'number',
                            description: '希望休眠的秒数。建议在 5 到 60 之间。'
                        }
                    },
                    required: ['seconds']
                }
            }
        },
        execute: async (argumentsObject = {}) => {
            const adapters = getRuntimeAdapters();
            if (typeof adapters.sleep !== 'function') {
                throw new Error('Sleep adapter is not configured');
            }
            return adapters.sleep(argumentsObject);
        }
    };
}

function createRuntimeTools(dependencies) {
    return [
        createDetect(dependencies),
        createLook(dependencies),
        createSpeak(dependencies),
        createSleep(dependencies)
    ];
}

module.exports = {
    createRuntimeTools
};
