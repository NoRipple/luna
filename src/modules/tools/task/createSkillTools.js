/* 主要职责：定义技能加载工具（load_skill）。 */
const { getToolDescriptionConfig } = require('../../../config/toolDescriptionConfig');

function createLoadSkillTool({ getSkillContent }) {
    const loadDescriptionConfig = getToolDescriptionConfig('load_skill');
    return {
        definition: {
            type: 'function',
            function: {
                name: 'load_skill',
                description: loadDescriptionConfig.description,
                parameters: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: loadDescriptionConfig.parameters?.name?.description || ''
                        }
                    },
                    required: ['name']
                }
            }
        },
        execute: (argumentsObject = {}) => {
            if (typeof getSkillContent !== 'function') {
                return 'Error: Skill service is not available.';
            }
            return getSkillContent(argumentsObject.name);
        }
    };
}

module.exports = {
    createLoadSkillTool
};
