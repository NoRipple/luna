/* 主要职责：定义 task 子 Agent 委派工具。 */
const { getToolDescriptionConfig } = require('../../../config/toolDescriptionConfig');

function createTaskDelegationTool({ getRuntimeAdapters }) {
    const descriptionConfig = getToolDescriptionConfig('task');
    return {
        subagentEnabled: false,
        timeline: {
            enabled: false
        },
        definition: {
            type: 'function',
            function: {
                name: 'task',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        prompt: {
                            type: 'string',
                            description: descriptionConfig.parameters?.prompt?.description || ''
                        },
                        description: {
                            type: 'string',
                            description: descriptionConfig.parameters?.description?.description || ''
                        },
                        wait: {
                            type: 'boolean',
                            description: descriptionConfig.parameters?.wait?.description || ''
                        }
                    },
                    required: ['prompt']
                }
            }
        },
        execute: async (argumentsObject = {}) => {
            const adapters = getRuntimeAdapters();
            if (typeof adapters.task !== 'function') {
                throw new Error('task adapter is not configured');
            }
            return adapters.task(argumentsObject);
        }
    };
}

module.exports = createTaskDelegationTool;
