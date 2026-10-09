// Echo runtime adapter: real conversations through the OpenAI Responses API (streaming), with the API key kept
// in Village Hall's environment. This is a paid API: every request first passes the village's paid-use check.
// The village's Echo is a SEPARATE API instance. It is not your ChatGPT account and has none of your ChatGPT
// conversations or memory; a ChatGPT subscription does not pay for API use. Requests are sent with
// store: false, so OpenAI is asked not to keep them as stored responses.
// Not yet checked against the live OpenAI API (the cloud workspace cannot reach it); verified only with a
// local fake that follows the documented event format (response.output_text.delta, response.completed, ...).
import type { AdapterContext, AdapterReply, AgentAdapter } from '../../server/lib/chat.ts';
import { errorText, readSse, residentSystemPrompt, toProviderTurns } from './sse.ts';

export const OPENAI_API = 'https://api.openai.com';

export type OpenAIAdapterDeps = {
  env: Record<string, string | undefined>;
  /** Tests only: point at a local fake server. Never read from .env, so a key cannot be redirected. */
  baseUrl?: string;
  maxOutputTokens?: number;
};

export class OpenAIAdapter implements AgentAdapter {
  readonly runtimeKind = 'openai-responses';
  private d: OpenAIAdapterDeps;

  constructor(deps: OpenAIAdapterDeps) {
    this.d = deps;
  }

  async reply(ctx: AdapterContext): Promise<AdapterReply> {
    const key = this.d.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not set in this machine\'s .env, so Echo cannot reply. Add it, restart the village and run Check integrations.');
    if (!ctx.resident.model) throw new Error(`${ctx.resident.displayName} has no model set in config/residents/${ctx.resident.id}.json.`);
    const body = {
      model: ctx.resident.model,
      instructions: residentSystemPrompt(ctx.resident, 'OpenAI API', 'You are a separate API instance: you are not the owner\'s ChatGPT and you do not have their ChatGPT conversations or memory.'),
      input: toProviderTurns(ctx.history, ctx.message).map((t) => ({ role: t.role, content: t.content })),
      stream: true,
      store: false,
      max_output_tokens: this.d.maxOutputTokens ?? 4096,
    };
    ctx.assertPaidAllowed(); // last check before a billable request
    let res: Response;
    try {
      res = await fetch(`${this.d.baseUrl ?? OPENAI_API}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
      throw new Error(`Could not reach the OpenAI API (${(e as Error).message}). Check this machine's internet connection.`);
    }
    if (!res.ok || !res.body) {
      const msg = await errorText(res);
      if (res.status === 401 || res.status === 403) throw new Error(`OpenAI rejected the API key (HTTP ${res.status}). Check OPENAI_API_KEY in .env. ${msg}`.trim());
      if (res.status === 429) throw new Error(`OpenAI rate limit or quota reached (HTTP 429). ${msg}`.trim());
      throw new Error(`OpenAI API error (HTTP ${res.status}): ${msg}`);
    }
    let text = '';
    let status: 'completed' | 'incomplete' | null = null;
    for await (const ev of readSse(res.body, ctx.signal)) {
      let data: any;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue; // e.g. a [DONE] marker
      }
      const type = data?.type ?? ev.event;
      if (type === 'response.output_text.delta' && typeof data.delta === 'string') {
        text += data.delta;
        ctx.onDelta(data.delta);
      } else if (type === 'response.completed') {
        status = 'completed';
      } else if (type === 'response.incomplete') {
        status = 'incomplete';
        const why = data.response?.incomplete_details?.reason;
        text += `\n\n[Reply incomplete${why ? `: ${why}` : ''}.]`;
      } else if (type === 'response.failed') {
        throw new Error(`OpenAI could not finish the reply: ${data.response?.error?.message ?? 'unknown error'}`);
      } else if (type === 'error') {
        throw new Error(`OpenAI stopped the reply: ${data.message ?? data.error?.message ?? 'unknown error'}`);
      }
    }
    if (!status) throw new Error('The OpenAI stream ended before the reply was complete.');
    return { text };
  }
}
