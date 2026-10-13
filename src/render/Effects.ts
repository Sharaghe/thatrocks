import * as THREE from 'three';
import { WORLD } from '../config';
import { Rng } from '../core/rng';

interface ParticleOptions {
  capacity: number;
  blending: THREE.Blending;
  /** Base point size in world units. */
  size: number;
  gravity: number;
  drag: number;
  /** Soft, puffy sprites (dust) vs. crisp dots (chips, droplets). */
  soft: boolean;
}

/** Pooled GPU particle system (one draw call). */
class ParticlePool {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly growth: Float32Array;
  private readonly floorY: Float32Array;
  private cursor = 0;
  private readonly geo: THREE.BufferGeometry;

  constructor(private readonly opts: ParticleOptions) {
    const n = opts.capacity;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n).fill(1);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.growth = new Float32Array(n);
    this.floorY = new Float32Array(n).fill(-100);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: opts.blending,
      uniforms: { uScale: { value: 400 }, uSoft: { value: opts.soft ? 1 : 0 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uSoft;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(p, p);
          if (r2 > 1.0) discard;
          float a = uSoft > 0.5 ? pow(1.0 - r2, 1.6) : smoothstep(1.0, 0.6, r2);
          gl_FragColor = vec4(vColor, a * vAlpha);
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  setViewportScale(heightPx: number, fovDeg: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  spawn(
    p: THREE.Vector3,
    v: THREE.Vector3,
    color: THREE.Color,
    size: number,
    life: number,
    growth = 0,
    floorY = -100,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.opts.capacity;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.growth[i] = growth;
    this.alpha[i] = 1;
    this.floorY[i] = floorY;
  }

  update(dt: number): void {
    const { gravity, drag } = this.opts;
    const n = this.opts.capacity;
    const k = Math.exp(-drag * dt);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) {
          this.alpha[i] = 0;
          any = true;
        }
        continue;
      }
      any = true;
      this.life[i] -= dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      const i3 = i * 3;
      this.vel[i3 + 1] -= gravity * dt;
      this.vel[i3] *= k;
      this.vel[i3 + 1] *= k;
      this.vel[i3 + 2] *= k;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < this.floorY[i]) {
        this.pos[i3 + 1] = this.floorY[i];
        this.vel[i3 + 1] *= -0.25;
        this.vel[i3] *= 0.5;
        this.vel[i3 + 2] *= 0.5;
      }
      this.size[i] += this.growth[i] * dt;
      this.alpha[i] = Math.max(0, Math.min(1, (1 - t) * 1.4)) * Math.min(1, t * 12 + 0.2);
    }
    if (any) {
      for (const name of ['position', 'aColor', 'aSize', 'aAlpha']) (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Expanding ripple rings on the water surface. */
class RipplePool {
  readonly group = new THREE.Group();
  private readonly rings: { mesh: THREE.Mesh; life: number; max: number; speed: number }[] = [];
  private cursor = 0;

  constructor(count: number) {
    const geo = new THREE.RingGeometry(0.85, 1, 48, 1);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: '#f4f8f4', transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.rings.push({ mesh, life: 0, max: 1, speed: 1 });
    }
  }

  spawn(x: number, z: number, strength: number): void {
    const r = this.rings[this.cursor];
    this.cursor = (this.cursor + 1) % this.rings.length;
    r.mesh.position.set(x, WORLD.waterLevel + 0.004, z);
    r.mesh.scale.setScalar(0.05);
    r.life = r.max = 1.2 + strength * 0.4;
    r.speed = 0.35 + strength * 0.25;
    r.mesh.visible = true;
  }

  update(dt: number): void {
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const t = 1 - r.life / r.max;
      r.mesh.scale.setScalar(0.05 + t * r.speed * 1.6);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.45;
      if (r.life <= 0) r.mesh.visible = false;
    }
  }
}

/** Impact dust, stone chips, splashes and ripples. */
export class Effects {
  readonly group = new THREE.Group();
  private readonly dust: ParticlePool;
  private readonly chips: ParticlePool;
  private readonly drops: ParticlePool;
  private readonly ripples = new RipplePool(10);
  private readonly rng = new Rng(4242);
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpC = new THREE.Color();

  constructor(densityScale = 1) {
    this.dust = new ParticlePool({ capacity: Math.round(260 * densityScale) + 60, blending: THREE.NormalBlending, size: 0.06, gravity: -0.05, drag: 2.2, soft: true });
    this.chips = new ParticlePool({ capacity: 220, blending: THREE.NormalBlending, size: 0.01, gravity: 9.81, drag: 0.4, soft: false });
    this.drops = new ParticlePool({ capacity: 260, blending: THREE.NormalBlending, size: 0.012, gravity: 9.81, drag: 0.6, soft: false });
    this.group.add(this.dust.points, this.chips.points, this.drops.points, this.ripples.group);
  }

  setViewport(heightPx: number, fovDeg: number): void {
    for (const p of [this.dust, this.chips, this.drops]) p.setViewportScale(heightPx, fovDeg);
  }

  /** Stone-on-stone impact: a puff of rock dust and a few chips. */
  impact(position: THREE.Vector3, speed: number, color: THREE.Color): void {
    const r = this.rng;
    const strength = Math.min(1, speed / 2.2);
    const dustCount = Math.round(3 + strength * 14);
    for (let i = 0; i < dustCount; i++) {
      this.tmpP.set(position.x + r.range(-0.06, 0.06), position.y + r.range(-0.02, 0.03), position.z + r.range(-0.06, 0.06));
      const a = r.range(0, Math.PI * 2);
      const s = r.range(0.08, 0.35) * (0.4 + strength);
      this.tmpV.set(Math.cos(a) * s, r.range(0.02, 0.18), Math.sin(a) * s);
      this.tmpC.copy(color).lerp(new THREE.Color('#d8cbb5'), 0.55).multiplyScalar(r.range(0.85, 1.1));
      this.dust.spawn(this.tmpP, this.tmpV, this.tmpC, r.range(0.025, 0.06) * (0.6 + strength), r.range(0.7, 1.6), r.range(0.04, 0.09));
    }
    if (strength > 0.25) {
      const chipCount = Math.round(strength * 10);
      for (let i = 0; i < chipCount; i++) {
        this.tmpP.copy(position);
        const a = r.range(0, Math.PI * 2);
        const s = r.range(0.4, 1.3) * strength;
        this.tmpV.set(Math.cos(a) * s, r.range(0.6, 1.8) * strength, Math.sin(a) * s);
        this.tmpC.copy(color).multiplyScalar(r.range(0.6, 1.2));
        this.chips.spawn(this.tmpP, this.tmpV, this.tmpC, r.range(0.006, 0.014), r.range(0.6, 1.3), 0, position.y - 0.25);
      }
    }
  }

  splash(x: number, z: number, speed: number): void {
    const r = this.rng;
    const strength = Math.min(1.5, speed / 2);
    const count = Math.round(10 + strength * 40);
    for (let i = 0; i < count; i++) {
      this.tmpP.set(x + r.range(-0.08, 0.08), WORLD.waterLevel + 0.01, z + r.range(-0.08, 0.08));
      const a = r.range(0, Math.PI * 2);
      const s = r.range(0.2, 1.1) * (0.5 + strength);
      this.tmpV.set(Math.cos(a) * s, r.range(1.0, 3.0) * (0.4 + strength * 0.6), Math.sin(a) * s);
      this.tmpC.setRGB(0.88, 0.93, 0.92);
      this.drops.spawn(this.tmpP, this.tmpV, this.tmpC, r.range(0.008, 0.02), r.range(0.5, 1.1), 0, WORLD.waterLevel - 0.02);
    }
    for (let i = 0; i < 6; i++) {
      this.tmpP.set(x + r.range(-0.15, 0.15), WORLD.waterLevel + 0.03, z + r.range(-0.15, 0.15));
      this.tmpV.set(r.range(-0.2, 0.2), r.range(0.05, 0.2), r.range(-0.2, 0.2));
      this.tmpC.setRGB(0.92, 0.95, 0.95);
      this.dust.spawn(this.tmpP, this.tmpV, this.tmpC, r.range(0.05, 0.1), r.range(0.4, 0.8), 0.15);
    }
    this.ripples.spawn(x, z, strength);
    this.ripples.spawn(x, z, strength * 0.6);
  }

  update(dt: number): void {
    this.dust.update(dt);
    this.chips.update(dt);
    this.drops.update(dt);
    this.ripples.update(dt);
  }

  dispose(): void {
    this.dust.dispose();
    this.chips.dispose();
    this.drops.dispose();
  }
}
