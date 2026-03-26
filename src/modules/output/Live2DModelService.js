const fs = require('fs');
const path = require('path');
const config = require('../../config/runtimeConfig');

class Live2DModelService {
    constructor() {
        this.cachedCapabilities = null;
        this.runtimeModelJsonAbsolutePath = '';
    }

    invalidateCache() {
        this.cachedCapabilities = null;
    }

    setRuntimeModelJsonPath(modelJsonPath) {
        const raw = String(modelJsonPath || '').trim();
        if (!raw) {
            throw new Error('模型路径不能为空');
        }

        const resolved = path.isAbsolute(raw)
            ? path.resolve(raw)
            : path.resolve(config.projectRoot, raw);

        if (!fs.existsSync(resolved)) {
            throw new Error(`模型文件不存在: ${resolved}`);
        }

        this.runtimeModelJsonAbsolutePath = resolved;
        this.invalidateCache();
        return resolved;
    }

    clearRuntimeModelJsonPath() {
        this.runtimeModelJsonAbsolutePath = '';
        this.invalidateCache();
    }

    resolveModelJsonAbsolutePath() {
        if (this.runtimeModelJsonAbsolutePath) {
            return this.runtimeModelJsonAbsolutePath;
        }

        const configuredPath = String(config.live2d.modelJsonPath || '').trim();
        if (!configuredPath) {
            throw new Error('LIVE2D_MODEL_JSON_PATH is empty');
        }

        if (path.isAbsolute(configuredPath)) {
            return configuredPath;
        }

        return path.resolve(config.projectRoot, configuredPath);
    }

    toRendererModelPath(absolutePath) {
        const rendererBase = path.resolve(config.projectRoot, 'src/renderer');
        const relativePath = path.relative(rendererBase, absolutePath);
        return relativePath.split(path.sep).join('/');
    }

    normalizeMotionNameFromFile(filePath) {
        const fileName = path.basename(String(filePath || ''));
        return fileName.replace(/\.motion3\.json$/i, '').replace(/\.json$/i, '');
    }

    normalizeExpressionName(rawExpression) {
        const fileName = path.basename(String(rawExpression || '').trim());
        return fileName.replace(/\.exp3\.json$/i, '.exp3').replace(/\.json$/i, '');
    }

    ensureUniquePush(targetList, value) {
        const normalized = String(value || '').trim();
        if (!normalized) return;
        if (!targetList.includes(normalized)) {
            targetList.push(normalized);
        }
    }

    addAlias(aliasMap, alias, rawName) {
        const normalizedAlias = String(alias || '').trim();
        const normalizedRaw = String(rawName || '').trim();
        if (!normalizedAlias || !normalizedRaw) return;

        aliasMap[normalizedAlias] = normalizedRaw;
        const lowerAlias = normalizedAlias.toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(aliasMap, lowerAlias)) {
            aliasMap[lowerAlias] = normalizedRaw;
        }
    }

    buildMotionCapabilities(motionGroups) {
        const motions = [];
        const motionAliasMap = {};

        for (const groupKey of Object.keys(motionGroups || {})) {
            const groupItems = motionGroups[groupKey];
            if (!Array.isArray(groupItems) || !groupItems.length) continue;

            const normalizedGroupKey = String(groupKey || '').trim();
            const fileBasedNames = groupItems
                .map((item) => this.normalizeMotionNameFromFile(item?.File))
                .filter((name) => !!name);

            if (normalizedGroupKey) {
                this.ensureUniquePush(motions, normalizedGroupKey);
                motionAliasMap[normalizedGroupKey] = normalizedGroupKey;
                for (const fileBasedName of fileBasedNames) {
                    motionAliasMap[fileBasedName] = normalizedGroupKey;
                }
            } else {
                for (const fileBasedName of fileBasedNames) {
                    this.ensureUniquePush(motions, fileBasedName);
                    motionAliasMap[fileBasedName] = fileBasedName;
                }
            }
        }

        const fallbackMotion = this.getFallbackMotion(motions);
        return {
            motions,
            fallbackMotion,
            motionAliasMap
        };
    }

    getFallbackMotion(motions) {
        if (!Array.isArray(motions) || !motions.length) return 'idle';
        const idleMotion = motions.find((name) => String(name).toLowerCase() === 'idle');
        return idleMotion || motions[0];
    }

    getFallbackExpression(expressions) {
        if (!Array.isArray(expressions) || !expressions.length) return '';
        return expressions[0];
    }

    isMurasameModel(modelJsonAbsolutePath) {
        const normalized = String(modelJsonAbsolutePath || '')
            .replace(/\\/g, '/')
            .toLowerCase();
        return normalized.endsWith('/murasame/murasame.model3.json');
    }

    buildExpressionCapabilities(modelJsonAbsolutePath, expressions) {
        const expressionAliasMap = {};
        const expressionSemanticMap = {};
        const promptExpressionHints = [];
        let promptExpressions = Array.isArray(expressions) ? expressions.slice() : [];
        let fallbackExpressionRaw = this.getFallbackExpression(expressions);
        let promptFallbackExpression = fallbackExpressionRaw || '""';

        if (!Array.isArray(expressions) || !expressions.length) {
            return {
                expressionAliasMap,
                expressionSemanticMap,
                promptExpressions: [],
                promptExpressionHints: [],
                fallbackExpressionRaw: '',
                promptFallbackExpression: '""'
            };
        }

        for (const rawExpression of expressions) {
            this.addAlias(expressionAliasMap, rawExpression, rawExpression);
            this.addAlias(
                expressionAliasMap,
                this.normalizeExpressionName(rawExpression),
                rawExpression
            );
        }

        if (this.isMurasameModel(modelJsonAbsolutePath)) {
            // Semantic aliases are for prompting convenience; raw exp names remain ground truth.
            const semanticProfile = [
                {
                    semantic: 'positive',
                    raw: 'exp2.exp3',
                    aliases: ['smile', 'happy', 'neutral', 'default', 'normal', 'calm', 'pleasant']
                },
                {
                    semantic: 'squint_smile',
                    raw: 'exp1.exp3',
                    aliases: ['soft_smile', 'grin', '眯眼笑']
                },
                {
                    semantic: 'dark_smile',
                    raw: 'exp3.exp3',
                    aliases: ['dark', 'gloomy', 'serious', 'blackened']
                },
                {
                    semantic: 'oppressive_angry',
                    raw: 'exp4.exp3',
                    aliases: ['angry_dark', 'menacing', 'intimidating', 'pressure']
                },
                {
                    semantic: 'breakdown',
                    raw: 'exp5.exp3',
                    aliases: ['crazy', 'chaotic', 'yandere', '颜艺']
                },
                {
                    semantic: 'shy_blush',
                    raw: 'exp6.exp3',
                    aliases: ['shy', 'embarrassed', 'blush']
                },
                {
                    semantic: 'flustered_blush',
                    raw: 'exp7.exp3',
                    aliases: ['flustered', 'nervous_blush', 'surprised']
                }
            ];

            const enabledSemantics = [];
            for (const item of semanticProfile) {
                if (!expressions.includes(item.raw)) continue;
                expressionSemanticMap[item.semantic] = item.raw;
                enabledSemantics.push(item.semantic);
                promptExpressionHints.push(`${item.semantic} -> ${item.raw}`);
                this.addAlias(expressionAliasMap, item.semantic, item.raw);
                for (const alias of item.aliases || []) {
                    this.addAlias(expressionAliasMap, alias, item.raw);
                }
            }

            if (enabledSemantics.length) {
                promptExpressions = enabledSemantics;
                promptFallbackExpression = enabledSemantics.includes('positive')
                    ? 'positive'
                    : enabledSemantics[0];
                fallbackExpressionRaw =
                    expressionSemanticMap.positive || expressionSemanticMap[promptFallbackExpression];
            }
        }

        return {
            expressionAliasMap,
            expressionSemanticMap,
            promptExpressions,
            promptExpressionHints,
            fallbackExpressionRaw,
            promptFallbackExpression
        };
    }

    getCapabilities() {
        if (this.cachedCapabilities) {
            return this.cachedCapabilities;
        }

        const modelJsonAbsolutePath = this.resolveModelJsonAbsolutePath();
        const raw = fs.readFileSync(modelJsonAbsolutePath, 'utf8');
        const modelJson = JSON.parse(raw);

        const motionGroups = modelJson?.FileReferences?.Motions || {};
        const motionCapabilities = this.buildMotionCapabilities(motionGroups);

        const expressions = [];
        const expressionItems = modelJson?.FileReferences?.Expressions;
        if (Array.isArray(expressionItems)) {
            for (const item of expressionItems) {
                const expressionName =
                    item?.Name || this.normalizeExpressionName(item?.File || '');
                if (expressionName && !expressions.includes(expressionName)) {
                    expressions.push(expressionName);
                }
            }
        }

        const expressionCapabilities = this.buildExpressionCapabilities(
            modelJsonAbsolutePath,
            expressions
        );

        const capabilities = {
            modelJsonAbsolutePath,
            rendererModelPath: this.toRendererModelPath(modelJsonAbsolutePath),
            modelDisplayName: path.basename(path.dirname(modelJsonAbsolutePath)),
            motions: motionCapabilities.motions,
            expressions,
            fallbackMotion: motionCapabilities.fallbackMotion,
            fallbackExpression: expressionCapabilities.fallbackExpressionRaw,
            motionAliasMap: motionCapabilities.motionAliasMap,
            expressionAliasMap: expressionCapabilities.expressionAliasMap,
            expressionSemanticMap: expressionCapabilities.expressionSemanticMap,
            promptExpressions: expressionCapabilities.promptExpressions,
            promptExpressionHints: expressionCapabilities.promptExpressionHints,
            promptFallbackExpression: expressionCapabilities.promptFallbackExpression
        };

        this.cachedCapabilities = capabilities;
        return capabilities;
    }

    sanitizeMotionName(motionName) {
        let capabilities;
        try {
            capabilities = this.getCapabilities();
        } catch (error) {
            return String(motionName || '').trim() || 'idle';
        }
        const motions = capabilities.motions || [];
        const motionAliasMap = capabilities.motionAliasMap || {};
        if (!motions.length) return capabilities.fallbackMotion;

        const raw = String(motionName || '').trim();
        if (!raw) return capabilities.fallbackMotion;

        if (motions.includes(raw)) return raw;

        if (motionAliasMap[raw]) return motionAliasMap[raw];

        const fromFileLikeName = this.normalizeMotionNameFromFile(raw);
        if (motions.includes(fromFileLikeName)) return fromFileLikeName;
        if (motionAliasMap[fromFileLikeName]) return motionAliasMap[fromFileLikeName];

        const lower = raw.toLowerCase();
        const caseInsensitiveMatch = motions.find((item) => item.toLowerCase() === lower);
        if (caseInsensitiveMatch) return caseInsensitiveMatch;

        const aliasKey = Object.keys(motionAliasMap).find((item) => item.toLowerCase() === lower);
        if (aliasKey) return motionAliasMap[aliasKey];

        const normalizedLower = fromFileLikeName.toLowerCase();
        const secondaryMatch = motions.find((item) => item.toLowerCase() === normalizedLower);
        if (secondaryMatch) return secondaryMatch;

        const secondaryAliasKey = Object.keys(motionAliasMap).find(
            (item) => item.toLowerCase() === normalizedLower
        );
        if (secondaryAliasKey) return motionAliasMap[secondaryAliasKey];

        return capabilities.fallbackMotion;
    }

    sanitizeExpressionName(expressionName) {
        let capabilities;
        try {
            capabilities = this.getCapabilities();
        } catch (error) {
            return String(expressionName || '').trim();
        }

        const expressions = capabilities.expressions || [];
        const expressionAliasMap = capabilities.expressionAliasMap || {};
        if (!expressions.length) return '';

        const raw = String(expressionName || '').trim();
        if (!raw) return capabilities.fallbackExpression;
        if (expressionAliasMap[raw]) return expressionAliasMap[raw];
        if (expressionAliasMap[raw.toLowerCase()]) return expressionAliasMap[raw.toLowerCase()];
        if (expressions.includes(raw)) return raw;

        const normalized = this.normalizeExpressionName(raw);
        if (expressionAliasMap[normalized]) return expressionAliasMap[normalized];
        if (expressionAliasMap[normalized.toLowerCase()]) {
            return expressionAliasMap[normalized.toLowerCase()];
        }
        if (expressions.includes(normalized)) return normalized;

        const lower = raw.toLowerCase();
        const caseInsensitiveMatch = expressions.find((item) => item.toLowerCase() === lower);
        if (caseInsensitiveMatch) return caseInsensitiveMatch;

        const normalizedLower = normalized.toLowerCase();
        const secondaryMatch = expressions.find((item) => item.toLowerCase() === normalizedLower);
        if (secondaryMatch) return secondaryMatch;

        return capabilities.fallbackExpression;
    }

    buildCompanionMotionPromptSuffix() {
        let capabilities;
        try {
            capabilities = this.getCapabilities();
        } catch (error) {
            return [
                '',
                'Live2D 动作约束：',
                '1. 未读取到模型动作列表，请输出 motion: idle。',
                '',
                'Live2D 表情约束：',
                '1. 未读取到模型表情列表，请输出 expression: ""。'
            ].join('\n');
        }
        const motions = capabilities.motions || [];
        const promptExpressions = capabilities.promptExpressions || [];
        const expressionList = promptExpressions.length
            ? promptExpressions
            : capabilities.expressions || [];
        const promptExpressionHints = capabilities.promptExpressionHints || [];
        const promptFallbackExpression =
            capabilities.promptFallbackExpression ||
            capabilities.fallbackExpression ||
            '""';

        return [
            '',
            'Live2D 动作约束：',
            `1. 可用 motion 列表：${motions.length ? motions.join(', ') : '（无可用动作）'}`,
            `2. 输出 JSON 时，motion 字段必须从上述列表中选择。`,
            `3. 若不确定，请输出 fallback motion：${capabilities.fallbackMotion}。`
            ,
            '',
            'Live2D 表情约束：',
            `1. 可用 expression 列表：${expressionList.length ? expressionList.join(', ') : '（无可用表情）'}`,
            '2. 输出 JSON 时，expression 字段必须从上述列表中选择。',
            `3. 若不确定，请输出 fallback expression：${promptFallbackExpression}。`,
            ...(promptExpressionHints.length
                ? [`4. 语义到原生映射：${promptExpressionHints.join('; ')}。`]
                : [])
        ].join('\n');
    }
}

module.exports = new Live2DModelService();
