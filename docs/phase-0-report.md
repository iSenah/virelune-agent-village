# Phase 0 report: environment checks and integration tests

Run on 2026-10-08 in the cloud development workspace (Linux x86_64, Node 22.22.0, no GPU), because your laptop was offline. Everything below marked **verified** actually ran here. Everything marked **needs Windows** must be checked on your laptop and home PC with `npm run doctor`, `npm run probe:sandbox` and `npm test`.

## What actually ran and passed here

| Area | Result | Evidence |
| --- | --- | --- |
| Village Hall starts with zero integrations | **Verified** | Server boots, serves the app, all 9 residents shown as "not checked yet" |
| 3D village in a real browser | **Verified** | Headless Chromium (software WebGL) rendered the procedural village and control panel |
| `village doctor` | **Verified** | Ran from the CLI and from the UI (in a child process); results recorded as events |
| Codex CLI 0.161.0 | **Verified: installed**, not logged in | Real binary from the official GitHub release |
| Codex app-server handshake | **Verified** | `initialize`, `getAuthStatus`, `account/read`, `mcpServerStatus/list`, ephemeral `thread/start` all answered |
| Codex protocol vs. docs | **Verified** | Generated types from the installed binary: approval requests are `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`; decisions `accept`, `acceptForSession`, `decline`, `cancel`; sandbox modes `read-only`, `workspace-write`, `danger-full-access` |
| Codex MCP isolation | **Verified, with a correction** | `-c mcp_servers={}` does **not** remove servers from a user's config; a dedicated Codex home does. The village now always uses its own Codex home |
| Real Codex → Tool Gateway | **Verified** | Launched as the village launches it, Codex saw only the `village` server and only the tools granted to its resident; a rogue server in a personal config was ignored |
| Tool Gateway security | **Verified** (13 tests) | Tokens, inactive residents, browser origins, Host header, default deny, unclassified tools hidden, exec approvals (deny, approve, expire), leases, no resources/prompts/sampling, size limits |
| Registries, event log, task engine, API, autonomy, exports | **Verified** (32 tests) | Including restart → `interrupted`, Assisted/Autonomous refused, secret scan, ZIP round trip |

`npm test`: **45 passed, 0 failed** with Codex installed; **44 passed, 1 skipped** without it.

## What failed or could not be tested here

| Item | Result | Why | Next step |
| --- | --- | --- | --- |
| Codex sandbox enforcement | **Untested** | Linux sandbox needs bubblewrap, which this workspace lacks | Run `npm run probe:sandbox` on Windows (Codex uses its own Windows sandbox; the doctor also calls `windowsSandbox/readiness`) |
| Codex login / model call | **Not possible here** | No ChatGPT login in the cloud; `api.openai.com` is blocked by this workspace's network policy | `npm run codex:login` on your laptop, then the doctor shows Codex as connected |
| Echo (OpenAI API) | **Not possible here** | Blocked network; no key | Add `OPENAI_API_KEY` to `.env`; doctor verifies it with a free models-list call |
| Claude (Anthropic API, Agent SDK) | **Not possible here** | No key; npm registry blocked here, so the SDK couldn't be installed | Add the key; install the SDK in the next milestone |
| React + React Three Fiber | **Deferred** | The npm registry is blocked in this workspace | Milestone 1 uses plain three.js in TypeScript; port to React + R3F on your laptop where npm works |
| Windows specifics | **Needs Windows** | Written for Windows (PATHEXT, `.cmd` shims, `setup.ps1`), not yet run there | Run setup, doctor, probe and tests on the laptop |

## What costs money

| Item | Cost | When |
| --- | --- | --- |
| Everything in this milestone | **Free** | Node, three.js, SQLite (built into Node), all tests |
| Doctor's live key checks | **Free** | They only list models |
| Codex | Included in your ChatGPT plan (5-hour limits) | When Codex starts real tasks (next milestone) |
| Echo | Paid OpenAI API, no free tier (GPT-5.6 Terra about $2 / $12 per million tokens) | When Echo starts planning |
| Claude | Paid Anthropic API (Sonnet 5.5 $2 / $10 per million tokens) | When Claude starts real tasks |

Note: the installed Codex reports its default model as `gpt-6.1-sol`, while OpenAI's API pricing page listed the GPT-5.6 family. Model names live in the manifests, so this is a config change, not a code change.

## Recommended next build

1. **On your laptop:** run `scripts\setup.ps1`, `npm run codex:login`, `npm run probe:sandbox` and `npm test`. This turns the Windows unknowns into facts.
2. **Codex adapter first.** Its protocol, isolation and gateway path are already verified, and it costs nothing beyond your ChatGPT plan. Wire `thread/start` + `turn/start` in `virelune-sandbox`, with approvals routed to the inbox and the village showing the real run.
3. **Then Echo (Supervised)** on the OpenAI Agents SDK with Village tools only.
4. **Then Claude** on the Agent SDK, completing the design → implement → review demo in `virelune-sandbox`.
5. **Port the village to React + R3F** once npm is available, keeping `web/src/village/state.ts` (the tested event-to-visual mapping) unchanged.
