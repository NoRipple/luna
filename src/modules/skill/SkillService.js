/* 主要职责：统一管理技能发现、状态开关、摘要输出与技能正文加载。 */
const fs = require('fs');
const path = require('path');
const config = require('../../config/runtimeConfig');

class SkillService {
    constructor(options = {}) {
        const projectRoot = path.resolve(String(options.projectRoot || config.projectRoot || process.cwd()));
        const defaultSkillDirs = [
            path.resolve(projectRoot, 'skills'),
            path.resolve(projectRoot, '.agents/skills')
        ];
        const rawSkillDirs = Array.isArray(options.skillDirectories)
            ? options.skillDirectories
            : defaultSkillDirs;

        this.skillDirectories = rawSkillDirs
            .filter(Boolean)
            .map((directory) => path.resolve(String(directory)));
        this.skillToggleFile = path.resolve(
            String(options.skillToggleFile || path.resolve(projectRoot, 'workspace/CompanionAgent/skill-toggles.json'))
        );
        this.skills = new Map();
        this.skillToggles = this.loadSkillToggles();
        this.refresh();
    }

    parseFrontmatter(rawText = '') {
        const text = String(rawText || '');
        const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        if (!match) {
            return {
                meta: {},
                body: text.trim()
            };
        }

        const meta = {};
        const lines = String(match[1] || '').split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            const separatorIndex = line.indexOf(':');
            if (separatorIndex <= 0) continue;

            const key = line.slice(0, separatorIndex).trim();
            let value = line.slice(separatorIndex + 1).trim();
            if (!key) continue;

            if (value === '>' || value === '|') {
                const chunks = [];
                for (let next = lineIndex + 1; next < lines.length; next += 1) {
                    const nested = String(lines[next] || '');
                    if (!/^\s+/.test(nested)) {
                        break;
                    }
                    chunks.push(nested.trim());
                    lineIndex = next;
                }
                value = value === '|'
                    ? chunks.join('\n')
                    : chunks.join(' ');
            }

            meta[key] = value;
        }

        return {
            meta,
            body: String(match[2] || '').trim()
        };
    }

    refresh() {
        this.skills.clear();
        this.skillDirectories.forEach((directory) => {
            const root = path.resolve(String(directory));
            if (!fs.existsSync(root)) return;

            const stack = [root];
            while (stack.length) {
                const current = stack.pop();
                let entries = [];
                try {
                    entries = fs.readdirSync(current, { withFileTypes: true });
                } catch (error) {
                    continue;
                }

                entries.forEach((entry) => {
                    const absolutePath = path.join(current, entry.name);
                    if (entry.isDirectory()) {
                        stack.push(absolutePath);
                        return;
                    }
                    if (!entry.isFile() || entry.name !== 'SKILL.md') return;

                    let text = '';
                    try {
                        text = fs.readFileSync(absolutePath, 'utf8');
                    } catch (error) {
                        return;
                    }

                    const { meta, body } = this.parseFrontmatter(text);
                    const name = String(meta.name || path.basename(path.dirname(absolutePath))).trim();
                    if (!name) return;

                    const description = String(meta.description || '').trim();
                    const tags = String(meta.tags || '').trim();
                    this.skills.set(name, {
                        name,
                        description,
                        tags,
                        body,
                        path: absolutePath
                    });
                });
            }
        });
    }

    list() {
        return Array.from(this.skills.values())
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((item) => ({
                name: item.name,
                description: item.description,
                tags: item.tags,
                path: item.path
            }));
    }

    loadSkillToggles() {
        try {
            if (!fs.existsSync(this.skillToggleFile)) {
                return {};
            }
            const content = fs.readFileSync(this.skillToggleFile, 'utf8');
            const parsed = JSON.parse(content);
            if (!parsed || typeof parsed !== 'object') {
                return {};
            }
            const toggles = {};
            Object.keys(parsed).forEach((key) => {
                const normalizedKey = String(key || '').trim();
                if (!normalizedKey) return;
                toggles[normalizedKey] = Boolean(parsed[key]);
            });
            return toggles;
        } catch (error) {
            return {};
        }
    }

    saveSkillToggles() {
        const dir = path.dirname(this.skillToggleFile);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.skillToggleFile, JSON.stringify(this.skillToggles, null, 2), 'utf8');
    }

    isSkillEnabled(skillName) {
        const normalizedName = String(skillName || '').trim();
        if (!normalizedName) return false;
        if (!Object.prototype.hasOwnProperty.call(this.skillToggles, normalizedName)) {
            return true;
        }
        return Boolean(this.skillToggles[normalizedName]);
    }

    getSkillsSnapshot() {
        this.refresh();
        return this.list().map((item) => ({
            ...item,
            enabled: this.isSkillEnabled(item.name)
        }));
    }

    getEnabledSkillSnapshots() {
        return this.getSkillsSnapshot().filter((item) => item.enabled !== false);
    }

    getSkillContent(name) {
        const normalizedName = String(name || '').trim();
        if (!normalizedName) {
            return 'Error: Skill name is required.';
        }
        const match = this.getSkillsSnapshot().find((item) => item.name === normalizedName);
        if (!match) {
            const names = this.getSkillsSnapshot().map((item) => item.name).join(', ');
            return `Error: Unknown skill "${normalizedName}". Available: ${names || '(none)'}`;
        }
        if (match.enabled === false) {
            return `Error: Skill "${normalizedName}" is disabled. Enable it before loading.`;
        }

        const skill = this.skills.get(normalizedName);
        if (!skill) {
            return `Error: Skill "${normalizedName}" is not loaded.`;
        }
        return `<skill name="${skill.name}" path="${skill.path}">\n${skill.body}\n</skill>`;
    }

    setSkillEnabled(name, enabled) {
        const normalizedName = String(name || '').trim();
        if (!normalizedName) {
            return {
                ok: false,
                message: 'Skill name is required.'
            };
        }
        const match = this.getSkillsSnapshot().find((item) => item.name === normalizedName);
        if (!match) {
            return {
                ok: false,
                message: `Unknown skill: ${normalizedName}`
            };
        }
        this.skillToggles[normalizedName] = Boolean(enabled);
        this.saveSkillToggles();
        return {
            ok: true,
            skill: {
                ...match,
                enabled: Boolean(enabled)
            }
        };
    }

    getSkillDescriptions() {
        const list = this.getEnabledSkillSnapshots();
        if (!list.length) return '(no skills available)';
        return list
            .map((item) => {
                const descriptionRaw = item.description || 'No description';
                const description = descriptionRaw.length > 140
                    ? `${descriptionRaw.slice(0, 139)}…`
                    : descriptionRaw;
                const tags = item.tags ? ` [${item.tags}]` : '';
                return `- ${item.name}: ${description}${tags}`;
            })
            .join('\n');
    }
}

module.exports = new SkillService();
