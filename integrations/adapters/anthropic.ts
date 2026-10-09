// Claude runtime adapter: real conversations through the Anthropic Messages API (streaming), with the API key
// kept in Village Hall's environment. This is a paid API: every request first passes the village's paid-use
// check (ctx.assertPaidAllowed), so nothing is sent unless you have allowed paid use for this resident.
// Authentication: an Anthropic API key (console.anthropic.com). A Claude.ai subscription cannot be used by
// third-party apps, so there is no subscription option and no fallback.
// API format checked against https://platform.claude.com/docs/en/build-with-claude/streaming (October 2026).
import type { AdapterContext, AdapterReply, AgentAdapter } from '../../server/lib/chat.ts';
import { errorText, readSse, residentSystemPrompt, toProviderTurns } from './sse.ts';

export const ANTHROPIC_API = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5-5';

export type AnthropicAdapterDeps = {
  env: Record<string, string | undefined>;
  /** Tests only: point at a local fake server. Never read from .env, so a key cannot be redirected. */
  baseUrl?: string;
  maxTokens?: number;
};

export class AnthropicAdapter implements AgentAdapter {
  readonly runtimeKind = 'anthropic-messages';
  private d: AnthropicAdapterDeps;

  constructor(deps: AnthropicAdapterDeps) {
    this.d = deps;
  }

  async reply(ctx: AdapterContext): Promise<AdapterReply> {
    const key = this.d.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set in this machine\'s .env, so Claude cannot reply. Add it, restart the village and run Check integrations.');
    const body = {
      model: ctx.resident.model ?? DEFAULT_MODEL,
      max_tokens: this.d.maxTokens ?? 4096,
      stream: true,
      system: residentSystemPrompt(ctx.resident, 'Anthropic API', 'You are a separate API instance: you do not have the owner\'s Claude.ai conversations, projects or memory.'),
      messages: toProviderTurns(ctx.history, ctx.message),
    };
    ctx.assertPaidAllowed(); // last check before a billable request
    let res: Response;
    try {
      res = await fetch(`${this.d.baseUrl ?? ANTHROPIC_API}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
      throw new Error(`Could not reach the Anthropic API (${(e as Error).message}). Check this machine's internet connection.`);
    }
    if (!res.ok || !res.body) {
      const msg = await errorText(res);
      if (res.status === 401 || res.status === 403) throw new Error(`Anthropic rejected the API key (HTTP ${res.status}). Check ANTHROPIC_API_KEY in .env. ${msg}`.trim());
      if (res.status === 429) throw new Error(`Anthropic rate limit or spending limit reached (HTTP 429). ${msg}`.trim());
      if (res.status === 529 || res.status === 503) throw new Error(`Anthropic is overloaded right now (HTTP ${res.status}). Try again in a moment.`);
      throw new Error(`Anthropic API error (HTTP ${res.status}): ${msg}`);
    }
    let text = '';
    let stopReason: string | null = null;
    let finished = false;
    for await (const ev of readSse(res.body, ctx.signal)) {
      let data: any;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const type = data?.type ?? ev.event;
      if (type === 'content_block_delta' && data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
        text += data.delta.text;
        ctx.onDelta(data.delta.text);
      } else if (type === 'message_delta') {
        stopReason = data.delta?.stop_reason ?? stopReason;
      } else if (type === 'message_stop') {
        finished = true;
      } else if (type === 'error') {
        throw new Error(`Anthropic stopped the reply: ${data.error?.message ?? 'unknown error'}${data.error?.type ? ` (${data.error.type})` : ''}`);
      }
      // ping and unknown event types are ignored, as the API asks
    }
    if (!finished) throw new Error('The Anthropic stream ended before the reply was complete.');
    if (stopReason === 'max_tokens') text += '\n\n[Reply cut off at the length limit.]';
    if (stopReason === 'refusal' && !text.trim()) throw new Error('Claude declined to answer this message.');
    return { text };
  }
}
