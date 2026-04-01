/* 主要职责：渲染扩展能力管理页面（skills/tools/mcp占位）。 */
import { escapeHtml, summarizeText } from './formatters.js';

function renderSkillRow(skill = {}) {
    const name = String(skill.name || '').trim() || '(unnamed)';
    const description = summarizeText(String(skill.description || '').trim() || 'No description', 120);
    const tags = String(skill.tags || '').trim();
    const path = String(skill.path || '').trim();
    const enabled = skill.enabled !== false;
    const checked = enabled ? 'checked' : '';
    return `
        <article class="skill-item" data-enabled="${enabled ? 'true' : 'false'}" data-skill-name="${escapeHtml(name)}">
            <div class="skill-item-main">
                <div class="skill-item-title">${escapeHtml(name)}</div>
                <div class="skill-item-desc">${escapeHtml(description)}</div>
                <div class="skill-item-meta">${escapeHtml(tags || 'no tags')}</div>
                <div class="skill-item-path">${escapeHtml(path)}</div>
            </div>
            <label class="skill-toggle">
                <input type="checkbox" data-role="skill-toggle" data-skill-name="${escapeHtml(name)}" ${checked}>
                <span>${enabled ? '已启用' : '已禁用'}</span>
            </label>
        </article>
    `;
}

function renderToolRow(tool = {}) {
    const name = String(tool.name || '').trim() || '(unknown)';
    const description = summarizeText(String(tool.description || '').trim() || 'No description', 120);
    const subagentEnabled = tool.subagentEnabled !== false ? 'subagent' : 'parent-only';
    const timelineEnabled = tool.timelineEnabled !== false ? 'timeline-on' : 'timeline-off';
    const timelineKind = String(tool.timelineKind || name).trim();
    return `
        <article class="tool-item">
            <div class="tool-item-title">${escapeHtml(name)}</div>
            <div class="tool-item-desc">${escapeHtml(description)}</div>
            <div class="tool-item-meta">
                <span>${escapeHtml(subagentEnabled)}</span>
                <span>${escapeHtml(timelineEnabled)}</span>
                <span>kind: ${escapeHtml(timelineKind)}</span>
            </div>
        </article>
    `;
}

export function renderExtensionsPage(dom, snapshot = {}) {
    if (!dom?.skillsListEl || !dom?.toolsListEl) return;
    const skills = Array.isArray(snapshot?.skills) ? snapshot.skills : [];
    const tools = Array.isArray(snapshot?.tools) ? snapshot.tools : [];
    const mcpStatus = String(snapshot?.mcp?.status || 'placeholder');

    dom.skillsListEl.innerHTML = skills.length
        ? skills.map(renderSkillRow).join('')
        : '<div class="empty-row">当前没有可用 skills。</div>';
    dom.toolsListEl.innerHTML = tools.length
        ? tools.map(renderToolRow).join('')
        : '<div class="empty-row">当前没有工具信息。</div>';
    if (dom.mcpPlaceholderEl) {
        dom.mcpPlaceholderEl.textContent = mcpStatus === 'placeholder'
            ? '预留区域：后续接入 MCP 能力管理。'
            : `MCP 状态：${mcpStatus}`;
    }
}
