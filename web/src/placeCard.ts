// The place card: what you see when you pick a building that nobody lives in (a shared workplace or a
// service slot). Everything on it comes from the layout and the registry; it never claims a connection.
import { $, el } from './dom.ts';
import type { Store } from './store.ts';
import { buildingRotY, route, type BuildingSpec, type World } from './village/worldModel.ts';

export type PlaceBuilding = BuildingSpec & { residents: string[]; workers: { profile: string; resident: string }[]; indicatorAnchor?: [number, number, number] };
export type PlaceWorld = World & { buildings: PlaceBuilding[] };

const KIND: Record<string, string> = { residence: 'Home', workplace: 'Shared workplace', service: 'Service building' };

function compass(dx: number, dz: number): string {
  const names = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  const deg = (Math.atan2(dz, dx) * 180) / Math.PI;
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

export class PlaceCard {
  private root = $('#place');
  private store: Store;
  private world: () => PlaceWorld | null;
  current: string | null = null;
  /** Open a resident's window (from the "works here" list). */
  onResident: (id: string) => void = () => {};
  onFocus: (building: string) => void = () => {};
  onClose: () => void = () => {};

  constructor(store: Store, world: () => PlaceWorld | null) {
    this.store = store;
    this.world = world;
  }

  /** Open the card for a building; false if the layout does not know it. */
  open(id: string): boolean {
    const w = this.world();
    const b = w?.buildings.find((x) => x.id === id);
    if (!w || !b) return false;
    this.current = id;
    this.root.hidden = false;
    const district = w.districts.find((d) => d.id === b.district);
    const names = new Map<string, string>((this.store.state?.residents ?? []).map((r: any) => [r.id, r.displayName]));
    const residentBtn = (rid: string, extra = '') => el('button', { class: 'btn ghost small', type: 'button', onclick: () => this.onResident(rid) }, `${names.get(rid) ?? rid}${extra}`);
    const byResident = new Map<string, string[]>();
    for (const wk of b.workers) byResident.set(wk.resident, [...(byResident.get(wk.resident) ?? []), wk.profile]);
    const rot = buildingRotY(b);
    const walk = route(w, 'plaza', `b:${b.id}`);
    const rows: [string, HTMLElement | string][] = [
      ['District', district ? `${district.name} · ${district.subtitle}` : b.district],
      ['Lives here', b.residents.length ? el('span', { class: 'chips' }, ...b.residents.map((r) => residentBtn(r))) : b.kind === 'workplace' ? 'Nobody. Residents come here to work.' : 'Nobody yet.'],
    ];
    if (b.workers.length) rows.push(['Works here', el('div', {}, el('span', { class: 'chips' }, ...[...byResident.keys()].map((r) => residentBtn(r))), el('p', { class: 'hint' }, `Through ${b.workers.map((x) => x.profile).join(', ')}. These are execution profiles of the same residents, not extra residents.`))]);
    if (b.kind === 'service') rows.push(['Connection', 'Not connected. No integration exists for this building yet, so nothing here can run.']);
    else if (b.kind === 'workplace') rows.push(['Connection', "Uses each resident's own connection. Their status is shown on their own card."]);
    if (b.modelNote) rows.push(['Model', `Coming: ${b.modelNote}. Until it arrives, a development marker shows the slot (Graphics → Show building slots).`]);
    rows.push(['Entrance', `Faces ${compass(Math.sin(rot), Math.cos(rot))}${walk ? `. On foot from the fountain: ${Math.round(walk.length)} m` : ''}.`]);
    if (b.indicatorAnchor) rows.push(['Above', `Space ${Math.round(b.indicatorAnchor[1] - (b.y ?? 0))} m up is reserved for future task-progress indicators.`]);
    this.root.replaceChildren(
      el('header', { class: 'rw-head' },
        el('span', { class: `rw-crest kind-${b.kind}` }),
        el('div', { class: 'rw-title' }, el('h3', {}, b.place), el('div', { class: 'hint' }, `${KIND[b.kind] ?? b.kind}${b.subtitle && b.subtitle !== b.place ? ` · ${b.subtitle}` : ''}`)),
        el('button', { class: 'close', type: 'button', 'aria-label': 'Close', onclick: () => this.close() }, '×'),
      ),
      el('table', { class: 'rw-profile' }, ...rows.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, v)))),
      el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'btn ghost', type: 'button', onclick: () => this.onFocus(b.id) }, 'Show in the village')),
    );
    return true;
  }

  /** Hide without telling the caller (used when another window takes its place). */
  hide() {
    this.current = null;
    this.root.hidden = true;
  }

  close() {
    this.hide();
    this.onClose();
  }
}
