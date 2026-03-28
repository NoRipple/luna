/* 主要职责：集中定义 task 类工具并导出 createTaskTools。 */
function createTodo({ todoManager }) {
    return {
        timeline: {
            enabled: false
        },
        definition: {
            type: 'function',
            function: {
                name: 'todo',
                description: '更新当前执行计划。适合多步命令任务，状态仅允许 pending、in_progress、completed。',
                parameters: {
                    type: 'object',
                    properties: {
                        items: {
                            type: 'array',
                            description: '完整的待办列表。',
                            items: {
                                type: 'object',
                                properties: {
                                    id: {
                                        type: 'string',
                                        description: '待办项标识符。'
                                    },
                                    text: {
                                        type: 'string',
                                        description: '待办项描述。'
                                    },
                                    status: {
                                        type: 'string',
                                        enum: ['pending', 'in_progress', 'completed'],
                                        description: '待办项状态。'
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

function createTaskTools(dependencies) {
    return [
        createTodo(dependencies)
    ];
}

module.exports = {
    createTaskTools
};
