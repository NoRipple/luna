/* 主要职责：基于现有 MEMORY.md + daily logs 构建 graph-memory 风格图谱、召回与可视化查询。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('@photostructure/sqlite');

const NODE_TYPES = ['TASK', 'SKILL', 'EVENT'];
const EDGE_TYPES = ['USED_SKILL', 'SOLVED_BY', 'REQUIRES', 'PATCHES', 'CONFLICTS_WITH'];

function hashText(text) {
    return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function normalizeText(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text) {
    const normalized = normalizeText(text).toLowerCase();
    if (!normalized) return [];
    return normalized
        .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2);
}

function cosineSimilarity(a = [], b = []) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < len; i += 1) {
        const va = Number(a[i] || 0);
        const vb = Number(b[i] || 0);
        dot += va * vb;
        normA += va * va;
        normB += vb * vb;
    }
    if (normA <= 0 || normB <= 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function parseTimestamp(text) {
    const raw = String(text || '').trim();
    if (!raw) return Date.now();
    const normalized = raw.replace(/\//g, '-');
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed)) return parsed;
    return Date.now();
}

class GraphMemoryService {
    constructor({
        memoryStoreService,
        dbPath,
        dedupThreshold = 0.9,
        pagerankDamping = 0.85,
        pagerankIterations = 20,
        recallMaxNodes = 12,
        recallMaxDepth = 2
    } = {}) {
        if (!memoryStoreService) {
            throw new Error('GraphMemoryService requires memoryStoreService');
        }
        this.memoryStoreService = memoryStoreService;
        this.dbPath = path.resolve(
            String(
                dbPath
                || path.join(this.memoryStoreService.workspaceDir, '.memory-graph', 'graph-memory.db')
            )
        );
        this.dedupThreshold = Number(dedupThreshold) || 0.9;
        this.pagerankDamping = Number(pagerankDamping) || 0.85;
        this.pagerankIterations = Math.max(4, Number(pagerankIterations) || 20);
        this.recallMaxNodes = Math.max(3, Number(recallMaxNodes) || 12);
        this.recallMaxDepth = Math.max(1, Number(recallMaxDepth) || 2);
        this.db = null;
        this.ready = false;
        this.maintenanceCounter = 0;
        this.lastStats = {
            nodes: 0,
            edges: 0,
            messages: 0,
            communities: 0,
            generatedAt: Date.now()
        };
    }

    ensureReady() {
        if (this.ready && this.db) return;
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA synchronous = NORMAL;');
        this.db.exec('PRAGMA temp_store = MEMORY;');
        this.initSchema();
        this.ready = true;
    }

    initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS gm_messages (
                id TEXT PRIMARY KEY,
                source_path TEXT NOT NULL,
                source_tier TEXT NOT NULL,
                line_start INTEGER NOT NULL DEFAULT 1,
                line_end INTEGER NOT NULL DEFAULT 1,
                content TEXT NOT NULL,
                content_hash TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,
                extracted INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS gm_nodes (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                content TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                validated_count INTEGER NOT NULL DEFAULT 1,
                source_sessions TEXT NOT NULL DEFAULT '[]',
                source_tier TEXT NOT NULL DEFAULT 'session',
                source_path TEXT NOT NULL DEFAULT '',
                source_line INTEGER NOT NULL DEFAULT 1,
                source_message_id TEXT NOT NULL DEFAULT '',
                community_id TEXT,
                pagerank REAL NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS gm_edges (
                id TEXT PRIMARY KEY,
                from_id TEXT NOT NULL,
                to_id TEXT NOT NULL,
                type TEXT NOT NULL,
                instruction TEXT NOT NULL DEFAULT '',
                condition TEXT NOT NULL DEFAULT '',
                session_id TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS gm_vectors (
                id TEXT PRIMARY KEY,
                owner_type TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                vector_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS gm_communities (
                id TEXT PRIMARY KEY,
                summary TEXT NOT NULL DEFAULT '',
                size INTEGER NOT NULL DEFAULT 0,
                member_ids TEXT NOT NULL DEFAULT '[]',
                embedding_vector_id TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS gm_node_messages (
                node_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                PRIMARY KEY(node_id, message_id)
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS gm_nodes_fts USING fts5(
                node_id UNINDEXED,
                name,
                description,
                content
            );
        `);
    }

    ingestAndMaintain({ reason = 'manual' } = {}) {
        this.ensureReady();
        const ingestStats = this.ingestSources();
        const extracted = this.extractPendingMessages();
        this.maintenanceCounter += 1;
        if (extracted > 0 || this.maintenanceCounter % 5 === 0 || reason === 'session_end') {
            this.runMaintenance();
            this.maintenanceCounter = 0;
        }
        this.lastStats = this.queryStats();
        return {
            ok: true,
            reason,
            ingest: ingestStats,
            extracted,
            stats: this.lastStats
        };
    }

    ingestSources() {
        const sources = this.memoryStoreService.listMemorySources();
        let inserted = 0;
        for (const sourcePath of sources) {
            if (!fs.existsSync(sourcePath)) continue;
            const raw = fs.readFileSync(sourcePath, 'utf8');
            const relPath = path.relative(this.memoryStoreService.workspaceDir, sourcePath).replace(/\\/g, '/');
            const tier = /(^|\/)MEMORY\.md$/i.test(relPath) ? 'longterm' : 'session';
            const entries = this.parseEntries(raw, relPath, tier);
            for (const entry of entries) {
                if (this.insertMessage(entry)) {
                    inserted += 1;
                }
            }
        }
        return {
            sources: sources.length,
            inserted
        };
    }

    parseEntries(raw, relPath, tier) {
        const lines = String(raw || '').split(/\r?\n/);
        const entries = [];
        let cursor = null;

        const flush = () => {
            if (!cursor) return;
            const content = normalizeText(cursor.parts.join('\n'));
            if (!content) {
                cursor = null;
                return;
            }
            entries.push({
                sourcePath: relPath,
                sourceTier: tier,
                lineStart: cursor.lineStart,
                lineEnd: cursor.lineEnd,
                content,
                createdAt: cursor.timestamp
            });
            cursor = null;
        };

        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            const bullet = line.match(/^\s*-\s*\[([^\]]+)\]\s*(.*)$/);
            if (bullet) {
                flush();
                cursor = {
                    lineStart: i + 1,
                    lineEnd: i + 1,
                    timestamp: parseTimestamp(bullet[1]),
                    parts: [bullet[2] || '']
                };
                continue;
            }

            if (cursor) {
                if (/^\s*-\s+/.test(line)) {
                    flush();
                    cursor = {
                        lineStart: i + 1,
                        lineEnd: i + 1,
                        timestamp: Date.now(),
                        parts: [line.replace(/^\s*-\s+/, '')]
                    };
                } else if (String(line || '').trim()) {
                    cursor.parts.push(line);
                    cursor.lineEnd = i + 1;
                } else {
                    flush();
                }
            }
        }
        flush();
        return entries;
    }

    insertMessage(entry = {}) {
        const normalizedContent = normalizeText(entry.content || '');
        if (!normalizedContent) return false;
        const contentHash = hashText(`${entry.sourcePath}:${entry.lineStart}:${normalizedContent}`);
        const messageId = `msg_${contentHash.slice(0, 16)}`;

        const exists = this.db
            .prepare('SELECT id FROM gm_messages WHERE content_hash = ?')
            .get(contentHash);
        if (exists?.id) return false;

        this.db.prepare(`
            INSERT INTO gm_messages (id, source_path, source_tier, line_start, line_end, content, content_hash, created_at, extracted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
            messageId,
            entry.sourcePath,
            entry.sourceTier || 'session',
            Number(entry.lineStart || 1),
            Number(entry.lineEnd || entry.lineStart || 1),
            normalizedContent,
            contentHash,
            Number(entry.createdAt || Date.now())
        );
        return true;
    }

    extractPendingMessages(limit = 200) {
        const rows = this.db.prepare(`
            SELECT id, source_path, source_tier, line_start, line_end, content, created_at
            FROM gm_messages
            WHERE extracted = 0
            ORDER BY created_at ASC
            LIMIT ?
        `).all(Number(limit));
        if (!Array.isArray(rows) || rows.length === 0) return 0;

        for (const row of rows) {
            this.extractFromMessage(row);
            this.db.prepare('UPDATE gm_messages SET extracted = 1 WHERE id = ?').run(row.id);
        }
        return rows.length;
    }

    classifyNodeType(text) {
        const source = String(text || '');
        if (/error|failed|异常|报错|失败|冲突|崩溃|卡住/i.test(source)) return 'EVENT';
        if (/修复|解决|方案|步骤|命令|配置|install|fix|workaround|迁移|patch/i.test(source)) return 'SKILL';
        return 'TASK';
    }

    extractSegments(content) {
        const normalized = normalizeText(content || '');
        if (!normalized) return [];
        const parts = normalized.split(/[。！？!?；;]+/).map((item) => normalizeText(item)).filter(Boolean);
        if (parts.length === 0) return [normalized];
        return parts.slice(0, 4);
    }

    buildNodeName(text, maxLen = 42) {
        const normalized = normalizeText(text || '');
        if (!normalized) return '(empty)';
        if (normalized.length <= maxLen) return normalized;
        return `${normalized.slice(0, maxLen - 1)}…`;
    }

    embedText(text, dimension = 128) {
        const vector = new Array(dimension).fill(0);
        const tokens = tokenize(text);
        if (tokens.length === 0) return vector;
        for (const token of tokens) {
            const digest = crypto.createHash('md5').update(token).digest();
            const index = digest[0] % dimension;
            const sign = digest[1] % 2 === 0 ? 1 : -1;
            const magnitude = (digest[2] / 255) + 0.2;
            vector[index] += sign * magnitude;
        }
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        if (norm > 0) {
            for (let i = 0; i < vector.length; i += 1) {
                vector[i] /= norm;
            }
        }
        return vector;
    }

    upsertNode(node = {}) {
        const now = Date.now();
        const type = NODE_TYPES.includes(node.type) ? node.type : 'TASK';
        const normalizedContent = normalizeText(node.content || '');
        const name = this.buildNodeName(node.name || normalizedContent);
        const key = hashText(`${type}:${name.toLowerCase()}`);
        const id = `node_${key.slice(0, 16)}`;
        const existing = this.db.prepare('SELECT id, validated_count, source_sessions FROM gm_nodes WHERE id = ?').get(id);
        const sourceSessions = Array.isArray(node.sourceSessions) ? node.sourceSessions.filter(Boolean) : [];
        if (!sourceSessions.length && node.sessionId) sourceSessions.push(node.sessionId);

        if (existing?.id) {
            let mergedSessions = [];
            try {
                const parsed = JSON.parse(existing.source_sessions || '[]');
                if (Array.isArray(parsed)) mergedSessions = parsed;
            } catch (error) {
                mergedSessions = [];
            }
            for (const session of sourceSessions) {
                if (!mergedSessions.includes(session)) mergedSessions.push(session);
            }
            this.db.prepare(`
                UPDATE gm_nodes
                SET description = ?,
                    content = ?,
                    validated_count = ?,
                    source_sessions = ?,
                    source_tier = ?,
                    source_path = ?,
                    source_line = ?,
                    source_message_id = ?,
                    updated_at = ?
                WHERE id = ?
            `).run(
                String(node.description || normalizedContent),
                normalizedContent,
                Number(existing.validated_count || 0) + 1,
                JSON.stringify(mergedSessions),
                String(node.sourceTier || 'session'),
                String(node.sourcePath || ''),
                Number(node.sourceLine || 1),
                String(node.sourceMessageId || ''),
                now,
                id
            );
            this.db.prepare(`
                UPDATE gm_nodes_fts
                SET name = ?, description = ?, content = ?
                WHERE node_id = ?
            `).run(name, String(node.description || normalizedContent), normalizedContent, id);
        } else {
            this.db.prepare(`
                INSERT INTO gm_nodes (
                    id, type, name, description, content, status, validated_count, source_sessions,
                    source_tier, source_path, source_line, source_message_id, community_id,
                    pagerank, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
            `).run(
                id,
                type,
                name,
                String(node.description || normalizedContent),
                normalizedContent,
                JSON.stringify(sourceSessions),
                String(node.sourceTier || 'session'),
                String(node.sourcePath || ''),
                Number(node.sourceLine || 1),
                String(node.sourceMessageId || ''),
                now,
                now
            );
            this.db.prepare(`
                INSERT INTO gm_nodes_fts (rowid, node_id, name, description, content)
                VALUES ((SELECT rowid FROM gm_nodes WHERE id = ?), ?, ?, ?, ?)
            `).run(id, id, name, String(node.description || normalizedContent), normalizedContent);
        }

        const vector = this.embedText(`${name}\n${normalizedContent}`);
        this.upsertVector('node', id, vector);
        return id;
    }

    upsertVector(ownerType, ownerId, vector = []) {
        const id = `${ownerType}_${ownerId}`;
        const exists = this.db.prepare('SELECT id FROM gm_vectors WHERE id = ?').get(id);
        if (exists?.id) {
            this.db.prepare('UPDATE gm_vectors SET vector_json = ?, created_at = ? WHERE id = ?')
                .run(JSON.stringify(vector), Date.now(), id);
            return;
        }
        this.db.prepare(`
            INSERT INTO gm_vectors (id, owner_type, owner_id, vector_json, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, ownerType, ownerId, JSON.stringify(vector), Date.now());
    }

    getNodeVector(nodeId) {
        const row = this.db.prepare(`
            SELECT vector_json FROM gm_vectors WHERE owner_type = 'node' AND owner_id = ?
        `).get(nodeId);
        if (!row?.vector_json) return [];
        try {
            const parsed = JSON.parse(row.vector_json);
            if (Array.isArray(parsed)) return parsed.map((item) => Number(item || 0));
        } catch (error) {
            return [];
        }
        return [];
    }

    insertEdge({
        fromId,
        toId,
        type,
        instruction = '',
        condition = '',
        sessionId = ''
    } = {}) {
        if (!fromId || !toId || fromId === toId) return;
        const normalizedType = EDGE_TYPES.includes(type) ? type : 'REQUIRES';
        const edgeId = `edge_${hashText(`${fromId}:${toId}:${normalizedType}`).slice(0, 16)}`;
        const exists = this.db.prepare('SELECT id FROM gm_edges WHERE id = ?').get(edgeId);
        if (exists?.id) return;
        this.db.prepare(`
            INSERT INTO gm_edges (id, from_id, to_id, type, instruction, condition, session_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            edgeId,
            fromId,
            toId,
            normalizedType,
            String(instruction || ''),
            String(condition || ''),
            String(sessionId || ''),
            Date.now()
        );
    }

    extractFromMessage(message = {}) {
        const segments = this.extractSegments(message.content || '');
        if (segments.length === 0) return;

        const createdNodeIds = [];
        const sessionId = path.basename(String(message.source_path || ''), '.md');
        for (const segment of segments) {
            const type = this.classifyNodeType(segment);
            const nodeId = this.upsertNode({
                type,
                name: this.buildNodeName(segment),
                description: segment,
                content: segment,
                sourceTier: message.source_tier,
                sourcePath: message.source_path,
                sourceLine: Number(message.line_start || 1),
                sourceMessageId: message.id,
                sessionId,
                sourceSessions: sessionId ? [sessionId] : []
            });
            createdNodeIds.push({ id: nodeId, type, content: segment });
            this.db.prepare(`
                INSERT OR IGNORE INTO gm_node_messages (node_id, message_id)
                VALUES (?, ?)
            `).run(nodeId, message.id);
        }

        this.linkNodesWithinMessage(createdNodeIds, sessionId);
        this.linkNodesAcrossGraph(createdNodeIds, sessionId);
    }

    linkNodesWithinMessage(nodeItems = [], sessionId = '') {
        for (let i = 0; i < nodeItems.length; i += 1) {
            for (let j = i + 1; j < nodeItems.length; j += 1) {
                const left = nodeItems[i];
                const right = nodeItems[j];
                const pair = `${left.type}|${right.type}`;
                if (pair === 'TASK|SKILL') {
                    this.insertEdge({
                        fromId: left.id,
                        toId: right.id,
                        type: 'USED_SKILL',
                        instruction: 'Task uses skill from same memory entry.',
                        sessionId
                    });
                } else if (pair === 'EVENT|SKILL') {
                    this.insertEdge({
                        fromId: left.id,
                        toId: right.id,
                        type: /修复|解决|fix|workaround/i.test(`${left.content}\n${right.content}`)
                            ? 'SOLVED_BY'
                            : 'REQUIRES',
                        instruction: 'Event and skill co-occurred in same memory entry.',
                        sessionId
                    });
                } else if (pair === 'TASK|EVENT') {
                    this.insertEdge({
                        fromId: left.id,
                        toId: right.id,
                        type: 'REQUIRES',
                        instruction: 'Task linked with event in same memory entry.',
                        sessionId
                    });
                }
            }
        }
    }

    isContradiction(leftText, rightText) {
        const a = String(leftText || '');
        const b = String(rightText || '');
        const contradictionGroups = [
            ['喜欢', '不喜欢'],
            ['always', 'never'],
            ['enabled', 'disabled'],
            ['允许', '禁止']
        ];
        return contradictionGroups.some(([positive, negative]) => (
            (a.includes(positive) && b.includes(negative))
            || (a.includes(negative) && b.includes(positive))
        ));
    }

    linkNodesAcrossGraph(createdNodeItems = [], sessionId = '') {
        if (!Array.isArray(createdNodeItems) || createdNodeItems.length === 0) return;
        const activeNodes = this.db.prepare(`
            SELECT id, type, content FROM gm_nodes WHERE status = 'active'
        `).all();
        const vectors = new Map();
        for (const node of activeNodes) {
            vectors.set(node.id, this.getNodeVector(node.id));
        }

        for (const current of createdNodeItems) {
            const currentVector = vectors.get(current.id) || this.getNodeVector(current.id);
            let bestSkill = { id: '', score: 0 };
            let bestEvent = { id: '', score: 0 };
            let bestTask = { id: '', score: 0 };
            let bestSimilarSkill = { id: '', score: 0 };

            for (const node of activeNodes) {
                if (node.id === current.id) continue;
                const score = cosineSimilarity(currentVector, vectors.get(node.id) || []);
                if (score <= 0.72) continue;

                if (node.type === 'SKILL' && score > bestSkill.score) {
                    bestSkill = { id: node.id, score };
                }
                if (node.type === 'EVENT' && score > bestEvent.score) {
                    bestEvent = { id: node.id, score };
                }
                if (node.type === 'TASK' && score > bestTask.score) {
                    bestTask = { id: node.id, score };
                }
                if (current.type === 'SKILL' && node.type === 'SKILL' && score > bestSimilarSkill.score) {
                    bestSimilarSkill = { id: node.id, score };
                }

                if (this.isContradiction(current.content, node.content) && score > 0.75) {
                    this.insertEdge({
                        fromId: current.id,
                        toId: node.id,
                        type: 'CONFLICTS_WITH',
                        instruction: 'Potential contradiction detected by semantic similarity.',
                        sessionId
                    });
                }
            }

            if (current.type === 'TASK' && bestSkill.id) {
                this.insertEdge({
                    fromId: current.id,
                    toId: bestSkill.id,
                    type: 'USED_SKILL',
                    instruction: `Linked by semantic similarity (${bestSkill.score.toFixed(2)}).`,
                    sessionId
                });
            }
            if (current.type === 'EVENT' && bestSkill.id) {
                this.insertEdge({
                    fromId: current.id,
                    toId: bestSkill.id,
                    type: 'SOLVED_BY',
                    instruction: `Linked by semantic similarity (${bestSkill.score.toFixed(2)}).`,
                    sessionId
                });
            }
            if (current.type === 'TASK' && bestEvent.id) {
                this.insertEdge({
                    fromId: current.id,
                    toId: bestEvent.id,
                    type: 'REQUIRES',
                    instruction: `Task-event relation by semantic similarity (${bestEvent.score.toFixed(2)}).`,
                    sessionId
                });
            }
            if (current.type === 'SKILL' && bestTask.id) {
                this.insertEdge({
                    fromId: bestTask.id,
                    toId: current.id,
                    type: 'USED_SKILL',
                    instruction: `Task linked to newly extracted skill (${bestTask.score.toFixed(2)}).`,
                    sessionId
                });
            }
            if (
                current.type === 'SKILL'
                && bestSimilarSkill.id
                && /patch|修复|更新|升级|hotfix/i.test(current.content)
                && bestSimilarSkill.score > 0.8
            ) {
                this.insertEdge({
                    fromId: current.id,
                    toId: bestSimilarSkill.id,
                    type: 'PATCHES',
                    instruction: `Skill patch relation by semantic similarity (${bestSimilarSkill.score.toFixed(2)}).`,
                    sessionId
                });
            }
        }
    }

    runMaintenance() {
        this.dedupNodes();
        this.computeGlobalPageRank();
        this.detectCommunities();
        this.summarizeCommunities();
    }

    dedupNodes() {
        const nodes = this.db.prepare(`
            SELECT id, type, validated_count, source_sessions
            FROM gm_nodes
            WHERE status = 'active'
            ORDER BY validated_count DESC
        `).all();
        if (nodes.length < 2) return;

        const vectors = new Map();
        for (const node of nodes) {
            vectors.set(node.id, this.getNodeVector(node.id));
        }

        for (let i = 0; i < nodes.length; i += 1) {
            const keepNode = nodes[i];
            if (!keepNode || keepNode.status === 'deprecated') continue;
            for (let j = i + 1; j < nodes.length; j += 1) {
                const dropNode = nodes[j];
                if (!dropNode || dropNode.type !== keepNode.type) continue;
                const similarity = cosineSimilarity(vectors.get(keepNode.id), vectors.get(dropNode.id));
                if (similarity < this.dedupThreshold) continue;
                this.mergeNode(keepNode.id, dropNode.id);
                nodes[j] = null;
            }
        }
    }

    mergeNode(keepId, dropId) {
        if (!keepId || !dropId || keepId === dropId) return;
        const keep = this.db.prepare(`
            SELECT validated_count, source_sessions FROM gm_nodes WHERE id = ?
        `).get(keepId);
        const drop = this.db.prepare(`
            SELECT validated_count, source_sessions FROM gm_nodes WHERE id = ?
        `).get(dropId);
        if (!keep || !drop) return;

        let sessions = [];
        try {
            const left = JSON.parse(keep.source_sessions || '[]');
            const right = JSON.parse(drop.source_sessions || '[]');
            if (Array.isArray(left)) sessions.push(...left);
            if (Array.isArray(right)) sessions.push(...right);
            sessions = Array.from(new Set(sessions));
        } catch (error) {
            sessions = [];
        }

        this.db.prepare(`
            UPDATE gm_nodes
            SET validated_count = ?, source_sessions = ?, updated_at = ?
            WHERE id = ?
        `).run(
            Number(keep.validated_count || 0) + Number(drop.validated_count || 0),
            JSON.stringify(sessions),
            Date.now(),
            keepId
        );

        this.db.prepare('UPDATE gm_edges SET from_id = ? WHERE from_id = ?').run(keepId, dropId);
        this.db.prepare('UPDATE gm_edges SET to_id = ? WHERE to_id = ?').run(keepId, dropId);
        this.db.prepare('UPDATE gm_node_messages SET node_id = ? WHERE node_id = ?').run(keepId, dropId);
        this.db.prepare('DELETE FROM gm_vectors WHERE owner_type = \'node\' AND owner_id = ?').run(dropId);
        this.db.prepare('DELETE FROM gm_nodes_fts WHERE node_id = ?').run(dropId);
        this.db.prepare('UPDATE gm_nodes SET status = \'deprecated\', updated_at = ? WHERE id = ?').run(Date.now(), dropId);
        this.db.exec(`
            DELETE FROM gm_edges
            WHERE rowid NOT IN (
                SELECT MIN(rowid)
                FROM gm_edges
                GROUP BY from_id, to_id, type
            )
        `);
    }

    computeGlobalPageRank() {
        const nodes = this.db.prepare(`
            SELECT id FROM gm_nodes WHERE status = 'active'
        `).all().map((item) => item.id);
        if (!nodes.length) return;
        const indexById = new Map(nodes.map((id, idx) => [id, idx]));
        const edges = this.db.prepare(`
            SELECT from_id, to_id FROM gm_edges
            WHERE from_id IN (SELECT id FROM gm_nodes WHERE status = 'active')
              AND to_id IN (SELECT id FROM gm_nodes WHERE status = 'active')
        `).all();

        const out = Array.from({ length: nodes.length }, () => []);
        for (const edge of edges) {
            const from = indexById.get(edge.from_id);
            const to = indexById.get(edge.to_id);
            if (from === undefined || to === undefined) continue;
            out[from].push(to);
        }

        let scores = new Array(nodes.length).fill(1 / nodes.length);
        const d = clamp(this.pagerankDamping, 0.5, 0.95);
        const base = (1 - d) / nodes.length;

        for (let it = 0; it < this.pagerankIterations; it += 1) {
            const next = new Array(nodes.length).fill(base);
            for (let i = 0; i < nodes.length; i += 1) {
                if (!out[i].length) {
                    const spread = d * scores[i] / nodes.length;
                    for (let j = 0; j < nodes.length; j += 1) next[j] += spread;
                    continue;
                }
                const spread = d * scores[i] / out[i].length;
                for (const to of out[i]) next[to] += spread;
            }
            scores = next;
        }

        const stmt = this.db.prepare('UPDATE gm_nodes SET pagerank = ? WHERE id = ?');
        for (let i = 0; i < nodes.length; i += 1) {
            stmt.run(Number(scores[i] || 0), nodes[i]);
        }
    }

    detectCommunities() {
        const nodes = this.db.prepare(`
            SELECT id FROM gm_nodes WHERE status = 'active'
        `).all().map((item) => item.id);
        const adjacency = new Map(nodes.map((id) => [id, new Set()]));
        const edges = this.db.prepare(`
            SELECT from_id, to_id FROM gm_edges
            WHERE from_id IN (SELECT id FROM gm_nodes WHERE status = 'active')
              AND to_id IN (SELECT id FROM gm_nodes WHERE status = 'active')
        `).all();
        for (const edge of edges) {
            if (!adjacency.has(edge.from_id) || !adjacency.has(edge.to_id)) continue;
            adjacency.get(edge.from_id).add(edge.to_id);
            adjacency.get(edge.to_id).add(edge.from_id);
        }

        const visited = new Set();
        let seq = 1;
        for (const nodeId of nodes) {
            if (visited.has(nodeId)) continue;
            const queue = [nodeId];
            const members = [];
            visited.add(nodeId);
            while (queue.length) {
                const current = queue.shift();
                members.push(current);
                const neighbors = Array.from(adjacency.get(current) || []);
                for (const neighbor of neighbors) {
                    if (visited.has(neighbor)) continue;
                    visited.add(neighbor);
                    queue.push(neighbor);
                }
            }
            const communityId = `community_${String(seq).padStart(3, '0')}`;
            seq += 1;
            const updateStmt = this.db.prepare('UPDATE gm_nodes SET community_id = ? WHERE id = ?');
            for (const member of members) {
                updateStmt.run(communityId, member);
            }
        }
    }

    summarizeCommunities() {
        const communities = this.db.prepare(`
            SELECT community_id AS id,
                   COUNT(*) AS size
            FROM gm_nodes
            WHERE status = 'active' AND community_id IS NOT NULL
            GROUP BY community_id
        `).all();
        const now = Date.now();

        for (const community of communities) {
            const members = this.db.prepare(`
                SELECT id, name, type, description, pagerank
                FROM gm_nodes
                WHERE status = 'active' AND community_id = ?
                ORDER BY pagerank DESC, validated_count DESC
                LIMIT 8
            `).all(community.id);
            const summary = this.buildCommunitySummary(members);
            const memberIds = members.map((item) => item.id);
            const embeddingVector = this.embedText(summary);
            const vectorId = `community_${community.id}`;
            this.upsertVector('community', community.id, embeddingVector);

            const exists = this.db.prepare('SELECT id FROM gm_communities WHERE id = ?').get(community.id);
            if (exists?.id) {
                this.db.prepare(`
                    UPDATE gm_communities
                    SET summary = ?, size = ?, member_ids = ?, embedding_vector_id = ?, updated_at = ?
                    WHERE id = ?
                `).run(
                    summary,
                    Number(community.size || 0),
                    JSON.stringify(memberIds),
                    vectorId,
                    now,
                    community.id
                );
            } else {
                this.db.prepare(`
                    INSERT INTO gm_communities (
                        id, summary, size, member_ids, embedding_vector_id, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(
                    community.id,
                    summary,
                    Number(community.size || 0),
                    JSON.stringify(memberIds),
                    vectorId,
                    now,
                    now
                );
            }
        }
    }

    buildCommunitySummary(members = []) {
        if (!Array.isArray(members) || members.length === 0) return 'Empty community.';
        const head = members.slice(0, 4);
        const topics = head.map((item) => `${item.type}:${item.name}`).join(' | ');
        return `Community topics: ${topics}`;
    }

    ftsSearchSeeds(query, limit = 12) {
        const normalized = normalizeText(query || '');
        if (!normalized) return [];
        try {
            return this.db.prepare(`
                SELECT n.id AS node_id, bm25(gm_nodes_fts) AS score
                FROM gm_nodes_fts
                JOIN gm_nodes n ON n.id = gm_nodes_fts.node_id
                WHERE gm_nodes_fts MATCH ? AND n.status = 'active'
                ORDER BY score
                LIMIT ?
            `).all(normalized, Number(limit))
                .map((item) => ({ id: item.node_id, score: 1 / (1 + Math.max(0, Number(item.score || 0))) }));
        } catch (error) {
            return this.db.prepare(`
                SELECT id AS node_id
                FROM gm_nodes
                WHERE status = 'active' AND (name LIKE ? OR description LIKE ? OR content LIKE ?)
                LIMIT ?
            `).all(`%${normalized}%`, `%${normalized}%`, `%${normalized}%`, Number(limit))
                .map((item) => ({ id: item.node_id, score: 0.45 }));
        }
    }

    vectorSearchSeeds(queryVector = [], limit = 12) {
        if (!Array.isArray(queryVector) || queryVector.length === 0) return [];
        const nodes = this.db.prepare(`
            SELECT owner_id AS node_id, vector_json
            FROM gm_vectors
            WHERE owner_type = 'node'
              AND owner_id IN (SELECT id FROM gm_nodes WHERE status = 'active')
        `).all();
        const scored = [];
        for (const row of nodes) {
            let vector = [];
            try {
                const parsed = JSON.parse(row.vector_json || '[]');
                if (Array.isArray(parsed)) vector = parsed;
            } catch (error) {
                vector = [];
            }
            const score = cosineSimilarity(queryVector, vector);
            if (score > 0.35) {
                scored.push({ id: row.node_id, score });
            }
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, Number(limit));
    }

    getCommunityMembers(communityIds = []) {
        if (!Array.isArray(communityIds) || communityIds.length === 0) return [];
        const placeholders = communityIds.map(() => '?').join(',');
        return this.db.prepare(`
            SELECT id FROM gm_nodes
            WHERE status = 'active' AND community_id IN (${placeholders})
        `).all(...communityIds).map((item) => item.id);
    }

    graphWalk(seedIds = [], depth = 2) {
        const uniqueSeeds = Array.from(new Set(seedIds.filter(Boolean)));
        if (!uniqueSeeds.length) return [];
        const visited = new Set(uniqueSeeds);
        let frontier = uniqueSeeds.slice();
        for (let step = 0; step < depth; step += 1) {
            if (!frontier.length) break;
            const placeholders = frontier.map(() => '?').join(',');
            const rows = this.db.prepare(`
                SELECT from_id, to_id FROM gm_edges
                WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})
            `).all(...frontier, ...frontier);
            const next = [];
            for (const row of rows) {
                const pair = [row.from_id, row.to_id];
                for (const id of pair) {
                    if (!visited.has(id)) {
                        visited.add(id);
                        next.push(id);
                    }
                }
            }
            frontier = next;
        }
        return Array.from(visited);
    }

    computePersonalizedPageRank(candidateIds = [], seedScores = new Map(), iterations = 16) {
        const nodes = Array.from(new Set(candidateIds.filter(Boolean)));
        if (!nodes.length) return new Map();
        const idx = new Map(nodes.map((id, i) => [id, i]));
        const adjacency = Array.from({ length: nodes.length }, () => []);
        const placeholders = nodes.map(() => '?').join(',');
        const edges = this.db.prepare(`
            SELECT from_id, to_id
            FROM gm_edges
            WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})
        `).all(...nodes, ...nodes);
        for (const edge of edges) {
            const from = idx.get(edge.from_id);
            const to = idx.get(edge.to_id);
            if (from === undefined || to === undefined) continue;
            adjacency[from].push(to);
        }

        const teleport = new Array(nodes.length).fill(0);
        let teleportSum = 0;
        for (const [id, score] of seedScores.entries()) {
            const index = idx.get(id);
            if (index === undefined) continue;
            const value = Math.max(0, Number(score || 0));
            teleport[index] += value;
            teleportSum += value;
        }
        if (teleportSum <= 0) {
            for (let i = 0; i < teleport.length; i += 1) teleport[i] = 1 / nodes.length;
        } else {
            for (let i = 0; i < teleport.length; i += 1) teleport[i] /= teleportSum;
        }

        const damping = clamp(this.pagerankDamping, 0.5, 0.95);
        let ranks = teleport.slice();
        for (let iter = 0; iter < iterations; iter += 1) {
            const next = new Array(nodes.length).fill(0);
            for (let i = 0; i < nodes.length; i += 1) {
                if (!adjacency[i].length) {
                    const spread = damping * ranks[i] / nodes.length;
                    for (let j = 0; j < nodes.length; j += 1) next[j] += spread;
                    continue;
                }
                const spread = damping * ranks[i] / adjacency[i].length;
                for (const to of adjacency[i]) next[to] += spread;
            }
            for (let i = 0; i < nodes.length; i += 1) {
                next[i] += (1 - damping) * teleport[i];
            }
            ranks = next;
        }

        const result = new Map();
        for (let i = 0; i < nodes.length; i += 1) {
            result.set(nodes[i], Number(ranks[i] || 0));
        }
        return result;
    }

    recall(query, options = {}) {
        this.ensureReady();
        this.ingestAndMaintain({ reason: 'recall' });
        const normalizedQuery = normalizeText(query || '');
        const maxNodes = Math.max(3, Number(options.maxNodes || this.recallMaxNodes));
        const depth = Math.max(1, Number(options.depth || this.recallMaxDepth));

        if (!normalizedQuery) {
            const nodes = this.db.prepare(`
                SELECT * FROM gm_nodes
                WHERE status = 'active'
                ORDER BY pagerank DESC, validated_count DESC
                LIMIT ?
            `).all(maxNodes);
            const nodeIds = nodes.map((item) => item.id);
            const edges = this.getEdgesAmong(nodeIds);
            return this.buildRecallPayload(nodes, edges, new Map(), normalizedQuery, {
                preciseSeeds: [],
                generalizedCommunities: []
            });
        }

        const queryVector = this.embedText(normalizedQuery);
        const ftsSeeds = this.ftsSearchSeeds(normalizedQuery, maxNodes * 2);
        const vectorSeeds = this.vectorSearchSeeds(queryVector, maxNodes * 2);
        const preciseSeedScores = new Map();
        for (const seed of [...ftsSeeds, ...vectorSeeds]) {
            const prev = preciseSeedScores.get(seed.id) || 0;
            preciseSeedScores.set(seed.id, Math.max(prev, Number(seed.score || 0)));
        }

        const preciseSeedIds = Array.from(preciseSeedScores.keys());
        const preciseCommunityRows = preciseSeedIds.length
            ? this.db.prepare(`
                SELECT DISTINCT community_id FROM gm_nodes
                WHERE id IN (${preciseSeedIds.map(() => '?').join(',')}) AND community_id IS NOT NULL
            `).all(...preciseSeedIds)
            : [];
        const preciseCommunityIds = preciseCommunityRows.map((item) => item.community_id).filter(Boolean);
        const preciseCommunityMembers = this.getCommunityMembers(preciseCommunityIds);
        const preciseCandidates = this.graphWalk(
            [...preciseSeedIds, ...preciseCommunityMembers],
            depth
        );
        const precisePpr = this.computePersonalizedPageRank(preciseCandidates, preciseSeedScores, 18);

        const communityRows = this.db.prepare(`
            SELECT c.id, c.summary, v.vector_json
            FROM gm_communities c
            LEFT JOIN gm_vectors v
              ON v.owner_type = 'community' AND v.owner_id = c.id
        `).all();
        const generalizedCommunityScores = [];
        for (const row of communityRows) {
            if (!row.vector_json) continue;
            let vector = [];
            try {
                const parsed = JSON.parse(row.vector_json);
                if (Array.isArray(parsed)) vector = parsed;
            } catch (error) {
                vector = [];
            }
            const score = cosineSimilarity(queryVector, vector);
            if (score > 0.35) generalizedCommunityScores.push({ id: row.id, score });
        }
        generalizedCommunityScores.sort((a, b) => b.score - a.score);
        const generalizedCommunityIds = generalizedCommunityScores.slice(0, 3).map((item) => item.id);
        const generalizedMembers = this.getCommunityMembers(generalizedCommunityIds);
        const generalizedSeedScores = new Map(generalizedMembers.map((id) => [id, 0.42]));
        const generalizedCandidates = this.graphWalk(generalizedMembers, 1);
        const generalizedPpr = this.computePersonalizedPageRank(generalizedCandidates, generalizedSeedScores, 12);

        const mergedScores = new Map();
        const writeScore = (id, score, weight) => {
            const prev = mergedScores.get(id) || 0;
            mergedScores.set(id, prev + Number(score || 0) * weight);
        };
        for (const [id, score] of precisePpr.entries()) writeScore(id, score, 0.68);
        for (const [id, score] of generalizedPpr.entries()) writeScore(id, score, 0.32);
        for (const [id, score] of preciseSeedScores.entries()) writeScore(id, score, 0.25);

        const rankedIds = Array.from(mergedScores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxNodes)
            .map((item) => item[0]);
        const nodes = this.getNodesByIds(rankedIds);
        const edges = this.getEdgesAmong(rankedIds);

        return this.buildRecallPayload(nodes, edges, mergedScores, normalizedQuery, {
            preciseSeeds: preciseSeedIds,
            generalizedCommunities: generalizedCommunityIds
        });
    }

    getNodesByIds(ids = []) {
        if (!Array.isArray(ids) || ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(',');
        const rows = this.db.prepare(`
            SELECT *
            FROM gm_nodes
            WHERE id IN (${placeholders}) AND status = 'active'
        `).all(...ids);
        const order = new Map(ids.map((id, idx) => [id, idx]));
        rows.sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0));
        return rows;
    }

    getEdgesAmong(nodeIds = []) {
        if (!Array.isArray(nodeIds) || nodeIds.length === 0) return [];
        const placeholders = nodeIds.map(() => '?').join(',');
        return this.db.prepare(`
            SELECT *
            FROM gm_edges
            WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})
        `).all(...nodeIds, ...nodeIds);
    }

    buildRecallPayload(nodes = [], edges = [], scoreMap = new Map(), query = '', extras = {}) {
        const topTraceNodeIds = nodes.slice(0, 3).map((item) => item.id);
        const episodicTraces = topTraceNodeIds.map((nodeId) => ({
            nodeId,
            traces: this.getNodeMessages(nodeId, 2)
        }));
        return {
            query,
            nodes: nodes.map((node) => ({
                ...this.mapNode(node),
                recallScore: Number(scoreMap.get(node.id) || 0)
            })),
            edges: edges.map((edge) => this.mapEdge(edge)),
            episodicTraces,
            meta: {
                preciseSeeds: Array.isArray(extras.preciseSeeds) ? extras.preciseSeeds : [],
                generalizedCommunities: Array.isArray(extras.generalizedCommunities)
                    ? extras.generalizedCommunities
                    : [],
                generatedAt: Date.now()
            }
        };
    }

    getNodeMessages(nodeId, limit = 4) {
        if (!nodeId) return [];
        return this.db.prepare(`
            SELECT m.id, m.source_path, m.line_start, m.line_end, m.content, m.created_at
            FROM gm_node_messages nm
            JOIN gm_messages m ON m.id = nm.message_id
            WHERE nm.node_id = ?
            ORDER BY m.created_at DESC
            LIMIT ?
        `).all(nodeId, Number(limit)).map((row) => ({
            id: row.id,
            sourcePath: row.source_path,
            lineStart: Number(row.line_start || 1),
            lineEnd: Number(row.line_end || 1),
            content: row.content,
            createdAt: Number(row.created_at || Date.now())
        }));
    }

    mapNode(node = {}) {
        return {
            id: node.id,
            type: node.type,
            name: node.name,
            description: node.description,
            content: node.content,
            status: node.status,
            validatedCount: Number(node.validated_count || 0),
            sourceTier: node.source_tier || 'session',
            sourcePath: node.source_path || '',
            sourceLine: Number(node.source_line || 1),
            sourceMessageId: node.source_message_id || '',
            sourceSessions: (() => {
                try {
                    const parsed = JSON.parse(node.source_sessions || '[]');
                    return Array.isArray(parsed) ? parsed : [];
                } catch (error) {
                    return [];
                }
            })(),
            communityId: node.community_id || null,
            pagerank: Number(node.pagerank || 0),
            createdAt: Number(node.created_at || Date.now()),
            updatedAt: Number(node.updated_at || Date.now())
        };
    }

    mapEdge(edge = {}) {
        return {
            id: edge.id,
            fromId: edge.from_id,
            toId: edge.to_id,
            type: edge.type,
            instruction: edge.instruction || '',
            condition: edge.condition || '',
            sessionId: edge.session_id || '',
            createdAt: Number(edge.created_at || Date.now())
        };
    }

    getCommunityList() {
        return this.db.prepare(`
            SELECT id, summary, size, member_ids, updated_at
            FROM gm_communities
            ORDER BY size DESC, id ASC
        `).all().map((item) => ({
            id: item.id,
            summary: item.summary,
            size: Number(item.size || 0),
            memberIds: (() => {
                try {
                    const parsed = JSON.parse(item.member_ids || '[]');
                    return Array.isArray(parsed) ? parsed : [];
                } catch (error) {
                    return [];
                }
            })(),
            updatedAt: Number(item.updated_at || Date.now())
        }));
    }

    getMemoryGraph(options = {}) {
        this.ensureReady();
        this.ingestAndMaintain({ reason: 'panel_graph' });
        const query = normalizeText(options.query || '');
        const layers = Array.isArray(options.layers) && options.layers.length
            ? options.layers.map((item) => String(item))
            : ['longterm', 'session'];
        const includeLongterm = layers.includes('longterm');
        const includeSession = layers.includes('session');
        const days = Number.isFinite(Number(options.days)) ? Number(options.days) : null;
        const maxNodes = Math.max(10, Number(options.maxNodes || 600));

        if (query) {
            const recalled = this.recall(query, { maxNodes: Math.min(maxNodes, this.recallMaxNodes * 3) });
            return {
                ok: true,
                mode: 'recall',
                query,
                nodes: recalled.nodes,
                edges: recalled.edges,
                communities: this.getCommunityList(),
                episodicTraces: recalled.episodicTraces,
                stats: this.queryStats(),
                generatedAt: Date.now()
            };
        }

        const sinceTs = days && days > 0 ? (Date.now() - days * 24 * 3600 * 1000) : null;
        const rows = this.db.prepare(`
            SELECT *
            FROM gm_nodes
            WHERE status = 'active'
            ORDER BY pagerank DESC, updated_at DESC
            LIMIT ?
        `).all(maxNodes);

        const filteredNodes = rows.filter((node) => {
            const tier = String(node.source_tier || 'session');
            if (tier === 'longterm' && !includeLongterm) return false;
            if (tier !== 'longterm' && !includeSession) return false;
            if (sinceTs && Number(node.updated_at || 0) < sinceTs) return false;
            return true;
        }).map((node) => this.mapNode(node));

        const nodeIds = filteredNodes.map((node) => node.id);
        const edges = this.getEdgesAmong(nodeIds).map((edge) => this.mapEdge(edge));

        return {
            ok: true,
            mode: 'full',
            query: '',
            nodes: filteredNodes,
            edges,
            communities: this.getCommunityList(),
            episodicTraces: [],
            stats: this.queryStats(),
            generatedAt: Date.now()
        };
    }

    getRecallPreview(options = {}) {
        const query = normalizeText(options.query || '');
        const maxNodes = Math.max(3, Number(options.maxNodes || this.recallMaxNodes));
        return {
            ok: true,
            ...this.recall(query, {
                maxNodes,
                depth: Number(options.depth || this.recallMaxDepth)
            }),
            communities: this.getCommunityList(),
            stats: this.queryStats(),
            generatedAt: Date.now()
        };
    }

    getNodeDetail(nodeId) {
        this.ensureReady();
        const id = String(nodeId || '').trim();
        if (!id) {
            return { ok: false, message: 'nodeId is required' };
        }
        const node = this.db.prepare(`
            SELECT * FROM gm_nodes WHERE id = ?
        `).get(id);
        if (!node) {
            return { ok: false, message: `Node not found: ${id}` };
        }
        const edges = this.db.prepare(`
            SELECT * FROM gm_edges
            WHERE from_id = ? OR to_id = ?
            ORDER BY created_at DESC
            LIMIT 120
        `).all(id, id).map((edge) => this.mapEdge(edge));
        const traces = this.getNodeMessages(id, 8);
        return {
            ok: true,
            node: this.mapNode(node),
            edges,
            traces,
            generatedAt: Date.now()
        };
    }

    queryStats() {
        const messages = this.db.prepare('SELECT COUNT(*) AS c FROM gm_messages').get()?.c || 0;
        const nodes = this.db.prepare(`
            SELECT COUNT(*) AS c FROM gm_nodes WHERE status = 'active'
        `).get()?.c || 0;
        const edges = this.db.prepare('SELECT COUNT(*) AS c FROM gm_edges').get()?.c || 0;
        const communities = this.db.prepare('SELECT COUNT(*) AS c FROM gm_communities').get()?.c || 0;
        return {
            messages: Number(messages || 0),
            nodes: Number(nodes || 0),
            edges: Number(edges || 0),
            communities: Number(communities || 0),
            generatedAt: Date.now()
        };
    }
}

module.exports = GraphMemoryService;
