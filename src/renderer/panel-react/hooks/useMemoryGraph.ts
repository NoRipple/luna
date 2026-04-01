import { useCallback, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import type { PanelAction } from '../state';
import type {
  MemoryGraphCommunity,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphSnapshot,
  MemoryGraphTrace
} from '../types';

type LoadOptions = {
  query?: string;
  layers?: string[];
  days?: number | null;
  maxNodes?: number;
};

export function useMemoryGraph(dispatch: Dispatch<PanelAction>) {
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  const mapNodes = (value: unknown): MemoryGraphNode[] => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && typeof item === 'object')
      .map((item) => item as MemoryGraphNode)
      .filter((item) => typeof item.id === 'string' && typeof item.type === 'string');
  };

  const mapEdges = (value: unknown): MemoryGraphEdge[] => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && typeof item === 'object')
      .map((item) => item as MemoryGraphEdge)
      .filter((item) => typeof item.id === 'string' && typeof item.fromId === 'string' && typeof item.toId === 'string');
  };

  const mapCommunities = (value: unknown): MemoryGraphCommunity[] => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && typeof item === 'object')
      .map((item) => item as MemoryGraphCommunity)
      .filter((item) => typeof item.id === 'string');
  };

  const mapTraces = (value: unknown): Array<{ nodeId: string; traces: MemoryGraphTrace[] }> => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const row = item as { nodeId?: string; traces?: unknown[] };
        const traces = Array.isArray(row.traces)
          ? row.traces.filter((trace) => trace && typeof trace === 'object').map((trace) => trace as MemoryGraphTrace)
          : [];
        return {
          nodeId: String(row.nodeId || ''),
          traces
        };
      })
      .filter((item) => item.nodeId);
  };

  const refreshMemoryGraph = useCallback(async (options: LoadOptions = {}) => {
    if (!window.electronAPI?.getPanelMemoryGraph || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await window.electronAPI.getPanelMemoryGraph(options);
      if (!result?.ok) {
        dispatch({ type: 'set_error', message: result?.message || '记忆图数据加载失败' });
        return;
      }
      const snapshot: MemoryGraphSnapshot = {
        mode: String(result.mode || 'full'),
        query: String(result.query || ''),
        nodes: mapNodes(result.nodes),
        edges: mapEdges(result.edges),
        communities: mapCommunities(result.communities),
        episodicTraces: mapTraces(result.episodicTraces),
        stats: result.stats && typeof result.stats === 'object' ? result.stats : {},
        generatedAt: Number(result.generatedAt || Date.now())
      };
      dispatch({ type: 'set_memory_graph', payload: snapshot });
    } catch (error) {
      dispatch({ type: 'set_error', message: `记忆图数据加载失败: ${String((error as Error)?.message || error)}` });
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [dispatch]);

  const loadRecallPreview = useCallback(async (query: string, options: LoadOptions = {}) => {
    if (!window.electronAPI?.getPanelMemoryRecallPreview || loadingRef.current) return;
    const normalized = String(query || '').trim();
    if (!normalized) {
      await refreshMemoryGraph(options);
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await window.electronAPI.getPanelMemoryRecallPreview({
        ...options,
        query: normalized
      });
      if (!result?.ok) {
        dispatch({ type: 'set_error', message: result?.message || '记忆召回预览失败' });
        return;
      }
      const snapshot: MemoryGraphSnapshot = {
        mode: 'recall',
        query: normalized,
        nodes: mapNodes(result.nodes),
        edges: mapEdges(result.edges),
        communities: mapCommunities(result.communities),
        episodicTraces: mapTraces(result.episodicTraces),
        stats: result.stats && typeof result.stats === 'object' ? result.stats : {},
        generatedAt: Number(result.generatedAt || Date.now())
      };
      dispatch({ type: 'set_memory_graph', payload: snapshot });
    } catch (error) {
      dispatch({ type: 'set_error', message: `记忆召回预览失败: ${String((error as Error)?.message || error)}` });
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [dispatch, refreshMemoryGraph]);

  return {
    loading,
    refreshMemoryGraph,
    loadRecallPreview
  };
}
