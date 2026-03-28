/* 主要职责：作为面板前端入口，负责事件绑定、初始状态获取与渲染调度。 */
import { createPanelDom } from './dom.js';
import { hasActiveTimelineEvents, renderPanelState, renderTimelineSection } from './renderers.js';

function logError(dom, msg) {
    console.error(msg);
    if (!dom.errorLogEl) return;
    dom.errorLogEl.style.display = 'block';
    dom.errorLogEl.innerHTML += `${msg}<br>`;
}

window.addEventListener('DOMContentLoaded', () => {
    const dom = createPanelDom();
    if (!dom.historyEl || !dom.chatInputEl || !dom.sendButtonEl) {
        return;
    }
    const panelShell = document.getElementById('panel-shell');
    const panelScaleState = {
        baseWidth: Math.max(1280, window.innerWidth || 1280),
        baseHeight: Math.max(760, window.innerHeight || 760)
    };
    document.body.classList.add('scaled-layout');

    function applyPanelViewportScale() {
        if (!panelShell) return;
        const viewportWidth = Math.max(1, window.innerWidth || 1);
        const viewportHeight = Math.max(1, window.innerHeight || 1);

        if (viewportWidth > panelScaleState.baseWidth) {
            panelScaleState.baseWidth = viewportWidth;
        }
        if (viewportHeight > panelScaleState.baseHeight) {
            panelScaleState.baseHeight = viewportHeight;
        }

        const scale = Math.min(
            viewportWidth / panelScaleState.baseWidth,
            viewportHeight / panelScaleState.baseHeight,
            1
        );
        const scaledWidth = panelScaleState.baseWidth * scale;
        const scaledHeight = panelScaleState.baseHeight * scale;
        const offsetX = (viewportWidth - scaledWidth) / 2;
        const offsetY = (viewportHeight - scaledHeight) / 2;

        panelShell.style.position = 'absolute';
        panelShell.style.left = '0';
        panelShell.style.top = '0';
        panelShell.style.width = `${panelScaleState.baseWidth}px`;
        panelShell.style.height = `${panelScaleState.baseHeight}px`;
        panelShell.style.transformOrigin = 'top left';
        panelShell.style.transform = `translate3d(${offsetX.toFixed(2)}px, ${offsetY.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
    }

    applyPanelViewportScale();
    window.addEventListener('resize', () => {
        applyPanelViewportScale();
    }, { passive: true });

    let latestUiState = {
        status: { text: '空闲', activeType: null, queueLength: 0 },
        realtimePerception: { status: 'idle', summary: '暂无感知结果', detail: '', updatedAt: null },
        recentPerceptions: [],
        panelNote: '',
        autonomousWakeAt: null,
        chatRecords: [],
        rawMessages: [],
        timeline: []
    };
    let pendingUiState = latestUiState;
    let hasPendingState = false;
    const RENDER_INTERVAL_MS = 200;
    const SNAPSHOT_POLL_MS = 1000;
    const TIMELINE_FRAME_MS = 1000 / 60;
    let perfDebug = { uiPerf: false, uiPerfSlowMs: 32 };
    let uiUpdateCount = 0;
    let flushCount = 0;
    let lastUiUpdateAt = 0;
    let pollingInFlight = false;
    let lastSnapshotVersion = 0;
    let timelineRafId = 0;
    let timelineLastFrameAt = 0;
    let chatViewMode = 'user';

    function syncChatViewToggle() {
        if (!dom.chatViewToggleEl) return;
        const isRaw = chatViewMode === 'raw';
        dom.chatViewToggleEl.dataset.mode = isRaw ? 'raw' : 'user';
        dom.chatViewToggleEl.textContent = isRaw ? '用户视图' : '真实视野';
        dom.chatViewToggleEl.title = isRaw
            ? '切换回用户视图（仅用户命令与 speak 回复）'
            : '切换到真实视野（显示原始 messages）';
    }

    syncChatViewToggle();

    function reportPerf(type, data = {}) {
        if (!perfDebug.uiPerf) return;
        const payload = {
            type,
            at: Date.now(),
            ...data
        };
        try {
            console.log('[UI PERF]', payload);
            if (window.electronAPI?.sendUIPerfLog) {
                window.electronAPI.sendUIPerfLog(payload);
            }
        } catch (error) {
            // ignore debug log failures
        }
    }

    function flushPanelState(force = false) {
        if (!force && !hasPendingState) return;
        const started = performance.now();
        latestUiState = pendingUiState || latestUiState;
        hasPendingState = false;
        const renderStarted = performance.now();
        renderPanelState(dom, latestUiState, { chatViewMode });
        const renderMs = performance.now() - renderStarted;
        const timelineStarted = performance.now();
        renderTimelineSection(dom, latestUiState, Date.now());
        ensureTimelineLoop();
        const timelineMs = performance.now() - timelineStarted;
        const totalMs = performance.now() - started;
        flushCount += 1;

        if (perfDebug.uiPerf && (
            totalMs >= perfDebug.uiPerfSlowMs ||
            renderMs >= perfDebug.uiPerfSlowMs
        )) {
            reportPerf('panel_flush_slow', {
                flush_count: flushCount,
                render_ms: Number(renderMs.toFixed(2)),
                timeline_ms: Number(timelineMs.toFixed(2)),
                total_ms: Number(totalMs.toFixed(2)),
                chat_size: Array.isArray(latestUiState?.chatRecords) ? latestUiState.chatRecords.length : 0,
                timeline_size: Array.isArray(latestUiState?.timeline) ? latestUiState.timeline.length : 0
            });
        }
    }

    function schedulePanelRender(nextState) {
        const nowPerf = performance.now();
        pendingUiState = nextState || pendingUiState;
        hasPendingState = true;
        uiUpdateCount += 1;
        if (lastUiUpdateAt) {
            const gapMs = nowPerf - lastUiUpdateAt;
            if (perfDebug.uiPerf && gapMs >= 120) {
                reportPerf('ui_update_gap', {
                    gap_ms: Number(gapMs.toFixed(2)),
                    update_count: uiUpdateCount
                });
            }
        }
        lastUiUpdateAt = nowPerf;
    }

    function applySnapshot(state) {
        const nextState = state || latestUiState;
        const version = Number(nextState?.meta?.version || 0);
        if (version > 0 && version === lastSnapshotVersion) {
            return;
        }
        if (version > 0) {
            lastSnapshotVersion = version;
        }
        schedulePanelRender(nextState);
    }

    function stopTimelineLoop() {
        if (!timelineRafId) return;
        window.cancelAnimationFrame(timelineRafId);
        timelineRafId = 0;
    }

    function runTimelineLoop(frameNow) {
        if (frameNow - timelineLastFrameAt >= TIMELINE_FRAME_MS) {
            timelineLastFrameAt = frameNow;
            renderTimelineSection(dom, latestUiState, Date.now());
        }

        if (!document.hidden && hasActiveTimelineEvents(latestUiState, Date.now())) {
            timelineRafId = window.requestAnimationFrame(runTimelineLoop);
            return;
        }

        timelineRafId = 0;
    }

    function ensureTimelineLoop() {
        if (document.hidden) {
            stopTimelineLoop();
            return;
        }
        if (!hasActiveTimelineEvents(latestUiState, Date.now())) {
            stopTimelineLoop();
            return;
        }
        if (timelineRafId) return;
        timelineLastFrameAt = 0;
        timelineRafId = window.requestAnimationFrame(runTimelineLoop);
    }

    async function pollSnapshot() {
        if (pollingInFlight || !window.electronAPI?.getUIHistorySnapshot) return;
        pollingInFlight = true;
        try {
            const state = await window.electronAPI.getUIHistorySnapshot();
            applySnapshot(state);
        } catch (error) {
            if (perfDebug.uiPerf) {
                reportPerf('snapshot_poll_failed', {
                    message: String(error?.message || error || 'unknown')
                });
            }
        } finally {
            pollingInFlight = false;
        }
    }

    async function sendCommand() {
        const text = dom.chatInputEl.value.trim();
        if (!text || !window.electronAPI?.sendUICommand) return;
        dom.sendButtonEl.disabled = true;
        try {
            const result = await window.electronAPI.sendUICommand(text);
            if (!result?.ok) {
                logError(dom, result?.message || '命令发送失败');
                return;
            }
            dom.chatInputEl.value = '';
        } catch (error) {
            logError(dom, `命令发送失败: ${error.message}`);
        } finally {
            dom.sendButtonEl.disabled = false;
        }
    }

    dom.sendButtonEl.addEventListener('click', () => {
        sendCommand().catch(() => {});
    });

    dom.chatInputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendCommand().catch(() => {});
        }
    });

    if (dom.chatViewToggleEl) {
        dom.chatViewToggleEl.addEventListener('click', () => {
            chatViewMode = chatViewMode === 'raw' ? 'user' : 'raw';
            syncChatViewToggle();
            flushPanelState(true);
        });
    }

    if (window.electronAPI?.getDebugFlags) {
        window.electronAPI.getDebugFlags()
            .then((flags) => {
                perfDebug = {
                    uiPerf: Boolean(flags?.uiPerf),
                    uiPerfSlowMs: Number(flags?.uiPerfSlowMs) || 32
                };
                reportPerf('debug_flags_loaded', perfDebug);
            })
            .catch(() => {});
    }

    if (window.electronAPI?.getUIHistorySnapshot) {
        window.electronAPI.getUIHistorySnapshot()
            .then((state) => {
                applySnapshot(state);
                flushPanelState(true);
            })
            .catch((error) => logError(dom, `状态加载失败: ${error.message}`));
    } else {
        schedulePanelRender(latestUiState);
        flushPanelState(true);
    }

    window.setInterval(() => {
        flushPanelState(false);
    }, RENDER_INTERVAL_MS);

    window.setInterval(() => {
        pollSnapshot().catch(() => {});
    }, SNAPSHOT_POLL_MS);

    if (window.ResizeObserver && dom.timelineLanesEl) {
        const resizeObserver = new window.ResizeObserver(() => {
            renderTimelineSection(dom, latestUiState, Date.now());
            ensureTimelineLoop();
        });
        resizeObserver.observe(dom.timelineLanesEl);
    }

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            flushPanelState(true);
            ensureTimelineLoop();
            return;
        }
        stopTimelineLoop();
    });

    // Renderer event-loop lag probe, useful when stalls are not from a single render pass.
    let loopProbeExpected = performance.now() + 250;
    window.setInterval(() => {
        if (!perfDebug.uiPerf) {
            loopProbeExpected = performance.now() + 250;
            return;
        }
        const nowPerf = performance.now();
        const lagMs = nowPerf - loopProbeExpected;
        loopProbeExpected = nowPerf + 250;
        if (lagMs >= perfDebug.uiPerfSlowMs) {
            reportPerf('renderer_event_loop_lag', {
                lag_ms: Number(lagMs.toFixed(2)),
                has_pending_state: hasPendingState
            });
        }
    }, 250);
});
