/* 主要职责：将任务图数据渲染为内置 SVG DAG。 */
import { escapeHtml } from './formatters.js';

const COL_WIDTH = 300;
const ROW_HEIGHT = 112;
const PADDING_X = 28;
const PADDING_Y = 28;
const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;

function normalizeTasks(tasks = []) {
    return (Array.isArray(tasks) ? tasks : [])
        .map((task) => {
            const id = Number(task?.id);
            if (!Number.isInteger(id) || id <= 0) return null;
            return {
                id,
                subject: String(task?.subject || '').trim() || `Task ${id}`,
                status: String(task?.status || 'pending').trim(),
                owner: String(task?.owner || '').trim(),
                blockedBy: Array.isArray(task?.blockedBy) ? task.blockedBy.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0) : []
            };
        })
        .filter(Boolean);
}

function buildGraph(tasks = []) {
    const nodes = normalizeTasks(tasks);
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const indegree = new Map();
    const outgoing = new Map();
    const level = new Map();

    nodes.forEach((node) => {
        indegree.set(node.id, 0);
        outgoing.set(node.id, new Set());
        level.set(node.id, 0);
    });

    nodes.forEach((node) => {
        node.blockedBy.forEach((fromId) => {
            if (!nodeMap.has(fromId)) return;
            const edges = outgoing.get(fromId);
            if (edges.has(node.id)) return;
            edges.add(node.id);
            indegree.set(node.id, Number(indegree.get(node.id) || 0) + 1);
        });
    });

    const queue = [];
    indegree.forEach((value, nodeId) => {
        if (value === 0) queue.push(nodeId);
    });

    const ordered = [];
    while (queue.length) {
        const current = queue.shift();
        ordered.push(current);
        const nextNodes = outgoing.get(current) || new Set();
        nextNodes.forEach((nextId) => {
            const nextLevel = Math.max(Number(level.get(nextId) || 0), Number(level.get(current) || 0) + 1);
            level.set(nextId, nextLevel);
            const nextIndegree = Number(indegree.get(nextId) || 0) - 1;
            indegree.set(nextId, nextIndegree);
            if (nextIndegree === 0) queue.push(nextId);
        });
    }

    const cycleNodes = nodes
        .map((node) => node.id)
        .filter((nodeId) => Number(indegree.get(nodeId) || 0) > 0);
    const hasCycle = cycleNodes.length > 0;
    const maxLevel = nodes.reduce((max, node) => Math.max(max, Number(level.get(node.id) || 0)), 0);
    const anomalyLevel = maxLevel + 1;

    const grouped = new Map();
    nodes.forEach((node) => {
        const col = cycleNodes.includes(node.id) ? anomalyLevel : Number(level.get(node.id) || 0);
        if (!grouped.has(col)) grouped.set(col, []);
        grouped.get(col).push(node.id);
    });

    const columns = Array.from(grouped.keys()).sort((a, b) => a - b);
    const positions = new Map();
    columns.forEach((col) => {
        const ids = grouped.get(col) || [];
        ids.sort((a, b) => a - b).forEach((nodeId, row) => {
            positions.set(nodeId, {
                x: PADDING_X + col * COL_WIDTH,
                y: PADDING_Y + row * ROW_HEIGHT
            });
        });
    });

    const edges = [];
    nodes.forEach((node) => {
        node.blockedBy.forEach((fromId) => {
            if (!positions.has(fromId) || !positions.has(node.id)) return;
            edges.push({ fromId, toId: node.id });
        });
    });

    const rowsPerCol = columns.map((col) => (grouped.get(col) || []).length);
    const width = Math.max(680, PADDING_X * 2 + (Math.max(0, columns.length - 1) * COL_WIDTH) + NODE_WIDTH + 40);
    const height = Math.max(260, PADDING_Y * 2 + (Math.max(0, Math.max(...rowsPerCol, 1) - 1) * ROW_HEIGHT) + NODE_HEIGHT + 40);

    return {
        nodes,
        positions,
        edges,
        hasCycle,
        cycleNodes,
        width,
        height,
        columns,
        anomalyLevel
    };
}

function statusClass(status = '') {
    const normalized = String(status || 'pending').trim();
    if (normalized === 'completed') return 'completed';
    if (normalized === 'in_progress') return 'in_progress';
    return 'pending';
}

function buildEdgePath(fromPos, toPos) {
    const startX = fromPos.x + NODE_WIDTH;
    const startY = fromPos.y + NODE_HEIGHT / 2;
    const endX = toPos.x;
    const endY = toPos.y + NODE_HEIGHT / 2;
    const ctrlOffset = Math.max(34, Math.abs(endX - startX) * 0.45);
    const c1x = startX + ctrlOffset;
    const c2x = endX - ctrlOffset;
    return `M ${startX} ${startY} C ${c1x} ${startY}, ${c2x} ${endY}, ${endX} ${endY}`;
}

function buildNodeSvg(node, pos) {
    const cls = statusClass(node.status);
    const subject = escapeHtml(node.subject);
    const owner = escapeHtml(node.owner || 'unassigned');
    const titleY = pos.y + 26;
    const metaY = pos.y + 50;
    return `
        <g class="task-node ${cls}" transform="translate(${pos.x},${pos.y})">
            <rect x="0" y="0" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="12" ry="12"></rect>
            <text x="12" y="${titleY - pos.y}" class="task-node-title">#${node.id} ${subject}</text>
            <text x="12" y="${metaY - pos.y}" class="task-node-meta">${escapeHtml(node.status)} · ${owner}</text>
        </g>
    `;
}

export function renderTaskGraph(dom, snapshot = {}) {
    if (!dom?.taskGraphCanvasEl || !dom?.taskGraphMetaEl) return;
    const hasSnapshot = snapshot && typeof snapshot === 'object' && (
        Array.isArray(snapshot.tasks) || Number.isFinite(Number(snapshot.generatedAt))
    );
    if (!hasSnapshot) {
        dom.taskGraphMetaEl.textContent = '尚未加载任务图';
        dom.taskGraphCanvasEl.innerHTML = '';
        return;
    }
    const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
    const generatedAt = Number(snapshot?.generatedAt || Date.now());
    const graph = buildGraph(tasks);

    dom.taskGraphMetaEl.textContent = `任务数 ${graph.nodes.length} · 更新于 ${new Date(generatedAt).toLocaleTimeString()}`;
    if (!graph.nodes.length) {
        dom.taskGraphCanvasEl.innerHTML = '<div class="empty-row">当前没有任务节点。</div>';
        return;
    }

    const edgeSvg = graph.edges.map((edge) => {
        const fromPos = graph.positions.get(edge.fromId);
        const toPos = graph.positions.get(edge.toId);
        return `<path class="task-edge" d="${buildEdgePath(fromPos, toPos)}"></path>`;
    }).join('');

    const nodeSvg = graph.nodes.map((node) => {
        const pos = graph.positions.get(node.id);
        return buildNodeSvg(node, pos);
    }).join('');

    const columnLabels = graph.columns.map((col) => {
        const x = PADDING_X + col * COL_WIDTH;
        const label = col === graph.anomalyLevel ? '异常区' : `层 ${col + 1}`;
        return `<text class="task-col-label" x="${x}" y="${PADDING_Y - 10}">${escapeHtml(label)}</text>`;
    }).join('');

    dom.taskGraphCanvasEl.innerHTML = `
        <svg class="task-graph-svg" viewBox="0 0 ${graph.width} ${graph.height}" role="img" aria-label="任务依赖图">
            <defs>
                <marker id="task-edge-arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
                    <path d="M0,0 L10,4 L0,8 Z"></path>
                </marker>
            </defs>
            ${columnLabels}
            <g class="task-edges">${edgeSvg}</g>
            <g class="task-nodes">${nodeSvg}</g>
        </svg>
    `;
}
