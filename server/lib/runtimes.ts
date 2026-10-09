// The real runtime adapters, built the same way for the server and for `npm run codex:verify`, so a
// verification checks exactly what the village runs.
import { AnthropicAdapter } from '../../integrations/adapters/anthropic.ts';
import { CodexAdapter } from '../../integrations/adapters/codex.ts';
import { OpenAIAdapter } from '../../integrations/adapters/openai.ts';
import type { Village } from './app.ts';
import type { AgentAdapter } from './chat.ts';

export function createRuntimeAdapters(v: Village, gatewayUrl: () => string): AgentAdapter[] {
  return [
    new CodexAdapter({
      dataDir: v.config.dataDir,
      env: v.config.env,
      events: v.events,
      approvals: v.approvals,
      issueToken: (id) => v.gateway.issueToken(id),
      revokeToken: (id) => v.gateway.revokeToken(id),
      gatewayUrl,
      workspaceFor: (id) => v.workspaceFor(id),
    }),
    // Paid APIs: every request passes the village's paid-use check first (see server/lib/billing.ts).
    new AnthropicAdapter({ env: v.config.env }),
    new OpenAIAdapter({ env: v.config.env }),
  ];
}
