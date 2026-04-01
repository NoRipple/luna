class CompactionStrategyRegistry {
    constructor() {
        this.strategies = new Map();
    }

    register(strategy) {
        const id = String(strategy?.id || '').trim();
        if (!id) {
            throw new Error('Compaction strategy requires a non-empty id');
        }
        this.strategies.set(id, strategy);
        return strategy;
    }

    get(mode) {
        const normalized = String(mode || '').trim();
        if (this.strategies.has(normalized)) {
            return this.strategies.get(normalized);
        }
        return null;
    }

    list() {
        return Array.from(this.strategies.keys());
    }
}

module.exports = CompactionStrategyRegistry;

