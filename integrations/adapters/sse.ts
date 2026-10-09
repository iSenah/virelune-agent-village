// Minimal Server-Sent Events reader for streaming HTTP APIs (Anthropic Messages, OpenAI Responses).
// Works with Node's built-in fetch; no packages.

export type SseEvent = { event: string; data: string };

/** Yield events from a streaming fetch Response body. Handles CRLF and events split across chunks. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const ev = parseBlock(block);
        if (ev) yield ev;
      }
    }
    const tail = parseBlock(buf.trim());
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseEvent | null {
  if (!block.trim()) return null;
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

/** Turn village chat history into alternating user/assistant turns that start with the user. */
export function toProviderTurns(history: { role: 'human' | 'resident'; body: string }[], message: string): { role: 'user' | 'assistant'; content: string }[] {
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const t of [...history, { role: 'human' as const, body: message }]) {
    const role = t.role === 'human' ? 'user' : 'assistant';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${t.body}`;
    else turns.push({ role, content: t.body });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

/** Shared identity text for API-powered residents. */
export function residentSystemPrompt(r: { displayName: string; role: string }, provider: string, accountNote: string): string {
  return [
    `You are ${r.displayName}, a resident of Virelune Agent Village. Your role: ${r.role}.`,
    `You are talking with the village's human owner through the village chat. Be direct, warm and concise.`,
    `You run through the ${provider} with the owner's API key. ${accountNote}`,
    `In this chat you have no tools: you cannot read or change files, run commands or browse. If something needs that, say so plainly instead of pretending.`,
  ].join('\n');
}

export async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const j = JSON.parse(raw);
    return String(j?.error?.message ?? j?.message ?? raw).slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
}
