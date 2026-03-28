/* 主要职责：提供项目级记忆能力，负责持久化记忆的读取、写入和查询。 */
class MemoryService {
    constructor() {
        this.shortTermMemory = [];
        this.longTermMemory = {};
    }

    remember(key, value) {
        this.longTermMemory[key] = value;
    }

    recall(key) {
        return this.longTermMemory[key];
    }

    addLog(log) {
        this.shortTermMemory.push({ timestamp: Date.now(), log });
        if (this.shortTermMemory.length > 100) {
            this.shortTermMemory.shift();
        }
    }
}

module.exports = new MemoryService();

