// Pure mapping from REAL backend state + events to what the village shows. No randomness, no invented activity.
// Ambient effects (time of day, lantern flicker, idle sway) live in the scene and never read from here.

export type ResidentLike = { id: string; displayName: string; building: string; status: 'untested' | 'disconnected' | 'connected'; reasons: string[]; appearance: { lineage: string; color: string; figure?: boolean } };
export type EventLike = { seq: number; type: string; actor: string; taskId: string | null; runId: string | null; payload: Record<string, any> };

export type ResidentVisual = {
  id: string;
  /** home: at the door; working: at the workbench; waiting: walked to the plaza porch for an approval */
  pose: 'home' | 'working' | 'waiting';
  status: ResidentLike['status'];
};

export type BuildingVisual = {
  id: string;
  /** Windows lit only when at least one resident of this building is connected. */
  lit: 'lit' | 'dark' | 'unknown';
  /** Chimney/forge activity only while a real run is active in this building. */
  busy: boolean;
  residents: string[];
};

/** Active runs and pending approvals, derived only from events. */
export function deriveActivity(events: EventLike[]): { activeRuns: Map<string, string>; pendingApprovals: Map<string, string> } {
  const activeRuns = new Map<string, string>(); // runId -> resident
  const pendingApprovals = new Map<string, string>(); // approvalId -> resident
  for (const e of events) {
    if (e.type === 'run.started' && e.runId) activeRuns.set(e.runId, e.actor);
    else if ((e.type === 'run.finished' || e.type === 'run.failed' || e.type === 'run.interrupted') && e.runId) activeRuns.delete(e.runId);
    else if (e.type === 'approval.requested' && e.payload?.approvalId) pendingApprovals.set(String(e.payload.approvalId), e.actor);
    else if (e.type === 'approval.decided' && e.payload?.approvalId) pendingApprovals.delete(String(e.payload.approvalId));
    else if (e.type === 'village.started') {
      // After a restart, runs that were in flight are interrupted (the backend marks their tasks).
      activeRuns.clear();
    }
  }
  return { activeRuns, pendingApprovals };
}

export function deriveVisuals(residents: ResidentLike[], events: EventLike[]): { residents: ResidentVisual[]; buildings: BuildingVisual[] } {
  const { activeRuns, pendingApprovals } = deriveActivity(events);
  const running = new Set(activeRuns.values());
  const waiting = new Set(pendingApprovals.values());
  const rv: ResidentVisual[] = residents.map((r) => ({
    id: r.id,
    status: r.status,
    // A resident can only be shown working if it is connected AND a real run is active.
    pose: r.status === 'connected' && waiting.has(r.id) ? 'waiting' : r.status === 'connected' && running.has(r.id) ? 'working' : 'home',
  }));
  const byBuilding = new Map<string, ResidentLike[]>();
  for (const r of residents) byBuilding.set(r.building, [...(byBuilding.get(r.building) ?? []), r]);
  const bv: BuildingVisual[] = [...byBuilding.entries()].map(([id, rs]) => ({
    id,
    residents: rs.map((r) => r.id),
    lit: rs.some((r) => r.status === 'connected') ? 'lit' : rs.every((r) => r.status === 'untested') ? 'unknown' : 'dark',
    busy: rs.some((r) => r.status === 'connected' && running.has(r.id)),
  }));
  return { residents: rv, buildings: bv };
}

/** Human-readable line for the event feed. */
export function describeEvent(e: EventLike, names: Map<string, string>): string {
  const who = (id: string) => names.get(id) ?? id;
  const p = e.payload ?? {};
  switch (e.type) {
    case 'village.started':
      return `Village Hall started on ${p.machine} (${p.residents} residents registered)`;
    case 'registry.invalid':
      return `Registry problem in ${String(p.file).split(/[\\/]/).slice(-2).join('/')}: ${p.message}`;
    case 'resident.status_changed':
      return `${who(e.actor)} is ${p.status === 'untested' ? 'not checked yet' : p.status}${p.reasons?.[0] ? ` (${p.reasons[0]})` : ''}`;
    case 'doctor.started':
      return `Integration check started${p.live ? '' : ' (offline)'}`;
    case 'doctor.completed':
      return `Integration check finished on ${p.machine}: ${p.count} integrations`;
    case 'doctor.failed':
      return `Integration check failed: ${p.error}`;
    case 'integration.checked':
      return `${p.name}: ${p.status}`;
    case 'task.created':
      return `New task: "${p.title}"${p.assignee ? ` for ${who(p.assignee)}` : ''}`;
    case 'task.status_changed':
      return `Task ${e.taskId}: ${p.from} → ${p.to}${p.reason ? ` (${p.reason})` : ''}`;
    case 'approval.requested':
      return `${who(e.actor)} asks for approval: ${p.summary}`;
    case 'approval.decided':
      return `Approval ${p.approvalId}: ${p.decision}${p.reason ? ` (${p.reason})` : ''}`;
    case 'settings.changed':
      return `Setting ${p.key}: ${p.from} → ${p.to}`;
    case 'tool.call_requested':
      return `${who(e.actor)} requested ${p.server}: ${p.tool} (${p.decision})`;
    case 'tool.call_denied':
      return `Tool Gateway denied ${p.server}: ${p.tool} for ${who(p.resident)} (${p.reason})`;
    case 'tool.call_completed':
      return `${who(e.actor)} used ${p.server}: ${p.tool}${p.isError ? ' (error)' : ''}`;
    case 'tool.auth_failed':
      return `Tool Gateway rejected a request for ${p.resident} (${p.reason})`;
    case 'chat.message_sent':
      return `You wrote to ${who(String(p.resident))}`;
    case 'chat.message_undelivered':
      return `Message to ${who(String(p.resident))} not delivered: ${p.reason}`;
    case 'chat.reply_completed':
      return `${who(e.actor)} replied`;
    case 'run.started':
      return p.kind === 'chat' ? `${who(e.actor)} is answering your message` : `${who(e.actor)} started work${e.taskId ? ` on task ${e.taskId}` : ''}`;
    case 'run.finished':
      return p.kind === 'chat' ? `${who(e.actor)} finished answering` : `${who(e.actor)} finished work${e.taskId ? ` on task ${e.taskId}` : ''}`;
    case 'run.failed':
      return `${who(e.actor)} could not finish: ${p.error}`;
    case 'run.interrupted':
      return `${who(e.actor)} was stopped${p.reason ? ` (${p.reason})` : ''}`;
    case 'runtime.command_finished':
      return `${who(e.actor)} ran \`${p.command}\`${p.exitCode !== null && p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ''}`;
    case 'runtime.files_changed':
      return `${who(e.actor)} ${p.status === 'completed' ? 'changed' : 'proposed changes to'} ${(p.files ?? []).map((f: any) => String(f.path).split(/[\\/]/).pop()).join(', ')}`;
    case 'runtime.tool_called':
      return `${who(e.actor)} used ${p.server}: ${p.tool}`;
    case 'runtime.request_declined':
      return `Declined automatically for ${who(String(p.resident))}: ${p.what} ${p.reason}`;
    case 'lease.acquired':
      return `${who(e.actor)} took the key to ${p.server}`;
    case 'lease.released':
      return `${who(e.actor)} returned the key to ${p.server}`;
    default:
      return e.type;
  }
}
