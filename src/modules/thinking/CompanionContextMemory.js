/* 主要职责：维护陪伴 Agent 的运行时上下文，负责近期轨迹与记忆块拼装。 */
class CompanionContextMemory {
    constructor(options = {}) {
        this.maxRecentAnalyses = Math.max(4, Number(options.maxRecentAnalyses) || 8);

        this.recentAnalyses = [];
        this.companionRoundCount = 0;
    }

    buildGlobalContext(currentInput, options = {}) {
        const inputType = options.inputType === 'command' ? 'command' : 'perception';
        const memorySnapshot = options.memorySnapshot && typeof options.memorySnapshot === 'object'
            ? options.memorySnapshot
            : {};
        const historyLines = this.recentAnalyses.map((item, idx) => `${idx + 1}. ${item}`);
        const recentTrajectory = historyLines.length ? historyLines.join('\n') : '- （暂无）';
        const longTermMemory = String(memorySnapshot.longTerm || '').trim() || '（暂无）';
        const recentMemoryLogs = String(memorySnapshot.recentDaily || '').trim() || '（暂无）';
        const retrievedMemories = String(memorySnapshot.retrieved || '').trim() || '（暂无）';
        const normalizedInput = String(currentInput || '').trim() || '（空）';

        const currentBlock =
            inputType === 'command'
                ? ['<UserCommand>', normalizedInput, '</UserCommand>']
                : ['<CurrentState>', normalizedInput, '</CurrentState>'];

        return [
            '<Context>',
            '<LongTermMemory>',
            longTermMemory,
            '</LongTermMemory>',
            '',
            '<RecentMemoryLogs>',
            recentMemoryLogs,
            '</RecentMemoryLogs>',
            '',
            '<RetrievedMemories>',
            retrievedMemories,
            '</RetrievedMemories>',
            '',
            '<RecentStateTrajectory order="oldToNew">',
            recentTrajectory,
            '</RecentStateTrajectory>',
            '',
            ...currentBlock,
            '</Context>'
        ].join('\n');
    }

    updateAfterRound(input, options = {}) {
        const inputType = options.inputType === 'command' ? 'command' : 'perception';
        const normalized = String(input || '').trim();
        const trajectoryItem =
            inputType === 'command'
                ? `用户命令：${normalized || '（空）'}`
                : `环境状态：${normalized || '（空）'}`;

        this.recentAnalyses.push(trajectoryItem);
        if (this.recentAnalyses.length > this.maxRecentAnalyses) {
            this.recentAnalyses.shift();
        }
        this.companionRoundCount += 1;
    }
}

module.exports = CompanionContextMemory;

