/* 主要职责：聚合 task 域工具工厂并导出 createTaskTools。 */
const createTodoTool = require('./createTodoTool');
const createTaskDelegationTool = require('./createTaskDelegationTool');
const { createLoadSkillTool } = require('./createSkillTools');
const {
    createTaskCreateTool,
    createTaskUpdateTool,
    createTaskListTool,
    createTaskGetTool
} = require('./createTaskGraphTools');
const createCompactTool = require('./createCompactTool');

function createTaskTools(dependencies) {
    return [
        createTodoTool(dependencies),
        createTaskDelegationTool(dependencies),
        createLoadSkillTool(dependencies),
        createTaskCreateTool(dependencies),
        createTaskUpdateTool(dependencies),
        createTaskListTool(dependencies),
        createTaskGetTool(dependencies),
        createCompactTool(dependencies)
    ];
}

module.exports = {
    createTaskTools
};
