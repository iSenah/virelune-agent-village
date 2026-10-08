// Client store: initial state over REST, then the live event stream (Server-Sent Events, auto-resume by seq).
export type VillageState = {
  machine: string;
  platform: string;
  lastSeq: number;
  residents: any[];
  tasks: any[];
  approvals: any[];
  echo: { autonomy: string; levels: { id: string; label: string; available: boolean; description: string }[] };
  doctor: { running: boolean; results: any[] | null };
  registry: any;
};

type Listener = () => void;

export class Store {
  state: VillageState | null = null;
  events: any[] = [];
  connected = false;
  private listeners = new Set<Listener>();
  private source: EventSource | null = null;
  private refreshTimer: number | null = null;

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  async start() {
    await this.refresh();
    const history = await api('GET', '/api/events?after=0&limit=5000');
    this.events = history.events;
    this.openStream();
    this.emit();
  }

  async refresh() {
    this.state = await api('GET', '/api/state');
    this.emit();
  }

  private openStream() {
    const after = this.events.length ? this.events[this.events.length - 1].seq : 0;
    this.source = new EventSource(`/api/events/stream?after=${after}`);
    this.source.onopen = () => {
      this.connected = true;
      this.emit();
    };
    this.source.onerror = () => {
      this.connected = false;
      this.emit();
    };
    this.source.addEventListener('village', (m) => {
      const e = JSON.parse((m as MessageEvent).data);
      if (this.events.length && e.seq <= this.events[this.events.length - 1].seq) return;
      this.events.push(e);
      if (this.events.length > 8000) this.events.splice(0, this.events.length - 8000);
      this.scheduleRefresh();
      this.emit();
    });
  }

  private scheduleRefresh() {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refresh().catch(() => {});
    }, 150);
  }
}

export async function api(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-village-client': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
