import { escapeHtml, summarizeText } from '../panel/scripts/formatters.js';

const RAW_FOLDABLE_TAGS = new Set([
  'Context',
  'LongTermSummary',
  'LongTermMemory',
  'RecentMemoryLogs',
  'RetrievedMemories',
  'RecentStateTrajectory',
  'CurrentState',
  'UserCommand',
  'reminder'
]);
const RAW_FOLDABLE_TAGS_LOWER = new Set(Array.from(RAW_FOLDABLE_TAGS.values()).map((tag) => String(tag).toLowerCase()));
const RAW_OMIT_CONTAINER_TAGS = new Set(['context']);

function renderRawProseBlock(text: string) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  return `<div class="raw-prose-block">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
}

function renderRawTextBlock(text: string) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  const codeFencePattern = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let html = '';
  let cursor = 0;
  let found = false;
  let match = codeFencePattern.exec(raw);
  while (match) {
    found = true;
    const start = Number(match.index || 0);
    const end = start + match[0].length;
    html += renderRawProseBlock(raw.slice(cursor, start));
    const lang = String(match[1] || '').trim() || 'text';
    const code = String(match[2] || '');
    html += `<figure class="raw-code-block"><figcaption>${escapeHtml(lang)}</figcaption><pre class="raw-code-pre"><code>${escapeHtml(code)}</code></pre></figure>`;
    cursor = end;
    match = codeFencePattern.exec(raw);
  }
  html += renderRawProseBlock(raw.slice(cursor));
  if (!found) return `<pre class="raw-text-block">${escapeHtml(raw)}</pre>`;
  return html;
}

function extractTagPreview(text: string, maxLength = 72) {
  const normalized = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return summarizeText(normalized, maxLength);
}

function renderTaggedContent(rawText: string, depth = 0): string {
  const text = String(rawText || '');
  const tagPattern = /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let cursor = 0;
  let output = '';
  let hasMatch = false;
  let match = tagPattern.exec(text);
  while (match) {
    const start = Number(match.index || 0);
    const end = start + match[0].length;
    output += renderRawTextBlock(text.slice(cursor, start));
    const tagName = String(match[1] || 'tag').trim();
    const foldable = RAW_FOLDABLE_TAGS.has(tagName) || RAW_FOLDABLE_TAGS_LOWER.has(tagName.toLowerCase());
    if (!foldable) {
      output += renderRawTextBlock(text.slice(start, end));
      cursor = end;
      match = tagPattern.exec(text);
      continue;
    }
    const innerText = String(match[2] || '');
    const body = depth < 4 ? renderTaggedContent(innerText, depth + 1) : renderRawTextBlock(innerText);
    const preview = extractTagPreview(innerText, 72);
    const omitContainer = depth === 0 && RAW_OMIT_CONTAINER_TAGS.has(tagName.toLowerCase());
    if (omitContainer) {
      output += body || renderRawTextBlock(innerText);
    } else {
      output += `
        <details class="tag-fold">
            <summary class="tag-fold-summary">
                <span class="tag-fold-name">&lt;${escapeHtml(tagName)}&gt;</span>
                ${preview ? `<span class="tag-fold-preview">${escapeHtml(preview)}</span>` : ''}
            </summary>
            <div class="tag-fold-body">${body || renderRawTextBlock(innerText)}</div>
        </details>
      `;
    }
    cursor = end;
    hasMatch = true;
    match = tagPattern.exec(text);
  }
  output += renderRawTextBlock(text.slice(cursor));
  if (!hasMatch && !output) return renderRawTextBlock(text);
  return output || renderRawTextBlock(text);
}

function normalizeRawMessageSegments(item: any = {}) {
  const segments: Array<{ kind: string; label: string; text: string }> = [];
  const pushSegment = (kind: string, label: string, text: unknown) => {
    const normalizedText = String(text ?? '');
    if (!normalizedText.trim()) return;
    segments.push({ kind, label, text: normalizedText });
  };

  const content = item.content;
  if (typeof content === 'string') {
    pushSegment('content', 'content', content);
  } else if (Array.isArray(content)) {
    content.forEach((part) => {
      if (!part || typeof part !== 'object') return;
      if (part.type === 'text') {
        pushSegment('content', 'content', String(part.text || ''));
        return;
      }
      if (part.type === 'image_url') {
        const imageUrl = typeof part.image_url?.url === 'string' ? part.image_url.url : '';
        pushSegment('image', 'image_url', imageUrl ? `[image_url] ${imageUrl}` : '[image_url]');
        return;
      }
      try {
        pushSegment('part', 'part', JSON.stringify(part, null, 2));
      } catch {
        pushSegment('part', 'part', String(part));
      }
    });
  } else if (content && typeof content === 'object') {
    try {
      pushSegment('content', 'content', JSON.stringify(content, null, 2));
    } catch {
      pushSegment('content', 'content', String(content));
    }
  } else if (content !== undefined && content !== null) {
    pushSegment('content', 'content', String(content));
  }

  if (item.tool_call_id) {
    pushSegment('tool_call_id', 'tool_call_id', String(item.tool_call_id));
  }
  if (Array.isArray(item.tool_calls) && item.tool_calls.length) {
    try {
      pushSegment('tool_calls', 'tool_calls', JSON.stringify(item.tool_calls, null, 2));
    } catch {
      pushSegment('tool_calls', 'tool_calls', '[tool_calls]');
    }
  }
  if (segments.length === 0) {
    pushSegment('content', 'content', '（空）');
  }
  return segments;
}

function renderRawSegment(segment: { kind: string; label: string; text: string }, showLabel = true) {
  const bodyHtml = renderTaggedContent(segment.text);
  if (segment.kind === 'tool_calls') {
    return `
      <details class="raw-toolcalls-fold">
          <summary class="raw-segment-summary">
              <span>tool_calls</span>
              <span>${escapeHtml(summarizeText(segment.text, 56) || '')}</span>
          </summary>
          <div class="raw-toolcalls-content">${bodyHtml}</div>
      </details>
    `;
  }
  if (segment.kind === 'tool_call_id') {
    return `<div class="raw-inline-meta">tool_call_id: ${escapeHtml(segment.text)}</div>`;
  }
  const labelHtml = showLabel ? `<span class="raw-inline-label">${escapeHtml(segment.label || segment.kind || 'segment')}</span>` : '';
  return `<section class="raw-segment-compact">${labelHtml}<div class="raw-segment-compact-body">${bodyHtml}</div></section>`;
}

export function buildRawMessageHtml(item: any, index: number) {
  const role = String(item?.role || 'unknown');
  const roleToken = role.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unknown';
  const segments = normalizeRawMessageSegments(item);
  const segmentHtml = segments
    .map((segment) => renderRawSegment(segment, segment.kind !== 'content' || segments.length > 1))
    .join('');
  const toolCallCount = Array.isArray(item?.tool_calls) ? item.tool_calls.length : 0;

  return `
    <article class="chat-message agent raw-message raw-role-${roleToken}">
      <div class="raw-message-shell">
        <div class="raw-message-head">
          <span class="raw-index">#${Number(index) + 1}</span>
          <span class="raw-role-pill">${escapeHtml(role)}</span>
          ${toolCallCount > 0 ? `<span class="raw-role-pill muted">tool_calls ${toolCallCount}</span>` : ''}
        </div>
        <div class="raw-message-body">${segmentHtml}</div>
      </div>
    </article>
  `;
}
