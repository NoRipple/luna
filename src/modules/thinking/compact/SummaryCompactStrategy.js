const path = require('path');
const {
    buildSummaryCompactionPrompt
} = require('./CompactionPromptTemplates');
const {
    serializeMessagesForPrompt,
    persistTranscript,
    extractReattachedFileRefs,
    findSystemMessage,
    validateSummarySections
} = require('./compactionUtils');

class SummaryCompactStrategy {
    constructor({
        client,
        config,
        workspaceDir,
        getCompanionSystemPrompt,
        getToolDefinitions
    }) {
        this.id = 'summary';
        this.capabilities = {
            requiresNewGeneration: false,
            supportsManualCompact: true,
            supportsFocus: true
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
        const focus = String(ctx.focus || '').trim();
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
        const prompt = buildSummaryCompactionPrompt({
            conversationText: promptMessagesText,
            focus
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
            max_tokens: Math.max(1200, Number(this.config.llm.autoCompactSummaryMaxTokens || 6000)),
            tools: this.getToolDefinitions(),
            tool_choice: 'none',
            extra_body: { enable_thinking: true }
        });
        const summaryText = String(completion.choices?.[0]?.message?.content || '').trim();
        if (!validateSummarySections(summaryText)) {
            throw new Error('Summary compaction output missing required sections');
        }

        const reattachedRefs = extractReattachedFileRefs(messages);
        const systemMessage = findSystemMessage(messages, this.getCompanionSystemPrompt());
        const refsText = reattachedRefs.length
            ? reattachedRefs.map((item) => `- ${item}`).join('\n')
            : '- (none)';
        const compactBoundary = [
            `<compact_boundary id="${compactId}" mode="summary" reason="${String(ctx.reason || 'threshold')}">`,
            `generation=${Number(ctx.generation || 1)}`,
            `transcript=${transcriptPath}`,
            '</compact_boundary>',
            '',
            summaryText,
            '',
            '<reattached_file_refs>',
            refsText,
            '</reattached_file_refs>'
        ].join('\n');
        messages.splice(
            0,
            messages.length,
            systemMessage,
            {
                role: 'user',
                content: compactBoundary
            },
            {
                role: 'assistant',
                content: 'Understood. Continuing with compacted context.'
            }
        );

        return {
            compactId,
            mode: this.id,
            transcriptPath,
            summaryText,
            reattachedRefs,
            generationAction: 'stay',
            boundaryLabel: 'compact_boundary',
            meta: {
                reason: String(ctx.reason || 'threshold'),
                estimatedTokens: Number(ctx.estimatedTokens || 0)
            }
        };
    }
}

module.exports = SummaryCompactStrategy;
