# Virelune Agent Village

A browser-based, stylized village where real AI agents work on real projects. Echo, the Mayor, coordinates. Codex builds, Claude designs and researches, and specialist residents join as their integrations are verified. Every sign of work in the village comes from a real backend event; nothing is simulated.

**Status: Version 2, Phase 2C (Claude and Echo adapters, mock-tested).** Village Hall (backend), registries, event log, task engine, approvals, Echo's autonomy setting, the Tool Gateway, `village doctor`, the 3D village, and a chat window for every resident all run. Codex can now reply for real through your ChatGPT plan, once it is signed in for the village (see [Verify your first real Codex conversation](docs/v2-plan.md#verify-your-first-real-codex-conversation-windows)). Every other resident still marks messages "not delivered" with the reason until its own adapter and checks are in place. See [docs/v2-plan.md](docs/v2-plan.md) for the V1 audit, the V2 phases and how to get your PC ready for the first agent, and [docs/phase-0-report.md](docs/phase-0-report.md) for the original research.

## Quick start (Windows)

You need **Node.js 22.18 or newer** (24 LTS recommended) and **Git**. Nothing else is required: there are no npm packages to install for this milestone.

```powershell
winget install OpenJS.NodeJS.LTS   # if you don't have Node.js
winget install Git.Git             # if you don't have Git
git clone https://github.com/iSenah/virelune-agent-village.git
cd virelune-agent-village
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
npm start
```

Then open **http://127.0.0.1:4317**. Or double-click `scripts\start-village.cmd`.

The setup script checks Node and Git, creates your machine's `.env` from `.env.example` (only if it doesn't exist), and runs `village doctor` to see which integrations this machine has.

### macOS / Linux

```bash
./scripts/setup.sh
npm start
```

## Using two machines (laptop and home PC)

The project is the same on every machine; only `.env` and the `data/` folder are machine-specific, and both are git-ignored.

1. Clone the repo on each machine and run the setup script there.
2. Each machine gets its own `.env` (keys, tool paths) and its own `data/` (database, village Codex login).
3. Run **Check integrations** in the village (or `npm run doctor`) on each machine. Residents connect only for what that machine actually has. On a laptop without Blender or Unreal, those residents stay registered but disconnected, with the reason shown.
4. Move code with `git pull` / `git push`. Never copy `.env` or `data/` between machines.

The village layout (lamp-post rotations you set in the village) is saved in `config/layout/village.json`, which **is** committed, so commit it after arranging lamps and both machines show the same village.

Doctor results are tied to the machine name. Results from one machine are never trusted on another.

## Talking to residents

Click a resident's figure, its building, or its name in the residents list. The resident window has:

- **Chat**: your conversation, kept in this machine's database. You can only send when the resident can really answer (connected, and its runtime adapter enabled); otherwise the window says why. There are no canned or simulated replies.
- **Tasks**: tasks assigned to this resident, and a form to add one.
- **Approvals**: anything this resident is waiting for you to approve.
- **Profile**: role, runtime, provider and billing, model, permissions, budget, tools and what each may do, and the integration checks behind its status.

Buildings with two residents (Blender House, UE Studio) show both as tabs at the top.

## Integration statuses

`village doctor` (also the **Check integrations** button) reports each integration as:

| Status | Meaning |
| --- | --- |
| `connected` | A live handshake succeeded in this run, and authentication (if needed) is verified |
| `authenticated` | Credentials were verified by a real check, but no live session handshake was done |
| `installed` | Found and its version read, but not authenticated or not usable yet |
| `untested` | Present or configured, but the check could not run here |
| `unavailable` | Not found on this machine |

```powershell
npm run doctor              # summary
npm run doctor -- --verbose # every individual check
npm run doctor -- --offline # skip the free live API key checks
npm run probe:sandbox       # verify Codex's sandbox blocks writes outside the workspace and network access
npm run codex:verify        # one real Codex reply through the village adapter (uses your ChatGPT plan)
npm run codex:sandbox-setup # Windows: one-time Codex sandbox setup for the village
```

## Connecting the focus residents

| Resident | What it needs on this machine |
| --- | --- |
| **Codex** | Codex CLI (`npm install -g @openai/codex`), then `npm run codex:login` (choose Sign in with ChatGPT), on Windows `npm run codex:sandbox-setup`, then `npm run codex:verify`. The village uses its **own** Codex home under `data/`, so your personal Codex settings and MCP servers are never loaded. API-key sign-ins are refused, and Codex's built-in apps (`codex_apps`), plugins, browser and computer use are switched off and checked on every launch. |
| **Claude** | `ANTHROPIC_API_KEY` in `.env` (paid API; a Claude subscription can't be used by third-party apps), then **Allow paid use** in Claude's Profile. Optional live check: `npm run paid:verify -- claude --confirm-paid`. |
| **Echo** | `OPENAI_API_KEY` in `.env` (paid API; a ChatGPT subscription does not cover it), then **Allow paid use** in Echo's Profile. The village's Echo is a separate API instance, not your ChatGPT. Optional live check: `npm run paid:verify -- echo --confirm-paid`. |

Aura, Scribe and the Blender and Unreal profiles of Claude and Codex stay **disconnected until each passes its own verification test**, even if their tools are installed. Gemini, Copilot and DeepSeek are planned residents.

## Configuration

All machine settings live in `.env` (see `.env.example`). Paths are resolved relative to the project folder unless absolute, so the project can live anywhere.

| Setting | Purpose |
| --- | --- |
| `VILLAGE_PORT` | Port for the village (default 4317). The host is always loopback. |
| `VILLAGE_DATA_DIR` | Database and runtime files (default `./data`) |
| `VILLAGE_MACHINE_NAME` | Shown in the village; doctor results are tied to it |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Echo and Claude |
| `CODEX_PATH` | Only if `codex` is not on PATH |
| `VILLAGE_SANDBOX_DIR` | Your virelune-sandbox clone, the only folder residents may change (with your approval). Defaults to `../virelune-sandbox` if it exists, else `data/workspaces/<resident>` |
| `OLLAMA_HOST`, `BLENDER_PATH`, `BLENDER_MCP_COMMAND`, `UNREAL_ENGINE_ROOT`, `UNREAL_MCP_COMMAND`, `AURA_MCP_COMMAND` | Optional specialist tools |

Residents, runtimes, providers, tool servers and playbooks are JSON manifests in `config/`. They are validated on startup; invalid ones are reported in the activity feed and not loaded.

## Security model

- **Local only.** Village Hall listens on 127.0.0.1, rejects non-loopback `Host` headers, and refuses cross-origin or header-less state changes.
- **Tool Gateway.** Residents reach MCP tools only through `/mcp/<resident>` with a per-session token (kept in memory, never on disk). Tools are hidden unless classified (`read` / `write` / `exec`) and granted. `exec` tools always need your approval, with the exact arguments shown. Unanswered approvals expire as denied. Apps like Blender need an exclusive lease. Resources, prompts and sampling are not passed through.
- **Runtime isolation.** Codex runs with its own Codex home (verified: it then loads no personal MCP servers), `workspace-write` sandbox and `untrusted` approvals. Claude runs with strict MCP config and no user settings.
- **Paid API safeguards.** Residents on per-use APIs (Claude and its variants, Echo) cannot make a single request until you switch on **Allow paid use** in their Profile. It is off by default, separate for each resident, switched off instantly from the top bar, and every change and refusal is logged. Keys never leave Village Hall.
- **Echo autonomy.** Only **Supervised** works: every plan waits for you. Assisted and Autonomous are visible but disabled.
- **No secrets in git or exports.** `.env`, `*.local.json`, `data/`, databases and key files are git-ignored and excluded from ZIP exports, and the export refuses to run if any file looks like it contains a key.

## Tests

```powershell
npm test
```

134 tests cover the registries, event log, task engine, approvals, Echo autonomy, resident chat, the Codex, Claude and Echo adapters, paid-use authorization, the API, the village's event-to-visual mapping, the custom models and their distance versions, graphics presets, the village layout, exports and secrets, and the Tool Gateway's security boundaries. Three tests drive the real Codex CLI (gateway-only isolation, built-in tool sources switched off, refusing an unsigned village home); they are reported as skipped (not passed) when Codex is not installed. None of the tests use your Codex sign-in.

## Export without GitHub

```powershell
npm run export
```

Creates `exports/virelune-agent-village-<date>.zip` with the whole project, minus secrets, machine settings, the database and dependencies.

## Project layout

```
config/          Registries: residents, runtimes, providers, tools, playbooks (JSON)
integrations/    Real integration checks, runtime launch config, probes (separate from the visual app)
server/          Village Hall: API, event log, task engine, approvals, Tool Gateway, CLI
web/             The browser app: control panel + procedural three.js village (TypeScript, served as JS)
tests/           Automated tests (node --test) and a test-only MCP fixture
scripts/         Setup and start scripts for Windows, macOS and Linux
docs/            Phase 0 report and notes
```

Experimental agent tasks run in the separate **virelune-sandbox** repository, never in this one.

## Moving around the village

| Action | Mouse | Keyboard |
| --- | --- | --- |
| Turn | Left-drag | Q / E |
| Pan | Right-drag | W A S D or arrow keys |
| Zoom | Scroll wheel | + / - |
| Open a resident's window | Click its figure or building, or its name in the left panel | |
| Fly to a building | Double-click it, or click a resident in the left panel | |
| Back to the overview | **Go to → Whole village** | Home or 0 |
| Fly to a district or building | **Go to** button in the top bar | 1 to 5 (districts) |
| Building info for workplaces and service slots | Click the building (opens its place card) | |
| Show or hide panels | | P |
| Graphics quality (Auto, High, Medium, Low) | **Graphics** button in the top bar | |
| Frame rate and graphics diagnostics | **Graphics → Show diagnostics** | G |
| Development markers on building slots | **Graphics → Show building slots** (on until each model arrives) | |
| Walk paths, entrances, indicator space | **Graphics → Show layout guides** | |
| Turn a lamp post | Click it, then use the arrow buttons | [ / ] (Shift for 5°), Esc when done |

The village lowers its render resolution automatically on slower GPUs and restores it when there is headroom. **Graphics: Auto** also steps down to Medium or Low only if frames stay slow; you can pick a preset yourself. See [docs/performance-audit.md](docs/performance-audit.md).

## Art and 3D models

The village has five districts: Founders' Square, Creative Workshops, the Artisan Quarter, Scholars' Heights and the Forgotten Woods. It uses custom textured models for the seven original buildings, the street lamps and five residents (Echo, Claude, Codex, Aura, Scribe), listed in `web/assets/models/manifest.json` (see [web/assets/models/README.md](web/assets/models/README.md)). Procedural placeholders show while models load and stay in place for any model that fails to load. Disconnected or unchecked residents are dimmed and their buildings slightly darker; a connected resident is shown at full colour with a soft ring at its feet. There are no work animations unless a real run is in progress. The fountain, river, waterfalls, bridges, fences and lamps are ambient scenery built after the hub concept; none of it reacts to agent work. Press **G** (or **Graphics → Show diagnostics**) for frame rate, draw calls, triangles and what each part of the village costs. Buildings, residents and lamp posts use a lighter version when far from the camera, so the overview stays fast. The five newer building slots (Tripo Stable, Runway Cinema, Gemini Observatory, Copilot Commandery, DeepSeek Gothic Cottage) show development markers until their models arrive; see [docs/world-expansion.md](docs/world-expansion.md) for how to add them.

| District | Building | Who |
| --- | --- | --- |
| Founders' Square | Town Hall | Echo |
| | Library & Archives | Claude |
| | Engineering Forge | Codex |
| | Unreal Workshop | Aura |
| | Post Office | Scribe |
| Creative Workshops | Blender House, UE Studio | Shared workplaces: Claude and Codex work here through their Blender and Unreal profiles |
| Artisan Quarter | Tripo Stable, Runway Cinema | Future services (no resident) |
| Scholars' Heights | Gemini Observatory, Copilot Commandery | Gemini, Copilot (planned) |
| The Forgotten Woods | DeepSeek Gothic Cottage | DeepSeek (planned) |

Residents walk the village's roads in response to real activity only: home when idle (Zzz while connected), to a workplace for profile work, outside the door when waiting for your approval, with blue / amber / red / gold indicators over buildings (see [docs/v3a-resident-life.md](docs/v3a-resident-life.md); `?simulate` opens a clearly labelled development-only simulation). Claude and Codex are each one resident. Their Blender and Unreal work runs through **execution profiles** (`config/profiles/`): same resident and figure, but each profile has its own runtime, tools and verification, and Claude's profiles follow Claude's paid-use switch. Planned residents have a reserved home but no provider, so they are never shown as connected and cannot receive messages. Building positions, entrances, districts and walkable roads live in `config/layout/world.json` (see [docs/world-expansion.md](docs/world-expansion.md)).

`docs/concept-art/` holds the reference sheets for the layout and the residents.

## Third-party code

`web/vendor/` holds three.js r170 files (MIT, see `web/vendor/THREE_LICENSE.txt`): `three.module.js`, `OrbitControls.js`, `GLTFLoader.js`, `BufferGeometryUtils.js` and `RoomEnvironment.js`. Their import paths were changed from `'three'` to the local files.
