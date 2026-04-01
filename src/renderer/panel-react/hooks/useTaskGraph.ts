import { useCallback, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import type { PanelAction } from '../state';
import type { TaskGraphSnapshot } from '../types';

export function useTaskGraph(dispatch: Dispatch<PanelAction>) {
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  const refreshTaskGraph = useCallback(async () => {
    if (!window.electronAPI?.getPanelTaskGraph || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await window.electronAPI.getPanelTaskGraph();
      if (!result?.ok) {
        dispatch({ type: 'set_error', message: result?.message || '任务图数据加载失败' });
        return;
      }
      const snapshot: TaskGraphSnapshot = {
        tasks: Array.isArray(result.tasks) ? result.tasks : [],
        generatedAt: Number(result.generatedAt || Date.now()),
        hasCycle: Boolean(result.hasCycle)
      };
      dispatch({ type: 'set_task_graph', payload: snapshot });
    } catch (error) {
      dispatch({ type: 'set_error', message: `任务图数据加载失败: ${String((error as Error)?.message || error)}` });
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [dispatch]);

  return {
    loading,
    refreshTaskGraph
  };
}
