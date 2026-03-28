/* 主要职责：提供模型输出中的 JSON 提取能力，服务于回复解析和格式修复流程。 */
function extractFirstJsonObject(text) {
    const source = String(text || '').trim();
    if (!source) return '';

    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const target = fenced ? fenced[1].trim() : source;

    const start = target.indexOf('{');
    if (start < 0) return '';

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < target.length; i += 1) {
        const ch = target[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') depth += 1;
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return target.slice(start, i + 1);
            }
        }
    }
    return '';
}

module.exports = {
    extractFirstJsonObject
};

