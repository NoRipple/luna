/* 主要职责：负责面板中的会话流、状态文案与感知列表渲染。 */
import { escapeHtml, formatDateTime, formatTime, summarizeText } from './formatters.js';

const RAW_FOLDABLE_TAGS = new Set([
    'Context',
    'LongTermSummary',
    'LongTermMemory',
    'RecentMemoryLogs',
    'RetrievedMemories',
    'RecentStateTrajectory',
    'CurrentState',
    'UserCommand',
    'reminder'
]);
const RAW_FOLDABLE_TAGS_LOWER = new Set(
    Array.from(RAW_FOLDABLE_TAGS.values()).map((tag) => String(tag).toLowerCase())
);
const RAW_OMIT_CONTAINER_TAGS = new Set(['context']);
const panelRenderCacheStore = new WeakMap();

function mapStatusMeta(state) {
    const statusText = state?.status?.text || '空闲';
    const queueLength = state?.status?.queueLength || 0;
    const subagentRunning = Number(state?.subagent?.running || 0);
    const subagentLimit = Number(state?.subagent?.limit || 0);
    const queueText = queueLength > 0 ? `队列 ${queueLength}` : '';
    const subagentText = subagentLimit > 0 ? `子Agent ${subagentRunning}/${subagentLimit}` : '';
    return [statusText, queueText, subagentText].filter(Boolean).join(' · ');
}

function buildRuntimeDetail(state) {
    if (state?.panelNote) {
        return state.panelNote;
    }
    const realtime = state?.realtimePerception || {};
    if (realtime.status === 'running') {
        return `正在感知：${realtime.summary || '处理中'}`;
    }
    return '等待新的命令或自主轮次。';
}

function setTextIfChanged(el, value) {
    if (!el) return;
    const next = String(value ?? '');
    if (el.textContent !== next) {
        el.textContent = next;
    }
}

function ensurePanelRenderCache(dom) {
    const existing = panelRenderCacheStore.get(dom);
    if (existing) return existing;
    const next = {
        historyHtml: '',
        perceptionHtml: ''
    };
    panelRenderCacheStore.set(dom, next);
    return next;
}

function renderEmptyMessage(mode = 'user') {
    const text = mode === 'raw'
        ? '真实视野当前没有可展示的原始 messages。'
        : '当前还没有对话记录，新的命令会从这里开始。';
    return `
        <article class="chat-message agent">
            <div class="message-row">
                <div class="message-avatar">AI</div>
                <div class="message-bubble">${text}</div>
            </div>
            <div class="message-time">--:--</div>
        </article>
    `;
}

function renderMessage(item) {
    const role = item.role === 'assistant' ? 'assistant' : 'user';
    const kind = String(item.kind || (role === 'assistant' ? 'speak' : 'command'));
    const messageText = summarizeText(String(item.text || '').trim(), 800) || '（空）';
    const messageTime = item.createdAt || item.updatedAt;
    const body = escapeHtml(messageText).replace(/\n/g, '<br>');
    const avatar = role === 'assistant' ? 'AI' : '你';
    const cssRole = role === 'assistant' ? 'agent' : 'user';
    const kindLabel = kind === 'speak'
        ? '回复'
        : (kind === 'command' ? '命令' : kind);

    return `
        <article class="chat-message ${cssRole}" data-kind="${escapeHtml(kind)}">
            <div class="message-row">
                <div class="message-avatar">${avatar}</div>
                <div class="message-bubble">${body}</div>
            </div>
            <div class="message-time">${formatTime(messageTime)} · ${kindLabel}</div>
        </article>
    `;
}

function extractTagPreview(text, maxLength = 72) {
    const normalized = String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return summarizeText(normalized, maxLength);
}

function normalizeRawMessageSegments(item = {}) {
    const segments = [];
    const pushSegment = (kind, label, text) => {
        const normalizedText = String(text ?? '');
        if (!normalizedText.trim()) return;
        segments.push({
            kind,
            label,
            text: normalizedText
        });
    };

    const content = item.content;
    if (typeof content === 'string') {
        pushSegment('content', 'content', content);
    } else if (Array.isArray(content)) {
        content.forEach((part) => {
            if (!part || typeof part !== 'object') return;
            if (part.type === 'text') {
                pushSegment('content', 'content', String(part.text || ''));
                return;
            }
            if (part.type === 'image_url') {
                const imageUrl = typeof part.image_url?.url === 'string' ? part.image_url.url : '';
                pushSegment('image', 'image_url', imageUrl ? `[image_url] ${imageUrl}` : '[image_url]');
                return;
            }
            try {
                pushSegment('part', 'part', JSON.stringify(part, null, 2));
            } catch (error) {
                pushSegment('part', 'part', String(part));
            }
        });
    } else if (content && typeof content === 'object') {
        try {
            pushSegment('content', 'content', JSON.stringify(content, null, 2));
        } catch (error) {
            pushSegment('content', 'content', String(content));
        }
    } else if (content !== undefined && content !== null) {
        pushSegment('content', 'content', String(content));
    }

    if (item.tool_call_id) {
        pushSegment('tool_call_id', 'tool_call_id', String(item.tool_call_id));
    }

    if (Array.isArray(item.tool_calls) && item.tool_calls.length) {
        try {
            pushSegment('tool_calls', 'tool_calls', JSON.stringify(item.tool_calls, null, 2));
        } catch (error) {
            pushSegment('tool_calls', 'tool_calls', '[tool_calls]');
        }
    }

    if (segments.length === 0) {
        pushSegment('content', 'content', '（空）');
    }
    return segments;
}

function renderRawProseBlock(text) {
    const raw = String(text || '');
    if (!raw.trim()) return '';
    return `<div class="raw-prose-block">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
}

function renderRawTextBlock(text) {
    const raw = String(text || '');
    if (!raw.trim()) return '';
    const codeFencePattern = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    let html = '';
    let cursor = 0;
    let foundCodeFence = false;
    let match = codeFencePattern.exec(raw);
    while (match) {
        foundCodeFence = true;
        const matchStart = Number(match.index || 0);
        const matchEnd = matchStart + match[0].length;
        html += renderRawProseBlock(raw.slice(cursor, matchStart));
        const language = String(match[1] || '').trim() || 'text';
        const code = String(match[2] || '');
        html += `
            <figure class="raw-code-block">
                <figcaption>${escapeHtml(language)}</figcaption>
                <pre class="raw-code-pre"><code>${escapeHtml(code)}</code></pre>
            </figure>
        `;
        cursor = matchEnd;
        match = codeFencePattern.exec(raw);
    }
    html += renderRawProseBlock(raw.slice(cursor));
    if (!foundCodeFence) {
        return `<pre class="raw-text-block">${escapeHtml(raw)}</pre>`;
    }
    return html;
}

function renderRawSegment(segment, showLabel = true) {
    if (!segment) return '';
    const bodyHtml = renderTaggedContent(segment.text);
    if (segment.kind === 'tool_calls') {
        return `
            <details class="raw-toolcalls-fold">
                <summary class="raw-segment-summary">
                    <span>tool_calls</span>
                    <span>${escapeHtml(summarizeText(segment.text, 56) || '')}</span>
                </summary>
                <div class="raw-toolcalls-content">${bodyHtml}</div>
            </details>
        `;
    }

    if (segment.kind === 'tool_call_id') {
        return `<div class="raw-inline-meta">tool_call_id: ${escapeHtml(segment.text)}</div>`;
    }

    const labelHtml = showLabel
        ? `<span class="raw-inline-label">${escapeHtml(segment.label || segment.kind || 'segment')}</span>`
        : '';
    return `
        <section class="raw-segment-compact">
            ${labelHtml}
            <div class="raw-segment-compact-body">${bodyHtml}</div>
        </section>
    `;
}

function renderTaggedContent(rawText, depth = 0) {
    const text = String(rawText || '');
    const tagPattern = /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let cursor = 0;
    let output = '';
    let hasMatch = false;
    let match = tagPattern.exec(text);
    while (match) {
        const matchStart = Number(match.index || 0);
        const matchEnd = matchStart + match[0].length;
        const plainSegment = text.slice(cursor, matchStart);
        output += renderRawTextBlock(plainSegment);

        const tagName = String(match[1] || 'tag');
        const normalizedTagName = tagName.trim();
        const isFoldableTag = RAW_FOLDABLE_TAGS.has(normalizedTagName)
            || RAW_FOLDABLE_TAGS_LOWER.has(normalizedTagName.toLowerCase());
        if (!isFoldableTag) {
            output += renderRawTextBlock(text.slice(matchStart, matchEnd));
            cursor = matchEnd;
            match = tagPattern.exec(text);
            continue;
        }
        const innerText = String(match[2] || '');
        const foldedBody = depth < 4
            ? renderTaggedContent(innerText, depth + 1)
            : renderRawTextBlock(innerText);
        const preview = extractTagPreview(innerText, 72);
        const shouldOmitContainer = depth === 0 && RAW_OMIT_CONTAINER_TAGS.has(normalizedTagName.toLowerCase());
        if (shouldOmitContainer) {
            output += foldedBody || renderRawTextBlock(innerText);
            cursor = matchEnd;
            hasMatch = true;
            match = tagPattern.exec(text);
            continue;
        }
        output += `
            <details class="tag-fold">
                <summary class="tag-fold-summary">
                    <span class="tag-fold-name">&lt;${escapeHtml(normalizedTagName)}&gt;</span>
                    ${preview ? `<span class="tag-fold-preview">${escapeHtml(preview)}</span>` : ''}
                </summary>
                <div class="tag-fold-body">${foldedBody || renderRawTextBlock(innerText)}</div>
            </details>
        `;

        cursor = matchEnd;
        hasMatch = true;
        match = tagPattern.exec(text);
    }

    output += renderRawTextBlock(text.slice(cursor));
    if (!hasMatch && !output) {
        return renderRawTextBlock(text);
    }
    return output || renderRawTextBlock(text);
}

function renderRawMessage(item, index) {
    const role = String(item?.role || 'unknown');
    const roleToken = role.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unknown';
    const cssRole = 'agent';
    const segments = normalizeRawMessageSegments(item);
    const segmentHtml = segments
        .map((segment) => renderRawSegment(segment, segment.kind !== 'content' || segments.length > 1))
        .join('');
    const toolCallCount = Array.isArray(item?.tool_calls) ? item.tool_calls.length : 0;

    return `
        <article class="chat-message ${cssRole} raw-message raw-role-${roleToken}">
            <div class="raw-message-shell">
                <div class="raw-message-head">
                    <span class="raw-index">#${Number(index) + 1}</span>
                    <span class="raw-role-pill">${escapeHtml(role)}</span>
                    ${toolCallCount > 0 ? `<span class="raw-role-pill muted">tool_calls ${toolCallCount}</span>` : ''}
                </div>
                <div class="raw-message-body">${segmentHtml}</div>
            </div>
        </article>
    `;
}

function renderPerceptionItem(item) {
    return `
        <li class="perception-item">
            <div class="perception-item-top">
                <strong class="perception-item-time">${formatTime(item.updatedAt)}</strong>
                <span class="perception-item-state">${escapeHtml(item.status || 'done')}</span>
            </div>
            <div>${escapeHtml(item.summary || '暂无摘要')}</div>
            <div class="perception-item-detail">${escapeHtml(summarizeText(item.detail || '', 96) || '暂无详情')}</div>
        </li>
    `;
}

export function renderPanelState(dom, state, options = {}) {
    const chatViewMode = options?.chatViewMode === 'raw' ? 'raw' : 'user';
    const userFacingRecords = Array.isArray(state?.chatRecords)
        ? state.chatRecords.filter((item) => {
            if (!item || typeof item !== 'object') return false;
            const role = String(item.role || '');
            const kind = String(item.kind || '');
            // User-facing conversation model:
            // - user command messages
            // - assistant spoken outputs (from speak tool / fallback)
            return (
                (role === 'user' && kind === 'command') ||
                (role === 'assistant' && kind === 'speak')
            );
        })
        : [];
    const rawMessages = Array.isArray(state?.rawMessages) ? state.rawMessages : [];
    const recentPerceptions = Array.isArray(state?.recentPerceptions) && state.recentPerceptions.length
        ? state.recentPerceptions.slice().reverse()
        : [{
            status: state?.realtimePerception?.status || 'idle',
            summary: state?.realtimePerception?.summary || '暂无感知结果',
            detail: state?.realtimePerception?.detail || '',
            updatedAt: state?.realtimePerception?.updatedAt || null
        }];
    const timeline = Array.isArray(state?.timeline) ? state.timeline : [];
    const runtimeDetail = buildRuntimeDetail(state);
    const runtimeDetailForState = summarizeText(runtimeDetail, 38) || runtimeDetail;
    const sessionStatus = state?.status?.text || '空闲';
    const wakeText = formatDateTime(state?.autonomousWakeAt);
    const renderCache = ensurePanelRenderCache(dom);
    const visibleMessageCount = chatViewMode === 'raw'
        ? rawMessages.length
        : userFacingRecords.length;

    setTextIfChanged(dom.chatStatusMetaEl, mapStatusMeta(state));
    setTextIfChanged(dom.composerRuntimeEl, summarizeText(runtimeDetail, 68) || runtimeDetail);
    setTextIfChanged(
        dom.conversationMetaEl,
        chatViewMode === 'raw'
            ? `真实视野 · ${visibleMessageCount} 条原始消息`
            : `${visibleMessageCount} 条消息`
    );
    setTextIfChanged(dom.stateSessionLabelEl, sessionStatus);
    setTextIfChanged(dom.stateRuntimeLabelEl, runtimeDetailForState);
    setTextIfChanged(dom.stateSessionValueEl, sessionStatus);
    setTextIfChanged(dom.stateRuntimeValueEl, runtimeDetailForState);
    setTextIfChanged(dom.stateWakeValueEl, wakeText);
    setTextIfChanged(dom.perceptionTimeEl, formatTime(recentPerceptions[0]?.updatedAt));
    setTextIfChanged(dom.traceDurationEl, `${timeline.length} 条记录`);
    setTextIfChanged(dom.memorySummaryEl, summarizeText(runtimeDetail, 66) || runtimeDetail);
    setTextIfChanged(dom.memoryCountsEl, `最近感知 ${recentPerceptions.length} · 行为事件 ${timeline.length}`);
    const progressWidth = `${Math.min(100, 48 + (state?.status?.queueLength || 0) * 10)}%`;
    if (dom.stateProgressFillEl && dom.stateProgressFillEl.style.width !== progressWidth) {
        dom.stateProgressFillEl.style.width = progressWidth;
    }

    const shouldStickToBottom = (
        dom.historyEl.scrollHeight - dom.historyEl.scrollTop - dom.historyEl.clientHeight
    ) <= 24;
    if (dom.historyEl) {
        dom.historyEl.dataset.view = chatViewMode;
    }

    const historyHtml = chatViewMode === 'raw'
        ? (
            rawMessages.length
                ? rawMessages.map(renderRawMessage).join('')
                : renderEmptyMessage('raw')
        )
        : (userFacingRecords.length ? userFacingRecords.map(renderMessage).join('') : renderEmptyMessage('user'));
    if (renderCache.historyHtml !== historyHtml) {
        dom.historyEl.innerHTML = historyHtml;
        renderCache.historyHtml = historyHtml;
        if (shouldStickToBottom) {
            dom.historyEl.scrollTop = dom.historyEl.scrollHeight;
        }
    }

    const perceptionHtml = recentPerceptions.map(renderPerceptionItem).join('');
    if (renderCache.perceptionHtml !== perceptionHtml) {
        dom.perceptionListEl.innerHTML = perceptionHtml;
        renderCache.perceptionHtml = perceptionHtml;
    }
}
