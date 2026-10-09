// What resident life looks like: task indicators above buildings, the Zzz of resting residents and the brief
// completed/failed badge. All of it is shown only from real state (see life.ts); nothing here invents activity.
import * as THREE from '../../vendor/three.module.js';
import { glowSprite } from './kit.ts';
import type { Indicator, IndicatorColor } from './life.ts';

export const INDICATOR_COLORS: Record<IndicatorColor, number> = { blue: 0x4f9dff, amber: 0xffb53d, red: 0xff5a4f, gold: 0xf2c94c };
const LABEL: Record<IndicatorColor, string> = { blue: 'Working', amber: 'Waiting for your approval', red: 'Failed', gold: 'Completed' };

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * One building's task indicator: a floating gem in the state colour with a ring. The ring spins while the work is
 * indeterminate; when the provider reports real progress it becomes an arc of exactly that fraction.
 */
export class IndicatorMark {
  readonly group = new THREE.Group();
  private gem: THREE.Mesh;
  private ring: THREE.Mesh;
  private arc: THREE.Mesh;
  private glow: THREE.Sprite;
  private mat: THREE.MeshBasicMaterial;
  private arcFraction = -1;
  private base: THREE.Vector3;
  current: Indicator | null = null;

  constructor(anchor: THREE.Vector3) {
    this.base = anchor.clone();
    this.group.position.copy(anchor);
    this.group.scale.setScalar(1.4);
    this.group.name = 'indicator';
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.55), this.mat);
    this.gem.scale.set(1, 1.5, 1);
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.08, 6, 40, Math.PI * 1.4), this.mat);
    this.ring.rotation.x = Math.PI / 2;
    this.arc = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.3, 48, 1, 0, Math.PI * 2), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    this.arc.rotation.x = -Math.PI / 2;
    this.glow = glowSprite(3.2, 0xffffff);
    this.group.add(this.gem, this.ring, this.arc, this.glow);
    this.group.visible = false;
  }

  set(ind: Indicator | null) {
    this.current = ind;
    this.group.visible = !!ind;
    if (!ind) return;
    const color = INDICATOR_COLORS[ind.color];
    this.mat.color.setHex(color);
    (this.arc.material as THREE.MeshBasicMaterial).color.setHex(color);
    (this.glow.material as THREE.SpriteMaterial).color.setHex(color);
    const p = ind.progress;
    this.ring.visible = !p;
    this.arc.visible = !!p;
    if (p) {
      const f = Math.max(0, Math.min(1, p.done / p.total));
      if (Math.abs(f - this.arcFraction) > 1e-3) {
        this.arcFraction = f;
        this.arc.geometry.dispose();
        this.arc.geometry = new THREE.RingGeometry(1.0, 1.3, 48, 1, Math.PI / 2, -Math.PI * 2 * Math.max(f, 0.001));
      }
    }
    this.group.userData.label = LABEL[ind.color];
  }

  /** Gentle motion while shown; the ring turns only for indeterminate active work or a pending approval. */
  update(t: number) {
    if (!this.group.visible) return;
    this.group.position.y = this.base.y + Math.sin(t * 1.6) * 0.18;
    this.gem.rotation.y = t * 0.8;
    const c = this.current?.color;
    if (this.ring.visible && (c === 'blue' || c === 'amber')) this.ring.rotation.z = -t * (c === 'amber' ? 1.2 : 2.4);
  }
}

let zTexture: THREE.CanvasTexture | null = null;
let doneTexture: THREE.CanvasTexture | null = null;
let failTexture: THREE.CanvasTexture | null = null;

function zTex() {
  return (zTexture ??= canvasTexture(64, 64, (ctx) => {
    ctx.font = 'bold 50px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(30,30,60,0.8)';
    ctx.strokeText('Z', 32, 34);
    ctx.fillStyle = '#e8ecff';
    ctx.fillText('Z', 32, 34);
  }));
}

function badgeTex(ok: boolean) {
  const draw = (ctx: CanvasRenderingContext2D) => {
    ctx.beginPath();
    ctx.arc(64, 64, 56, 0, Math.PI * 2);
    ctx.fillStyle = ok ? '#f2c94c' : '#ff5a4f';
    ctx.fill();
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(40,25,10,0.8)';
    ctx.stroke();
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#2a1c10';
    ctx.beginPath();
    if (ok) {
      ctx.moveTo(38, 66);
      ctx.lineTo(56, 84);
      ctx.lineTo(90, 46);
    } else {
      ctx.moveTo(44, 44);
      ctx.lineTo(84, 84);
      ctx.moveTo(84, 44);
      ctx.lineTo(44, 84);
    }
    ctx.stroke();
  };
  if (ok) return (doneTexture ??= canvasTexture(128, 128, draw));
  return (failTexture ??= canvasTexture(128, 128, draw));
}

/** Floating Zzz and the completed/failed badge above one resident. Hidden (and free) unless needed. */
export class ResidentMarks {
  readonly group = new THREE.Group();
  private zs: THREE.Sprite[] = [];
  private badge: THREE.Sprite;
  private height = 2.4;

  constructor() {
    this.group.name = 'resident-marks';
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: zTex(), transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      s.userData.phase = i / 3;
      this.zs.push(s);
      this.group.add(s);
    }
    this.badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTex(true), transparent: true, depthWrite: false }));
    this.badge.scale.setScalar(0.9);
    this.badge.visible = false;
    this.group.add(this.badge);
  }

  setHeight(h: number) {
    this.height = h;
  }

  update(t: number, o: { zzz: boolean; outcome: 'completed' | 'failed' | null }) {
    for (const s of this.zs) {
      s.visible = o.zzz;
      if (!o.zzz) continue;
      const p = (t * 0.28 + s.userData.phase) % 1;
      s.position.set(0.35 + p * 0.5, this.height + p * 1.3, 0);
      s.scale.setScalar(0.28 + p * 0.3);
      (s.material as THREE.SpriteMaterial).opacity = Math.sin(p * Math.PI) * 0.85;
    }
    this.badge.visible = !!o.outcome;
    if (o.outcome) {
      const m = this.badge.material as THREE.SpriteMaterial;
      const tex = badgeTex(o.outcome === 'completed');
      if (m.map !== tex) {
        m.map = tex;
        m.needsUpdate = true;
      }
      this.badge.position.set(0, this.height + 0.6 + Math.sin(t * 3) * 0.08, 0);
    }
  }
}
