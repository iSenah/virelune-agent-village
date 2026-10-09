// The 3D village. Work-related visuals (lit windows, smoke, forge glow, resident poses, approval markers)
// come only from deriveVisuals(), which reads real backend state. Everything else here is ambient.
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { RoomEnvironment } from '../../vendor/RoomEnvironment.js';
import * as THREE from '../../vendor/three.module.js';
import { attachBuildingModel, BUILDINGS, buildBuilding, drawSign, plinthLampSpots, type BuildingHandle } from './buildings.ts';
import { applyCharacterStatus, attachCharacterModel, buildCharacter } from './characters.ts';
import { buildHub, fenceAlong, PLAZA_R, type Hub } from './hub.ts';
import { plaza, road } from './kit.ts';
import { LampSet, lanternToward, type LampSpot } from './lamps.ts';
import { instantiate, loadManifest, loadShared, modelMaterials, type ModelManifest } from './models.ts';
import { grassGround, landscape, type Keepout } from './nature.ts';
import type { BuildingVisual, ResidentLike, ResidentVisual } from './state.ts';


export type LampInfo = { id: string; label: string; rotation: number; custom: boolean };

type Figure = { group: THREE.Group; resident: ResidentLike; home: THREE.Vector3; target: THREE.Vector3; pose: ResidentVisual['pose']; phase: number };

export class VillageScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private buildings = new Map<string, BuildingHandle>();
  private figures = new Map<string, Figure>();
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private ambient: THREE.AmbientLight;
  private clock = new THREE.Clock();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private hovered: string | null = null;
  private night = true;
  private buildingVisuals = new Map<string, BuildingVisual>();
  private manifest: Promise<ModelManifest | null> = loadManifest();
  private shadowDirty = true;
  private lastStatus = new Map<string, ResidentLike['status']>();
  onSelect: (sel: { building?: string; resident?: string }) => void = () => {};
  /** A lamp post was selected (or deselected with null). */
  onLampSelect: (info: LampInfo | null) => void = () => {};
  /** A lamp post was rotated (degrees) or reset to its default (null); the caller saves it to the layout. */
  onLampRotate: (id: string, rotation: number | null) => void = () => {};
  private lamps!: LampSet;
  private hub!: Hub;
  private stats: HTMLElement | null = null;
  private pendingHover: PointerEvent | null = null;
  private downAt: { x: number; y: number } | null = null;
  private keys = new Set<string>();
  private pickProxies: THREE.Mesh[] = [];
  private proxyMat = new THREE.MeshBasicMaterial({ visible: false });
  private fpsWindow: number[] = [];
  private dpr = Math.min(window.devicePixelRatio, 1.5);
  private statFrames = 0;
  private statSince = performance.now();

  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The village is mostly static: re-render shadows only when something moves or a model arrives.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(0x2c3d2a);
    this.scene.fog = new THREE.Fog(0x2c3d2a, 90, 190);
    // Soft image-based light so the models' metal and PBR materials (e.g. Codex's brass) read correctly.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 400);
    this.camera.position.set(0, 84, 98);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 1);
    // Snappier feel: less drift after letting go, faster zoom, panning across the ground plane.
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.rotateSpeed = 0.9;
    this.controls.zoomSpeed = 1.4;
    this.controls.panSpeed = 1.1;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 14;
    this.controls.maxDistance = 150;
    this.controls.maxPolarAngle = Math.PI * 0.43;
    this.hemi = new THREE.HemisphereLight(0xffe7c8, 0x3a2f28, 1.0);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xfff1dd, 0.35);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff0d6, 1.6);
    this.sun.position.set(-22, 40, 18);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -40;
    sc.right = 40;
    sc.top = 40;
    sc.bottom = -40;
    sc.far = 120;
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.sun);
    this.buildWorld();
    this.setNight(true);
    window.addEventListener('resize', () => this.resize());
    // Hover picking is throttled to one test per frame and skipped while dragging the camera.
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      this.pendingHover = e;
    });
    canvas.addEventListener('pointerdown', (e) => (this.downAt = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('click', (e) => {
      // A drag that ends over a building is a camera move, not a selection.
      if (this.downAt && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 5) return;
      this.pick(e, true);
    });
    canvas.addEventListener('dblclick', (e) => this.pick(e, true, true));
    window.addEventListener('keydown', (e) => this.keys.add(e.key.toLowerCase()) && this.onKey(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    this.resize();
    if (new URLSearchParams(location.search).has('stats')) {
      // Optional performance readout: http://127.0.0.1:4317/?stats
      this.stats = document.createElement('div');
      this.stats.style.cssText = 'position:fixed;left:50%;top:84px;transform:translateX(-50%);z-index:9;font:12px monospace;color:#f2e9d8;background:rgba(0,0,0,.6);padding:4px 10px;border-radius:8px';
      document.body.append(this.stats);
    }
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private buildWorld() {
    this.scene.add(grassGround(170));
    this.scene.add(plaza(PLAZA_R));
    const keepout: Keepout = { circles: [{ x: 0, z: 0, r: PLAZA_R + 2.8 }], segments: [] };
    const spots: LampSpot[] = [];
    const roadAngles: number[] = [];
    const fences: { a: THREE.Vector2; b: THREE.Vector2; offset: number }[] = [];
    BUILDINGS.forEach((def, i) => {
      // road from the plaza edge to the building's front steps
      const front = new THREE.Vector3(0, 0, def.d / 2 + 2.4).applyAxisAngle(new THREE.Vector3(0, 1, 0), def.rotY).add(new THREE.Vector3(def.x, 0, def.z));
      const end = new THREE.Vector2(front.x, front.z);
      const dir = end.clone().normalize();
      const start = dir.clone().multiplyScalar(PLAZA_R + 0.3);
      this.scene.add(road(start, end, 2.6, 100 + i));
      roadAngles.push(Math.atan2(dir.y, dir.x));
      keepout.segments.push({ a: start.clone(), b: end.clone(), r: 2.6 });
      keepout.circles.push({ x: def.x, z: def.z, r: Math.hypot(def.w, def.d) / 2 + 1.6 });
      // lamp posts flanking the road where it leaves the plaza, lanterns hanging over the road
      const right = new THREE.Vector2(-dir.y, dir.x);
      const at = dir.clone().multiplyScalar(PLAZA_R + 2.5);
      for (const s of [1, -1]) {
        const off = right.clone().multiplyScalar(2.35 * s);
        const p = at.clone().add(off);
        spots.push({ id: `road:${def.id}:${s > 0 ? 'right' : 'left'}`, label: `Road to ${def.place}, ${s > 0 ? 'right' : 'left'}`, x: p.x, y: 0, z: p.y, rotY: lanternToward(-off.x, -off.y) });
      }
      fences.push({ a: dir.clone().multiplyScalar(PLAZA_R + 3.9), b: end.clone().sub(dir.clone().multiplyScalar(0.8)), offset: 2.1 });
      const b = buildBuilding(def);
      this.buildings.set(def.id, b);
      this.scene.add(b.group);
      // lamp posts on the plinth, either side of the front steps
      b.group.updateMatrixWorld(true);
      const steps = b.group.localToWorld(new THREE.Vector3(0, 0, def.d / 2 + 1.2));
      for (const spot of plinthLampSpots(def)) {
        const w = b.group.localToWorld(spot.local.clone());
        spots.push({ id: `plinth:${def.id}:${spot.side}`, label: `${def.place}, ${spot.side} lamp`, x: w.x, y: w.y, z: w.z, rotY: lanternToward(steps.x - w.x, steps.z - w.z) });
      }
      // Cheap invisible box for picking (testing the detailed models' triangles on every mouse move is very slow).
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(def.w + 1.2, 9, def.d + 1.2), this.proxyMat);
      proxy.position.y = 4.5;
      proxy.userData.buildingId = def.id;
      b.group.add(proxy);
      this.pickProxies.push(proxy);
    });
    this.scene.add(fenceAlong(fences));
    this.hub = buildHub(roadAngles);
    this.scene.add(this.hub.group);
    spots.push(...this.hub.lampSpots);
    keepout.segments.push(...this.hub.segments);
    keepout.custom = this.hub.blocked;
    for (const sp of spots) keepout.circles.push({ x: sp.x, z: sp.z, r: 1.1 });
    this.lamps = new LampSet(spots);
    this.lamps.onDirty = () => (this.shadowDirty = true);
    this.scene.add(this.lamps.group);
    this.pickProxies.push(...this.lamps.proxies);
    this.scene.add(landscape(keepout));
    this.loadBuildingModels();
  }

  /** Apply saved lamp rotations from the shared village layout. */
  applyLayout(layout: { lamps?: Record<string, { rotation: number }> }) {
    this.lamps.setOverrides(layout.lamps ?? {});
    this.emitLamp();
  }

  private emitLamp() {
    const id = this.lamps.selected();
    this.onLampSelect(id ? { id, label: this.lamps.label(id), rotation: this.lamps.rotation(id), custom: this.lamps.isCustom(id) } : null);
  }

  selectLamp(id: string | null) {
    if (id === this.lamps.selected()) return;
    this.lamps.select(id);
    this.emitLamp();
  }

  /** Rotate the selected lamp post by some degrees (positive = clockwise seen from above). */
  rotateSelectedLamp(deltaDeg: number) {
    const id = this.lamps.selected();
    if (!id) return;
    // three.js turns counter-clockwise for positive angles when seen from above
    const rot = this.lamps.rotateBy(id, -deltaDeg);
    this.onLampRotate(id, rot);
    this.emitLamp();
  }

  resetSelectedLamp() {
    const id = this.lamps.selected();
    if (!id) return;
    this.lamps.reset(id);
    this.onLampRotate(id, null);
    this.emitLamp();
  }

  /** Replace procedural bodies with custom models. On any failure the procedural body simply stays. */
  private async loadBuildingModels() {
    const manifest = await this.manifest;
    if (!manifest) return;
    const lamp = manifest.props?.['street-lamp'];
    if (lamp) {
      loadShared('street-lamp', lamp)
        .then((src) => this.lamps.attachModel(src, lamp.height ?? 3.3))
        .catch(() => {}); // the procedural lanterns stay
    }
    for (const [id, b] of this.buildings) {
      const entry = manifest.buildings[id];
      if (!entry) continue;
      instantiate(id, entry)
        .then((model) => {
          attachBuildingModel(b, model);
          b.group.userData.modelMats = modelMaterials(model).map((m) => ({ mat: m, base: m.color.clone() }));
          this.applyBuildingVisuals();
          this.shadowDirty = true;
        })
        .catch(() => {});
    }
  }

  private async loadCharacterModel(fig: THREE.Group, r: ResidentLike) {
    const manifest = await this.manifest;
    const entry = manifest?.characters[r.appearance.lineage];
    if (!entry) return; // no custom model for this resident yet (e.g. Scribe): keep the placeholder
    try {
      const model = await instantiate(`character:${r.id}`, entry);
      attachCharacterModel(fig, model);
      applyCharacterStatus(fig, this.lastStatus.get(r.id) ?? r.status);
      this.shadowDirty = true;
    } catch {
      /* placeholder stays */
    }
  }

  setNight(night: boolean) {
    this.night = night;
    // Green, grassy horizon: deep evening green at night, soft meadow haze by day.
    const horizon = night ? 0x2c3d2a : 0x9fbf8a;
    this.scene.background = new THREE.Color(horizon);
    (this.scene.fog as THREE.Fog).color.set(horizon);
    this.hemi.intensity = night ? 1.1 : 1.6;
    this.hemi.color.set(night ? 0xd9d0ff : 0xfff3e0);
    this.ambient.intensity = night ? 0.45 : 0.7;
    this.sun.intensity = night ? 1.5 : 2.6;
    this.sun.color.set(night ? 0xffd9b0 : 0xfff2dc);
    this.hub?.setNight(night);
    this.applyBuildingVisuals();
  }

  isNight() {
    return this.night;
  }

  /** Apply real state. Called whenever residents or events change. */
  update(residents: ResidentLike[], visuals: { residents: ResidentVisual[]; buildings: BuildingVisual[] }) {
    this.buildingVisuals = new Map(visuals.buildings.map((b) => [b.id, b]));
    this.applyBuildingVisuals();
    for (const [id, b] of this.buildings) {
      // The sign speaks for the residents who live here in the village (figure shown), or all if none are shown.
      const here = residents.filter((r) => r.building === id);
      const rs = here.some((r) => r.appearance.figure !== false) ? here.filter((r) => r.appearance.figure !== false) : here;
      const connected = rs.filter((r) => r.status === 'connected').length;
      const label = !rs.length ? 'No resident registered' : rs.every((r) => r.status === 'untested') ? 'Not checked yet' : connected ? `${connected}/${rs.length} connected` : rs.length > 1 ? `${rs.length} residents · disconnected` : 'Disconnected';
      const color = !rs.length ? '#7d7466' : connected ? '#6fd08c' : rs.every((r) => r.status === 'untested') ? '#8aa0c8' : '#c97a6a';
      const key = `${label}|${color}`;
      if (b.sign.userData.key !== key) {
        b.sign.userData.key = key;
        drawSign(b.signCanvas, b.def, { label, color });
        (b.sign.material as THREE.SpriteMaterial).map!.needsUpdate = true;
      }
    }
    const poseOf = new Map(visuals.residents.map((v) => [v.id, v]));
    // Residents with appearance.figure === false stay registered but have no figure in the village.
    const shown = residents.filter((r) => r.appearance.figure !== false);
    for (const r of shown) {
      let f = this.figures.get(r.id);
      const b = this.buildings.get(r.building);
      if (!b) continue;
      if (!f) {
        const fig = buildCharacter(r.id, r.appearance.lineage);
        fig.userData.residentId = r.id;
        const siblings = shown.filter((x) => x.building === r.building);
        const idx = siblings.findIndex((x) => x.id === r.id);
        const spread = (idx - (siblings.length - 1) / 2) * 1.5;
        const local = new THREE.Vector3(spread * 1.2, 0.95, b.def.d / 2 + 0.35);
        const home = b.group.localToWorld(local.clone());
        fig.position.copy(home);
        fig.rotation.y = b.def.rotY;
        this.scene.add(fig);
        const proxy = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.6, 1.3), this.proxyMat);
        proxy.position.y = 1.3;
        proxy.scale.setScalar(1 / fig.scale.x);
        proxy.userData.residentId = r.id;
        fig.add(proxy);
        this.pickProxies.push(proxy);
        f = { group: fig, resident: r, home, target: home.clone(), pose: 'home', phase: Math.random() * 6 };
        this.figures.set(r.id, f);
        this.loadCharacterModel(fig, r);
        this.shadowDirty = true;
      }
      f.resident = r;
      const v = poseOf.get(r.id);
      f.pose = v?.pose ?? 'home';
      if (f.pose === 'waiting') {
        // walk to the plaza "porch" where approvals are handed to you
        const ang = Math.atan2(b.def.z, b.def.x);
        f.target.set(Math.cos(ang) * 4.6, 0.75, Math.sin(ang) * 4.6);
      } else if (f.pose === 'working') {
        f.target.copy(b.group.localToWorld(b.doorLocal.clone()));
      } else f.target.copy(f.home);
      applyCharacterStatus(f.group, r.status);
      this.lastStatus.set(r.id, r.status);
      (f.group.userData.marker as THREE.Sprite).visible = f.pose === 'waiting';
    }
  }

  private applyBuildingVisuals() {
    for (const [id, b] of this.buildings) {
      const v = this.buildingVisuals.get(id);
      const lit = v?.lit === 'lit';
      b.windowMat.emissiveIntensity = lit ? (this.night ? 1.5 : 0.6) : v?.lit === 'unknown' ? 0.06 : 0;
      b.windowMat.color.set(lit ? 0x5a4a30 : 0x2a2f45);
      b.light.intensity = lit && this.night ? 14 : 0;
      for (const m of b.accentMats) m.emissiveIntensity = lit ? 1.4 : 0.05;
      // Custom models have no separate window meshes, so the whole model reads a little dimmer while inactive.
      const dim = lit ? 1 : v?.lit === 'unknown' ? 0.85 : 0.72;
      for (const { mat, base } of (b.group.userData.modelMats ?? []) as { mat: THREE.MeshStandardMaterial; base: THREE.Color }[]) mat.color.copy(base).multiplyScalar(dim);
    }
  }

  private pick(e: PointerEvent | MouseEvent, click: boolean, focus = false) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickProxies, false);
    // Residents stand in front of their buildings: prefer a resident if one was hit.
    const residentHit = hits.find((h) => h.object.userData.residentId);
    // Plinth lamps stand inside their building's pick box, so a lamp wins if it is hit close behind the box face.
    const lampHit = hits.find((h) => h.object.userData.lampId);
    if (!residentHit && lampHit && lampHit.distance - hits[0].distance < 3.5) {
      this.canvas.style.cursor = 'pointer';
      this.hovered = `lamp:${lampHit.object.userData.lampId}`;
      if (click) this.selectLamp(lampHit.object.userData.lampId);
      return;
    }
    if (click) this.selectLamp(null);
    const hit = residentHit ?? hits.find((h) => !h.object.userData.lampId);
    let resident: string | undefined;
    let building: string | undefined;
    for (let o: THREE.Object3D | null = hit?.object ?? null; o; o = o.parent) {
      if (o.userData.residentId) resident = o.userData.residentId;
      if (o.userData.buildingId) building = o.userData.buildingId;
    }
    const key = resident ?? building ?? null;
    this.canvas.style.cursor = key ? 'pointer' : 'grab';
    if (key !== this.hovered) this.hovered = key;
    if (click && key) this.onSelect({ building: building ?? this.figures.get(resident!)?.resident.building, resident });
    if (focus && key) this.focusBuilding(building ?? this.figures.get(resident!)!.resident.building);
  }

  private camTween: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; start: number } | null = null;

  /** Glide the camera to look at a building's front door from the plaza side. */
  focusBuilding(id: string) {
    const b = this.buildings.get(id);
    if (!b) return;
    const door = b.group.localToWorld(new THREE.Vector3(0, 2.2, b.def.d / 2));
    const out = new THREE.Vector3(Math.sin(b.def.rotY), 0, Math.cos(b.def.rotY));
    const pos = door.clone().add(out.multiplyScalar(17)).add(new THREE.Vector3(0, 10, 0));
    this.camTween = { from: this.camera.position.clone(), to: pos, tFrom: this.controls.target.clone(), tTo: door, start: performance.now() };
  }

  /** Back to the whole-village view. */
  overview() {
    this.camTween = { from: this.camera.position.clone(), to: new THREE.Vector3(0, 84, 98), tFrom: this.controls.target.clone(), tTo: new THREE.Vector3(0, 0, 1), start: performance.now() };
  }

  /** Keyboard: WASD / arrows pan, Q / E turn, + / - zoom, Home or 0 returns to the overview. */
  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
    if (e.key === 'Home' || e.key === '0') this.overview();
    // Selected lamp post: [ and ] turn it 15° (hold Shift for 5°), Escape lets go.
    if (this.lamps.selected()) {
      const step = e.shiftKey ? 5 : 15;
      if (e.key === '[' || e.key === '{') this.rotateSelectedLamp(-step);
      if (e.key === ']' || e.key === '}') this.rotateSelectedLamp(step);
      if (e.key === 'Escape') this.selectLamp(null);
    }
  }

  private keyboardMove(dt: number) {
    const t = document.activeElement as HTMLElement | null;
    if (!this.keys.size || (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName))) return;
    const k = this.keys;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const forward = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).setY(0).normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3();
    if (k.has('w') || k.has('arrowup')) move.add(forward);
    if (k.has('s') || k.has('arrowdown')) move.sub(forward);
    if (k.has('d') || k.has('arrowright')) move.add(right);
    if (k.has('a') || k.has('arrowleft')) move.sub(right);
    if (move.lengthSq()) {
      move.normalize().multiplyScalar(dist * 0.9 * dt);
      this.camera.position.add(move);
      this.controls.target.add(move);
      this.camTween = null;
    }
    const turn = (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0);
    if (turn) {
      const off = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), turn * dt * 1.4);
      this.camera.position.copy(this.controls.target).add(off);
      this.camTween = null;
    }
    const zoom = (k.has('-') || k.has('_') ? 1 : 0) - (k.has('=') || k.has('+') ? 1 : 0);
    if (zoom) {
      const off = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      const len = THREE.MathUtils.clamp(off.length() * (1 + zoom * dt * 1.5), this.controls.minDistance, this.controls.maxDistance);
      this.camera.position.copy(this.controls.target).add(off.setLength(len));
      this.camTween = null;
    }
    // keep the view over the village
    const tgt = this.controls.target;
    const lim = 60;
    const clamped = new THREE.Vector3(THREE.MathUtils.clamp(tgt.x, -lim, lim), tgt.y, THREE.MathUtils.clamp(tgt.z, -lim, lim));
    this.camera.position.add(clamped.clone().sub(tgt));
    tgt.copy(clamped);
  }

  /** Lower the render resolution on slower GPUs (and restore it when there is headroom). */
  private adaptResolution(dt: number) {
    this.fpsWindow.push(dt);
    if (this.fpsWindow.length < 90) return;
    const avg = this.fpsWindow.reduce((a, b) => a + b, 0) / this.fpsWindow.length;
    this.fpsWindow = [];
    const fps = 1 / Math.max(avg, 1e-3);
    const max = Math.min(window.devicePixelRatio, 1.5);
    const next = fps < 40 ? Math.max(0.75, this.dpr - 0.25) : fps > 57 ? Math.min(max, this.dpr + 0.25) : this.dpr;
    if (next !== this.dpr) {
      this.dpr = next;
      this.renderer.setPixelRatio(next);
      this.resize();
    }
  }

  private resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    const t = this.clock.elapsedTime;
    this.adaptResolution(rawDt);
    this.keyboardMove(dt);
    if (this.pendingHover) {
      this.pick(this.pendingHover, false);
      this.pendingHover = null;
    }
    if (this.camTween) {
      const c = this.camTween;
      const t = Math.min(1, (performance.now() - c.start) / 900);
      const k = t * t * (3 - 2 * t);
      this.camera.position.lerpVectors(c.from, c.to, k);
      this.controls.target.lerpVectors(c.tFrom, c.tTo, k);
      if (t >= 1) this.camTween = null;
    }
    this.controls.update();
    // ---- ambient (not tied to agent activity) ----
    this.hub.update(t);
    const hall = this.buildings.get('town-hall');
    if (hall?.group.userData.flag) hall.group.userData.flag.rotation.y = Math.sin(t * 1.7) * 0.18;
    const now = new Date();
    const hands = hall?.group.userData.clockHands;
    if (hands) {
      hands[0].rotation.z = -((now.getMinutes() / 60) * Math.PI * 2);
      hands[1].rotation.z = -(((now.getHours() % 12) / 12) * Math.PI * 2) + Math.PI / 2;
    }
    // ---- activity-driven (from real state only) ----
    for (const [id, b] of this.buildings) {
      const busy = this.buildingVisuals.get(id)?.busy ?? false;
      for (const s of b.smoke) {
        if (!busy) {
          (s.material as THREE.SpriteMaterial).opacity = 0;
          continue;
        }
        const p = (t * 0.35 + s.userData.phase) % 1;
        s.position.y = (b.chimney?.y ?? 0) + 0.95 + p * 2.2;
        s.scale.setScalar(0.5 + p * 1.1);
        (s.material as THREE.SpriteMaterial).opacity = 0.5 * (1 - p);
      }
      const gear = b.group.userData.gear as THREE.Object3D | undefined;
      if (gear && busy) gear.rotation.z += dt * 1.2;
    }
    for (const f of this.figures.values()) {
      const pos = f.group.position;
      const d = f.target.clone().sub(pos);
      d.y = 0;
      const dist = d.length();
      if (dist > 0.05) {
        const step = Math.min(dist, dt * 3.2);
        pos.add(d.normalize().multiplyScalar(step));
        f.group.rotation.y = Math.atan2(d.x, d.z);
        pos.y = f.target.y + Math.abs(Math.sin(t * 9)) * 0.08; // walking bob
        this.shadowDirty = true;
      } else if (f.resident.status === 'connected') {
        // idle sway is ambient; it only signals that the resident is connected (a real status)
        f.group.rotation.z = Math.sin(t * 1.4 + f.phase) * 0.03;
        if (f.pose === 'working') pos.y = f.target.y + Math.abs(Math.sin(t * 5 + f.phase)) * 0.06;
      }
      const marker = f.group.userData.marker as THREE.Sprite;
      if (marker.visible) marker.scale.setScalar(0.8 + Math.sin(t * 4) * 0.12);
    }
    if (this.shadowDirty) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    this.renderer.render(this.scene, this.camera);
    if (this.stats) {
      this.statFrames++;
      const now = performance.now();
      if (now - this.statSince > 1000) {
        const info = this.renderer.info;
        this.stats.textContent = `${((this.statFrames * 1000) / (now - this.statSince)).toFixed(0)} fps · ${info.render.calls} draws · ${(info.render.triangles / 1000).toFixed(0)}k tris · ${info.memory.textures} textures`;
        this.statFrames = 0;
        this.statSince = now;
      }
    }
  }
}
