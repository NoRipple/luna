/* 主要职责：负责实时行为追踪时间线的泳道、事件节点与详情交互渲染。 */
import { formatDateTime, summarizeText } from './formatters.js';

const TIMELINE_WINDOW_MS = 30 * 1000;
const TIMELINE_ACTIVE_BUFFER_MS = TIMELINE_WINDOW_MS + 10 * 1000;
const TIMELINE_MIN_VISIBLE_WIDTH = 1;
const TIMELINE_MAX_VISIBLE = 36;
const TIMELINE_TITLE_FONT = '700 12px "Segoe UI", "Microsoft YaHei UI", sans-serif';
const TIMELINE_META_FONT = '500 10px "Segoe UI", "Microsoft YaHei UI", sans-serif';
const TIMELINE_NODE_TEXT_GAP_PX = 4;
const TIMELINE_NODE_HORIZONTAL_PADDING_PX = 12;
const TIMELINE_NODE_BORDER_PX = 2;
const TIMELINE_INSPECTOR_HIDE_DELAY_MS = 420;
const TIMELINE_INSPECTOR_EDGE_PADDING_PX = 8;
const TIMELINE_INSPECTOR_GAP_PX = 10;
const TIMELINE_INSPECTOR_MIN_WIDTH_PX = 260;
const TIMELINE_INSPECTOR_MAX_WIDTH_PX = 430;
const TIMELINE_DENSITY_COMPACT_THRESHOLD = 5;
const TIMELINE_DENSITY_DENSE_THRESHOLD = 9;
const TIMELINE_LIGHTWEIGHT_HOVER = false;
const TIMELINE_INSPECTOR_DETAIL_MAX = 180;
const TIMELINE_INSPECTOR_RESULT_MAX = 220;
const timelineViewStore = new WeakMap();
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

function summarizeTimelineResult(result) {
    if (typeof result === 'string') {
        return summarizeText(result.replace(/\s+/g, ' ').trim(), 220) || '（无）';
    }
    if (!result || typeof result !== 'object') {
        return '（无）';
    }
    try {
        return summarizeText(JSON.stringify(result), 220) || '（无）';
    } catch (error) {
        return '（无）';
    }
}

function createTimelineNode(onHover) {
    const article = document.createElement('article');
    article.className = 'timeline-node';
    article.tabIndex = 0;

    const header = document.createElement('div');
    header.className = 'timeline-node-header';
    article.appendChild(header);

    const title = document.createElement('div');
    title.className = 'timeline-node-title';
    header.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'timeline-node-meta';
    header.appendChild(meta);

    let snapshot = null;
    if (!TIMELINE_LIGHTWEIGHT_HOVER) {
        const notifyHover = (entering) => {
            if (!snapshot || typeof onHover !== 'function') return;
            onHover(snapshot, entering === true, article);
        };
        article.addEventListener('mouseenter', () => notifyHover(true));
        article.addEventListener('mouseleave', () => notifyHover(false));
        article.addEventListener('focus', () => notifyHover(true));
        article.addEventListener('blur', () => notifyHover(false));
    }

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
        channelId: 'main',
        snapshot: null,
        setSnapshot: (nextSnapshot) => {
            snapshot = nextSnapshot || null;
        },
        x: NaN,
        width: NaN
    };
}

function clampTimelineValue(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function measureTimelineNodeAnchor(nodeEl, flowEl) {
    if (!nodeEl || !flowEl) return null;
    if (typeof nodeEl.getBoundingClientRect !== 'function') return null;
    if (typeof flowEl.getBoundingClientRect !== 'function') return null;

    const nodeRect = nodeEl.getBoundingClientRect();
    const flowRect = flowEl.getBoundingClientRect();
    if (!nodeRect || !flowRect || flowRect.width <= 0 || flowRect.height <= 0) {
        return null;
    }

    const localWidth = Math.max(1, Number(flowEl.clientWidth) || 1);
    const localHeight = Math.max(1, Number(flowEl.clientHeight) || 1);
    const scaleX = flowRect.width / localWidth;
    const scaleY = flowRect.height / localHeight;
    const safeScaleX = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;
    const safeScaleY = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1;

    return {
        left: (nodeRect.left - flowRect.left) / safeScaleX,
        top: (nodeRect.top - flowRect.top) / safeScaleY,
        width: nodeRect.width / safeScaleX,
        height: nodeRect.height / safeScaleY
    };
}

function normalizeTimelineChannels(state = {}) {
    const channels = Array.isArray(state?.timelineChannels)
        ? state.timelineChannels
            .filter((channel) => channel && typeof channel === 'object' && String(channel.id || '').trim())
            .map((channel) => ({
                id: String(channel.id).trim(),
                name: String(channel.name || '子任务').trim() || '子任务',
                type: String(channel.type || 'subagent').trim() || 'subagent'
            }))
        : [];

    if (!channels.some((channel) => channel.id === 'main')) {
        channels.unshift({
            id: 'main',
            name: '主线程',
            type: 'main'
        });
    }
    return channels;
}

function normalizeTimelineChannelLabelText(value) {
    const raw = String(value || '').trim();
    if (!raw) return '子任务';
    const stripped = raw
        .replace(/^[\[\(\{【（「『]+/, '')
        .replace(/[\]\)\}】）」』]+$/, '')
        .trim();
    return stripped || raw;
}

function getTimelineChannelDisplayLabel(channel = {}) {
    if (String(channel.id || '') === 'main') {
        return String(channel.name || '主线程').trim() || '主线程';
    }
    const normalized = normalizeTimelineChannelLabelText(channel.name);
    if (normalized.length <= 4) {
        return normalized;
    }
    return `${normalized.slice(0, 3)}…`;
}

function createTimelineTrack(channel) {
    const lane = document.createElement('div');
    lane.className = 'timeline-track-lane';
    lane.dataset.channelId = channel.id;
    lane.dataset.channelType = channel.type || 'subagent';

    const label = document.createElement('div');
    label.className = 'timeline-track-label';
    label.textContent = getTimelineChannelDisplayLabel(channel);
    lane.appendChild(label);

    const row = document.createElement('div');
    row.className = 'timeline-track-row';
    row.dataset.channelId = channel.id;
    row.dataset.channelType = channel.type || 'subagent';
    lane.appendChild(row);

    return {
        lane,
        row,
        label
    };
}

function resolveTimelineDensity(subChannelCount) {
    const count = Math.max(0, Number(subChannelCount) || 0);
    if (count >= TIMELINE_DENSITY_DENSE_THRESHOLD) return 'dense';
    if (count >= TIMELINE_DENSITY_COMPACT_THRESHOLD) return 'compact';
    return 'regular';
}

function createTimelineInspector() {
    const inspector = document.createElement('aside');
    inspector.className = 'timeline-inspector';

    const head = document.createElement('header');
    head.className = 'timeline-inspector-head';
    const headCopy = document.createElement('div');
    headCopy.className = 'timeline-inspector-head-copy';
    const title = document.createElement('strong');
    title.textContent = '事件详情';
    const hint = document.createElement('span');
    hint.className = 'timeline-inspector-hint';
    hint.textContent = '悬浮时间块查看详细信息';
    headCopy.append(title, hint);
    const badge = document.createElement('span');
    badge.className = 'timeline-inspector-badge';
    badge.textContent = 'HOVER';
    head.append(headCopy, badge);

    const empty = document.createElement('div');
    empty.className = 'timeline-inspector-empty';
    empty.textContent = '将鼠标悬浮到任意时间块，可在此查看详细信息。';

    const content = document.createElement('div');
    content.className = 'timeline-inspector-content';

    const overview = document.createElement('section');
    overview.className = 'timeline-inspector-overview';

    const eventValue = document.createElement('strong');
    eventValue.className = 'timeline-inspector-event-title';
    overview.appendChild(eventValue);

    const chips = document.createElement('div');
    chips.className = 'timeline-inspector-chips';
    const channelValue = document.createElement('span');
    channelValue.className = 'timeline-inspector-chip timeline-inspector-chip-channel';
    const statusValue = document.createElement('span');
    statusValue.className = 'timeline-inspector-chip timeline-inspector-chip-status';
    const durationValue = document.createElement('span');
    durationValue.className = 'timeline-inspector-chip timeline-inspector-chip-duration';
    chips.append(channelValue, statusValue, durationValue);
    overview.appendChild(chips);

    const timeValue = document.createElement('div');
    timeValue.className = 'timeline-inspector-time';
    overview.appendChild(timeValue);

    const detailBlock = document.createElement('section');
    detailBlock.className = 'timeline-inspector-block';
    const detailTitle = document.createElement('div');
    detailTitle.className = 'timeline-inspector-block-title';
    detailTitle.textContent = '摘要';
    const detailBody = document.createElement('div');
    detailBody.className = 'timeline-inspector-block-body';
    detailBlock.append(detailTitle, detailBody);

    const resultBlock = document.createElement('section');
    resultBlock.className = 'timeline-inspector-block';
    const resultTitle = document.createElement('div');
    resultTitle.className = 'timeline-inspector-block-title';
    resultTitle.textContent = '结果（可展开）';
    const resultDetails = document.createElement('details');
    resultDetails.className = 'timeline-inspector-result-details';
    const resultSummary = document.createElement('summary');
    resultSummary.className = 'timeline-inspector-result-summary';
    const resultSummaryTitle = document.createElement('span');
    resultSummaryTitle.textContent = '查看结果';
    const resultPreview = document.createElement('span');
    resultPreview.className = 'timeline-inspector-result-preview';
    resultSummary.append(resultSummaryTitle, resultPreview);
    const resultBody = document.createElement('div');
    resultBody.className = 'timeline-inspector-block-body';
    resultDetails.append(resultSummary, resultBody);
    resultBlock.append(resultTitle, resultDetails);

    content.append(overview, detailBlock, resultBlock);
    inspector.append(head, empty, content);

    return {
        root: inspector,
        emptyEl: empty,
        contentEl: content,
        eventValueEl: eventValue,
        channelValueEl: channelValue,
        statusValueEl: statusValue,
        durationValueEl: durationValue,
        timeValueEl: timeValue,
        detailBodyEl: detailBody,
        resultDetailsEl: resultDetails,
        resultPreviewEl: resultPreview,
        resultTitleEl: resultTitle,
        resultBodyEl: resultBody
    };
}

function positionTimelineInspector(view) {
    const root = view?.inspector?.root;
    const flow = view?.flow;
    if (!root || !flow) return;

    const anchor = view.hoveredAnchor;
    const hasAnchor = Boolean(anchor && Number.isFinite(anchor.left) && Number.isFinite(anchor.top));
    if (!hasAnchor) {
        root.dataset.placement = 'none';
        root.style.left = '';
        root.style.top = '';
        root.style.width = '';
        root.style.maxWidth = '';
        root.style.removeProperty('--timeline-inspector-arrow-left');
        return;
    }

    const flowRect = flow.getBoundingClientRect();
    if (!flowRect || flowRect.width <= 0 || flowRect.height <= 0) return;

    const localFlowWidth = Math.max(1, Number(flow.clientWidth) || 1);
    const localFlowHeight = Math.max(1, Number(flow.clientHeight) || 1);
    const scaleX = flowRect.width / localFlowWidth;
    const scaleY = flowRect.height / localFlowHeight;
    const safeScaleX = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;
    const safeScaleY = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1;

    const maxWidth = Math.max(180, Math.floor(localFlowWidth - TIMELINE_INSPECTOR_EDGE_PADDING_PX * 2));
    const preferredWidth = Math.min(
        TIMELINE_INSPECTOR_MAX_WIDTH_PX,
        Math.max(TIMELINE_INSPECTOR_MIN_WIDTH_PX, Math.round(localFlowWidth * 0.44))
    );
    const width = Math.min(preferredWidth, maxWidth);
    root.style.width = `${width}px`;
    root.style.maxWidth = `${maxWidth}px`;

    const measured = root.getBoundingClientRect();
    const inspectorWidth = (measured.width || (width * safeScaleX)) / safeScaleX;
    const inspectorHeight = (measured.height || 0) / safeScaleY;
    if (inspectorWidth <= 0 || inspectorHeight <= 0) return;

    const anchorCenterX = anchor.left + anchor.width / 2;
    const minLeft = TIMELINE_INSPECTOR_EDGE_PADDING_PX;
    const maxLeft = Math.max(minLeft, localFlowWidth - inspectorWidth - TIMELINE_INSPECTOR_EDGE_PADDING_PX);
    const left = clampTimelineValue(anchorCenterX - inspectorWidth / 2, minLeft, maxLeft);

    const topAbove = anchor.top - inspectorHeight - TIMELINE_INSPECTOR_GAP_PX;
    const topBelow = anchor.top + anchor.height + TIMELINE_INSPECTOR_GAP_PX;
    const fitsAbove = topAbove >= TIMELINE_INSPECTOR_EDGE_PADDING_PX;
    const fitsBelow = (topBelow + inspectorHeight) <= (localFlowHeight - TIMELINE_INSPECTOR_EDGE_PADDING_PX);
    const preferAbove = anchor.top >= localFlowHeight * 0.44;

    let placement = preferAbove ? 'top' : 'bottom';
    if (placement === 'top' && !fitsAbove && fitsBelow) placement = 'bottom';
    if (placement === 'bottom' && !fitsBelow && fitsAbove) placement = 'top';

    const rawTop = placement === 'top' ? topAbove : topBelow;
    const hasEnoughVerticalSpace = inspectorHeight <= (localFlowHeight - TIMELINE_INSPECTOR_EDGE_PADDING_PX * 2);
    let top = rawTop;
    if (hasEnoughVerticalSpace) {
        const maxTop = Math.max(
            TIMELINE_INSPECTOR_EDGE_PADDING_PX,
            localFlowHeight - inspectorHeight - TIMELINE_INSPECTOR_EDGE_PADDING_PX
        );
        top = clampTimelineValue(rawTop, TIMELINE_INSPECTOR_EDGE_PADDING_PX, maxTop);
    }

    // Final clamp in viewport space, so the popover is fully readable even when the panel is scaled.
    const measuredViewportWidth = measured.width || (inspectorWidth * safeScaleX);
    const measuredViewportHeight = measured.height || (inspectorHeight * safeScaleY);
    const viewportMinLeft = TIMELINE_INSPECTOR_EDGE_PADDING_PX;
    const viewportMaxLeft = Math.max(
        viewportMinLeft,
        (window.innerWidth || 0) - measuredViewportWidth - TIMELINE_INSPECTOR_EDGE_PADDING_PX
    );
    const viewportMinTop = TIMELINE_INSPECTOR_EDGE_PADDING_PX;
    const viewportMaxTop = Math.max(
        viewportMinTop,
        (window.innerHeight || 0) - measuredViewportHeight - TIMELINE_INSPECTOR_EDGE_PADDING_PX
    );
    const viewportLeft = flowRect.left + left * safeScaleX;
    const viewportTop = flowRect.top + top * safeScaleY;
    const clampedViewportLeft = clampTimelineValue(viewportLeft, viewportMinLeft, viewportMaxLeft);
    const clampedViewportTop = clampTimelineValue(viewportTop, viewportMinTop, viewportMaxTop);
    const finalLeft = (clampedViewportLeft - flowRect.left) / safeScaleX;
    const finalTop = (clampedViewportTop - flowRect.top) / safeScaleY;

    root.style.left = `${finalLeft.toFixed(1)}px`;
    root.style.top = `${finalTop.toFixed(1)}px`;
    root.dataset.placement = placement;
    const arrowLeft = clampTimelineValue(anchorCenterX - finalLeft, 18, Math.max(18, inspectorWidth - 18));
    root.style.setProperty('--timeline-inspector-arrow-left', `${arrowLeft.toFixed(1)}px`);
}

function clearTimelineInspectorHideTimer(view) {
    if (!view?.inspectorHideTimer) return;
    clearTimeout(view.inspectorHideTimer);
    view.inspectorHideTimer = 0;
}

function scheduleTimelineInspectorHide(view) {
    if (TIMELINE_LIGHTWEIGHT_HOVER) return;
    if (!view) return;
    clearTimelineInspectorHideTimer(view);
    view.inspectorHideTimer = setTimeout(() => {
        view.inspectorHideTimer = 0;
        if (view.inspectorHovered) return;
        view.hoveredEventId = '';
        view.hoveredSnapshot = null;
        view.hoveredAnchor = null;
        renderTimelineInspector(view);
        syncTimelineHoveredState(view);
    }, TIMELINE_INSPECTOR_HIDE_DELAY_MS);
}

function ensureTimelineView(container) {
    const existing = timelineViewStore.get(container);
    if (existing) {
        return existing;
    }

    const flow = document.createElement('div');
    flow.className = 'timeline-flow';

    const mainTrackHost = document.createElement('div');
    mainTrackHost.className = 'timeline-main-track-host';

    const subTrackScroller = document.createElement('div');
    subTrackScroller.className = 'timeline-sub-track-scroller';
    const subTrackGrid = document.createElement('div');
    subTrackGrid.className = 'timeline-sub-track-grid';
    subTrackScroller.appendChild(subTrackGrid);

    const empty = document.createElement('div');
    empty.className = 'timeline-flow-empty';
    empty.textContent = '当前还没有行为事件，新的运行记录会从左侧流入。';

    const inspector = TIMELINE_LIGHTWEIGHT_HOVER ? null : createTimelineInspector();

    if (inspector?.root) {
        flow.append(mainTrackHost, subTrackScroller, empty, inspector.root);
    } else {
        flow.append(mainTrackHost, subTrackScroller, empty);
    }
    container.replaceChildren(flow);

    const view = {
        container,
        flow,
        mainTrackHost,
        subTrackScroller,
        subTrackGrid,
        empty,
        inspector,
        tracksByChannelId: new Map(),
        channelOrder: [],
        mainChannelId: 'main',
        nodesById: new Map(),
        orderedEvents: [],
        lastWidth: 0,
        lastOrderKeysByChannel: new Map(),
        hoveredEventId: '',
        hoveredSnapshot: null,
        hoveredAnchor: null,
        inspectorHovered: false,
        inspectorHideTimer: 0
    };
    if (inspector?.root) {
        inspector.root.addEventListener('mouseenter', () => {
            view.inspectorHovered = true;
            clearTimelineInspectorHideTimer(view);
        });
        inspector.root.addEventListener('mouseleave', () => {
            view.inspectorHovered = false;
            scheduleTimelineInspectorHide(view);
        });
    }
    subTrackScroller.addEventListener('scroll', () => {
        if (!view.hoveredEventId) return;
        const node = view.nodesById.get(view.hoveredEventId);
        if (!node?.element) return;
        view.hoveredAnchor = measureTimelineNodeAnchor(node.element, view.flow);
        positionTimelineInspector(view);
    }, { passive: true });
    timelineViewStore.set(container, view);
    if (!TIMELINE_LIGHTWEIGHT_HOVER) {
        renderTimelineInspector(view);
    }
    return view;
}

function syncTimelineTracks(view, channels) {
    const normalizedChannels = Array.isArray(channels) ? channels : [];
    const mainChannel = normalizedChannels.find((channel) => channel.id === 'main') || normalizedChannels[0] || {
        id: 'main',
        name: '主线程',
        type: 'main'
    };
    const subChannels = normalizedChannels.filter((channel) => channel.id !== mainChannel.id);
    const orderedChannels = [mainChannel, ...subChannels];
    const nextOrder = orderedChannels.map((channel) => channel.id);
    const activeChannelIds = new Set(nextOrder);

    for (const [channelId, track] of view.tracksByChannelId.entries()) {
        if (!activeChannelIds.has(channelId)) {
            track.lane.remove();
            view.tracksByChannelId.delete(channelId);
            view.lastOrderKeysByChannel.delete(channelId);
        }
    }

    const mainFragment = document.createDocumentFragment();
    const subFragment = document.createDocumentFragment();
    orderedChannels.forEach((channel) => {
        let track = view.tracksByChannelId.get(channel.id);
        if (!track) {
            track = createTimelineTrack(channel);
            view.tracksByChannelId.set(channel.id, track);
        }
        const displayLabel = getTimelineChannelDisplayLabel(channel);
        if (track.label.textContent !== displayLabel) {
            track.label.textContent = displayLabel;
        }
        track.label.title = channel.name;
        track.lane.dataset.channelType = channel.type || 'subagent';
        track.lane.dataset.channelId = channel.id;
        track.row.dataset.channelType = channel.type || 'subagent';
        track.row.dataset.channelId = channel.id;
        if (channel.id === mainChannel.id) {
            mainFragment.appendChild(track.lane);
        } else {
            subFragment.appendChild(track.lane);
        }
    });
    view.mainTrackHost.replaceChildren(mainFragment);
    view.subTrackGrid.replaceChildren(subFragment);
    view.subTrackScroller.style.display = subChannels.length ? 'block' : 'none';
    view.flow.dataset.density = resolveTimelineDensity(subChannels.length);
    view.flow.dataset.hasSubchannels = subChannels.length ? 'true' : 'false';
    view.channelOrder = nextOrder;
    view.mainChannelId = mainChannel.id;
}

function renderTimelineInspector(view) {
    const inspector = view?.inspector;
    if (!inspector) return;
    const snapshot = view.hoveredSnapshot;
    const hasSelection = Boolean(
        snapshot
        && typeof snapshot === 'object'
        && view.hoveredAnchor
        && Number.isFinite(view.hoveredAnchor.left)
        && Number.isFinite(view.hoveredAnchor.top)
    );

    inspector.root.dataset.visible = hasSelection ? 'true' : 'false';
    inspector.root.dataset.status = hasSelection ? String(snapshot?.status || 'done').toLowerCase() : 'idle';
    inspector.root.dataset.kind = hasSelection ? String(snapshot?.kind || 'main') : 'none';
    inspector.emptyEl.style.display = hasSelection ? 'none' : 'block';
    inspector.contentEl.style.display = hasSelection ? 'grid' : 'none';
    if (!hasSelection) {
        inspector.root.dataset.hasResult = 'false';
        positionTimelineInspector(view);
        return;
    }

    const durationMs = Math.max(0, Math.round(Number(snapshot.durationMs) || 0));
    inspector.eventValueEl.textContent = String(snapshot.title || '运行时事件');
    inspector.eventValueEl.title = String(snapshot.title || '运行时事件');
    const channelText = String(snapshot.channelName || '主线程');
    inspector.channelValueEl.textContent = summarizeText(channelText, 22) || '主线程';
    inspector.channelValueEl.title = channelText;
    inspector.statusValueEl.textContent = formatTimelineStatus(snapshot.status || 'done');
    inspector.durationValueEl.textContent = `${durationMs} ms`;
    inspector.timeValueEl.textContent = `${formatDateTime(snapshot.startedAt)} → ${formatDateTime(snapshot.finishedAt)} · ${Math.max(0, Math.round(Number(snapshot.durationMs) || 0))} ms`;
    const detailText = summarizeText(String(snapshot.detail || '').trim(), TIMELINE_INSPECTOR_DETAIL_MAX) || '（无）';
    const resultText = summarizeText(String(snapshot.resultSummary || '').trim(), TIMELINE_INSPECTOR_RESULT_MAX) || '（无）';
    const hasResult = resultText !== '（无）';
    inspector.detailBodyEl.textContent = detailText;
    inspector.resultBodyEl.textContent = resultText;
    inspector.resultPreviewEl.textContent = hasResult ? resultText : '无结果输出';
    inspector.resultDetailsEl.open = false;
    inspector.resultDetailsEl.style.display = hasResult ? 'grid' : 'none';
    inspector.resultTitleEl.style.display = hasResult ? 'block' : 'none';
    inspector.root.dataset.hasResult = hasResult ? 'true' : 'false';
    positionTimelineInspector(view);
}

function syncTimelineHoveredState(view) {
    if (TIMELINE_LIGHTWEIGHT_HOVER) return;
    for (const [eventId, node] of view.nodesById.entries()) {
        const isHovered = Boolean(view.hoveredEventId) && view.hoveredEventId === eventId;
        if (node.element.dataset.hovered !== (isHovered ? 'true' : 'false')) {
            node.element.dataset.hovered = isHovered ? 'true' : 'false';
        }
    }
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
            const detailText = String(event.detail || '').replace(/\s+/g, ' ').trim() || '（无）';
            const resultSummary = summarizeTimelineResult(event.result);
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
                channelId: String(event.channelId || 'main'),
                channelName: String(event.channelName || ''),
                startedAt,
                finishedAt,
                durationMs: normalizedDurationMs,
                detailText,
                resultSummary,
                width,
                left,
                right
            };
        })
        .filter((event) => event.right >= 0 && event.left <= containerWidth)
        .sort((left, right) => left.left - right.left || left.seq - right.seq);
}

function assignTimelineChannels(events, channels) {
    const allowedChannelIds = new Set(channels.map((channel) => channel.id));
    return events
        .filter((event) => (
            allowedChannelIds.has(event.channelId)
            || !event.channelId
            || event.channelId === 'main'
        ))
        .map((event) => ({
            ...event,
            channelId: allowedChannelIds.has(event.channelId) ? event.channelId : 'main'
        }));
}

function syncTimelineNodes(view, orderedEvents) {
    const activeIds = new Set(orderedEvents.map((event) => event.id));
    let structureChanged = false;
    let inspectorNeedsRefresh = false;

    for (const [id, node] of view.nodesById.entries()) {
        if (!activeIds.has(id)) {
            node.element.remove();
            view.nodesById.delete(id);
            if (view.hoveredEventId === id) {
                view.hoveredEventId = '';
                view.hoveredSnapshot = null;
                view.hoveredAnchor = null;
                inspectorNeedsRefresh = true;
            }
            structureChanged = true;
        }
    }

    orderedEvents.forEach((event) => {
        let node = view.nodesById.get(event.id);
        if (!node) {
            node = createTimelineNode((snapshot, entering, nodeEl) => {
                if (entering) {
                    clearTimelineInspectorHideTimer(view);
                    view.hoveredEventId = snapshot?.id || '';
                    view.hoveredSnapshot = snapshot || null;
                    view.hoveredAnchor = measureTimelineNodeAnchor(nodeEl, view.flow);
                    renderTimelineInspector(view);
                    syncTimelineHoveredState(view);
                    return;
                }
                if (!snapshot || view.hoveredEventId !== snapshot.id) return;
                scheduleTimelineInspectorHide(view);
            });
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
            node.element.setAttribute('aria-label', event.tooltip);
            node.element.setAttribute('title', event.tooltip);
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
        if (node.channelId !== event.channelId) {
            node.channelId = event.channelId;
            structureChanged = true;
        }
        const channelTrack = view.tracksByChannelId.get(event.channelId);
        const channelName = (
            event.channelName
            || channelTrack?.label?.textContent
            || (event.channelId === 'main' ? '主线程' : '子任务')
        );
        const snapshot = {
            id: event.id,
            title: event.title,
            kind: event.kind,
            status: event.status,
            channelId: event.channelId,
            channelName,
            startedAt: event.startedAt,
            finishedAt: event.finishedAt,
            durationMs: event.durationMs,
            detail: event.detailText,
            resultSummary: event.resultSummary
        };
        node.snapshot = snapshot;
        node.setSnapshot(snapshot);
        if (!TIMELINE_LIGHTWEIGHT_HOVER && view.hoveredEventId === event.id) {
            view.hoveredSnapshot = snapshot;
            view.hoveredAnchor = measureTimelineNodeAnchor(node.element, view.flow);
            inspectorNeedsRefresh = true;
        }
    });

    const groupedByChannel = new Map();
    view.channelOrder.forEach((channelId) => {
        groupedByChannel.set(channelId, []);
    });
    orderedEvents.forEach((event) => {
        const targetChannel = groupedByChannel.has(event.channelId) ? event.channelId : 'main';
        if (!groupedByChannel.has(targetChannel)) {
            groupedByChannel.set(targetChannel, []);
        }
        groupedByChannel.get(targetChannel).push(event);
    });

    for (const channelId of view.channelOrder) {
        const laneEvents = groupedByChannel.get(channelId) || [];
        const laneOrderKey = laneEvents.map((event) => event.id).join('|');
        if (!structureChanged && view.lastOrderKeysByChannel.get(channelId) === laneOrderKey) {
            continue;
        }
        const fragment = document.createDocumentFragment();
        laneEvents.forEach((event) => {
            const node = view.nodesById.get(event.id);
            if (node) {
                fragment.appendChild(node.element);
            }
        });
        const lane = view.tracksByChannelId.get(channelId);
        if (lane?.row) {
            lane.row.replaceChildren(fragment);
        }
        view.lastOrderKeysByChannel.set(channelId, laneOrderKey);
    }
    if (!TIMELINE_LIGHTWEIGHT_HOVER && inspectorNeedsRefresh) {
        renderTimelineInspector(view);
    }
    syncTimelineHoveredState(view);
}

function updateTimelineNodePositions(view) {
    if (TIMELINE_LIGHTWEIGHT_HOVER) {
        for (const event of view.orderedEvents) {
            const node = view.nodesById.get(event.id);
            if (!node) continue;
            if (node.x !== event.left) {
                node.element.style.transform = `translate3d(${event.left.toFixed(1)}px, -50%, 0)`;
                node.x = event.left;
            }
            node.element.style.opacity = event.faded ? '0.42' : '1';
        }
        return;
    }

    let hoveredNodeMoved = false;
    for (const event of view.orderedEvents) {
        const node = view.nodesById.get(event.id);
        if (!node) continue;

        if (node.x !== event.left) {
            node.element.style.transform = `translate3d(${event.left.toFixed(1)}px, -50%, 0)`;
            node.x = event.left;
        }
        node.element.style.opacity = event.faded ? '0.42' : '1';
        if (view.hoveredEventId === event.id) {
            view.hoveredAnchor = measureTimelineNodeAnchor(node.element, view.flow);
            hoveredNodeMoved = true;
        }
    }
    if (hoveredNodeMoved) {
        positionTimelineInspector(view);
    }
}

export function renderTimelineSection(dom, state, now = Date.now()) {
    if (!dom.timelineLanesEl) return;

    const view = ensureTimelineView(dom.timelineLanesEl);
    const channels = normalizeTimelineChannels(state);
    syncTimelineTracks(view, channels);
    const containerWidth = Math.max(320, (view.flow.clientWidth || dom.timelineLanesEl.clientWidth || 320) - 28);
    const visibleEvents = collectVisibleTimelineEvents(state?.timeline, containerWidth, now);
    const orderedEvents = assignTimelineChannels(visibleEvents, channels);

    view.lastWidth = containerWidth;
    view.orderedEvents = orderedEvents;
    view.empty.style.display = orderedEvents.length ? 'none' : 'grid';
    view.mainTrackHost.style.display = 'grid';

    syncTimelineNodes(view, orderedEvents);
    updateTimelineNodePositions(view);
}
