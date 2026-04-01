/* 主要职责：从提示词素材文件组装陪伴 Agent 的系统提示词，并注入占位符结构。 */
const fs = require('fs');
const path = require('path');

const LIVE2D_CONSTRAINTS_PLACEHOLDER = '{{LIVE2D_CONSTRAINTS}}';
const SKILL_DESCRIPTION_PLACEHOLDER = '{{skillDescription}}';
const TOOL_DESCRIPTION_PLACEHOLDER = '{{toolDescription}}';

function readPromptFile(baseDir, fileName) {
    const filePath = path.join(baseDir, fileName);
    try {
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch (error) {
        console.warn(`Companion prompt file missing or unreadable: ${filePath}`);
        return '';
    }
}

function buildCompanionSystemPrompt(baseDir) {
    const agents = readPromptFile(baseDir, 'AGENTS.md');
    const identity = readPromptFile(baseDir, 'IDENTITY.md');
    const user = readPromptFile(baseDir, 'USER.md');

    return [
        '# AGENTS',
        agents,
        '',
        '# IDENTITY',
        identity,
        '',
        '# USER',
        user,
        '',
        '全局一致性要求：',
        '1. 回答不仅参考当前状态，还要参考最近多轮状态轨迹。',
        '2. 若用户状态未明显变化，语气与关注点应保持连续，避免每轮都像重新开始。',
        '3. 若用户状态明显切换（如从编码到视频/游戏），再自然切换话题与关怀重点。',
        '',
        'JSON 格式示例：',
        '{',
        '  "text": "",',
        '  "motion": "TapHead",',
        '  "expression": "exp1.exp3"',
        '}'
    ].join('\n');
}

module.exports = {
    buildCompanionSystemPrompt,
    LIVE2D_CONSTRAINTS_PLACEHOLDER,
    SKILL_DESCRIPTION_PLACEHOLDER,
    TOOL_DESCRIPTION_PLACEHOLDER
};

