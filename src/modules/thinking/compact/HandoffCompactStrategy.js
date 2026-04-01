const path = require('path');
const {
    buildHandoffPrompt
} = require('./CompactionPromptTemplates');
const {
    serializeMessagesForPrompt,
    persistTranscript,
    extractReattachedFileRefs,
    writeTextFile
} = require('./compactionUtils');

class HandoffCompactStrategy {
    constructor({
        client,
        config,
        workspaceDir,
        getCompanionSystemPrompt,
        getToolDefinitions
    }) {
        this.id = 'handoff';
        this.capabilities = {
            requiresNewGeneration: true,
            supportsManualCompact: false,
            supportsFocus: false
        };
        this.client = client;
        this.config = config;
        this.workspaceDir = workspaceDir;
        this.getCompanionSystemPrompt = getCompanionSystemPrompt;
        this.getToolDefinitions = getToolDefinitions;
    }

    async run(ctx = {}) {
        const compactId = String(ctx.compactId || '').trim();
        const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
        const transcriptDir = path.resolve(this.workspaceDir, 'transcripts');
        const transcriptPath = persistTranscript({
            messages,
            transcriptDir,
            compactId
        });
        const promptMessagesText = serializeMessagesForPrompt(
            messages,
            this.config.llm.contextCompactTranscriptMaxChars
        );
        const prompt = buildHandoffPrompt({
            conversationText: promptMessagesText
        });

        const completion = await this.client.chat.completions.create({
            model: this.config.llm.textModel,
            messages: [
                {
                    role: 'system',
                    content: this.getCompanionSystemPrompt()
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            stream: false,
            max_tokens: Math.max(1200, Math.ceil(Number(this.config.llm.autoCompactHandoffMaxChars || 32000) / 3)),
            tools: this.getToolDefinitions(),
            tool_choice: 'none',
            extra_body: { enable_thinking: true }
        });
        const rawHandoffText = String(completion.choices?.[0]?.message?.content || '').trim();
        const maxChars = Math.max(2000, Number(this.config.llm.autoCompactHandoffMaxChars || 32000));
        const handoffText = rawHandoffText.length > maxChars
            ? `${rawHandoffText.slice(0, maxChars)}\n\n...[truncated]`
            : rawHandoffText;
        if (!handoffText) {
            throw new Error('Handoff compaction returned empty HANDOFF.md');
        }

        const latestHandoffPath = path.resolve(this.workspaceDir, 'HANDOFF.md');
        const historyDir = path.resolve(this.workspaceDir, 'handoffs');
        const historyHandoffPath = path.resolve(historyDir, `HANDOFF-${compactId}.md`);
        writeTextFile(latestHandoffPath, handoffText);
        writeTextFile(historyHandoffPath, handoffText);
        const reattachedRefs = extractReattachedFileRefs(messages);

        return {
            compactId,
            mode: this.id,
            transcriptPath,
            handoffPath: latestHandoffPath,
            handoffArchivePath: historyHandoffPath,
            reattachedRefs,
            generationAction: 'switch',
            boundaryLabel: 'compact_boundary',
            meta: {
                reason: String(ctx.reason || 'threshold'),
                estimatedTokens: Number(ctx.estimatedTokens || 0)
            }
        };
    }
}

module.exports = HandoffCompactStrategy;
