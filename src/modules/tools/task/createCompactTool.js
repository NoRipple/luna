/* 主要职责：定义 compact 工具。 */
const { getToolDescriptionConfig } = require('../../../config/toolDescriptionConfig');

function createCompactTool({ getRuntimeAdapters }) {
    const descriptionConfig = getToolDescriptionConfig('compact');
    return {
        subagentEnabled: false,
        timeline: {
            enabled: true,
            kind: 'compact'
        },
        definition: {
            type: 'function',
            function: {
                name: 'compact',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        focus: {
                            type: 'string',
                            description: descriptionConfig.parameters?.focus?.description || ''
                        }
                    },
                    required: []
                }
            }
        },
        execute: async (argumentsObject = {}) => {
            const adapters = getRuntimeAdapters();
            const focus = String(argumentsObject.focus || '').trim();
            if (typeof adapters.compact === 'function') {
                return adapters.compact({ focus });
            }
            return {
                requested: true,
                mode: 'summary',
                focus
            };
        }
    };
}

module.exports = createCompactTool;
