class CompanionMemory {
    constructor() {
        this.maxSessionMessages = 20;
        this.maxRecentAnalyses = 8;
        this.summaryEveryRounds = 10;

        this.recentAnalyses = [];
        this.longTermSummary = '';
        this.summarySourceBuffer = [];
        this.companionRoundCount = 0;
    }

    trimSession(messages, keepHeadCount = 0) {
        const overflow = messages.length - this.maxSessionMessages;
        if (overflow <= 0) return;
        messages.splice(keepHeadCount, overflow);
    }

    buildGlobalContext(currentInput, options = {}) {
        const inputType = options.inputType === 'command' ? 'command' : 'perception';
        const historyLines = this.recentAnalyses.map((item, idx) => `${idx + 1}. ${item}`);
        const recentTrajectory = historyLines.length ? historyLines.join('\n') : '- （暂无）';
        const normalizedInput = String(currentInput || '').trim() || '（空）';

        const currentBlock =
            inputType === 'command'
                ? ['<UserCommand>', normalizedInput, '</UserCommand>']
                : ['<CurrentState>', normalizedInput, '</CurrentState>'];

        return [
            '<Context>',
            '<LongTermSummary>',
            this.longTermSummary || '（暂无）',
            '</LongTermSummary>',
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
        this.summarySourceBuffer.push(trajectoryItem);
        this.companionRoundCount += 1;
    }

    shouldRefreshSummary() {
        return this.companionRoundCount % this.summaryEveryRounds === 0
            && this.summarySourceBuffer.length >= this.summaryEveryRounds;
    }

    buildSummaryPrompt() {
        const lines = this.summarySourceBuffer.map((item, idx) => `${idx + 1}. ${item}`);
        return [
            '你是会话摘要器。请将“历史摘要 + 新的10轮状态”压缩为新的长期摘要。',
            '要求：',
            '1. 只输出纯文本，不要 Markdown，不要 JSON。',
            '2. 长度控制在 120~220 字。',
            '3. 保留稳定偏好、近期主任务、情绪趋势与节奏变化。',
            '',
            `历史摘要：${this.longTermSummary || '（暂无）'}`,
            '',
            '新的10轮状态：',
            ...lines
        ].join('\n');
    }

    applySummary(summaryText) {
        if (summaryText) this.longTermSummary = summaryText;
        this.summarySourceBuffer = [];
    }

    compactSessionAfterSummary(messages, keepHeadCount = 1, keepRecentMessages = 6) {
        if (!Array.isArray(messages)) return;
        if (messages.length <= keepHeadCount + keepRecentMessages) return;

        const head = messages.slice(0, keepHeadCount);
        const tail = messages.slice(-keepRecentMessages);
        messages.splice(0, messages.length, ...head, ...tail);
    }
}

module.exports = CompanionMemory;
