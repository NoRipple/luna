const { extractFirstJsonObject } = require('../JsonUtils');

async function parseCompanionPayload(rawText, repairToJsonObject) {
    if (!rawText) {
        return null;
    }

    let parsed = null;
    try {
        const jsonStr = extractFirstJsonObject(rawText);
        if (!jsonStr) {
            throw new Error('Companion response does not contain valid JSON object');
        }
        parsed = JSON.parse(jsonStr);
    } catch (parseError) {
        const repaired = await repairToJsonObject(rawText);
        const repairedJsonStr = extractFirstJsonObject(repaired);
        if (!repairedJsonStr) {
            throw parseError;
        }
        parsed = JSON.parse(repairedJsonStr);
    }

    if (parsed && typeof parsed !== 'object') {
        throw new Error('Companion response JSON is not an object');
    }

    return parsed;
}

function resolveCompanionResult({ parsed, actionState, inputType, live2dModelService }) {
    const fallbackText = actionState.spokenText || actionState.panelNote || '';
    const defaultText = inputType === 'command'
        ? '嗯... 我暂时有点卡住了。'
        : '';
    const finalText = parsed && typeof parsed.text === 'string'
        ? parsed.text
        : (fallbackText || defaultText);
    const finalMotion = actionState.motion || (parsed ? live2dModelService.sanitizeMotionName(parsed.motion) : '');
    const finalExpression = actionState.expression || (parsed ? live2dModelService.sanitizeExpressionName(parsed.expression) : '');

    return {
        text: finalText,
        motion: finalMotion || live2dModelService.getCapabilities().fallbackMotion,
        expression: finalExpression,
        observedState: actionState.observedState || '',
        handledByAgentTools: actionState.usedOutputTool,
        spoke: actionState.spoke,
        sleepSeconds: actionState.sleepSeconds
    };
}

function buildCompanionErrorFallback(live2dModelService) {
    let fallbackMotion = 'idle';
    let fallbackExpression = '';
    try {
        const capabilities = live2dModelService.getCapabilities();
        fallbackMotion = capabilities.fallbackMotion;
        fallbackExpression = capabilities.fallbackExpression || '';
    } catch (error) {
        // ignore
    }

    return {
        text: 'Hmm... something went wrong...',
        motion: fallbackMotion,
        expression: fallbackExpression,
        observedState: '',
        handledByAgentTools: false,
        spoke: false,
        sleepSeconds: null
    };
}

module.exports = {
    parseCompanionPayload,
    resolveCompanionResult,
    buildCompanionErrorFallback
};

