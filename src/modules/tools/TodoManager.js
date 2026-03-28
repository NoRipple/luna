/* 主要职责：维护 Agent 的 todo 状态、校验约束和订阅通知，是任务计划的状态容器。 */
class TodoManager {
    constructor() {
        this.items = [];
        this.updatedAt = null;
        this.listeners = new Set();
    }

    update(items = []) {
        if (!Array.isArray(items)) {
            throw new Error('Todo items must be an array');
        }
        if (items.length > 20) {
            throw new Error('Max 20 todos allowed');
        }

        const validated = [];
        let inProgressCount = 0;

        items.forEach((item, index) => {
            const rawItem = item || {};
            const id = String(rawItem.id || index + 1).trim();
            const text = String(rawItem.text || '').trim();
            const status = String(rawItem.status || 'pending').trim().toLowerCase();

            if (!id) {
                throw new Error(`Todo item ${index + 1}: id required`);
            }
            if (!text) {
                throw new Error(`Todo item ${id}: text required`);
            }
            if (!['pending', 'in_progress', 'completed'].includes(status)) {
                throw new Error(`Todo item ${id}: invalid status "${status}"`);
            }
            if (status === 'in_progress') {
                inProgressCount += 1;
            }

            validated.push({ id, text, status });
        });

        if (inProgressCount > 1) {
            throw new Error('Only one task can be in_progress at a time');
        }

        this.items = validated;
        this.updatedAt = Date.now();
        this.emitChange();
        return this.render();
    }

    render() {
        if (!this.items.length) {
            return 'No todos.';
        }

        const lines = this.items.map((item) => {
            const marker = {
                pending: '[ ]',
                in_progress: '[>]',
                completed: '[x]'
            }[item.status] || '[?]';
            return `${marker} #${item.id}: ${item.text}`;
        });
        const completedCount = this.items.filter((item) => item.status === 'completed').length;
        lines.push(`\n(${completedCount}/${this.items.length} completed)`);
        return lines.join('\n');
    }

    getState() {
        return {
            items: this.items.map((item) => ({ ...item })),
            updatedAt: this.updatedAt,
            summary: this.render(),
            hasOpenItems: this.items.some((item) => item.status !== 'completed')
        };
    }

    subscribe(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    emitChange() {
        const snapshot = this.getState();
        this.listeners.forEach((listener) => {
            try {
                listener(snapshot);
            } catch (error) {
                // Ignore subscriber failures so todo updates never break the loop.
            }
        });
    }
}

module.exports = TodoManager;
