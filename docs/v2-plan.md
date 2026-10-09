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
2. **Real agent integrations.** 2A (built; Windows fixes in; waiting on your PC check): Codex through the Codex app-server, using the isolated Codex home and the Tool Gateway. Then Claude (Claude Agent SDK, Anthropic API key) and Echo (OpenAI Agents SDK, OpenAI API key), each behind a per-resident paid-use switch. Aura, Blender and Unreal MCP are investigated with real handshakes and stay disconnected until those pass.
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

- **Same isolation as V1.** Each Codex resident gets its own `codex app-server` process using the village Codex home (`data\runtime\codex-home`). Your personal Codex config, sessions and MCP servers are never loaded. The only MCP server is the village Tool Gateway, reached with a per-session token kept only in the process environment. The gateway URL is also passed on the command line, so Codex residents never race on the shared config file. Codex's built-in tool sources (apps / `codex_apps`, plugins, browser and computer use) are switched off on every launch, and the adapter checks what Codex actually loaded before using it.
- **Your ChatGPT plan only.** Before every reply the adapter reads the village sign-in. No sign-in, or an API-key sign-in (billed per token), is refused before any request. OpenAI, Anthropic and Codex API keys are removed from Codex's environment. There is no fallback to another provider.
- **Workspace boundaries.** Threads run in the resident's workspace with sandbox `workspace-write` and approval policy `untrusted`. Codex must ask before changing files and before running anything that is not a known read-only command. Each ask becomes a village approval, shown inside the chat with the exact command or diff. Unanswered asks are declined after 5 minutes. Requests aimed outside the workspace are declined without asking, and requests for extra permissions are never granted.
- **Windows sandbox.** On Windows, Codex's sandbox needs a one-time setup. Until Codex reports it ready, the doctor marks Codex not ready and the adapter refuses to work (`npm run codex:sandbox-setup` fixes it).
- **Conversations.** Replies stream into the chat and are saved. The Codex thread id is stored, so the next message continues the same Codex thread, including after a restart. Stop interrupts the Codex turn. Failures, crashes, timeouts and a missing CLI are recorded as failures with the reason. A crashed app-server is restarted on the next message.
- **Activity.** Commands Codex runs, files it changes, tools it calls and anything declined automatically are recorded as events and appear in the activity feed.
- **Variants stay locked.** Codex · Blender and Codex · Unreal use the same adapter, but stay disconnected until their own Blender and Unreal verification passes. Connecting Codex does not unlock them.

### First Windows verification: what went wrong, and the fixes

Your first run on Windows (Codex 0.162.0, ChatGPT Plus, sandbox set up) found four real problems:

| What you saw | Cause | Fix |
| --- | --- | --- |
| MCP isolation failed: `codex_apps` visible | Codex 0.16x turns on a built-in **apps** feature by default. With a ChatGPT sign-in it adds `codex_apps`, an MCP server for your ChatGPT connectors. It comes from Codex itself, not from any config file, so a separate Codex home does not stop it. Other built-in features (plugins, remote plugins, browser use, computer use, in-app browser) are also on by default and could give Codex tools outside the village | Every launch switches these features off, both in the village Codex `config.toml` and on the command line. Before Codex may do anything, the adapter asks Codex what it actually loaded. It refuses, with no model request, if anything besides the village gateway is there or any of those features is still on. The doctor runs the same check |
| Doctor said the sandbox was ready; the adapter said it was not set up | The sandbox setup records itself in the village Codex `config.toml` (its `[windows]` section). The adapter **overwrote** that file on every launch, erasing it | The village now edits only its own clearly marked block (features, the gateway, and removing any other MCP servers, apps or plugins) and keeps everything else Codex writes. Because the old version already erased the setup, run the sandbox setup once more (step 5 below) |
| `codex:verify` crashed deleting its temp folder (`EPERM`) | Verify used a temporary folder as Codex's workspace and deleted it while Codex was still shutting down inside it. Windows will not delete a folder a running program is using | Verify now uses your real workspace and only a throwaway database. It waits for Codex to exit before cleaning up, retries, and never crashes on cleanup |
| Did verify check what the village runs? | No. The doctor started Codex with plain settings, and verify used a different workspace | One shared launch definition is now used by the doctor, the adapter, sandbox setup and verify. Verify builds its adapter with the same code as the server. A test checks that the doctor's launch matches the adapter's exactly |

Nothing in your personal Codex setup (`%USERPROFILE%\.codex`) is read or changed. All of this happens in the village Codex home under `data\runtime\codex-home`. The workspace boundary, approvals and ChatGPT-only sign-in checks are unchanged, and the Windows sandbox check is just as strict.

You can delete any leftover `virelune-codex-verify-*` folders in `%TEMP%`.

### What is verified, and what is not yet

| Check | Status |
| --- | --- |
| Adapter logic: streaming, saving, resume, stop, timeouts, crashes, sign-in refusal, approvals, workspace boundary, several residents at once | Automated tests against a protocol-faithful fake app-server |
| The four Windows issues above | Regression tests (`tests/codex-windows-regressions.test.ts`) that fail on the old behaviour |
| Real Codex: starts, refuses an unsigned home, loads only the village gateway, and reports apps, plugins, browser and computer use **off** under the village launch settings | Automated tests against the real Codex CLI 0.161.0 (skipped where Codex is not installed) |
| `codex_apps` absent while signed in with ChatGPT | **To verify on your PC** (step 6). Cloud tests cannot sign in to ChatGPT. If Codex ever shows it anyway, the village refuses to use Codex rather than continuing |
| A real Codex reply through the village, and an approved file operation in virelune-sandbox | **To verify on your PC** (steps 6 to 8) |

## Verify your first real Codex conversation (Windows)

Run these in **PowerShell**, one at a time. You already installed Codex, signed in and set up the sandbox once.

1. Pull the fixes: in GitHub Desktop select `virelune-agent-village`, **Fetch origin**, then **Pull origin**.
2. Stop the village if it is running (Ctrl+C in its window), then go to the project:
   ```powershell
   cd "$HOME\Documents\GitHub\virelune-agent-village"
   ```
3. Check the sandbox folder setting. Run `notepad .env`: `VILLAGE_SANDBOX_DIR` should be your virelune-sandbox clone (or empty if the two repos sit side by side).
4. Optional: confirm the sign-in is still the ChatGPT one. Run `npm run codex:login` only if step 6 says otherwise.
5. Set up the Windows sandbox **once more**, because the old version erased the setup:
   ```powershell
   npm run codex:sandbox-setup
   ```
   It should end with "Done: the Codex sandbox is ready" (or "already set up"). If it fails, run `npm run codex:sandbox-setup -- --elevated`.
6. Run the full check and one real reply:
   ```powershell
   npm run codex:verify
   ```
   Expected:
   - `PASS  sign-in type (village needs a ChatGPT plan login): ChatGPT plan (plus)`
   - `PASS  MCP isolation (village launch settings): only the village gateway (village); built-in apps, plugins, browser and computer use are off`
   - `PASS  Windows sandbox readiness: ready`
   - Codex's sentence streams in, ending with `Verified: a genuine Codex reply`.

   If MCP isolation still fails, copy the whole output to me. The village will not use Codex until it passes.
7. Start the village and talk to Codex:
   ```powershell
   npm start
   ```
   Open http://127.0.0.1:4317, press **Check integrations**, click Codex at the Engineering Forge, send a message and watch the reply stream in. Stop the village (Ctrl+C), run `npm start` again, reopen the page and click Codex: the conversation is still there.
8. The approved file operation. Ask Codex:
   > Create a file named hello-from-virelune.txt in the workspace containing one line: Hello from Virelune.

   An approval card appears in the chat with the file and its contents. Press **Approve**: the file appears in your virelune-sandbox folder, and the activity feed shows "Codex changed hello-from-virelune.txt". Ask again for a second file and press **Deny**: no file is written, and Codex says it was declined. Afterwards, discard or commit the file in GitHub Desktop.

If any step fails, send me the exact text from the terminal or the chat.
