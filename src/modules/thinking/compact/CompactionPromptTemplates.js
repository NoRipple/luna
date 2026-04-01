const COMPACT_INSTRUCTIONS = `## Compact Instructions

When compressing, preserve in priority order:

1. Architecture decisions (NEVER summarize)
2. Modified files and their key changes
3. Current verification status (pass/fail)
4. Open TODOs and rollback notes
5. Tool outputs (can delete, keep pass/fail only)`;

function buildSummaryCompactionPrompt({ conversationText, focus = '' }) {
    const normalizedFocus = String(focus || '').trim();
    const focusLine = normalizedFocus
        ? `Additional focus from caller: ${normalizedFocus}`
        : 'Additional focus from caller: (none)';
    return [
        'You are compacting a long coding-agent conversation for continuity.',
        'You must follow the compact instructions exactly.',
        '',
        COMPACT_INSTRUCTIONS,
        '',
        'Output requirements:',
        '1. Return Markdown only.',
        '2. Use EXACT section headings below and keep the same order.',
        '3. Keep architecture decision statements verbatim where available.',
        '4. Tool Outputs section should keep pass/fail only, no long logs.',
        '',
        'Required headings:',
        '## Architecture decisions (NEVER summarize)',
        '## Modified files and key changes',
        '## Current verification status (pass/fail)',
        '## Open TODOs and rollback notes',
        '## Tool outputs (pass/fail only)',
        '',
        focusLine,
        '',
        'Conversation to compact:',
        conversationText
    ].join('\n');
}

function buildHandoffPrompt({ conversationText }) {
    return [
        'Write HANDOFF.md for the next fresh agent instance.',
        'The next instance should continue by reading only this file.',
        '',
        'Required sections (Markdown headings):',
        '## Current progress',
        '## Tried already',
        '## What worked',
        '## Dead ends / failed paths',
        '## Next steps',
        '',
        'Keep it concrete. Include file paths, commands attempted, and actionable next steps.',
        '',
        'Conversation context:',
        conversationText
    ].join('\n');
}

module.exports = {
    COMPACT_INSTRUCTIONS,
    buildSummaryCompactionPrompt,
    buildHandoffPrompt
};

