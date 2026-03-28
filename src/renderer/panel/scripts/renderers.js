/* 主要职责：根据运行时状态生成对话流、感知列表和高性能单轨行为时间轴的 DOM 内容。 */
import { escapeHtml, formatDateTime, formatTime, summarizeText } from './formatters.js';

const TIMELINE_WINDOW_MS = 30 * 1000;
const TIMELINE_ACTIVE_BUFFER_MS = TIMELINE_WINDOW_MS + 10 * 1000;
const TIMELINE_CHANNEL_COUNT = 1;
const TIMELINE_MIN_VISIBLE_WIDTH = 1;
const TIMELINE_MAX_VISIBLE = 36;
const TIMELINE_TITLE_FONT = '700 12px "Segoe UI", "Microsoft YaHei UI", sans-serif';
const TIMELINE_META_FONT = '500 10px "Segoe UI", "Microsoft YaHei UI", sans-serif';
const TIMELINE_NODE_TEXT_GAP_PX = 4;
const TIMELINE_NODE_HORIZONTAL_PADDING_PX = 12;
const TIMELINE_NODE_BORDER_PX = 2;
const RAW_FOLDABLE_TAGS = new Set([
    'Context',
    'LongTermSummary',
    'RecentStateTrajectory',
    'CurrentState',
    'UserCommand',
    'reminder'
]);
const RAW_FOLDABLE_TAGS_LOWER = new Set(
    Array.from(RAW_FOLDABLE_TAGS.values()).map((tag) => String(tag).toLowerCase())
);
const RAW_OMIT_CONTAINER_TAGS = new Set(['context']);
const timelineViewStore = new WeakMap();
const panelRenderCacheStore = new WeakMap();
const timelineMeasureCache = new Map();
let timelineMeasureCtx = null;

export function hasActiveTimelineEvents(state, now = Date.now()) {
    const events = Array.isArray(state?.timeline) ? state.timeline : [];
    return events.some((event) => isTimelineEventActive(event, now));
}

function getTimelineMeasureContext() {
    if (timelineMeasureCtx) return timelineMeasureCtx;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    const canvas = document.createElement('canvas');
    timelineMeasureCtx = canvas.getContext('2d');
    return timelineMeasureCtx;
}

function measureTimelineTextWidth(text, font) {
    const normalized = String(text || '');
    if (!normalized) return 0;
    const cacheKey = `${font}::${normalized}`;
    if (timelineMeasureCache.has(cacheKey)) {
        return timelineMeasureCache.get(cacheKey) || 0;
    }

    const ctx = getTimelineMeasureContext();
    let width = 0;
    if (ctx) {
        ctx.font = font;
        width = Math.ceil(ctx.measureText(normalized).width);
    } else {
        width = Math.ceil(normalized.length * 8);
    }

    timelineMeasureCache.set(cacheKey, width);
    if (timelineMeasureCache.size > 2048) {
        timelineMeasureCache.clear();
    }
    return width;
}

function getTimelineNodeMinWidth(title, meta) {
    const titleWidth = measureTimelineTextWidth(title, TIMELINE_TITLE_FONT);
    const metaWidth = measureTimelineTextWidth(meta, TIMELINE_META_FONT);
    return Math.ceil(
        titleWidth +
        metaWidth +
        TIMELINE_NODE_TEXT_GAP_PX +
        TIMELINE_NODE_HORIZONTAL_PADDING_PX +
        TIMELINE_NODE_BORDER_PX
    );
}

function mapStatusMeta(state) {
    const statusText = state?.status?.text || '空闲';
    const queueLength = state?.status?.queueLength || 0;
    return queueLength > 0 ? `${statusText} · 队列 ${queueLength}` : statusText;
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

function resolveTimelineKind(event = {}) {
    if (event.kind) return event.kind;
    if (event.lane === 'tool') return 'tool';
    if (event.lane === 'memory') return 'memory';
    return 'main';
}

function isTimelineEventActive(event = {}, now = Date.now()) {
    const createdAt = Number(event?.createdAt);
    return Number.isFinite(createdAt) && now - createdAt <= TIMELINE_ACTIVE_BUFFER_MS;
}

function formatTimelineStatus(status = 'done') {
    const normalized = String(status || 'done').toLowerCase();
    if (normalized === 'error') return '失败';
    if (normalized === 'running') return '进行中';
    return '完成';
}

function buildTimelineTooltip(event = {}) {
    const detailText = String(event.detail || '').replace(/\s+/g, ' ').trim();
    const detailSummary = summarizeText(detailText, 220) || '（无）';
    let resultSummary = '（无）';
    if (typeof event.result === 'string') {
        resultSummary = summarizeText(event.result.replace(/\s+/g, ' ').trim(), 220) || '（无）';
    } else if (event.result && typeof event.result === 'object') {
        try {
            resultSummary = summarizeText(JSON.stringify(event.result), 220) || '（无）';
        } catch (error) {
            resultSummary = '（无）';
        }
    }
    return [
        `事件：${event.title || '运行时事件'}`,
        `状态：${formatTimelineStatus(event.status)}`,
        `开始：${formatDateTime(event.startedAt)}`,
        `结束：${formatDateTime(event.finishedAt)}`,
        `持续：${Math.max(0, Math.round(Number(event.durationMs) || 0))} ms`,
        `调用结果：${resultSummary}`,
        `摘要：${detailSummary}`
    ].join('\n');
}

function createTimelineNode() {
    const article = document.createElement('article');
    article.className = 'timeline-node';

    const header = document.createElement('div');
    header.className = 'timeline-node-header';
    article.appendChild(header);

    const title = document.createElement('div');
    title.className = 'timeline-node-title';
    header.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'timeline-node-meta';
    header.appendChild(meta);

    return {
        element: article,
        titleEl: title,
        metaEl: meta,
        title: '',
        meta: '',
        tooltip: '',
        kind: '',
        status: '',
        faded: false,
        channel: -1,
        x: NaN,
        width: NaN
    };
}

function ensureTimelineView(container) {
    const existing = timelineViewStore.get(container);
    if (existing) {
        return existing;
    }

    const flow = document.createElement('div');
    flow.className = 'timeline-flow';

    const trackGrid = document.createElement('div');
    trackGrid.className = 'timeline-track-grid';
    const tracks = Array.from({ length: TIMELINE_CHANNEL_COUNT }, (_, index) => {
        const lane = document.createElement('div');
        lane.className = 'timeline-track-lane';

        const label = document.createElement('div');
        label.className = 'timeline-track-label';
        label.textContent = '主线程';
        lane.appendChild(label);

        const row = document.createElement('div');
        row.className = 'timeline-track-row';
        row.dataset.channel = String(index + 1);
        lane.appendChild(row);
        trackGrid.appendChild(lane);
        return row;
    });

    const empty = document.createElement('div');
    empty.className = 'timeline-flow-empty';
    empty.textContent = '当前还没有行为事件，新的运行记录会从左侧流入。';

    flow.append(trackGrid, empty);
    container.replaceChildren(flow);

    const view = {
        container,
        flow,
        trackGrid,
        tracks,
        empty,
        nodesById: new Map(),
        orderedEvents: [],
        lastWidth: 0,
        lastOrderKeysByChannel: new Array(TIMELINE_CHANNEL_COUNT).fill('')
    };
    timelineViewStore.set(container, view);
    return view;
}

function ageToPosition(ageMs, containerWidth) {
    const ratio = Math.max(0, Math.min(1, ageMs / TIMELINE_WINDOW_MS));
    return Math.max(0, Math.min(containerWidth, ratio * containerWidth));
}

function collectVisibleTimelineEvents(events, containerWidth, now) {
    return (Array.isArray(events) ? events : [])
        .filter((event) => Number.isFinite(Number(event?.createdAt)))
        .filter((event) => isTimelineEventActive(event, now))
        .slice(-TIMELINE_MAX_VISIBLE)
        .map((event) => {
            const finishedAt = Number(event.createdAt || now);
            const measuredDurationMs = Math.max(0, Number(event.durationMs) || 0);
            const startedAtRaw = Number(event.startedAt);
            const startedAt = Number.isFinite(startedAtRaw)
                ? Math.min(startedAtRaw, finishedAt)
                : finishedAt - measuredDurationMs;
            const normalizedDurationMs = Math.max(0, finishedAt - startedAt);
            const left = ageToPosition(Math.max(0, now - finishedAt), containerWidth);
            const right = ageToPosition(Math.max(0, now - startedAt), containerWidth);
            const displayTitle = event.title || '运行时事件';
            const displayMeta = `${Math.round(normalizedDurationMs)} ms`;
            const widthByDuration = Math.max(TIMELINE_MIN_VISIBLE_WIDTH, right - left);
            const widthByLabel = getTimelineNodeMinWidth(displayTitle, displayMeta);
            const width = Math.max(widthByDuration, widthByLabel);
            return {
                id: String(event.id || `${event.kind || 'event'}-${event.createdAt || Date.now()}`),
                seq: Number(event.seq) || 0,
                title: displayTitle,
                meta: displayMeta,
                tooltip: buildTimelineTooltip({
                    title: displayTitle,
                    status: event.status || 'done',
                    startedAt,
                    finishedAt,
                    durationMs: normalizedDurationMs,
                    detail: event.detail || '',
                    result: event.result || null
                }),
                kind: resolveTimelineKind(event),
                status: event.status || 'done',
                faded: now - finishedAt > TIMELINE_WINDOW_MS,
                width,
                left,
                right
            };
        })
        .filter((event) => event.right >= 0 && event.left <= containerWidth)
        .sort((left, right) => left.left - right.left || left.seq - right.seq);
}

function assignTimelineChannels(events) {
    return events.map((event) => ({
        ...event,
        channel: 0
    }));
}

function syncTimelineNodes(view, orderedEvents) {
    if (!Array.isArray(view.lastOrderKeysByChannel) || view.lastOrderKeysByChannel.length !== TIMELINE_CHANNEL_COUNT) {
        view.lastOrderKeysByChannel = new Array(TIMELINE_CHANNEL_COUNT).fill('');
    }
    const activeIds = new Set(orderedEvents.map((event) => event.id));
    let structureChanged = false;

    for (const [id, node] of view.nodesById.entries()) {
        if (!activeIds.has(id)) {
            node.element.remove();
            view.nodesById.delete(id);
            structureChanged = true;
        }
    }

    orderedEvents.forEach((event) => {
        let node = view.nodesById.get(event.id);
        if (!node) {
            node = createTimelineNode();
            view.nodesById.set(event.id, node);
            structureChanged = true;
        }

        if (node.title !== event.title) {
            node.titleEl.textContent = event.title;
            node.title = event.title;
        }
        if (node.meta !== event.meta) {
            node.metaEl.textContent = event.meta;
            node.meta = event.meta;
        }
        if (node.tooltip !== event.tooltip) {
            node.element.title = event.tooltip;
            node.tooltip = event.tooltip;
        }
        if (node.kind !== event.kind) {
            node.element.dataset.kind = event.kind;
            node.kind = event.kind;
        }
        if (node.status !== event.status) {
            node.element.dataset.status = event.status;
            node.status = event.status;
        }
        if (node.faded !== event.faded) {
            node.element.dataset.faded = event.faded ? 'true' : 'false';
            node.faded = event.faded;
        }
        if (node.width !== event.width) {
            node.element.style.width = `${event.width.toFixed(1)}px`;
            node.width = event.width;
        }
        const compact = event.width < 32;
        if (node.element.dataset.compact !== (compact ? 'true' : 'false')) {
            node.element.dataset.compact = compact ? 'true' : 'false';
        }
        if (node.channel !== event.channel) {
            node.channel = event.channel;
            structureChanged = true;
        }
    });

    const groupedByChannel = new Array(TIMELINE_CHANNEL_COUNT).fill(null).map(() => []);
    orderedEvents.forEach((event) => {
        const lane = Math.max(0, Math.min(TIMELINE_CHANNEL_COUNT - 1, Number(event.channel) || 0));
        groupedByChannel[lane].push(event);
    });

    for (let lane = 0; lane < TIMELINE_CHANNEL_COUNT; lane += 1) {
        const laneEvents = groupedByChannel[lane];
        const laneOrderKey = laneEvents.map((event) => event.id).join('|');
        if (!structureChanged && view.lastOrderKeysByChannel[lane] === laneOrderKey) {
            continue;
        }
        const fragment = document.createDocumentFragment();
        laneEvents.forEach((event) => {
            const node = view.nodesById.get(event.id);
            if (node) {
                fragment.appendChild(node.element);
            }
        });
        view.tracks[lane].replaceChildren(fragment);
        view.lastOrderKeysByChannel[lane] = laneOrderKey;
    }
}

function updateTimelineNodePositions(view) {
    for (const event of view.orderedEvents) {
        const node = view.nodesById.get(event.id);
        if (!node) continue;

        if (node.x !== event.left) {
            node.element.style.transform = `translate3d(${event.left.toFixed(1)}px, -50%, 0)`;
            node.x = event.left;
        }
        node.element.style.opacity = event.faded ? '0.42' : '1';
    }
}

export function renderTimelineSection(dom, state, now = Date.now()) {
    if (!dom.timelineLanesEl) return;

    const view = ensureTimelineView(dom.timelineLanesEl);
    const containerWidth = Math.max(320, (view.flow.clientWidth || dom.timelineLanesEl.clientWidth || 320) - 28);
    const visibleEvents = collectVisibleTimelineEvents(state?.timeline, containerWidth, now);
    const orderedEvents = assignTimelineChannels(visibleEvents);

    view.lastWidth = containerWidth;
    view.orderedEvents = orderedEvents;
    view.empty.style.display = orderedEvents.length ? 'none' : 'grid';
    view.trackGrid.style.display = orderedEvents.length ? 'grid' : 'none';

    syncTimelineNodes(view, orderedEvents);
    updateTimelineNodePositions(view);
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
            // - assistant spoken outputs (from speak tool)
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
