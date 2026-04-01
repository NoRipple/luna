/* 主要职责：定义 todo 工具。 */
const { getToolDescriptionConfig } = require('../../../config/toolDescriptionConfig');

function createTodoTool({ todoManager }) {
    const descriptionConfig = getToolDescriptionConfig('todo');
    return {
        timeline: {
            enabled: false
        },
        definition: {
            type: 'function',
            function: {
                name: 'todo',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        items: {
                            type: 'array',
                            description: descriptionConfig.parameters?.items?.description || '',
                            items: {
                                type: 'object',
                                properties: {
                                    id: {
                                        type: 'string',
                                        description: descriptionConfig.parameters?.items?.items?.properties?.id?.description || ''
                                    },
                                    text: {
                                        type: 'string',
                                        description: descriptionConfig.parameters?.items?.items?.properties?.text?.description || ''
                                    },
                                    status: {
                                        type: 'string',
                                        enum: ['pending', 'in_progress', 'completed'],
                                        description: descriptionConfig.parameters?.items?.items?.properties?.status?.description || ''
                                    }
                                },
                                required: ['id', 'text', 'status']
                            }
                        }
                    },
                    required: ['items']
                }
            }
        },
        execute: (argumentsObject = {}) => {
            return {
                board: todoManager.update(argumentsObject.items || []),
                state: todoManager.getState()
            };
        }
    };
}

module.exports = createTodoTool;
