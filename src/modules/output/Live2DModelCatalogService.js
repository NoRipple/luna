/* 主要职责：管理可用 Live2D 模型目录，负责模型发现、描述构建和目标模型解析。 */
const fs = require('fs');
const path = require('path');
const config = require('../../config/runtimeConfig');

class Live2DModelCatalogService {
    constructor() {
        this.assetsRoot = path.resolve(config.projectRoot, 'assets');
        this.supportedExtensions = ['.model3.json', '.model.json'];
    }

    normalizePathForId(filePath) {
        return String(filePath || '').split(path.sep).join('/');
    }

    buildDescriptor(absolutePath) {
        const normalizedAbsolutePath = path.resolve(String(absolutePath || ''));
        const relativeFromRoot = path.relative(config.projectRoot, normalizedAbsolutePath);
        const relativeFromRenderer = path.relative(
            path.resolve(config.projectRoot, 'src/renderer'),
            normalizedAbsolutePath
        );
        const modelFileName = path.basename(normalizedAbsolutePath);
        const displayName = path.basename(path.dirname(normalizedAbsolutePath));

        return {
            id: this.normalizePathForId(relativeFromRoot),
            displayName,
            fileName: modelFileName,
            modelJsonAbsolutePath: normalizedAbsolutePath,
            modelJsonRelativePath: this.normalizePathForId(relativeFromRoot),
            rendererModelPath: this.normalizePathForId(relativeFromRenderer)
        };
    }

    isSupportedModelFile(fileName) {
        const loweredName = String(fileName || '').toLowerCase();
        return this.supportedExtensions.some((extension) => loweredName.endsWith(extension));
    }

    collectModelJsonFiles(dirPath, result) {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const absolutePath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                this.collectModelJsonFiles(absolutePath, result);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!this.isSupportedModelFile(entry.name)) continue;
            result.push(absolutePath);
        }
    }

    listAvailableModels() {
        const results = [];

        if (!fs.existsSync(this.assetsRoot)) {
            return results;
        }

        this.collectModelJsonFiles(this.assetsRoot, results);
        return results
            .map((absolutePath) => this.buildDescriptor(absolutePath))
            .sort((a, b) => {
                if (a.displayName === b.displayName) {
                    return a.fileName.localeCompare(b.fileName);
                }
                return a.displayName.localeCompare(b.displayName);
            });
    }

    resolveModel(inputPath) {
        const raw = String(inputPath || '').trim();
        if (!raw) {
            throw new Error('模型路径不能为空');
        }

        const candidates = this.listAvailableModels();
        const byId = candidates.find((item) => item.id === this.normalizePathForId(raw));
        if (byId) return byId;

        const byAbsolutePath = candidates.find((item) => item.modelJsonAbsolutePath === raw);
        if (byAbsolutePath) return byAbsolutePath;

        const byRelativePath = candidates.find(
            (item) =>
                item.modelJsonRelativePath === this.normalizePathForId(raw) ||
                item.rendererModelPath === this.normalizePathForId(raw)
        );
        if (byRelativePath) return byRelativePath;

        const maybeAbsolutePath = path.isAbsolute(raw)
            ? path.resolve(raw)
            : path.resolve(config.projectRoot, raw);

        if (!fs.existsSync(maybeAbsolutePath)) {
            throw new Error(`找不到模型文件: ${raw}`);
        }
        if (!this.isSupportedModelFile(path.basename(maybeAbsolutePath))) {
            throw new Error(`不支持的模型文件: ${raw}`);
        }

        return this.buildDescriptor(maybeAbsolutePath);
    }
}

module.exports = new Live2DModelCatalogService();

