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
2. **Real agent integrations.** 2A (built; Windows fixes in; waiting on your PC check): Codex through the Codex app-server, using the isolated Codex home and the Tool Gateway. 2B (done): per-resident paid-use switch. 2C (built, mock-tested): Claude (Anthropic Messages API) and Echo (OpenAI Responses API), behind that switch. Aura, Blender and Unreal MCP are investigated with real handshakes and stay disconnected until those pass.
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

## Phase 2B: paid API safeguards (done)

Residents whose provider bills per use need **Allow paid use** switched on before any request can be made. These are Claude, Claude · Blender and Claude · Unreal (Anthropic API) and Echo (OpenAI API).

- **Off by default** for every paid resident, on every machine. Setup never turns it on, and no `.env` setting can. The only way is the switch in the resident's Profile, which first asks you to confirm that replies will be billed to your account (the API requires `acknowledge: true`).
- **Enforced by Village Hall** before every billable request: chat replies now, task runs in Phase 3. Adapters must check again right before each provider call (`assertPaidAllowed`), so switching it off between two calls in a tool loop also blocks the second.
- **Off works immediately.** Turning paid use off stops a paid reply in progress. **Stop all paid use** in the top bar switches every resident off at once.
- **One switch per resident.** Allowing Claude does not allow Claude · Blender, Claude · Unreal or Echo.
- **Logged.** `billing.paid_use_changed` records every change (who, when, which resident). `billing.request_denied` records every refused request (resident, provider, purpose, message or run).
- **Visible.** Each Profile has a Billing section (provider, billing method, whether actions can cost money, the switch and since when). The chat says when a message was held back because paid use is off. The top bar shows who may spend money right now, and the residents list tags them "paid".
- **Not affected.** Codex uses your ChatGPT plan (subscription), so it has no paid switch and still refuses API-key sign-ins. Scribe (Ollama) is free and local; Aura is a subscription.
- **Keys stay on the server.** API keys live only in Village Hall's `.env`. A test checks that the state, resident, event, doctor and page responses never contain them, and that `.env` and the database are never served.
- **Budgets.** Each resident's per-task and daily budget is shown when you allow paid use, but it is **not enforced yet**. Set a monthly spending limit in your provider's dashboard.

## Phase 2C: Claude and Echo adapters (built; not yet verified live)

**Authentication options checked.** Claude needs an **Anthropic API key**: a Claude.ai subscription cannot be used by third-party apps. Echo needs an **OpenAI API key**: a ChatGPT subscription does not pay for API use. Both bill per use, so both sit behind **Allow paid use** (Phase 2B). Neither has a free or subscription route, so there is nothing to fall back to, and the village does not try.

**Implementation.** The planned SDK packages (Claude Agent SDK, OpenAI Agents SDK) cannot be installed in the cloud workspace (no npm access), and the main residents only need conversation for now. So both adapters call the providers' official HTTP APIs directly with streaming, using Node's built-in `fetch`, with no packages to install on Windows:

| Resident | Runtime | API | Notes |
| --- | --- | --- | --- |
| Claude | `anthropic-messages` | `POST https://api.anthropic.com/v1/messages`, `anthropic-version: 2023-06-01`, `stream: true` | Model `claude-sonnet-5-5` (current model ID, checked in Anthropic's docs). Event format checked against Anthropic's streaming docs |
| Echo | `openai-responses` | `POST https://api.openai.com/v1/responses`, `stream: true`, `store: false` | Model `gpt-5.6-terra` from Echo's config. Event format follows OpenAI's documented Responses streaming events, but the cloud workspace cannot reach OpenAI to check it. Confirm the model name in your OpenAI dashboard |

- **Paid-use gate.** Each adapter calls the paid-use check immediately before every request. With paid use off, or no key, no HTTP request is made.
- **Keys.** Keys are read from Village Hall's `.env` and sent only to the provider. They never appear in the browser, events, saved messages or errors (tested). The adapters never read a base URL from `.env`, so a key cannot be redirected to another server.
- **Identity.** Each resident gets its own role and identity in the system prompt. Both chats show a disclosure that this is the village's own API instance, not your ChatGPT or Claude.ai account, with none of those conversations or memory.
- **No tools in chat yet.** Claude and Echo have no granted Tool Gateway tools, and the adapters offer none, so they cannot touch files. Tool use through the gateway comes with Phase 3 delegation.
- **Handling.** Streaming into the chat, saved history (sent back as alternating turns), stop, timeouts and switching paid use off all close the HTTP stream. Errors are failures with a clear reason: bad key, rate or spending limit, overload, a mid-stream error, a cut-off stream, or a failed response. Length limits are marked in the saved reply.
- **Variants stay locked.** Claude · Blender and Claude · Unreal keep the Agent SDK runtime, because they will need Blender and Unreal tools. They stay disconnected until those are verified. Scribe keeps its local Ollama setup.

**What is verified.** Only mock-based tests (`tests/paid-adapters.test.ts`): a local fake server speaking the documented formats. **No live request has been made to Anthropic or OpenAI.** A live check needs your key and your permission to spend:

```powershell
# 1. Put the key in .env (ANTHROPIC_API_KEY=... and/or OPENAI_API_KEY=...), restart the village, Check integrations.
# 2. In the village, open Claude (or Echo) > Profile > Allow paid use.
# 3. One small billed request through the real adapter:
npm run paid:verify -- claude --confirm-paid
npm run paid:verify -- echo --confirm-paid
```

`paid:verify` refuses without `--confirm-paid`, and refuses while paid use is off. It never turns paid use on.

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
