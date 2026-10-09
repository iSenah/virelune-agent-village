# Version 2: from village to working multi-agent workspace

## V1 audit (October 2026)

What V1 already does well, and V2 builds on:

- **One source of truth.** Every state change is an event in an append-only SQLite log, streamed to the browser over Server-Sent Events. The village and the panels both read only from that.
- **Honest status.** A resident's status comes from `village doctor` checks on this machine. Non-focus residents (Aura, the Blender and Unreal combos, Scribe) stay disconnected until each passes its own verification test.
- **Safety rails.** The Tool Gateway (`/mcp/<resident>`) is the only route to MCP tools: per-session tokens, default deny, `exec` always asks, approvals expire as denied, exclusive leases, Origin and Host checks. Codex runs with its own Codex home, so it never loads your personal MCP servers (verified with codex-cli 0.161.0).
- **Task engine and approvals.** Validated status transitions, dependencies, honest waiting reasons, restart recovery.
- **Village visuals already wired to real events.** `run.started` / `run.finished` drive a resident's working pose, smoke and lit windows; approvals send a resident to the plaza. Nothing animates without a real event.

What V1 could not do, and V2 adds:

| Gap | Where it is solved |
| --- | --- |
| No way to talk to a resident | Phase 1 (done): resident window with persistent chat |
| No runtime adapters, so nothing can reply or run a task | Phase 2: Codex adapter first, then Claude and Echo |
| "Connected" only means "its checks pass", not "it can work" | Phase 1 shows the difference: the chat says when an adapter is missing |
| No guard against surprise API bills | Phase 2: paid residents (Claude, Echo) need an explicit "allow paid use" switch per resident before any request |
| Echo cannot plan or delegate | Phase 3 |
| Browser code is only syntax-checked when served | Phase 1 adds a test that every browser file compiles; full type checking (`tsc`) can be added once npm packages are allowed |

Smaller notes for later: the browser loads up to 5,000 past events at startup (fine for now; add paging when the log grows), and Scribe is configured for free local Ollama, which makes it a cheap second candidate for a real chat after Codex.

## Phases

1. **Interactive resident chat** (done). Every resident opens from its figure, its building, or the residents list. The window has Chat, Tasks, Approvals and Profile tabs. History is stored in Village Hall's database. A message is delivered only to a connected resident with an enabled adapter; otherwise it is saved as "not delivered" with the reason, and nothing replies.
2. **Real agent integrations.** Codex through the Codex app-server, using the isolated Codex home and the Tool Gateway. Then Claude (Claude Agent SDK, Anthropic API key) and Echo (OpenAI Agents SDK, OpenAI API key), each behind a per-resident paid-use switch. Aura, Blender and Unreal MCP are investigated with real handshakes and stay disconnected until those pass.
3. **Supervised delegation.** Echo proposes a plan; you approve it; tasks run Echo → Claude → Codex → Echo in `virelune-sandbox`, every step an event.
4. **Activity visualization.** Building lights, resident indicators and notifications for chat runs, task runs and approvals, keeping ambient life separate from real work.

## How chat works (Phase 1)

- `POST /api/residents/<id>/chat` stores your message and returns at once. Then exactly one of:
  - **Not delivered.** The resident is not checked, disconnected, or has no enabled adapter. The message is marked `undelivered` with the reason (`chat.message_undelivered` event). No reply is created.
  - **Delivered.** A `run.started` event (kind `chat`) starts a reply from the runtime adapter. Text streams live to the window (not stored as events), then the finished reply is saved (`chat.reply_completed`, `run.finished`). Errors and empty replies are saved as failures (`run.failed`), never as answers. You can stop a reply; its partial text is kept (`run.interrupted`).
- One reply at a time per resident. Replies time out after 10 minutes.
- After a restart, replies that were in progress are marked interrupted; nothing resumes silently.
- Messages live in `data/village.db` on each machine (git-ignored, excluded from exports). Conversations do not travel between your laptop and PC.
- The server registers no adapters until Phase 2, and a test fails if test-only adapters or canned replies ever reach server or browser code.

## Getting your PC ready for the first real agent (Codex)

Do this now; the Codex adapter arrives in Phase 2, and these steps are what it needs.

1. Update the project: fetch and pull in GitHub Desktop.
2. Install Node.js 22.18 or newer if you have not (`winget install OpenJS.NodeJS.LTS`).
3. Install the Codex CLI: `npm install -g @openai/codex`, then check `codex --version` in a new PowerShell window.
4. In the project folder, sign Codex in **for the village only**: `npm run codex:login`. This uses the village's own Codex home under `data\runtime\codex-home`, separate from your personal Codex setup, and uses your ChatGPT plan (no API key, no per-token bill).
5. Start the village (`npm start`, or double-click `scripts\start-village.cmd`), open http://127.0.0.1:4317 and press **Check integrations**.
6. Click Codex. If the chat says Codex's checks pass but the adapter is not enabled yet, your PC is ready for Phase 2. If it says something else (Codex not found, not logged in), the reason tells you which step to repeat.

Optional, and only if you are happy to pay per use later: put `ANTHROPIC_API_KEY` (Claude) and `OPENAI_API_KEY` (Echo) in your `.env`. The doctor only lists models to verify a key (free). Phase 2 will not send any paid request until you switch on paid use for that resident.
