/* 主要职责：维护持久化任务图（JSON 文件），提供任务 CRUD 与依赖解锁。 */
const fs = require('fs');
const path = require('path');

const STATUS_SET = new Set(['pending', 'in_progress', 'completed']);

class TaskGraphManager {
    constructor(tasksDirectory) {
        this.tasksDirectory = path.resolve(String(tasksDirectory || '.tasks'));
        fs.mkdirSync(this.tasksDirectory, { recursive: true });
        this.nextId = this.findMaxId() + 1;
    }

    taskPath(taskId) {
        return path.join(this.tasksDirectory, `task_${taskId}.json`);
    }

    listTaskFileNames() {
        const fileNames = fs.readdirSync(this.tasksDirectory);
        return fileNames
            .filter((name) => /^task_(\d+)\.json$/.test(name));
    }

    normalizeTaskId(rawTaskId) {
        const taskId = Number(rawTaskId);
        if (!Number.isInteger(taskId) || taskId <= 0) {
            throw new Error(`Invalid task id: ${rawTaskId}`);
        }
        return taskId;
    }

    readTask(taskId) {
        const normalizedTaskId = this.normalizeTaskId(taskId);
        const filePath = this.taskPath(normalizedTaskId);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Task ${normalizedTaskId} not found`);
        }
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    }

    writeTask(task) {
        const normalizedTaskId = this.normalizeTaskId(task?.id);
        const filePath = this.taskPath(normalizedTaskId);
        fs.writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf8');
    }

    findMaxId() {
        const ids = this.listTaskFileNames()
            .map((name) => {
                const match = name.match(/^task_(\d+)\.json$/);
                return match ? Number(match[1]) : 0;
            })
            .filter((value) => Number.isInteger(value) && value > 0);
        if (!ids.length) return 0;
        return Math.max(...ids);
    }

    dedupeTaskIdArray(rawList = []) {
        if (!Array.isArray(rawList)) return [];
        const unique = new Set();
        rawList.forEach((item) => {
            try {
                unique.add(this.normalizeTaskId(item));
            } catch (error) {
                // Ignore invalid item.
            }
        });
        return Array.from(unique.values());
    }

    clearDependency(completedTaskId) {
        const normalizedTaskId = this.normalizeTaskId(completedTaskId);
        const allTasks = this.listAllObjects();
        allTasks.forEach((task) => {
            if (!Array.isArray(task.blockedBy) || !task.blockedBy.includes(normalizedTaskId)) return;
            task.blockedBy = task.blockedBy.filter((item) => item !== normalizedTaskId);
            this.writeTask(task);
        });
    }

    create(subject, description = '') {
        const normalizedSubject = String(subject || '').trim();
        if (!normalizedSubject) {
            throw new Error('task.subject is required');
        }

        const task = {
            id: this.nextId,
            subject: normalizedSubject,
            description: String(description || '').trim(),
            status: 'pending',
            blockedBy: [],
            blocks: [],
            owner: '',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this.writeTask(task);
        this.nextId += 1;
        return task;
    }

    get(taskId) {
        return this.readTask(taskId);
    }

    update(taskId, patch = {}) {
        const normalizedTaskId = this.normalizeTaskId(taskId);
        const task = this.readTask(normalizedTaskId);
        const status = patch?.status === undefined ? null : String(patch.status || '').trim();
        const subject = patch?.subject === undefined ? null : String(patch.subject || '').trim();
        const description = patch?.description === undefined ? null : String(patch.description || '').trim();
        const owner = patch?.owner === undefined ? null : String(patch.owner || '').trim();
        const addBlockedBy = this.dedupeTaskIdArray(patch?.add_blocked_by || patch?.addBlockedBy || []);
        const addBlocks = this.dedupeTaskIdArray(patch?.add_blocks || patch?.addBlocks || []);

        if (status) {
            if (!STATUS_SET.has(status)) {
                throw new Error(`Invalid status: ${status}`);
            }
            task.status = status;
        }
        if (subject !== null) {
            if (!subject) throw new Error('task.subject cannot be empty');
            task.subject = subject;
        }
        if (description !== null) {
            task.description = description;
        }
        if (owner !== null) {
            task.owner = owner;
        }

        task.blockedBy = this.dedupeTaskIdArray([...(task.blockedBy || []), ...addBlockedBy])
            .filter((item) => item !== normalizedTaskId);
        task.blocks = this.dedupeTaskIdArray([...(task.blocks || []), ...addBlocks])
            .filter((item) => item !== normalizedTaskId);
        task.updatedAt = Date.now();

        this.writeTask(task);

        // Maintain bidirectional dependency edges.
        addBlocks.forEach((blockedTaskId) => {
            try {
                const blockedTask = this.readTask(blockedTaskId);
                const blockedBy = this.dedupeTaskIdArray([...(blockedTask.blockedBy || []), normalizedTaskId]);
                blockedTask.blockedBy = blockedBy.filter((item) => item !== blockedTaskId);
                blockedTask.updatedAt = Date.now();
                this.writeTask(blockedTask);
            } catch (error) {
                // Ignore unknown task; update is best effort.
            }
        });

        if (status === 'completed') {
            this.clearDependency(normalizedTaskId);
        }

        return this.readTask(normalizedTaskId);
    }

    listAllObjects() {
        return this.listTaskFileNames()
            .map((name) => {
                const match = name.match(/^task_(\d+)\.json$/);
                if (!match) return null;
                try {
                    return this.readTask(Number(match[1]));
                } catch (error) {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((a, b) => a.id - b.id);
    }

    clearAllTasks() {
        const fileNames = this.listTaskFileNames();
        let removed = 0;
        fileNames.forEach((name) => {
            const filePath = path.join(this.tasksDirectory, name);
            try {
                fs.unlinkSync(filePath);
                removed += 1;
            } catch (error) {
                // Ignore file-level deletion failure.
            }
        });
        this.nextId = 1;
        return {
            removed,
            total: fileNames.length
        };
    }

    listSummary() {
        const allTasks = this.listAllObjects();
        if (!allTasks.length) {
            return {
                total: 0,
                tasks: [],
                summary: 'No tasks.'
            };
        }

        const summaryLines = allTasks.map((task) => {
            const marker = {
                pending: '[ ]',
                in_progress: '[>]',
                completed: '[x]'
            }[task.status] || '[?]';
            const blocked = Array.isArray(task.blockedBy) && task.blockedBy.length
                ? ` (blocked by: ${task.blockedBy.join(', ')})`
                : '';
            return `${marker} #${task.id}: ${task.subject}${blocked}`;
        });

        return {
            total: allTasks.length,
            tasks: allTasks,
            summary: summaryLines.join('\n')
        };
    }
}

module.exports = TaskGraphManager;
