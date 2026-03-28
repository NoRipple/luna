/* 主要职责：集中缓存面板页面所需的 DOM 引用，避免渲染逻辑分散查询节点。 */
export function createPanelDom() {
    return {
        historyEl: document.getElementById('chat-history'),
        chatInputEl: document.getElementById('chat-input'),
        sendButtonEl: document.getElementById('chat-send'),
        chatViewToggleEl: document.getElementById('chat-view-toggle'),
        chatStatusMetaEl: document.getElementById('chat-status-meta'),
        composerRuntimeEl: document.getElementById('composer-runtime'),
        conversationMetaEl: document.getElementById('conversation-meta'),
        traceDurationEl: document.getElementById('trace-duration'),
        timelineLanesEl: document.getElementById('timeline-lanes'),
        stateSessionLabelEl: document.getElementById('state-session-label'),
        stateRuntimeLabelEl: document.getElementById('state-runtime-label'),
        stateSessionValueEl: document.getElementById('state-session-value'),
        stateRuntimeValueEl: document.getElementById('state-runtime-value'),
        stateWakeValueEl: document.getElementById('state-wake-value'),
        stateProgressFillEl: document.getElementById('state-progress-fill'),
        perceptionTimeEl: document.getElementById('perception-live-time'),
        perceptionListEl: document.getElementById('ai-perception-list'),
        memorySummaryEl: document.getElementById('memory-summary'),
        memoryCountsEl: document.getElementById('memory-counts'),
        errorLogEl: document.getElementById('error-log')
    };
}
