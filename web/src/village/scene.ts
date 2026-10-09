// The 3D village. Work-related visuals (lit windows, smoke, forge glow, resident poses, approval markers)
// come only from deriveVisuals(), which reads real backend state. Everything else here is ambient.
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { RoomEnvironment } from '../../vendor/RoomEnvironment.js';
import * as THREE from '../../vendor/three.module.js';
import { attachBuildingModel, buildBuilding, defFromSpec, drawSign, plinthLampSpots, PROCEDURAL_BODIES, type BuildingHandle } from './buildings.ts';
import { applyCharacterStatus, attachCharacterModel, buildCharacter } from './characters.ts';
import { activeLights, gpuName, sceneBreakdown } from './diagnostics.ts';
import { AutoQuality, nextPixelRatio, PRESETS, type GraphicsChoice, type Preset } from './graphics.ts';
import { buildHub, fenceAlong, PLAZA_R, type Hub } from './hub.ts';
import { plaza } from './kit.ts';
import { LampSet, lanternToward, type LampSpot } from './lamps.ts';
import { instantiate, loadManifest, loadShared, modelMaterials, setLodScale, type ModelManifest } from './models.ts';
import { grassGround, landscape, type Keepout } from './nature.ts';
import { buildRoads } from './roads.ts';
import type { BuildingVisual, ResidentLike, ResidentVisual } from './state.ts';
import { buildTerrain, plateauFalls } from './terrain.ts';
import { allNodes, allRoads, entrance, heightAt, indicatorAnchor, roadPoints, type World } from './worldModel.ts';

/** The whole-village view, and how far the camera may roam from the fountain. */
const OVERVIEW = { pos: new THREE.Vector3(0, 185, 168), target: new THREE.Vector3(0, 0, -10) };
const BOUNDS = { minX: -100, maxX: 100, minZ: -118, maxZ: 100 };


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
  private diagEl: HTMLElement | null = null;
  private graphicsChoice: GraphicsChoice = 'auto';
  private preset: Preset = PRESETS.high;
  private auto = new AutoQuality();
  private lodFactor = 1;
  private frameTimes: number[] = [];
  private lastFrameAt = 0;
  private diagSince = performance.now();
  /** Called when the active preset changes (e.g. Auto stepping down). */
  onGraphics: (info: { choice: GraphicsChoice; preset: Preset }) => void = () => {};
  private pendingHover: PointerEvent | null = null;
  private downAt: { x: number; y: number } | null = null;
  private keys = new Set<string>();
  private pickProxies: THREE.Mesh[] = [];
  private proxyMat = new THREE.MeshBasicMaterial({ visible: false });
  private fpsWindow: number[] = [];
  private dpr = Math.min(window.devicePixelRatio, 1.5);

  private canvas: HTMLCanvasElement;
  private world: World;
  private shadowFrame = { x: NaN, z: NaN, half: NaN };

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas;
    this.world = world;
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
    this.scene.fog = new THREE.Fog(0x2c3d2a, 230, 460);
    // Soft image-based light so the models' metal and PBR materials (e.g. Codex's brass) read correctly.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 700);
    this.camera.position.copy(OVERVIEW.pos);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(OVERVIEW.target);
    // Snappier feel: less drift after letting go, faster zoom, panning across the ground plane.
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.rotateSpeed = 0.9;
    this.controls.zoomSpeed = 1.4;
    this.controls.panSpeed = 1.1;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 14;
    this.controls.maxDistance = 260;
    this.controls.maxPolarAngle = Math.PI * 0.43;
    this.hemi = new THREE.HemisphereLight(0xffe7c8, 0x3a2f28, 1.0);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xfff1dd, 0.35);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff0d6, 1.6);
    this.sun.position.set(-22, 40, 18);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.fitShadows();
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
    if (new URLSearchParams(location.search).has('diag')) {
      (window as any).__villageDiagnostics = () => this.diagnostics();
      // For screenshots and measurements: put the camera somewhere exact.
      (window as any).__villageCamera = (pos: number[], target: number[]) => {
        this.camTween = null;
        this.camera.position.set(pos[0], pos[1], pos[2]);
        this.controls.target.set(target[0], target[1], target[2]);
      };
    }
    if (new URLSearchParams(location.search).has('stats')) this.setDiagnostics(true);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private buildWorld() {
    // Top-level parts are named so the graphics diagnostics can show what each part costs.
    const named = <T extends THREE.Object3D>(o: T, name: string) => ((o.name = name), o);
    const world = this.world;
    this.scene.add(named(grassGround(240), 'ground'));
    this.scene.add(named(plaza(PLAZA_R), 'plaza'));
    const net = buildRoads(world, PLAZA_R);
    this.scene.add(named(net.group, 'roads'));
    const terrain = buildTerrain(world, net.keepout);
    this.scene.add(named(terrain.group, 'terrain'));
    const keepout: Keepout = {
      circles: [{ x: 0, z: 0, r: PLAZA_R + 2.8 }, ...terrain.keepout.circles],
      segments: [...net.keepout, ...terrain.keepout.segments],
      heightAt: (x, z) => heightAt(world, x, z),
    };
    const spots: LampSpot[] = [...terrain.lampSpots];
    const roadAngles: number[] = [];
    const fences: { a: THREE.Vector2; b: THREE.Vector2; offset: number }[] = [];
    // Founders' Square: lamp posts where each road leaves the plaza, and low fences along the roads.
    for (const fr of net.foundersRoads) {
      const def = world.buildings.find((x) => x.id === fr.building);
      if (!def) continue;
      const dir = fr.start.clone().normalize();
      roadAngles.push(Math.atan2(dir.y, dir.x));
      const right = new THREE.Vector2(-dir.y, dir.x);
      const at = dir.clone().multiplyScalar(PLAZA_R + 2.5);
      for (const s of [1, -1]) {
        const off = right.clone().multiplyScalar(2.35 * s);
        const p = at.clone().add(off);
        spots.push({ id: `road:${def.id}:${s > 0 ? 'right' : 'left'}`, label: `Road to ${def.place}, ${s > 0 ? 'right' : 'left'}`, x: p.x, y: 0, z: p.y, rotY: lanternToward(-off.x, -off.y) });
      }
      fences.push({ a: dir.clone().multiplyScalar(PLAZA_R + 3.9), b: fr.end.clone().sub(dir.clone().multiplyScalar(0.8)), offset: 2.1 });
    }
    for (const spec of world.buildings) {
      const def = defFromSpec(world, spec);
      keepout.circles.push({ x: def.x, z: def.z, r: Math.hypot(def.w, def.d) / 2 + 1.6 });
      const b = buildBuilding(def);
      b.group.name = `building:${def.id}`;
      this.buildings.set(def.id, b);
      this.scene.add(b.group);
      b.group.updateMatrixWorld(true);
      // lamp posts on the plinth, either side of the front steps (new slots get theirs with their real model)
      if (PROCEDURAL_BODIES.has(def.id)) {
        const steps = b.group.localToWorld(new THREE.Vector3(0, 0, def.d / 2 + 1.2));
        for (const spot of plinthLampSpots(def)) {
          const w = b.group.localToWorld(spot.local.clone());
          spots.push({ id: `plinth:${def.id}:${spot.side}`, label: `${def.place}, ${spot.side} lamp`, x: w.x, y: w.y, z: w.z, rotY: lanternToward(steps.x - w.x, steps.z - w.z) });
        }
      }
      // Cheap invisible box for picking (testing the detailed models' triangles on every mouse move is very slow).
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(def.w + 1.2, 9, def.d + 1.2), this.proxyMat);
      proxy.position.y = 4.5;
      proxy.userData.buildingId = def.id;
      b.group.add(proxy);
      this.pickProxies.push(proxy);
    }
    this.scene.add(named(fenceAlong(fences), 'fences'));
    this.hub = buildHub(world, roadAngles, plateauFalls(world));
    this.hub.group.name = 'hub';
    this.scene.add(this.hub.group);
    spots.push(...this.hub.lampSpots);
    keepout.segments.push(...this.hub.segments);
    keepout.custom = this.hub.blocked;
    for (const sp of spots) keepout.circles.push({ x: sp.x, z: sp.z, r: 1.1 });
    this.lamps = new LampSet(spots);
    this.lamps.onDirty = () => (this.shadowDirty = true);
    this.lamps.group.name = 'lamps';
    this.scene.add(this.lamps.group);
    this.pickProxies.push(...this.lamps.proxies);
    const woods = world.districts.find((d) => d.id === 'woods');
    this.scene.add(named(landscape(keepout, woods && { x: woods.center[0], z: woods.center[1], r: woods.radius }), 'landscape'));
    this.loadBuildingModels();
  }

  /**
   * The sun's shadow covers the area around where the camera looks, wider when zoomed out, so the larger
   * village keeps sharp shadows up close without a bigger shadow map. Re-rendered only when it moves.
   */
  private fitShadows() {
    const t = this.controls.target;
    const dist = this.camera.position.distanceTo(t);
    const half = Math.min(110, Math.max(40, Math.ceil((dist * 0.55) / 10) * 10));
    const step = half / 4;
    const x = Math.round(t.x / step) * step;
    const z = Math.round(t.z / step) * step;
    const f = this.shadowFrame;
    if (f.x === x && f.z === z && f.half === half) return;
    this.shadowFrame = { x, z, half };
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x - 44, 80, z + 36);
    const sc = this.sun.shadow.camera;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.updateProjectionMatrix();
    this.sun.target.updateMatrixWorld();
    this.shadowDirty = true;
  }

  private slotMarkers = true;
  private guides: THREE.Group | null = null;

  /** Show or hide the development markers on building slots whose models have not arrived yet. */
  setSlotMarkers(on: boolean) {
    this.slotMarkers = on;
    for (const b of this.buildings.values()) if (b.marker) b.marker.visible = on && !b.model;
  }

  /**
   * Layout guides for development (off by default): every entrance, the space reserved above each building for
   * task indicators, and the walkable paths residents will use in V3, all straight from the layout data.
   */
  setLayoutGuides(on: boolean) {
    if (on && !this.guides) this.guides = this.buildGuides();
    if (this.guides) this.guides.visible = on;
  }

  private buildGuides(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'guides';
    const w = this.world;
    const nodes = allNodes(w);
    const pts: number[] = [];
    for (const road of allRoads(w)) {
      const p = roadPoints(w, road, nodes);
      for (let i = 1; i < p.length; i++) pts.push(p[i - 1][0], p[i - 1][1] + 0.7, p[i - 1][2], p[i][0], p[i][1] + 0.7, p[i][2]);
    }
    const paths = new THREE.BufferGeometry();
    paths.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const walk = new THREE.LineSegments(paths, new THREE.LineBasicMaterial({ color: 0x5fe0ff, transparent: true, opacity: 0.9, depthTest: false }));
    walk.renderOrder = 20;
    g.add(walk);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x5fe0ff, transparent: true, opacity: 0.9, depthTest: false });
    const anchorMat = new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.9, depthTest: false });
    const stems: number[] = [];
    for (const b of w.buildings) {
      const e = entrance(w, b);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.09, 6, 24).rotateX(Math.PI / 2), ringMat);
      ring.position.set(e[0], e[1] + 0.7, e[2]);
      ring.renderOrder = 21;
      g.add(ring);
      const a = indicatorAnchor(w, b);
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.5), anchorMat);
      gem.position.set(a[0], a[1], a[2]);
      gem.renderOrder = 21;
      g.add(gem);
      stems.push(a[0], a[1] - 0.5, a[2], a[0], a[1] - 3, a[2]);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(stems, 3));
    g.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.7, depthTest: false })));
    this.scene.add(g);
    return g;
  }

  /** Choose a graphics preset, or 'auto' (starts at High and steps down only if frames stay slow). */
  setGraphics(choice: GraphicsChoice) {
    this.graphicsChoice = choice;
    if (choice === 'auto') this.auto.current = 'high';
    this.applyPreset(PRESETS[choice === 'auto' ? this.auto.current : choice]);
  }

  graphics() {
    return { choice: this.graphicsChoice, preset: this.preset };
  }

  /**
   * Presets only change rendering cost: resolution, shadows, how soon distant models use their lighter copy,
   * and how much tiny ground detail (grass tufts, flowers) is drawn. Every building, resident and feature stays.
   */
  private applyPreset(p: Preset) {
    const prev = this.preset;
    this.preset = p;
    const max = Math.min(window.devicePixelRatio, p.maxPixelRatio);
    const next = Math.min(max, Math.max(Math.min(p.minPixelRatio, max), p.id === prev.id ? this.dpr : max));
    if (next !== this.dpr) {
      this.dpr = next;
      this.renderer.setPixelRatio(next);
      this.resize();
    }
    this.sun.castShadow = p.shadows;
    if (this.sun.shadow.mapSize.x !== p.shadowMapSize) {
      this.sun.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
      this.sun.shadow.map?.dispose();
      (this.sun.shadow as any).map = null;
    }
    const type = p.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (this.renderer.shadowMap.type !== type) {
      this.renderer.shadowMap.type = type;
      this.scene.traverse((o: any) => {
        for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) m.needsUpdate = true;
      });
    }
    this.scene.traverse((o: any) => {
      if (!o.userData.groundDetail) return;
      o.userData.fullCount ??= o.count;
      o.count = Math.floor(o.userData.fullCount * p.groundDetail);
      o.visible = o.count > 0;
    });
    this.lodFactor = p.id === 'high' ? 1 : p.id === 'medium' ? 0.6 : 0;
    setLodScale(this.scene, this.lodFactor);
    this.shadowDirty = true;
    this.onGraphics({ choice: this.graphicsChoice, preset: p });
  }

  /** Show or hide the frame-rate and graphics diagnostics display. */
  setDiagnostics(on: boolean) {
    if (on && !this.diagEl) {
      this.diagEl = document.createElement('pre');
      this.diagEl.className = 'diag';
      this.diagEl.setAttribute('aria-label', 'Graphics diagnostics');
      document.body.append(this.diagEl);
      this.frameTimes = [];
      this.diagSince = performance.now();
    } else if (!on && this.diagEl) {
      this.diagEl.remove();
      this.diagEl = null;
    }
  }

  private updateDiagnostics(now: number) {
    if (!this.diagEl || now - this.diagSince < 1000) return;
    const times = this.frameTimes;
    this.frameTimes = [];
    const secs = (now - this.diagSince) / 1000;
    this.diagSince = now;
    if (!times.length) return;
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const worst = Math.max(...times);
    const d = this.diagnostics();
    const parts = d.parts.slice(0, 6).map((x) => `  ${x.part.padEnd(10)} ${String(x.draws).padStart(4)} draws ${String(Math.round(x.triangles / 1000)).padStart(5)}k tris`).join('\n');
    this.diagEl.textContent = [
      `${(times.length / secs).toFixed(0)} fps   frame ${avg.toFixed(1)} ms (worst ${worst.toFixed(0)} ms)`,
      `graphics ${this.graphicsChoice === 'auto' ? `Auto → ${this.preset.label}` : this.preset.label}${this.preset.maxFps ? ` (cap ${this.preset.maxFps} fps)` : ''}   resolution ×${d.pixelRatio} (${d.canvas.width}×${d.canvas.height})`,
      `${d.lastFrame.draws} draw calls   ${(d.lastFrame.triangles / 1000).toFixed(0)}k triangles`,
      `shadows ${d.shadows}`,
      `lights: ${d.lights.directional} sun, ${d.lights.point} point   textures ${d.memory.textures}   geometries ${d.memory.geometries}   shaders ${d.memory.programs}`,
      `GPU ${d.gpu}`,
      'by part (visible):',
      parts,
    ].join('\n');
  }

  /** What the village costs to draw right now (for the diagnostics display and the performance audit). */
  diagnostics() {
    const info = this.renderer.info;
    return {
      gpu: gpuName(this.renderer),
      pixelRatio: this.dpr,
      canvas: { width: this.renderer.domElement.width, height: this.renderer.domElement.height },
      lastFrame: { draws: info.render.calls, triangles: info.render.triangles },
      memory: { geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0 },
      lights: activeLights(this.scene),
      shadows: this.sun.castShadow ? `${this.sun.shadow.mapSize.x}px, updated only when something moves` : 'off',
      parts: sceneBreakdown(this.scene),
    };
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
          attachBuildingModel(b, model); // also retires the slot's development marker
          setLodScale(model, this.lodFactor);
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
      setLodScale(model, this.lodFactor);
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
      // The sign speaks only from real registry state. Shared workplaces name who works there (no connection
      // claims); building slots for planned residents or future services say so plainly.
      const def = b.def;
      let label: string;
      let color: string;
      const here = residents.filter((r) => r.building === id);
      if (def.kind === 'workplace') {
        const ws = residents.filter((r) => r.workplaces?.includes(id));
        label = ws.length ? `${ws.map((r) => r.displayName).join(' · ')} work here` : 'No one works here yet';
        color = '#c9a45a';
      } else if (!here.length) {
        label = def.kind === 'service' ? 'Not connected · model coming' : 'No resident registered';
        color = '#7d7466';
      } else if (here.every((r) => r.planned)) {
        label = 'Planned resident · not connected';
        color = '#7d7466';
      } else {
        // The residents who live here in the village (figure shown), or all if none are shown.
        const rs = here.some((r) => r.appearance.figure !== false) ? here.filter((r) => r.appearance.figure !== false) : here;
        const connected = rs.filter((r) => r.status === 'connected').length;
        label = rs.every((r) => r.status === 'untested') ? 'Not checked yet' : connected ? `${connected}/${rs.length} connected` : rs.length > 1 ? `${rs.length} residents · disconnected` : 'Disconnected';
        color = connected ? '#6fd08c' : rs.every((r) => r.status === 'untested') ? '#8aa0c8' : '#c97a6a';
      }
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
        fig.name = `resident:${r.id}`;
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
      b.light.visible = b.light.intensity > 0; // invisible lights cost no shader time
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
    this.camTween = { from: this.camera.position.clone(), to: OVERVIEW.pos.clone(), tFrom: this.controls.target.clone(), tTo: OVERVIEW.target.clone(), start: performance.now() };
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
  }

  /** Keep the view over the village (mouse panning and keyboard alike). */
  private clampTarget() {
    const tgt = this.controls.target;
    const clamped = new THREE.Vector3(THREE.MathUtils.clamp(tgt.x, BOUNDS.minX, BOUNDS.maxX), tgt.y, THREE.MathUtils.clamp(tgt.z, BOUNDS.minZ, BOUNDS.maxZ));
    if (clamped.equals(tgt)) return;
    this.camera.position.add(clamped.clone().sub(tgt));
    tgt.copy(clamped);
  }

  /** Lower the render resolution on slower GPUs (and restore it when there is headroom); Auto may change preset. */
  private adaptResolution(dt: number) {
    this.fpsWindow.push(dt);
    if (this.fpsWindow.length < 90) return;
    const total = this.fpsWindow.reduce((a, b) => a + b, 0);
    const avg = total / this.fpsWindow.length;
    this.fpsWindow = [];
    const fps = 1 / Math.max(avg, 1e-3);
    if (document.hidden) return;
    const next = nextPixelRatio(fps, this.dpr, this.preset, window.devicePixelRatio);
    if (next !== this.dpr) {
      this.dpr = next;
      this.renderer.setPixelRatio(next);
      this.resize();
    }
    if (this.graphicsChoice === 'auto') {
      const step = this.auto.observe(fps, this.dpr, total);
      if (step) this.applyPreset(PRESETS[step]);
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
    const now = performance.now();
    // Low preset: cap the frame rate to keep laptops cool (ambient animation just runs at the capped rate).
    if (this.preset.maxFps && now - this.lastFrameAt < 1000 / this.preset.maxFps - 2) return;
    if (this.lastFrameAt) this.frameTimes.push(now - this.lastFrameAt);
    this.lastFrameAt = now;
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
    this.clampTarget();
    this.controls.update();
    if (this.sun.castShadow) this.fitShadows();
    // ---- ambient (not tied to agent activity) ----
    this.hub.update(t);
    const hall = this.buildings.get('town-hall');
    if (hall?.group.userData.flag) hall.group.userData.flag.rotation.y = Math.sin(t * 1.7) * 0.18;
    const clockTime = new Date();
    const hands = hall?.group.userData.clockHands;
    if (hands) {
      hands[0].rotation.z = -((clockTime.getMinutes() / 60) * Math.PI * 2);
      hands[1].rotation.z = -(((clockTime.getHours() % 12) / 12) * Math.PI * 2) + Math.PI / 2;
    }
    // ---- activity-driven (from real state only) ----
    for (const [id, b] of this.buildings) {
      const busy = this.buildingVisuals.get(id)?.busy ?? false;
      for (const s of b.smoke) {
        s.visible = busy; // no draw call while idle
        if (!busy) continue;
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
    this.updateDiagnostics(now);
  }
}
