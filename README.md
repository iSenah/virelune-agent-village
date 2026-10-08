# Virelune Agent Village

A browser-based, stylized village where real AI agents work on real projects. Every sign of work in the village comes from a real backend event. Nothing is simulated.

> **Status: work in progress (Milestone 1, foundation).** The backend core, registries, event log, task engine, Tool Gateway and procedural 3D village are being built. No agent is connected yet. Full setup instructions for Windows will land with the milestone.

## Principles

- **Real activity only.** Residents look busy only when a real run is in progress. Ambient life (weather, lights, idle wandering) is clearly separate.
- **Registered but disconnected.** Every resident is registered. A resident connects only after real integration checks pass on the machine you are using.
- **Restricted by default.** Residents reach MCP tools only through the Tool Gateway, with per-resident grants, approvals and leases.
- **Portable.** Runs on Windows, macOS and Linux with Node.js 22.18+. Machine settings live in a git-ignored `.env`.

## Repositories

- `virelune-agent-village` (this repo): the application.
- `virelune-sandbox`: a separate, standalone repo where experimental agent tasks run.
