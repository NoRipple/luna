/* 主要职责：定义任务图工具（task_create/update/list/get）。 */
const { getToolDescriptionConfig } = require('../../../config/toolDescriptionConfig');

function createTaskCreateTool({ taskGraphManager }) {
    const descriptionConfig = getToolDescriptionConfig('task_create');
    return {
        definition: {
            type: 'function',
            function: {
                name: 'task_create',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        subject: {
                            type: 'string',
                            description: descriptionConfig.parameters?.subject?.description || ''
                        },
                        description: {
                            type: 'string',
                            description: descriptionConfig.parameters?.description?.description || ''
                        }
                    },
                    required: ['subject']
                }
            }
        },
        execute: (argumentsObject = {}) => {
            const task = taskGraphManager.create(argumentsObject.subject, argumentsObject.description);
            return {
                task,
                summary: `Created task #${task.id}: ${task.subject}`
            };
        }
    };
}

function createTaskUpdateTool({ taskGraphManager }) {
    const descriptionConfig = getToolDescriptionConfig('task_update');
    return {
        definition: {
            type: 'function',
            function: {
                name: 'task_update',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        task_id: {
                            type: 'integer',
                            description: descriptionConfig.parameters?.task_id?.description || ''
                        },
                        status: {
                            type: 'string',
                            enum: ['pending', 'in_progress', 'completed'],
                            description: descriptionConfig.parameters?.status?.description || ''
                        },
                        subject: {
                            type: 'string',
                            description: descriptionConfig.parameters?.subject?.description || ''
                        },
                        description: {
                            type: 'string',
                            description: descriptionConfig.parameters?.description?.description || ''
                        },
                        owner: {
                            type: 'string',
                            description: descriptionConfig.parameters?.owner?.description || ''
                        },
                        add_blocked_by: {
                            type: 'array',
                            items: { type: 'integer' },
                            description: descriptionConfig.parameters?.add_blocked_by?.description || ''
                        },
                        add_blocks: {
                            type: 'array',
                            items: { type: 'integer' },
                            description: descriptionConfig.parameters?.add_blocks?.description || ''
                        }
                    },
                    required: ['task_id']
                }
            }
        },
        execute: (argumentsObject = {}) => {
            const task = taskGraphManager.update(argumentsObject.task_id, argumentsObject);
            return {
                task,
                summary: `Updated task #${task.id} (${task.status})`
            };
        }
    };
}

function createTaskListTool({ taskGraphManager }) {
    const descriptionConfig = getToolDescriptionConfig('task_list');
    return {
        definition: {
            type: 'function',
            function: {
                name: 'task_list',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            }
        },
        execute: () => taskGraphManager.listSummary()
    };
}

function createTaskGetTool({ taskGraphManager }) {
    const descriptionConfig = getToolDescriptionConfig('task_get');
    return {
        definition: {
            type: 'function',
            function: {
                name: 'task_get',
                description: descriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        task_id: {
                            type: 'integer',
                            description: descriptionConfig.parameters?.task_id?.description || ''
                        }
                    },
                    required: ['task_id']
                }
            }
        },
        execute: (argumentsObject = {}) => taskGraphManager.get(argumentsObject.task_id)
    };
}

module.exports = {
    createTaskCreateTool,
    createTaskUpdateTool,
    createTaskListTool,
    createTaskGetTool
};
