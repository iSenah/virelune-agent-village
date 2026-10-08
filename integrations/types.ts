// Shared result shape for `village doctor`. The five statuses are deliberately strict:
//   unavailable   - not found on this machine
//   installed     - found and its version read, but not (yet) authenticated or not usable
//   authenticated - credentials verified by a real check (the tool itself, or a live auth call)
//   connected     - a live handshake with the runtime/service succeeded in this run, and auth (if needed) is verified
//   untested      - present or configured, but the check could not run here (skipped, offline, timed out, needs a package)
export type IntegrationStatus = 'unavailable' | 'installed' | 'authenticated' | 'connected' | 'untested';

export type Check = { name: string; result: 'pass' | 'fail' | 'skip'; detail: string };

export type IntegrationResult = {
  id: string;
  name: string;
  status: IntegrationStatus;
  /** True when this integration meets what residents need from it (e.g. git installed, an API key verified). */
  ready: boolean;
  version: string | null;
  summary: string;
  checks: Check[];
  costs: string;
};

export type DoctorContext = {
  env: Record<string, string | undefined>;
  projectRoot: string;
  dataDir: string;
  /** Make free live auth calls (listing models). Never generates tokens. */
  live: boolean;
};

export type DoctorReport = {
  machine: string;
  platform: string;
  node: string;
  startedAt: string;
  finishedAt: string;
  live: boolean;
  integrations: IntegrationResult[];
};
