export type RouteKey = 'chat' | 'extensions' | 'task_graph' | 'memory_graph';
export type ChatViewMode = 'user' | 'raw';

export interface UiStatus {
  text?: string;
  activeType?: string | null;
  queueLength?: number;
}

export interface RealtimePerception {
  status?: string;
  summary?: string;
  detail?: string;
  updatedAt?: number | null;
}

export interface UiPanelState {
  status?: UiStatus;
  realtimePerception?: RealtimePerception;
  recentPerceptions?: Array<{
    status?: string;
    summary?: string;
    detail?: string;
    updatedAt?: number | null;
  }>;
  panelNote?: string;
  autonomousWakeAt?: number | null;
  subagent?: { limit?: number; running?: number; queued?: number; channelCount?: number };
  timelineChannels?: Array<{ id: string; name?: string; type?: string }>;
  chatRecords?: Array<{ role?: string; kind?: string; text?: string; createdAt?: number; updatedAt?: number }>;
  rawMessages?: Array<unknown>;
  timeline?: Array<unknown>;
  meta?: { version?: number; updatedAt?: number };
}

export interface SkillInfo {
  name?: string;
  description?: string;
  tags?: string;
  path?: string;
  enabled?: boolean;
}

export interface ToolInfo {
  name?: string;
  description?: string;
  subagentEnabled?: boolean;
  timelineEnabled?: boolean;
  timelineKind?: string;
}

export interface ExtensionsSnapshot {
  skills: SkillInfo[];
  tools: ToolInfo[];
  mcp: { status?: string };
}

export interface TaskGraphItem {
  id?: number;
  subject?: string;
  status?: string;
  owner?: string;
  blockedBy?: number[];
}

export interface TaskGraphSnapshot {
  tasks: TaskGraphItem[];
  generatedAt: number;
  hasCycle: boolean;
}

export interface MemoryGraphNode {
  id: string;
  type: 'TASK' | 'SKILL' | 'EVENT' | string;
  name?: string;
  description?: string;
  content?: string;
  status?: string;
  sourceTier?: 'longterm' | 'session' | string;
  sourcePath?: string;
  sourceLine?: number;
  communityId?: string | null;
  pagerank?: number;
  recallScore?: number;
  validatedCount?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface MemoryGraphEdge {
  id: string;
  fromId: string;
  toId: string;
  type: 'USED_SKILL' | 'SOLVED_BY' | 'REQUIRES' | 'PATCHES' | 'CONFLICTS_WITH' | string;
  instruction?: string;
  condition?: string;
  sessionId?: string;
  createdAt?: number;
}

export interface MemoryGraphCommunity {
  id: string;
  summary?: string;
  size?: number;
  memberIds?: string[];
  updatedAt?: number;
}

export interface MemoryGraphTrace {
  id: string;
  sourcePath?: string;
  lineStart?: number;
  lineEnd?: number;
  content?: string;
  createdAt?: number;
}

export interface MemoryGraphSnapshot {
  mode?: 'full' | 'recall' | string;
  query?: string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  communities: MemoryGraphCommunity[];
  episodicTraces: Array<{ nodeId: string; traces: MemoryGraphTrace[] }>;
  stats?: {
    messages?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    generatedAt?: number;
  };
  generatedAt: number;
}

export interface VoiceAsrEvent {
  type?: string;
  text?: string;
  isFinal?: boolean;
  message?: string;
}

export interface DebugFlags {
  uiPerf?: boolean;
  uiPerfSlowMs?: number;
}

export interface CommandResult {
  ok?: boolean;
  message?: string;
}
