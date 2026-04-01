/* 主要职责：集中定义 runtime 类工具并导出 createRuntimeTools。 */
const { getToolDescriptionConfig } = require('../../config/toolDescriptionConfig');

function createDetect({ getRuntimeAdapters }) {
    const descriptionConfig = getToolDescriptionConfig('detect');
    return {
        subagentEnabled: false,
        definition: {
            type: 'function',
            function: {
                name: 'detect',
                description: descriptionConfig.description,
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
    const descriptionConfig = getToolDescriptionConfig('look');
    return {
        subagentEnabled: false,
        definition: {
            type: 'function',
            function: {
                name: 'look',
                description: descriptionConfig.description,
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
    const descriptionConfig = getToolDescriptionConfig('speak');
    return {
        subagentEnabled: false,
        definition: {
            type: 'function',
            function: {
                name: 'speak',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: descriptionConfig.parameters?.text?.description || ''
                        },
                        motion: {
                            type: 'string',
                            description: descriptionConfig.parameters?.motion?.description || ''
                        },
                        expression: {
                            type: 'string',
                            description: descriptionConfig.parameters?.expression?.description || ''
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
    const descriptionConfig = getToolDescriptionConfig('sleep');
    return {
        subagentEnabled: false,
        definition: {
            type: 'function',
            function: {
                name: 'sleep',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        seconds: {
                            type: 'number',
                            description: descriptionConfig.parameters?.seconds?.description || ''
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

function createListen({ getRuntimeAdapters }) {
    const descriptionConfig = getToolDescriptionConfig('listen');
    return {
        subagentEnabled: false,
        definition: {
            type: 'function',
            function: {
                name: 'listen',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        seconds: {
                            type: 'number',
                            description: descriptionConfig.parameters?.seconds?.description || ''
                        }
                    },
                    required: []
                }
            }
        },
        execute: async (argumentsObject = {}) => {
            const adapters = getRuntimeAdapters();
            if (typeof adapters.listen !== 'function') {
                throw new Error('Listen adapter is not configured');
            }
            return adapters.listen(argumentsObject);
        }
    };
}

function createRuntimeTools(dependencies) {
    return [
        createDetect(dependencies),
        createLook(dependencies),
        createSpeak(dependencies),
        createSleep(dependencies),
        createListen(dependencies)
    ];
}

module.exports = {
    createRuntimeTools
};
