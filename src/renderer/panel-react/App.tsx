import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import cytoscape, { type Core as CytoscapeCore } from 'cytoscape';
import { buildRawMessageHtml } from './rawMessageHtml';
import { initialExtensions, initialUiState, panelReducer } from './state';
import type { ChatViewMode, MemoryGraphSnapshot, RouteKey } from './types';
import { useUiSnapshot } from './hooks/useUiSnapshot';
import { useExtensions } from './hooks/useExtensions';
import { useTaskGraph } from './hooks/useTaskGraph';
import { useMemoryGraph } from './hooks/useMemoryGraph';
import { useVoiceAsr } from './hooks/useVoiceAsr';
import { formatDateTime, formatTime, summarizeText } from '../panel/scripts/formatters.js';
import { hasActiveTimelineEvents, renderTimelineSection } from '../panel/scripts/timelineLanesRenderer.js';
import { renderTaskGraph } from '../panel/scripts/taskGraphRenderer.js';

const TIMELINE_FRAME_MS = 1000 / 60;

function mapStatusMeta(state: any) {
  const statusText = state?.status?.text || '空闲';
  const queueLength = state?.status?.queueLength || 0;
  const subagentRunning = Number(state?.subagent?.running || 0);
  const subagentLimit = Number(state?.subagent?.limit || 0);
  const queueText = queueLength > 0 ? `队列 ${queueLength}` : '';
  const subagentText = subagentLimit > 0 ? `子Agent ${subagentRunning}/${subagentLimit}` : '';
  return [statusText, queueText, subagentText].filter(Boolean).join(' · ');
}

function buildRuntimeDetail(state: any) {
  if (state?.panelNote) return state.panelNote;
  const realtime = state?.realtimePerception || {};
  if (realtime.status === 'running') return `正在感知：${realtime.summary || '处理中'}`;
  return '等待新的命令或自主轮次。';
}

function renderEmptyMessage(mode: ChatViewMode = 'user') {
  const text = mode === 'raw'
    ? '真实视野当前没有可展示的原始 messages。'
    : '当前还没有对话记录，新的命令会从这里开始。';
  return (
    <article className="chat-message agent">
      <div className="message-row">
        <div className="message-avatar">AI</div>
        <div className="message-bubble">{text}</div>
      </div>
      <div className="message-time">--:--</div>
    </article>
  );
}

function UserMessage({ item, index }: { item: any; index: number }) {
  const role = item.role === 'assistant' ? 'assistant' : 'user';
  const kind = String(item.kind || (role === 'assistant' ? 'speak' : 'command'));
  const messageText = summarizeText(String(item.text || '').trim(), 800) || '（空）';
  const messageTime = item.createdAt || item.updatedAt;
  const avatar = role === 'assistant' ? 'AI' : '你';
  const cssRole = role === 'assistant' ? 'agent' : 'user';
  const kindLabel = kind === 'speak' ? '回复' : (kind === 'command' ? '命令' : kind);

  return (
    <article
      className={`chat-message ${cssRole} message-enter`}
      data-kind={kind}
      style={{ animationDelay: `${Math.min(index, 8) * 42}ms` }}
    >
      <div className="message-row">
        <div className="message-avatar">{avatar}</div>
        <div className="message-bubble">{messageText}</div>
      </div>
      <div className="message-time">{formatTime(messageTime)} · {kindLabel}</div>
    </article>
  );
}

function RawMessage({ item, index }: { item: any; index: number }) {
  const html = useMemo(() => buildRawMessageHtml(item, index), [item, index]);
  return (
    <div
      className="raw-message-enter"
      style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function TimelineBlock({ uiState }: { uiState: any }) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const rafIdRef = useRef<number>(0);
  const lastFrameAtRef = useRef<number>(0);

  useEffect(() => {
    const dom = { timelineLanesEl: timelineRef.current };
    renderTimelineSection(dom, uiState, Date.now());

    const runLoop = (frameNow: number) => {
      if (!timelineRef.current) {
        rafIdRef.current = 0;
        return;
      }
      if (frameNow - lastFrameAtRef.current >= TIMELINE_FRAME_MS) {
        lastFrameAtRef.current = frameNow;
        renderTimelineSection(dom, uiState, Date.now());
      }
      if (!document.hidden && hasActiveTimelineEvents(uiState, Date.now())) {
        rafIdRef.current = window.requestAnimationFrame(runLoop);
      } else {
        rafIdRef.current = 0;
      }
    };

    if (!document.hidden && hasActiveTimelineEvents(uiState, Date.now())) {
      lastFrameAtRef.current = 0;
      rafIdRef.current = window.requestAnimationFrame(runLoop);
    }

    return () => {
      if (rafIdRef.current) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
    };
  }, [uiState]);

  return <div id="timeline-lanes" className="timeline-lanes" ref={timelineRef} />;
}

function TaskGraphCanvas({
  snapshot,
  onRefresh,
  burstClass
}: {
  snapshot: any;
  onRefresh: () => void;
  burstClass: string;
}) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const metaRef = useRef<HTMLParagraphElement | null>(null);
  const hasCycle = Boolean(snapshot?.hasCycle);

  useEffect(() => {
    const dom = {
      taskGraphCanvasEl: canvasRef.current,
      taskGraphMetaEl: metaRef.current
    };
    renderTaskGraph(dom, snapshot);
  }, [snapshot]);

  return (
    <>
      <header className="task-graph-header">
        <div>
          <h2>当前 Agent 任务图</h2>
          <p id="task-graph-meta" ref={metaRef}>加载中...</p>
        </div>
        <button id="task-graph-refresh" type="button" className="extensions-refresh-btn" onClick={onRefresh}>
          刷新
        </button>
      </header>
      {hasCycle ? (
        <div id="task-graph-alert" className="task-graph-alert task-graph-alert-enter">
          检测到循环依赖，相关节点已放入“异常区”列显示。
        </div>
      ) : null}
      <div className="task-graph-legend" id="task-graph-legend">
        <span data-status="pending">Pending</span>
        <span data-status="in_progress">In Progress</span>
        <span data-status="completed">Completed</span>
      </div>
      <div id="task-graph-canvas" className={`task-graph-canvas ${burstClass}`} ref={canvasRef}></div>
    </>
  );
}

function MemoryGraphPanel({
  snapshot,
  onReload,
  onRecall
}: {
  snapshot: MemoryGraphSnapshot | null;
  onReload: (options?: {
    query?: string;
    layers?: string[];
    days?: number | null;
    maxNodes?: number;
  }) => void;
  onRecall: (query: string) => void;
}) {
  const graphRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<CytoscapeCore | null>(null);
  const [query, setQuery] = useState('');
  const [showLongterm, setShowLongterm] = useState(true);
  const [showSession, setShowSession] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [days, setDays] = useState<number | null>(null);

  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const edges = Array.isArray(snapshot?.edges) ? snapshot.edges : [];
  const communities = Array.isArray(snapshot?.communities) ? snapshot.communities : [];
  const traces = Array.isArray(snapshot?.episodicTraces) ? snapshot.episodicTraces : [];
  const selectedNode = nodes.find((item) => item.id === selectedNodeId) || null;
  const selectedTrace = traces.find((item) => item.nodeId === selectedNodeId) || null;

  useEffect(() => {
    if (!graphRef.current) return;
    const cy = cytoscape({
      container: graphRef.current,
      elements: [],
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'background-color': 'data(color)',
            color: '#f8f6f2',
            'font-size': 11,
            'text-wrap': 'wrap',
            'text-max-width': '120px',
            'text-valign': 'center',
            'text-halign': 'center',
            width: 'mapData(weight, 0.001, 1, 26, 56)',
            height: 'mapData(weight, 0.001, 1, 26, 56)',
            'border-width': 1,
            'border-color': '#efe4d2'
          }
        },
        {
          selector: 'edge',
          style: {
            width: 1.8,
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': 'data(color)',
            'line-color': 'data(color)',
            opacity: 0.78
          }
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 3,
            'border-color': '#f7d999'
          }
        }
      ],
      layout: { name: 'circle', fit: true, padding: 32 }
    });
    cy.on('select', 'node', (evt) => {
      setSelectedNodeId(String(evt.target.id() || ''));
    });
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const nodeElements = nodes.map((node) => {
      const type = String(node.type || 'TASK');
      const color = type === 'SKILL'
        ? '#9a6f46'
        : (type === 'EVENT' ? '#8b4a4a' : '#4d7198');
      const weight = Number(node.recallScore || node.pagerank || 0.05);
      return {
        data: {
          id: node.id,
          label: summarizeText(node.name || node.description || node.id, 34),
          color,
          weight: String(Math.max(0.001, weight)),
          type
        }
      };
    });
    const edgeElements = edges.map((edge) => {
      const edgeType = String(edge.type || 'REQUIRES');
      const color = edgeType === 'CONFLICTS_WITH'
        ? '#b34c4c'
        : (edgeType === 'PATCHES' ? '#6e8e5f' : '#8a7d6c');
      return {
        data: {
          id: edge.id,
          source: edge.fromId,
          target: edge.toId,
          color,
          edgeType
        }
      };
    });
    cy.elements().remove();
    cy.add([...nodeElements, ...edgeElements]);
    cy.layout({
      name: 'cose',
      fit: true,
      padding: 36,
      animate: false,
      idealEdgeLength: 80,
      nodeRepulsion: 4200
    }).run();
  }, [nodes, edges]);

  const applyLayerFilter = () => {
    const layers: string[] = [];
    if (showLongterm) layers.push('longterm');
    if (showSession) layers.push('session');
    onReload({
      query: '',
      layers,
      days,
      maxNodes: 800
    });
  };

  return (
    <>
      <header className="task-graph-header">
        <div>
          <h2>记忆图谱</h2>
          <p>
            节点 {snapshot?.stats?.nodes || nodes.length} · 边 {snapshot?.stats?.edges || edges.length} · 社区 {communities.length}
          </p>
        </div>
        <button type="button" className="extensions-refresh-btn" onClick={() => onReload({ maxNodes: 800 })}>
          刷新
        </button>
      </header>
      <div className="memory-graph-toolbar">
        <label>
          <input type="checkbox" checked={showLongterm} onChange={(e) => setShowLongterm(e.target.checked)} />
          长期
        </label>
        <label>
          <input type="checkbox" checked={showSession} onChange={(e) => setShowSession(e.target.checked)} />
          会话
        </label>
        <select
          value={days === null ? 'all' : String(days)}
          onChange={(event) => {
            const value = event.target.value;
            setDays(value === 'all' ? null : Number(value));
          }}
        >
          <option value="all">全量</option>
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
          <option value="90">最近 90 天</option>
        </select>
        <button type="button" className="extensions-refresh-btn" onClick={applyLayerFilter}>应用筛选</button>
        <input
          type="text"
          placeholder="输入 query 预览召回路径..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="extensions-refresh-btn"
          onClick={() => onRecall(query)}
        >
          召回预览
        </button>
      </div>
      <div className="memory-graph-workspace">
        <div className="memory-graph-canvas" ref={graphRef}></div>
        <aside className="memory-graph-detail">
          {selectedNode ? (
            <>
              <h3>{selectedNode.name || selectedNode.id}</h3>
              <p>{selectedNode.description || selectedNode.content || '暂无描述'}</p>
              <div className="memory-graph-meta">
                <span>类型：{selectedNode.type}</span>
                <span>层级：{selectedNode.sourceTier || 'session'}</span>
                <span>社区：{selectedNode.communityId || 'N/A'}</span>
              </div>
              <div className="memory-graph-meta">
                <span>来源：{selectedNode.sourcePath || 'unknown'}:{selectedNode.sourceLine || 1}</span>
              </div>
              <h4>相关会话片段</h4>
              <div className="memory-graph-traces">
                {Array.isArray(selectedTrace?.traces) && selectedTrace?.traces?.length
                  ? selectedTrace.traces.map((trace) => (
                    <article key={trace.id} className="memory-trace-card">
                      <strong>{trace.sourcePath}:{trace.lineStart}-{trace.lineEnd}</strong>
                      <p>{summarizeText(String(trace.content || ''), 220)}</p>
                    </article>
                  ))
                  : <div className="empty-row">暂无关联片段</div>}
              </div>
            </>
          ) : (
            <div className="empty-row">选择图节点查看详情</div>
          )}
        </aside>
      </div>
    </>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(panelReducer, {
    route: 'chat' as RouteKey,
    chatViewMode: 'user' as ChatViewMode,
    uiState: initialUiState,
    extensions: initialExtensions,
    taskGraph: null,
    memoryGraph: null,
    errorText: ''
  });
  const [chatInput, setChatInput] = useState('');
  const [routeFxTick, setRouteFxTick] = useState(0);
  const [sendFxTick, setSendFxTick] = useState(0);
  const [voiceFxTick, setVoiceFxTick] = useState(0);
  const [extensionsFxTick, setExtensionsFxTick] = useState(0);
  const [taskGraphFxTick, setTaskGraphFxTick] = useState(0);
  const [memoryGraphFxTick, setMemoryGraphFxTick] = useState(0);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const panelShellRef = useRef<HTMLDivElement | null>(null);

  useUiSnapshot(dispatch);
  const { refreshExtensions, toggleSkill } = useExtensions(dispatch);
  const { refreshTaskGraph } = useTaskGraph(dispatch);
  const { refreshMemoryGraph, loadRecallPreview } = useMemoryGraph(dispatch);

  const route = state.route;
  const uiState = state.uiState || initialUiState;

  const doRefreshExtensions = async () => {
    setExtensionsFxTick((value) => value + 1);
    await refreshExtensions();
  };

  const doRefreshTaskGraph = async () => {
    setTaskGraphFxTick((value) => value + 1);
    await refreshTaskGraph();
  };

  const doRefreshMemoryGraph = async (options: {
    query?: string;
    layers?: string[];
    days?: number | null;
    maxNodes?: number;
  } = {}) => {
    setMemoryGraphFxTick((value) => value + 1);
    await refreshMemoryGraph(options);
  };

  const sendCommand = async (overrideText = '', options: { keepInputOnFailure?: boolean } = {}) => {
    const text = String(overrideText || chatInput || '').trim();
    const keepInputOnFailure = Boolean(options.keepInputOnFailure);
    if (!text || !window.electronAPI?.sendUICommand) return;
    try {
      const result = await window.electronAPI.sendUICommand(text);
      if (!result?.ok) {
        dispatch({ type: 'set_error', message: result?.message || '命令发送失败' });
        if (keepInputOnFailure) setChatInput(text);
        return;
      }
      setSendFxTick((value) => value + 1);
      setChatInput('');
    } catch (error) {
      dispatch({ type: 'set_error', message: `命令发送失败: ${String((error as Error)?.message || error)}` });
      if (keepInputOnFailure) setChatInput(text);
    }
  };

  const voice = useVoiceAsr(
    async (text, options) => {
      await sendCommand(text, options);
      setVoiceFxTick((value) => value + 1);
    },
    () => chatInput,
    (value) => setChatInput(value)
  );

  const recentPerceptions = Array.isArray(uiState?.recentPerceptions) && uiState.recentPerceptions.length
    ? uiState.recentPerceptions.slice().reverse()
    : [{
      status: uiState?.realtimePerception?.status || 'idle',
      summary: uiState?.realtimePerception?.summary || '暂无感知结果',
      detail: uiState?.realtimePerception?.detail || '',
      updatedAt: uiState?.realtimePerception?.updatedAt || null
    }];
  const timeline = Array.isArray(uiState?.timeline) ? uiState.timeline : [];
  const runtimeDetail = buildRuntimeDetail(uiState);
  const sessionStatus = uiState?.status?.text || '空闲';
  const wakeText = formatDateTime(uiState?.autonomousWakeAt);
  const progressWidth = `${Math.min(100, 48 + (uiState?.status?.queueLength || 0) * 10)}%`;
  const userFacingRecords = Array.isArray(uiState?.chatRecords)
    ? uiState.chatRecords.filter((item: any) => {
      if (!item || typeof item !== 'object') return false;
      const role = String(item.role || '');
      const kind = String(item.kind || '');
      return (
        (role === 'user' && kind === 'command')
        || (role === 'assistant' && kind === 'speak')
      );
    })
    : [];
  const rawMessages = Array.isArray(uiState?.rawMessages) ? uiState.rawMessages : [];

  useEffect(() => {
    document.body.classList.add('panel-window', 'scaled-layout');
    document.body.dataset.route = route;
    setRouteFxTick((value) => value + 1);
  }, [route]);

  useEffect(() => {
    const panelShell = panelShellRef.current;
    if (!panelShell) return;
    const panelScaleState = {
      baseWidth: Math.max(1280, window.innerWidth || 1280),
      baseHeight: Math.max(760, window.innerHeight || 760)
    };
    const applyScale = () => {
      const viewportWidth = Math.max(1, window.innerWidth || 1);
      const viewportHeight = Math.max(1, window.innerHeight || 1);
      if (viewportWidth > panelScaleState.baseWidth) panelScaleState.baseWidth = viewportWidth;
      if (viewportHeight > panelScaleState.baseHeight) panelScaleState.baseHeight = viewportHeight;
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
    };
    applyScale();
    window.addEventListener('resize', applyScale, { passive: true });
    return () => window.removeEventListener('resize', applyScale);
  }, []);

  useEffect(() => {
    if (!state.errorText) return;
    const timer = window.setTimeout(() => dispatch({ type: 'clear_error' }), 9000);
    return () => window.clearTimeout(timer);
  }, [state.errorText]);

  useEffect(() => {
    if (route === 'extensions') {
      doRefreshExtensions().catch(() => {});
    } else if (route === 'task_graph') {
      doRefreshTaskGraph().catch(() => {});
    } else if (route === 'memory_graph') {
      doRefreshMemoryGraph({ maxNodes: 800 }).catch(() => {});
    }
  }, [route]);

  useEffect(() => {
    const el = historyRef.current;
    if (!el) return;
    const delta = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (delta <= 64) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.chatViewMode, rawMessages.length, userFacingRecords.length]);

  const conversationMeta = state.chatViewMode === 'raw'
    ? `真实视野 · ${rawMessages.length} 条原始消息`
    : `${userFacingRecords.length} 条消息`;

  const routeFxClass = routeFxTick % 2 === 0 ? 'route-fx-a' : 'route-fx-b';
  const sendFxClass = sendFxTick % 2 === 0 ? 'btn-fx-a' : 'btn-fx-b';
  const voiceFxClass = voiceFxTick % 2 === 0 ? 'btn-fx-a' : 'btn-fx-b';
  const extensionsFxClass = extensionsFxTick % 2 === 0 ? 'surface-fx-a' : 'surface-fx-b';
  const taskGraphFxClass = taskGraphFxTick % 2 === 0 ? 'surface-fx-a' : 'surface-fx-b';
  const memoryGraphFxClass = memoryGraphFxTick % 2 === 0 ? 'surface-fx-a' : 'surface-fx-b';

  return (
    <div id="panel-shell" ref={panelShellRef} data-route-fx={routeFxClass}>
      <aside className="app-rail" aria-label="导航侧栏">
        <div className="app-brand">
          <div className="app-brand-mark">✦</div>
          <div className="app-brand-copy">
            <strong>Agent OS</strong>
            <span>Platinum</span>
          </div>
        </div>
        <div className="rail-section-label">功能模块</div>
        <nav className="app-nav">
          <button id="nav-chat" className="app-nav-item" type="button" data-route="chat" data-active={route === 'chat'} onClick={() => dispatch({ type: 'set_route', route: 'chat' })}>
            <span>会话</span><span>实时对话</span>
          </button>
          <button id="nav-extensions" className="app-nav-item" type="button" data-route="extensions" data-active={route === 'extensions'} onClick={() => dispatch({ type: 'set_route', route: 'extensions' })}>
            <span>扩展能力</span><span>Skill · Tool · MCP</span>
          </button>
          <button id="nav-task-graph" className="app-nav-item" type="button" data-route="task_graph" data-active={route === 'task_graph'} onClick={() => dispatch({ type: 'set_route', route: 'task_graph' })}>
            <span>任务图</span><span>执行依赖</span>
          </button>
          <button id="nav-memory-graph" className="app-nav-item" type="button" data-route="memory_graph" data-active={route === 'memory_graph'} onClick={() => dispatch({ type: 'set_route', route: 'memory_graph' })}>
            <span>记忆图</span><span>TASK · SKILL · EVENT</span>
          </button>
        </nav>
        <button className="app-settings" type="button" disabled><span className="app-settings-icon">⚙</span><span>设置</span></button>
      </aside>

      <main className="workspace-grid">
        <section className="main-column">
          <div id="page-chat" className={`panel-page ${route === 'chat' ? 'active page-enter' : ''}`}>
            <section className="chat-surface">
              <header className="chat-header">
                <div className="assistant-chip">✦</div>
                <div className="chat-header-copy">
                  <h1>Platinum Assistant</h1>
                  <p><span className="status-dot"></span><span id="chat-status-meta">{mapStatusMeta(uiState)}</span></p>
                </div>
                <div className="chat-header-actions">
                  <span className="model-pill">GPT-4o</span>
                  <button id="chat-open-task-graph" className="chat-view-toggle" type="button" onClick={() => dispatch({ type: 'set_route', route: 'task_graph' })}>任务图</button>
                  <button
                    id="chat-view-toggle"
                    className="chat-view-toggle"
                    type="button"
                    data-mode={state.chatViewMode}
                    onClick={() => dispatch({ type: 'toggle_view' })}
                  >
                    {state.chatViewMode === 'raw' ? '用户视图' : '真实视野'}
                  </button>
                  <button className="header-dot-button" type="button" disabled>···</button>
                </div>
              </header>

              <div id="chat-history" className="chat-stream" data-view={state.chatViewMode} ref={historyRef}>
                {state.chatViewMode === 'raw' ? (
                  rawMessages.length
                    ? rawMessages.map((item, index) => <RawMessage key={`raw-${index}`} item={item} index={index} />)
                    : renderEmptyMessage('raw')
                ) : (
                  userFacingRecords.length
                    ? userFacingRecords.map((item: any, idx: number) => (
                        <UserMessage key={`${item.role}-${item.createdAt || idx}`} item={item} index={idx} />
                      ))
                    : renderEmptyMessage('user')
                )}
              </div>

              <footer className="composer-shell">
                <div className="composer-frame">
                  <label className="sr-only" htmlFor="chat-input">发送消息</label>
                  <textarea
                    id="chat-input"
                    placeholder="发送消息... (Enter 发送, Shift+Enter 换行)"
                    rows={2}
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        sendCommand().catch(() => {});
                      }
                    }}
                  />
                  <div className="composer-tools">
                    <button
                      id="chat-voice"
                      className={`composer-voice ${voiceFxClass}`}
                      type="button"
                      title={voice.buttonTitle}
                      data-state={voice.recording ? 'recording' : 'idle'}
                      disabled={Boolean(voice.unsupportedReason) || voice.stopping}
                      onClick={() => {
                        setVoiceFxTick((value) => value + 1);
                        if (voice.recording) {
                          voice.stopVoiceInput(true).catch(() => {});
                          return;
                        }
                        voice.startVoiceInput().catch(() => {});
                      }}
                    >
                      {voice.recording ? '■' : '🎙'}
                    </button>
                    <button id="chat-send" className={`composer-send ${sendFxClass}`} type="button" onClick={() => sendCommand().catch(() => {})}>➤</button>
                  </div>
                </div>
                <div className="composer-meta">
                  <span id="composer-runtime">{summarizeText(runtimeDetail, 68) || runtimeDetail}</span>
                  <span id="voice-meta" data-state={voice.metaState}>{voice.metaText}</span>
                  <span id="conversation-meta">{conversationMeta}</span>
                </div>
              </footer>
            </section>

            <section className="trace-surface">
              <header className="trace-header">
                <div className="trace-header-copy">
                  <h2>实时行为追踪</h2>
                  <span className="trace-subtitle">统一主时间流 · 稳定展示近期工具与状态事件</span>
                </div>
                <div className="trace-header-meta">
                  <span id="trace-duration">{timeline.length} 条记录</span>
                  <span className="trace-live"><span className="status-dot soft"></span>LIVE</span>
                </div>
              </header>
              <TimelineBlock uiState={uiState} />
            </section>
          </div>

          <section id="page-extensions" className={`extensions-surface panel-page ${route === 'extensions' ? `active page-enter ${extensionsFxClass}` : ''}`} aria-label="扩展能力管理">
            <header className="extensions-header">
              <div>
                <h2>扩展能力管理</h2>
                <p>管理 Skill 启用状态，查看当前 Tool 能力，并为 MCP 扩展保留入口。</p>
              </div>
              <button id="extensions-refresh" type="button" className="extensions-refresh-btn" onClick={() => doRefreshExtensions().catch(() => {})}>刷新</button>
            </header>

            <section className="extensions-block">
              <h3>Skills</h3>
              <div id="skills-list" className="skills-list">
                {state.extensions.skills.length ? state.extensions.skills.map((skill, index) => {
                  const name = String(skill.name || '').trim() || '(unnamed)';
                  const description = summarizeText(String(skill.description || '').trim() || 'No description', 120);
                  const tags = String(skill.tags || '').trim();
                  const path = String(skill.path || '').trim();
                  const enabled = skill.enabled !== false;
                  return (
                    <article key={`${name}-${index}`} className="skill-item card-enter" data-enabled={enabled ? 'true' : 'false'} data-skill-name={name} style={{ animationDelay: `${Math.min(index, 8) * 36}ms` }}>
                      <div className="skill-item-main">
                        <div className="skill-item-title">{name}</div>
                        <div className="skill-item-desc">{description}</div>
                        <div className="skill-item-meta">{tags || 'no tags'}</div>
                        <div className="skill-item-path">{path}</div>
                      </div>
                      <label className="skill-toggle">
                        <input type="checkbox" checked={enabled} onChange={(event) => toggleSkill(name, event.target.checked).catch(() => {})} />
                        <span>{enabled ? '已启用' : '已禁用'}</span>
                      </label>
                    </article>
                  );
                }) : <div className="empty-row">当前没有可用 skills。</div>}
              </div>
            </section>

            <section className="extensions-block">
              <h3>Tools</h3>
              <div id="tools-list" className="tools-list">
                {state.extensions.tools.length ? state.extensions.tools.map((tool, index) => {
                  const name = String(tool.name || '').trim() || '(unknown)';
                  const description = summarizeText(String(tool.description || '').trim() || 'No description', 120);
                  const subagentEnabled = tool.subagentEnabled !== false ? 'subagent' : 'parent-only';
                  const timelineEnabled = tool.timelineEnabled !== false ? 'timeline-on' : 'timeline-off';
                  const timelineKind = String(tool.timelineKind || name).trim();
                  return (
                    <article key={`${name}-${index}`} className="tool-item card-enter" style={{ animationDelay: `${Math.min(index, 8) * 34}ms` }}>
                      <div className="tool-item-title">{name}</div>
                      <div className="tool-item-desc">{description}</div>
                      <div className="tool-item-meta">
                        <span>{subagentEnabled}</span>
                        <span>{timelineEnabled}</span>
                        <span>kind: {timelineKind}</span>
                      </div>
                    </article>
                  );
                }) : <div className="empty-row">当前没有工具信息。</div>}
              </div>
            </section>

            <section className="extensions-block">
              <h3>MCP</h3>
              <div id="mcp-placeholder" className="mcp-placeholder">
                {state.extensions.mcp?.status === 'placeholder'
                  ? '预留区域：后续接入 MCP 能力管理。'
                  : `MCP 状态：${state.extensions.mcp?.status || 'unknown'}`}
              </div>
            </section>
          </section>

          <section id="page-task-graph" className={`task-graph-surface panel-page ${route === 'task_graph' ? `active page-enter ${taskGraphFxClass}` : ''}`} aria-label="任务图">
            <TaskGraphCanvas snapshot={state.taskGraph} onRefresh={() => doRefreshTaskGraph().catch(() => {})} burstClass={taskGraphFxClass} />
          </section>

          <section id="page-memory-graph" className={`task-graph-surface panel-page ${route === 'memory_graph' ? `active page-enter ${memoryGraphFxClass}` : ''}`} aria-label="记忆图">
            <MemoryGraphPanel
              snapshot={state.memoryGraph}
              onReload={(options = {}) => {
                doRefreshMemoryGraph(options).catch(() => {});
              }}
              onRecall={(query) => {
                const normalized = String(query || '').trim();
                if (!normalized) {
                  doRefreshMemoryGraph({ maxNodes: 800 }).catch(() => {});
                  return;
                }
                setMemoryGraphFxTick((value) => value + 1);
                loadRecallPreview(normalized).catch(() => {});
              }}
            />
          </section>
        </section>

        <aside className="side-column">
          <section className="insight-surface">
            <header className="insight-header">
              <h2>AI 状态</h2>
              <span className="live-inline"><span className="status-dot soft"></span>实时</span>
            </header>

            <article className="insight-hero">
              <div className="insight-avatar">AI</div>
              <div>
                <strong id="state-session-label">{sessionStatus}</strong>
                <p id="state-runtime-label">{summarizeText(runtimeDetail, 38) || runtimeDetail}</p>
              </div>
            </article>

            <section className="insight-block insight-block-fixed insight-block-session">
              <div className="insight-block-head">
                <span>会话状态</span>
                <strong id="state-session-value">{sessionStatus}</strong>
              </div>
              <div className="state-progress-track">
                <span id="state-progress-fill" className="state-progress-fill" style={{ width: progressWidth }}></span>
              </div>
            </section>

            <section className="insight-block insight-block-fixed insight-block-runtime">
              <div className="insight-block-head">
                <span>运行时状态</span>
                <strong id="state-runtime-value">{summarizeText(runtimeDetail, 38) || runtimeDetail}</strong>
              </div>
              <div className="state-inline-meta">
                <span>下次唤醒</span>
                <strong id="state-wake-value">{wakeText}</strong>
              </div>
            </section>

            <section className="insight-block perception-block">
              <div className="insight-block-head stacked">
                <span>最近感知</span>
                <strong id="perception-live-time">{formatTime(recentPerceptions[0]?.updatedAt)}</strong>
              </div>
              <ul id="ai-perception-list" className="perception-list">
                {recentPerceptions.map((item, index) => (
                  <li key={`perception-${index}`} className="perception-item">
                    <div className="perception-item-top">
                      <strong className="perception-item-time">{formatTime(item.updatedAt)}</strong>
                      <span className="perception-item-state">{item.status || 'done'}</span>
                    </div>
                    <div>{item.summary || '暂无摘要'}</div>
                    <div className="perception-item-detail">{summarizeText(item.detail || '', 96) || '暂无详情'}</div>
                  </li>
                ))}
              </ul>
            </section>
          </section>

          <section className="memory-surface">
            <div className="memory-topbar">
              <span>AI 记忆系统</span>
              <span className="memory-badge">待命开发</span>
            </div>
            <div className="memory-core">
              <div className="memory-orb">✺</div>
              <strong>AI 记忆系统</strong>
              <p id="memory-summary">{summarizeText(runtimeDetail, 66) || runtimeDetail}</p>
            </div>
            <div className="memory-footnote">
              <span id="memory-counts">最近感知 {recentPerceptions.length} · 行为事件 {timeline.length}</span>
              <button className="memory-help" type="button" disabled>?</button>
            </div>
          </section>
        </aside>
      </main>

      <div id="error-log" style={{ display: state.errorText ? 'block' : 'none' }}>
        {state.errorText || ''}
      </div>
    </div>
  );
}
