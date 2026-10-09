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
2. **Real agent integrations.** 2A (done, waiting on your PC check): Codex through the Codex app-server, using the isolated Codex home and the Tool Gateway. Then Claude (Claude Agent SDK, Anthropic API key) and Echo (OpenAI Agents SDK, OpenAI API key), each behind a per-resident paid-use switch. Aura, Blender and Unreal MCP are investigated with real handshakes and stay disconnected until those pass.
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

## Phase 2A: the Codex adapter

Codex now answers through `integrations/adapters/codex.ts`, built against the protocol that codex-cli 0.161.0 prints with `codex app-server generate-ts`.

- **Same isolation as V1.** Each Codex resident gets its own `codex app-server` process using the village Codex home (`data\runtime\codex-home`). Your personal Codex config, sessions and MCP servers are never loaded. The only MCP server is the village Tool Gateway, reached with a per-session token kept only in the process environment. The gateway URL is also passed on the command line, so Codex residents never race on the shared config file.
- **Your ChatGPT plan only.** Before every reply the adapter reads the village sign-in. No sign-in, or an API-key sign-in (billed per token), is refused before any request. OpenAI, Anthropic and Codex API keys are removed from Codex's environment. There is no fallback to another provider.
- **Workspace boundaries.** Threads run in the resident's workspace with sandbox `workspace-write` and approval policy `untrusted`. Codex must ask before changing files and before running anything that is not a known read-only command. Each ask becomes a village approval, shown inside the chat with the exact command or diff. Unanswered asks are declined after 5 minutes. Requests aimed outside the workspace are declined without asking, and requests for extra permissions are never granted.
- **Windows sandbox.** On Windows, Codex's sandbox needs a one-time setup. Until Codex reports it ready, the doctor marks Codex not ready and the adapter refuses to work (`npm run codex:sandbox-setup` fixes it).
- **Conversations.** Replies stream into the chat and are saved. The Codex thread id is stored, so the next message continues the same Codex thread, including after a restart. Stop interrupts the Codex turn. Failures, crashes, timeouts and a missing CLI are recorded as failures with the reason. A crashed app-server is restarted on the next message.
- **Activity.** Commands Codex runs, files it changes, tools it calls and anything declined automatically are recorded as events and appear in the activity feed.
- **Variants stay locked.** Codex · Blender and Codex · Unreal use the same adapter, but stay disconnected until their own Blender and Unreal verification passes. Connecting Codex does not unlock them.

### What is verified, and what is not yet

| Check | Status |
| --- | --- |
| Adapter logic: streaming, saving, resume, stop, timeouts, crashes, sign-in refusal, approvals, workspace boundary, several residents at once | Automated tests against a protocol-faithful fake app-server |
| Real Codex 0.161.0: starts, handshakes, refuses an unsigned village home before any request; launch flags load only the village gateway | Automated tests against the real Codex CLI (skipped where Codex is not installed) |
| A real Codex reply through the village | **Not yet verified.** The cloud workspace cannot sign in to OpenAI, so this happens on your PC (steps below) |
| A real approved file operation in virelune-sandbox | **Not yet verified.** Also on your PC (step 9 below) |

## Verify your first real Codex conversation (Windows)

Open **PowerShell** and run these one at a time. Replace the folder paths with where GitHub Desktop cloned your repos (often `C:\Users\<you>\Documents\GitHub\...`).

1. Pull the latest code: in GitHub Desktop, select `virelune-agent-village`, then **Fetch origin** and **Pull origin**. Do the same for `virelune-sandbox`.
2. Go to the project and check Node (22.18 or newer):
   ```powershell
   cd "$HOME\Documents\GitHub\virelune-agent-village"
   node --version
   ```
3. Install the Codex CLI, then open a **new** PowerShell window in the project folder and check it:
   ```powershell
   npm install -g @openai/codex
   codex --version
   ```
4. Point the village at your sandbox clone. Run `notepad .env` and set this line (create `.env` with `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1` if it does not exist):
   ```
   VILLAGE_SANDBOX_DIR=C:\Users\<you>\Documents\GitHub\virelune-sandbox
   ```
   If both repos sit side by side in the same folder, you can leave it empty; the village finds `..\virelune-sandbox` by itself.
5. Sign Codex in for the village only, and choose **Sign in with ChatGPT** in the browser that opens:
   ```powershell
   npm run codex:login
   ```
6. Set up Codex's Windows sandbox for the village (one time):
   ```powershell
   npm run codex:sandbox-setup
   ```
   If it reports a problem, try `npm run codex:sandbox-setup -- --elevated` (Windows asks for administrator permission).
7. Check the whole chain from the command line. Codex's reply is printed as it streams:
   ```powershell
   npm run codex:verify
   ```
   It should end with "Verified: a genuine Codex reply". This uses your ChatGPT plan's Codex allowance, not an API bill, and saves nothing to the village.
8. Start the village and talk to Codex:
   ```powershell
   npm start
   ```
   Open http://127.0.0.1:4317, press **Check integrations**, click Codex at the Engineering Forge, type a message and press Enter. The reply streams in. Close the browser tab, stop the village with Ctrl+C, run `npm start` again, reopen the page and click Codex: the conversation is still there.
9. A small approved file operation in the sandbox. Ask Codex:
   > Create a file named hello-from-virelune.txt in the workspace containing one line: Hello from Virelune.

   An approval card appears in the chat showing the file and its contents. Press **Approve**. The file appears in your virelune-sandbox folder, and the activity feed shows "Codex changed hello-from-virelune.txt". Try asking again and pressing **Deny**: Codex says it was declined and no file is written. Commit or delete the file in GitHub Desktop afterwards. It is only in your local clone until you push.

If any step fails, the chat, `npm run codex:verify` or **Check integrations → Integrations** tab says why and which step to repeat. You can send me that text.
