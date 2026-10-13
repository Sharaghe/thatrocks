import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { GAMEPLAY, PHYSICS, SCORING, WORLD } from '../config';
import { clamp, damp, dampFactor, lerp, smoothstep } from '../core/math';
import { quatAngle, quatMultiply, quatYaw } from '../core/quat';
import { randomSeed } from '../core/rng';
import { StoneSequence, type RockId } from '../stones/catalog';
import type { Quat, StoneShape } from '../stones/StoneShape';
import type { StoneFactory } from '../stones/StoneFactory';
import { convexHull3D } from '../stones/hull3d';
import type { RenderContext } from '../render/RenderContext';
import type { Environment } from '../render/Environment';
import type { Effects } from '../render/Effects';
import { CameraRig, type CameraMode } from '../render/CameraRig';
import { createGhostMaterial, createStoneMaterial, sharedUniforms } from '../render/materials';
import { stoneGeometry } from '../render/stoneGeometry';
import type { SurfaceTextures } from '../render/TextureFactory';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Haptics } from '../platform/haptics';
import type { ScoreStore, Settings } from '../storage/ScoreStore';
import type { Hud } from '../ui/Hud';
import type { DebugOverlay } from '../ui/DebugOverlay';
import type { InputSink, PlacementInput } from '../input/PlacementInput';
import { GameStateMachine, type GamePhase } from './GameStateMachine';
import { comboMultiplier, computeRisk, initialScoreState, scorePlacement, type RiskBreakdown, type ScoreState } from './Scoring';
import type { LandingInfo, Simulation, StepReport, StoneBody } from './Simulation';
import type { StabilityReport } from './Stability';

interface HeldStone {
  level: number;
  shape: StoneShape;
  mesh: THREE.Mesh;
  cast: RAPIER.Shape;
  x: number;
  z: number;
  yaw: number;
  pose: number;
  disp: { x: number; y: number; z: number; quat: THREE.Quaternion; init: boolean };
  landing: LandingInfo | null;
  appear: number;
}

interface SettleTracker {
  stone: StoneBody;
  time: number;
  rest: number;
  peakAngular: number;
  slowmoUsed: boolean;
  /** Orientations of the new stone after first contact (every other step). */
  history: Quat[];
  /** Orientation of each older stone at drop time, and its largest deviation since. */
  before: Map<number, { rot: Quat; maxDev: number }>;
  contact: boolean;
}

export interface Placement {
  level: number;
  pos: [number, number, number];
  rot: Quat;
  waitSteps: number;
}

export interface GameDeps {
  ctx: RenderContext;
  sim: Simulation;
  env: Environment;
  effects: Effects;
  factory: StoneFactory;
  textures: SurfaceTextures;
  audio: AudioEngine;
  haptics: Haptics;
  store: ScoreStore;
  hud: Hud;
  debug: DebugOverlay;
  input: PlacementInput;
  fixedSeed: number | null;
  reducedMotion: boolean;
  qualityLabel: string;
}

const TIER_INDEX: Record<string, number> = { steady: 0, bold: 1, daring: 2, knife: 3 };

export class Game implements InputSink {
  readonly fsm = new GameStateMachine();
  readonly camera: CameraRig;
  private readonly ctx: RenderContext;
  private readonly sim: Simulation;
  private seed = 1;
  private sequence = new StoneSequence(1);
  private level = 0;
  private score: ScoreState = initialScoreState();
  private held: HeldStone | null = null;
  private spawnToken = 0;
  private settle: SettleTracker | null = null;
  private views = new Map<number, THREE.Mesh>();
  private materials = new Map<RockId, THREE.MeshStandardMaterial>();
  private ghost: THREE.Mesh;
  private ghostMaterial = createGhostMaterial();
  private marker: THREE.Mesh;
  private dropLine: THREE.Line;
  private acc = 0;
  private timeScale = 1;
  private slowmoReal = 0;
  private collapseTime = 0;
  private paused = false;
  private rotateHoldDir: -1 | 0 | 1 = 0;
  private towerTopCache: number = WORLD.baseTop;
  private bestHeight = 0;
  private lastAxis = new THREE.Vector3();
  private aimStartStep = 0;
  private placements: Placement[] = [];
  private replayQueue: Placement[] | null = null;
  private lastReport: { report: StabilityReport; risk: RiskBreakdown; stoneId: number } | null = null;
  private debugGroup = new THREE.Group();
  private colliderLines: THREE.LineSegments | null = null;
  private hintShown = 0;
  private time = 0;
  private scrapeLevel = 0;
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private frameCpuMs = 0;
  private lastPhysicsMs = 0;
  private resolveWaiters: (() => void)[] = [];
  private fixedSeed: number | null;

  constructor(private readonly d: GameDeps) {
    this.ctx = d.ctx;
    this.sim = d.sim;
    this.fixedSeed = d.fixedSeed;
    this.camera = new CameraRig(d.ctx.camera);
    this.camera.reducedMotion = d.reducedMotion;
    const scene = d.ctx.scene;

    this.ghost = new THREE.Mesh(new THREE.BufferGeometry(), this.ghostMaterial);
    this.ghost.visible = false;
    this.ghost.renderOrder = 4;
    const ring = new THREE.RingGeometry(0.012, 0.022, 24);
    ring.rotateX(-Math.PI / 2);
    this.marker = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: '#fff4dc', transparent: true, opacity: 0.85, depthTest: false }));
    this.marker.renderOrder = 5;
    this.marker.visible = false;
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]);
    this.dropLine = new THREE.Line(lineGeo, new THREE.LineDashedMaterial({ color: '#fff4dc', transparent: true, opacity: 0.55, dashSize: 0.012, gapSize: 0.01, depthTest: false }));
    this.dropLine.renderOrder = 5;
    this.dropLine.visible = false;
    scene.add(this.ghost, this.marker, this.dropLine, d.effects.group, this.debugGroup);

    this.fsm.onChange((next, prev) => this.onPhase(next, prev));
    this.resetCamera();
  }

  /**
   * Compile every shader program the game will need before play starts, so
   * the first stone, ghost and debris never cause a hitch (notably on iOS).
   */
  prewarm(): void {
    const scene = this.ctx.scene;
    const temp: THREE.Object3D[] = [];
    const geo = new THREE.SphereGeometry(0.1, 8, 6);
    const colors = new Float32Array(geo.getAttribute('position').count * 3).fill(0.5);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    for (const rock of ['granite', 'sandstone', 'basalt', 'slate', 'quartzite', 'limestone'] as RockId[]) {
      const m = new THREE.Mesh(geo, this.materialFor(rock));
      m.position.set(0, -50, 0);
      m.castShadow = true;
      temp.push(m);
    }
    const ghost = new THREE.Mesh(geo, this.ghostMaterial);
    ghost.position.set(0, -50, 0);
    temp.push(ghost);
    scene.add(...temp);
    const wasVisible = [this.marker.visible, this.dropLine.visible];
    this.marker.visible = true;
    this.dropLine.visible = true;
    try {
      this.ctx.renderer.compile(scene, this.ctx.camera);
    } finally {
      scene.remove(...temp);
      geo.dispose();
      [this.marker.visible, this.dropLine.visible] = wasVisible;
    }
  }

  // ------------------------------------------------------------ lifecycle
  get phase(): GamePhase {
    return this.fsm.phase;
  }

  loaded(): void {
    this.fsm.send({ type: 'LOADED' });
  }

  startGame(): void {
    if (this.fsm.phase === 'title') {
      this.newRound();
      this.fsm.send({ type: 'START' });
    }
  }

  restart(): void {
    if (this.fsm.phase === 'title' || this.fsm.phase === 'loading') return;
    this.paused = false;
    this.newRound();
    this.fsm.send({ type: 'RESTART' });
  }

  quitToTitle(): void {
    this.paused = false;
    this.clearTower();
    this.fsm.send({ type: 'QUIT' });
  }

  setPaused(paused: boolean): void {
    if (paused && !(this.phase === 'aiming' || this.phase === 'settling' || this.phase === 'collapsing')) return;
    this.paused = paused;
    this.d.input.enabled = !paused;
    if (paused) {
      this.d.audio.setScrape(0, null);
      this.d.hud.show('pause');
    } else {
      this.d.hud.show('game');
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private newRound(): void {
    this.clearTower();
    this.seed = this.fixedSeed ?? randomSeed();
    this.sequence = new StoneSequence(this.seed);
    this.level = 0;
    this.score = initialScoreState();
    this.bestHeight = 0;
    this.placements = [];
    this.lastReport = null;
    this.timeScale = 1;
    this.slowmoReal = 0;
    this.acc = 0;
    this.d.factory.clearCache();
    this.d.hud.setScore(0, false);
    this.d.hud.setHeight(0);
    this.d.hud.setCombo(0, 1);
    this.d.hud.clearPopups();
    this.camera.targetAzimuth = this.camera.azimuth;
    this.camera.zoom = 1;
  }

  private clearTower(): void {
    this.spawnToken++;
    this.dropHeldVisual();
    this.settle = null;
    for (const s of this.sim.stones) {
      const mesh = this.views.get(s.id);
      if (mesh) {
        this.ctx.scene.remove(mesh);
        mesh.geometry.dispose();
      }
    }
    this.views.clear();
    this.sim.clearStones();
    this.towerTopCache = this.sim.baseTop();
    this.clearDebugMarkers();
  }

  private onPhase(next: GamePhase, prev: GamePhase): void {
    const hud = this.d.hud;
    switch (next) {
      case 'title':
        hud.show('title');
        hud.setTitleInfo(this.d.store.bestScore, this.d.store.bestHeight, false);
        this.d.input.enabled = false;
        break;
      case 'aiming':
        hud.show('game');
        this.d.input.enabled = true;
        this.aimStartStep = this.sim.physics.stepCount;
        hud.setControlsActive(false);
        this.spawnHeld();
        if (prev !== 'settling') {
          hud.showHint('Drag to move · Twist or ⟲ ⟳ to rotate · Drop', 6);
          this.hintShown = 1;
        }
        break;
      case 'settling':
        hud.setControlsActive(false);
        break;
      case 'collapsing':
        this.collapseTime = 0;
        hud.setControlsActive(false);
        hud.hideHint();
        this.d.input.enabled = false;
        break;
      case 'gameover':
        this.finishGame();
        break;
      default:
        break;
    }
    for (const w of this.resolveWaiters.splice(0)) w();
  }

  // ------------------------------------------------------------ held stone
  private stoneKey(level: number): string {
    return `${this.seed}:${level}`;
  }

  private spawnHeld(): void {
    const token = ++this.spawnToken;
    const level = this.level;
    const recipe = this.sequence.recipe(level);
    this.d.factory
      .get(this.stoneKey(level), recipe)
      .catch((err) => {
        // Never leave the player without a stone: fall back to a variant recipe.
        console.warn('Stone generation failed, using a variant', err);
        return this.d.factory.get(`${this.stoneKey(level)}:alt`, this.sequence.recipe(level + 7919));
      })
      .then((shape) => {
        if (token !== this.spawnToken || this.phase !== 'aiming') return;
        this.setHeld(shape, level);
        // Prefetch the next stone while the player aims.
        void this.d.factory.get(this.stoneKey(level + 1), this.sequence.recipe(level + 1)).catch(() => undefined);
      })
      .catch((err) => console.error('Could not create a stone', err));
  }

  private materialFor(rock: RockId): THREE.MeshStandardMaterial {
    let m = this.materials.get(rock);
    if (!m) {
      m = createStoneMaterial(rock, this.d.textures);
      this.materials.set(rock, m);
    }
    return m;
  }

  private setHeld(shape: StoneShape, level: number): void {
    const mesh = new THREE.Mesh(stoneGeometry(shape), this.materialFor(shape.rock.id));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `stone-${level}`;
    this.ctx.scene.add(mesh);
    const last = this.placements[this.placements.length - 1];
    const x = last ? last.pos[0] * 0.6 : 0;
    const z = last ? last.pos[2] * 0.6 : 0;
    this.held = {
      level,
      shape,
      mesh,
      cast: this.sim.createCastShape(shape),
      x,
      z,
      yaw: shape.recipe.yaw,
      pose: 0,
      disp: { x, y: 0, z, quat: new THREE.Quaternion(), init: false },
      landing: null,
      appear: 0,
    };
    this.ghost.geometry = mesh.geometry;
    this.d.hud.setControlsActive(true);
    this.aimStartStep = this.sim.physics.stepCount;
  }

  private heldTargetQuat(h: HeldStone): Quat {
    return quatMultiply(quatYaw(h.yaw), h.shape.restingPoses[h.pose % h.shape.restingPoses.length].quaternion);
  }

  private updateHeld(dt: number): void {
    const h = this.held;
    if (!h) return;
    const lambda = 1 / GAMEPLAY.inputSmoothing;
    if (this.rotateHoldDir !== 0) h.yaw += this.rotateHoldDir * GAMEPLAY.rotateSpeed * dt;
    const tq = this.heldTargetQuat(h);
    this.tmpQ.set(tq[0], tq[1], tq[2], tq[3]);
    if (!h.disp.init) {
      h.disp.x = h.x;
      h.disp.z = h.z;
      h.disp.quat.copy(this.tmpQ);
    } else {
      h.disp.x = damp(h.disp.x, h.x, lambda, dt);
      h.disp.z = damp(h.disp.z, h.z, lambda, dt);
      h.disp.quat.slerp(this.tmpQ, dampFactor(lambda * 0.55, dt));
    }
    const q = h.disp.quat;
    const fromY = this.towerTopCache + h.shape.boundingRadius * 2 + 0.3;
    h.landing = this.sim.castLanding(h.cast, h.disp.x, h.disp.z, [q.x, q.y, q.z, q.w], fromY);
    const targetY = h.landing ? h.landing.y + GAMEPLAY.hoverClearance : this.sim.baseTop() + 0.5;
    if (!h.disp.init) h.disp.y = targetY + 0.25;
    // Rise immediately when needed (never intersect), descend smoothly.
    h.disp.y = Math.max(targetY, damp(h.disp.y, targetY, 14, dt));
    h.disp.init = true;
    h.appear = Math.min(1, h.appear + dt * 4);
    const s = 0.7 + 0.3 * smoothstep(0, 1, h.appear);
    const bob = Math.sin(this.time * 2.4) * 0.0015;
    h.mesh.position.set(h.disp.x, h.disp.y + bob, h.disp.z);
    h.mesh.quaternion.copy(q);
    h.mesh.scale.setScalar(s);

    // Landing preview
    const L = h.landing;
    if (L) {
      const gap = h.disp.y - L.y;
      this.ghost.visible = gap > 0.012;
      this.ghost.position.set(h.disp.x, L.y, h.disp.z);
      this.ghost.quaternion.copy(q);
      this.ghostMaterial.uniforms.uColor.value.set(L.kind === 'ground' ? '#ff9a7a' : '#fff6e0');
      this.ghostMaterial.uniforms.uOpacity.value = 0.5 * smoothstep(0, 1, h.appear);
      this.marker.visible = true;
      this.marker.position.set(L.contact[0], L.contact[1] + 0.002, L.contact[2]);
      const pulse = 1 + Math.sin(this.time * 5) * 0.12;
      this.marker.scale.setScalar(pulse);
      (this.marker.material as THREE.MeshBasicMaterial).color.set(L.kind === 'ground' ? '#ff9a7a' : '#fff4dc');
      const top = L.contact[1] + gap;
      const pos = this.dropLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, L.contact[0], top, L.contact[2]);
      pos.setXYZ(1, L.contact[0], L.contact[1], L.contact[2]);
      pos.needsUpdate = true;
      this.dropLine.computeLineDistances();
      this.dropLine.visible = gap > 0.02;
    } else {
      this.ghost.visible = false;
      this.marker.visible = false;
      this.dropLine.visible = false;
    }
  }

  private dropHeldVisual(): void {
    if (this.held) {
      this.ctx.scene.remove(this.held.mesh);
      this.held.mesh.geometry.dispose();
      this.held = null;
    }
    this.ghost.visible = false;
    this.marker.visible = false;
    this.dropLine.visible = false;
  }

  // ------------------------------------------------------------ InputSink
  moveBy(dxPx: number, dyPx: number, speed: number): void {
    const h = this.held;
    if (!h || this.phase !== 'aiming' || this.paused) return;
    const cam = this.ctx.camera;
    const dist = cam.position.distanceTo(this.tmpV.set(h.disp.x, h.disp.y, h.disp.z));
    const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / this.ctx.height;
    const gain = lerp(GAMEPLAY.dragGainSlow, GAMEPLAY.dragGainFast, smoothstep(0, GAMEPLAY.dragSpeedForFullGain, speed));
    const right = new THREE.Vector3();
    const forward = new THREE.Vector3();
    this.camera.basis(right, forward);
    const mx = dxPx * worldPerPx * gain;
    const mz = -dyPx * worldPerPx * gain;
    h.x += right.x * mx + forward.x * mz;
    h.z += right.z * mx + forward.z * mz;
    const r = Math.hypot(h.x, h.z);
    if (r > GAMEPLAY.maxHorizontalRange) {
      h.x *= GAMEPLAY.maxHorizontalRange / r;
      h.z *= GAMEPLAY.maxHorizontalRange / r;
    }
    if (this.hintShown === 1 && Math.abs(dxPx) + Math.abs(dyPx) > 2) {
      this.hintShown = 2;
      window.setTimeout(() => this.d.hud.hideHint(), 1500);
    }
  }

  rotateBy(radians: number): void {
    if (this.held && this.phase === 'aiming' && !this.paused) this.held.yaw += radians;
  }

  rotateStep(dir: -1 | 1): void {
    if (this.held && this.phase === 'aiming' && !this.paused) {
      this.held.yaw += dir * GAMEPLAY.rotateStep;
      this.d.haptics.pulse('tick');
    }
  }

  rotateHold(dir: -1 | 0 | 1): void {
    this.rotateHoldDir = dir;
  }

  orbitBy(radians: number): void {
    this.camera.orbit(radians);
  }

  zoomBy(factor: number): void {
    this.camera.zoomBy(factor);
  }

  flip(): void {
    const h = this.held;
    if (!h || this.phase !== 'aiming' || this.paused) return;
    if (h.shape.restingPoses.length < 2) {
      h.yaw += Math.PI / 2;
    } else {
      h.pose = (h.pose + 1) % h.shape.restingPoses.length;
    }
    this.d.haptics.pulse('light');
    this.d.audio.click();
  }

  drop(): void {
    const h = this.held;
    if (!h || this.phase !== 'aiming' || this.paused || !h.disp.init) return;
    const q = h.disp.quat;
    const rot: Quat = [q.x, q.y, q.z, q.w];
    const landing = this.sim.castLanding(h.cast, h.disp.x, h.disp.z, rot, this.towerTopCache + h.shape.boundingRadius * 2 + 0.3);
    const y = landing ? landing.y + GAMEPLAY.hoverClearance : h.disp.y;
    this.commitDrop(h, [h.disp.x, y, h.disp.z], rot);
  }

  private commitDrop(h: HeldStone, pos: [number, number, number], rot: Quat): void {
    const stone = this.sim.addStone(h.shape, pos, rot, h.level);
    h.mesh.scale.setScalar(1);
    h.mesh.position.set(pos[0], pos[1], pos[2]);
    this.views.set(stone.id, h.mesh);
    this.placements.push({ level: h.level, pos, rot, waitSteps: this.sim.physics.stepCount - this.aimStartStep });
    this.held = null;
    this.ghost.visible = false;
    this.marker.visible = false;
    this.dropLine.visible = false;
    this.rotateHoldDir = 0;
    const before = new Map<number, { rot: Quat; maxDev: number }>();
    for (const s of this.sim.stones) if (!s.removed && s !== stone) before.set(s.id, { rot: [...s.rot] as Quat, maxDev: 0 });
    this.settle = { stone, time: 0, rest: 0, peakAngular: 0, slowmoUsed: false, contact: false, history: [], before };
    this.d.haptics.pulse('light');
    this.fsm.send({ type: 'DROP' });
  }

  togglePause(): void {
    if (this.paused) this.setPaused(false);
    else this.setPaused(true);
  }

  toggleDebug(): void {
    this.setDebug(!this.d.debug.isVisible);
  }

  setDebug(on: boolean): void {
    this.d.debug.setVisible(on);
    this.d.store.updateSettings({ debug: on });
    this.updateDebugVisuals();
  }

  gesture(): void {
    if (this.d.store.settings.sound) this.d.audio.unlock();
  }

  applySettings(s: Settings): void {
    this.d.audio.setMuted(!s.sound);
    this.d.haptics.enabled = s.haptics;
  }

  // ---------------------------------------------------------------- frame
  update(dtReal: number): void {
    const t0 = performance.now();
    const dt = Math.min(dtReal, 0.1);
    this.time += dt;
    sharedUniforms.uTime.value = this.time;
    this.d.input.update(dt);

    const phase = this.phase;
    const simulate = !this.paused && phase !== 'title' && phase !== 'loading';

    // Slow motion: physics still runs in fixed steps, just fewer per real second.
    if (this.slowmoReal > 0) this.slowmoReal -= dt;
    const debugSlow = this.d.debug.isVisible && this.d.debug.toggles.slowmo;
    const targetScale = debugSlow ? 0.25 : this.slowmoReal > 0 ? GAMEPLAY.slowMotionScale : 1;
    this.timeScale = damp(this.timeScale, targetScale, this.slowmoReal > 0 ? 14 : 5, dt);
    this.d.hud.setSlowMotion(this.slowmoReal > 0);

    let physicsMs = 0;
    if (simulate) {
      this.acc += dt * this.timeScale;
      let steps = 0;
      const p0 = performance.now();
      while (this.acc >= PHYSICS.fixedDt && steps < PHYSICS.maxStepsPerFrame) {
        this.stepPhysics();
        this.acc -= PHYSICS.fixedDt;
        steps++;
      }
      if (steps === PHYSICS.maxStepsPerFrame) this.acc = Math.min(this.acc, PHYSICS.fixedDt);
      physicsMs = performance.now() - p0;
      if (steps > 0) this.towerTopCache = this.sim.towerTop();
    }
    this.lastPhysicsMs = physicsMs;

    if (this.phase === 'aiming' && !this.paused) {
      this.updateHeld(dt);
      this.runReplay();
    }
    this.syncViews();
    this.updateScrape();
    this.updateCamera(dt);
    this.d.effects.update(this.paused ? 0 : dt * Math.max(this.timeScale, 0.35));
    this.d.audio.update();
    this.d.hud.update(dt);
    if (this.colliderLines) this.refreshColliderLines();
    this.ctx.render();
    this.frameCpuMs = performance.now() - t0;
    this.ctx.trackFrame(dtReal * 1000);
    this.d.debug.frame(dtReal * 1000);
    this.d.debug.update(dtReal * 1000, () => this.debugLines());
  }

  private stepPhysics(): void {
    const report = this.sim.step();
    this.handleEvents(report);
    const phase = this.phase;
    if (phase === 'aiming' || phase === 'settling') {
      if (this.detectFailure(report)) {
        this.beginCollapse();
        return;
      }
    }
    if (phase === 'settling') this.stepSettle();
    if (phase === 'collapsing') {
      this.collapseTime += PHYSICS.fixedDt;
      if (this.collapseTime >= GAMEPLAY.collapseDuration) this.fsm.send({ type: 'COLLAPSE_DONE' });
    }
  }

  private detectFailure(report: StepReport): boolean {
    if (report.groundTouches.length > 0 || report.outOfBounds.length > 0) return true;
    const minY = this.sim.baseTop() - 0.12;
    for (const s of this.sim.stones) if (!s.removed && s.pos[1] < minY) return true;
    return false;
  }

  private stepSettle(): void {
    const st = this.settle;
    if (!st) return;
    const dt = PHYSICS.fixedDt;
    st.time += dt;
    const m = this.sim.motion();
    let towerSway = 0;
    if (st.contact && !st.stone.removed) {
      const w = st.stone.body.angvel();
      if (st.time > GAMEPLAY.wobbleIgnoreTime) st.peakAngular = Math.max(st.peakAngular, Math.hypot(w.x, w.y, w.z));
      if ((this.sim.physics.stepCount & 1) === 0) st.history.push([...st.stone.rot] as Quat);
    }
    for (const s of this.sim.stones) {
      const b = st.before.get(s.id);
      if (!b || s.removed) continue;
      const dev = quatAngle(b.rot, s.rot);
      if (dev > b.maxDev) b.maxDev = dev;
      towerSway = Math.max(towerSway, dev);
    }
    // A dramatic wobble earns a short, physically simulated slow motion.
    const wobbling =
      (st.time > GAMEPLAY.wobbleIgnoreTime && st.peakAngular > GAMEPLAY.wobbleAngularSpeed) ||
      (towerSway > (GAMEPLAY.closeCallTowerTiltDeg * Math.PI) / 360 && m.maxAngular > 0.5);
    if (!st.slowmoUsed && st.contact && st.time < 4 && wobbling) {
      st.slowmoUsed = true;
      this.slowmoReal = GAMEPLAY.slowMotionMaxRealTime;
      this.d.haptics.pulse('warning');
    }
    const resting = m.maxLinear < GAMEPLAY.settleLinearSpeed && m.maxAngular < GAMEPLAY.settleAngularSpeed;
    st.rest = resting ? st.rest + dt : 0;
    if ((st.time > GAMEPLAY.minSettleTime && st.rest > GAMEPLAY.settleHoldTime) || st.time > GAMEPLAY.settleTimeout) {
      this.onSettled(st);
    }
  }

  private onSettled(st: SettleTracker): void {
    this.settle = null;
    this.slowmoReal = Math.min(this.slowmoReal, 0.15);
    const stone = st.stone;
    const report = this.sim.analyze(stone);
    const risk = computeRisk(report);
    const closeCall = this.wasCloseCall(st);
    const result = scorePlacement(this.score, { level: stone.level, risk: risk.total, closeCall });
    this.score = result.state;
    this.lastReport = { report, risk, stoneId: stone.id };
    const height = Math.max(0, this.sim.towerTop() - this.sim.baseTop());
    this.bestHeight = Math.max(this.bestHeight, height);

    const hud = this.d.hud;
    hud.setScore(this.score.score);
    hud.setHeight(height);
    hud.setCombo(result.combo, comboMultiplier(result.combo));
    const screen = this.project(stone.pos[0], stone.pos[1] + stone.shape.boundingRadius + 0.05, stone.pos[2]);
    const tierLabel = result.combo >= 2 ? `${result.tier.label} · ×${result.comboMultiplier.toFixed(2).replace(/\.?0+$/, '')}` : result.tier.label;
    hud.popup(screen.x, screen.y, `+${result.points - result.closeCallBonus}`, tierLabel, `tier-${result.tier.id}`);
    if (closeCall) {
      window.setTimeout(() => hud.popup(screen.x, screen.y - 46, `Close call +${result.closeCallBonus}`, '', 'special'), 380);
      this.d.audio.closeCall();
    }
    const tierIdx = TIER_INDEX[result.tier.id] ?? 0;
    this.d.audio.placed(tierIdx, result.combo);
    this.d.haptics.pulse(tierIdx >= 2 ? 'success' : 'light');
    if (result.comboBroken) hud.showHint('Combo ended — play bolder to build it again', 2.5);
    this.updateDebugVisuals();
    this.level++;
    this.fsm.send({ type: 'SETTLED' });
  }

  /** The stone (or the tower under it) tipped noticeably and recovered on its own. */
  private wasCloseCall(st: SettleTracker): boolean {
    const final = st.stone.rot;
    let rocked = 0;
    for (const q of st.history) rocked = Math.max(rocked, quatAngle(q, final));
    if (rocked > (GAMEPLAY.closeCallTiltDeg * Math.PI) / 180) return true;
    for (const s of this.sim.stones) {
      const b = st.before.get(s.id);
      if (!b || s.removed) continue;
      const finalDev = quatAngle(b.rot, s.rot);
      if (b.maxDev > (GAMEPLAY.closeCallTowerTiltDeg * Math.PI) / 180 && finalDev < b.maxDev * 0.5) return true;
    }
    return false;
  }

  private beginCollapse(): void {
    if (!this.fsm.send({ type: 'COLLAPSE' })) return;
    this.settle = null;
    this.dropHeldVisual();
    this.slowmoReal = 0.75;
    this.d.audio.collapse();
    this.d.haptics.pulse('failure');
    this.camera.addShake(0.45);
  }

  private finishGame(): void {
    const res = this.d.store.recordGame({
      score: this.score.score,
      height: this.bestHeight,
      stones: this.score.placements,
      date: new Date().toISOString(),
      seed: this.seed,
    });
    this.d.hud.showGameOver({
      score: this.score.score,
      height: this.bestHeight,
      stones: this.score.placements,
      maxCombo: this.score.maxCombo,
      best: this.d.store.bestScore,
      newBest: res.newBestScore && this.score.score > 0,
      newBestHeight: res.newBestHeight && this.bestHeight > 0,
    });
    this.d.audio.gameOver(res.newBestScore && this.score.score > 0);
    this.d.audio.setScrape(0, null);
  }

  // --------------------------------------------------------------- events
  private handleEvents(report: StepReport): void {
    const audio = this.d.audio;
    for (const imp of report.impacts) {
      const s = imp.stone;
      if (this.settle && (s === this.settle.stone || imp.other === this.settle.stone)) this.settle.contact = true;
      const other = imp.other;
      const p = this.tmpV.set(s.pos[0], s.pos[1] - s.shape.boundingRadius * 0.45, s.pos[2]);
      if (other) p.set((s.pos[0] + other.pos[0]) / 2, (s.pos[1] + other.pos[1]) / 2, (s.pos[2] + other.pos[2]) / 2);
      const pan = this.panOf(p);
      const mass = other ? Math.min(s.shape.mass, other.shape.mass) : s.shape.mass;
      audio.impact(s.shape.rock.sound, other ? other.shape.rock.sound : null, imp.speed, s.shape.boundingRadius, mass, pan, imp.kind === 'ground');
      if (imp.speed > 0.25) {
        const color = new THREE.Color(s.shape.rock.palette[0]);
        this.d.effects.impact(p, imp.speed, color);
      }
      if (imp.speed > 0.6) this.camera.addShake(clamp(imp.speed * mass * 0.004, 0, 0.35));
      if (this.phase === 'settling' && imp.speed > 0.35) this.d.haptics.pulse(imp.speed > 1 ? 'medium' : 'tick');
    }
    for (const sp of report.splashes) {
      this.d.effects.splash(sp.position[0], sp.position[2], sp.speed);
      audio.splash(sp.speed, this.panOf(this.tmpV.set(sp.position[0], sp.position[1], sp.position[2])));
    }
    for (const s of report.outOfBounds) {
      const mesh = this.views.get(s.id);
      if (mesh) mesh.visible = false;
    }
  }

  private panOf(p: THREE.Vector3): number {
    const v = p.clone().project(this.ctx.camera);
    return clamp(v.x * 0.8, -0.9, 0.9);
  }

  private updateScrape(): void {
    if (this.paused || this.phase === 'title') {
      this.d.audio.setScrape(0, null);
      return;
    }
    let intensity = 0;
    let sig = null as StoneBody['shape']['rock']['sound'] | null;
    let best = 0;
    for (const s of this.sim.stones) {
      if (s.removed || s.body.isSleeping() || s.submerged) continue;
      const v = s.body.linvel();
      const w = s.body.angvel();
      const slide = Math.hypot(v.x, v.z) + Math.hypot(w.x, w.y, w.z) * s.shape.boundingRadius * 0.3;
      if (slide < 0.03 || Math.abs(v.y) > 0.6) continue;
      let touching = false;
      this.sim.world.contactPairsWith(s.collider, () => {
        touching = true;
      });
      if (!touching) continue;
      intensity += slide;
      if (slide > best) {
        best = slide;
        sig = s.shape.rock.sound;
      }
    }
    this.scrapeLevel = damp(this.scrapeLevel, intensity * this.timeScale, 12, 1 / 60);
    this.d.audio.setScrape(this.scrapeLevel, sig);
  }

  // ---------------------------------------------------------------- views
  private syncViews(): void {
    const alpha = clamp(this.acc / PHYSICS.fixedDt, 0, 1);
    for (const s of this.sim.stones) {
      if (s.removed) continue;
      const mesh = this.views.get(s.id);
      if (!mesh) continue;
      mesh.position.set(lerp(s.prevPos[0], s.pos[0], alpha), lerp(s.prevPos[1], s.pos[1], alpha), lerp(s.prevPos[2], s.pos[2], alpha));
      this.tmpQ.set(s.prevRot[0], s.prevRot[1], s.prevRot[2], s.prevRot[3]);
      this.tmpQ2.set(s.rot[0], s.rot[1], s.rot[2], s.rot[3]);
      mesh.quaternion.slerpQuaternions(this.tmpQ, this.tmpQ2, alpha);
    }
  }

  private updateCamera(dt: number): void {
    const baseY = this.sim.baseTop();
    const top = this.towerTopCache;
    const towerHeight = Math.max(0, top - baseY);
    // Follow the upper tower horizontally (a leaning tower stays framed).
    let ax = 0;
    let az = 0;
    let m = 0;
    for (const s of this.sim.stones) {
      if (s.removed || s.groundContact || s.pos[1] < top - 0.6) continue;
      ax += s.pos[0] * s.shape.mass;
      az += s.pos[2] * s.shape.mass;
      m += s.shape.mass;
    }
    if (m > 0) this.lastAxis.set((ax / m) * 0.6, 0, (az / m) * 0.6);
    else this.lastAxis.set(0, 0, 0);
    const mode: CameraMode =
      this.phase === 'title' || this.phase === 'loading'
        ? 'title'
        : this.phase === 'settling'
          ? 'settle'
          : this.phase === 'collapsing'
            ? 'collapse'
            : this.phase === 'gameover'
              ? 'gameover'
              : 'aim';
    const workY = this.held ? this.held.disp.y : top + 0.1;
    this.camera.update(dt, { workY, towerHeight, baseY, axis: this.lastAxis, mode });
    const focus = this.camera.focusPoint;
    const extent = mode === 'title' || mode === 'gameover' || mode === 'collapse' ? 3.2 : clamp(1.7 + towerHeight * 0.45, 1.9, 3.4);
    this.d.env.update(this.tmpV.set(focus.x, Math.max(baseY, focus.y - 0.3), focus.z), extent);
  }

  private resetCamera(): void {
    this.camera.reset({ workY: WORLD.baseTop + 0.4, towerHeight: 0, baseY: WORLD.baseTop, axis: new THREE.Vector3(), mode: 'title' });
  }

  private project(x: number, y: number, z: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).project(this.ctx.camera);
    return { x: ((v.x + 1) / 2) * this.ctx.width, y: ((1 - v.y) / 2) * this.ctx.height };
  }

  // ---------------------------------------------------------------- debug
  private clearDebugMarkers(): void {
    for (const c of [...this.debugGroup.children]) {
      if (c === this.colliderLines) continue;
      this.debugGroup.remove(c);
      if (c instanceof THREE.Mesh || c instanceof THREE.Line) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    }
  }

  updateDebugVisuals(): void {
    const dbg = this.d.debug;
    const show = dbg.isVisible;
    // Collider wireframes (Rapier's own debug geometry)
    if (show && dbg.toggles.colliders) {
      if (!this.colliderLines) {
        this.colliderLines = new THREE.LineSegments(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }),
        );
        this.colliderLines.renderOrder = 10;
        this.colliderLines.frustumCulled = false;
        this.debugGroup.add(this.colliderLines);
      }
    } else if (this.colliderLines) {
      this.debugGroup.remove(this.colliderLines);
      this.colliderLines.geometry.dispose();
      (this.colliderLines.material as THREE.Material).dispose();
      this.colliderLines = null;
    }
    this.clearDebugMarkers();
    if (!show || !dbg.toggles.contacts || !this.lastReport) return;
    const { report } = this.lastReport;
    const dotGeo = new THREE.SphereGeometry(0.008, 8, 6);
    const dotMat = new THREE.MeshBasicMaterial({ color: '#7dff8a', depthTest: false });
    for (const p of report.supportPoints) {
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.set(p.x, p.y, p.z);
      dot.renderOrder = 11;
      this.debugGroup.add(dot);
    }
    const y = report.supportPoints.length ? report.supportPoints.reduce((a, p) => a + p.y, 0) / report.supportPoints.length : 0;
    if (report.supportPolygon.length >= 2) {
      const pts = report.supportPolygon.map((p) => new THREE.Vector3(p.x, y + 0.003, p.y));
      pts.push(pts[0].clone());
      const loop = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#7dff8a', depthTest: false }));
      loop.renderOrder = 11;
      this.debugGroup.add(loop);
    }
    const com = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshBasicMaterial({ color: report.margin > 0 ? '#ffe066' : '#ff5a5a', depthTest: false }));
    com.position.set(report.comXZ.x, y + 0.004, report.comXZ.y);
    com.renderOrder = 12;
    this.debugGroup.add(com);
  }

  private refreshColliderLines(): void {
    if (!this.colliderLines) return;
    const { vertices, colors } = this.sim.debugLines();
    const g = this.colliderLines.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  }

  private debugLines(): string[] {
    const sim = this.sim;
    const motion = sim.motion();
    const active = sim.activeStones();
    const lines = [
      `phase ${this.phase}${this.paused ? ' (paused)' : ''}  timeScale ${this.timeScale.toFixed(2)}`,
      `cpu ${this.frameCpuMs.toFixed(1)} ms  physics ${this.lastPhysicsMs.toFixed(2)} ms/frame  step ${sim.physics.lastStepMs.toFixed(2)} ms`,
      `res ×${this.ctx.resolutionScale.toFixed(2)}${this.ctx.frameCapMs ? ` (cap ${this.ctx.frameCapMs.toFixed(0)} ms)` : ''}  dpr ${this.ctx.pixelRatio.toFixed(2)}  ${this.ctx.width}×${this.ctx.height}  ${this.d.qualityLabel}`,
      `draw calls ${this.ctx.renderer.info.render.calls}  tris ${(this.ctx.renderer.info.render.triangles / 1000).toFixed(0)}k`,
      `seed ${this.seed}  level ${this.level}  steps ${sim.physics.stepCount}`,
      `bodies ${active.length}  awake ${motion.awake}  vmax ${motion.maxLinear.toFixed(3)}  ωmax ${motion.maxAngular.toFixed(3)}`,
      `tower ${(this.towerTopCache - sim.baseTop()).toFixed(3)} m  lean ${sim.towerLean().toFixed(3)} m`,
      `gravity ${PHYSICS.gravity}  dt 1/${Math.round(1 / PHYSICS.fixedDt)}  iters ${PHYSICS.solverIterations}+${PHYSICS.additionalSolverIterations}`,
    ];
    if (this.held) {
      const s = this.held.shape;
      lines.push(
        `held ${s.recipe.archetype}/${s.rock.name}  m ${s.mass.toFixed(1)} kg  μ ${s.rock.friction}  e ${s.rock.restitution}`,
        `  hull ${s.collisionPoints.length / 3} pts / ${convexHull3D(s.collisionPoints).faces.length} faces  poses ${s.restingPoses.map((p) => ((p.tippingAngle * 180) / Math.PI).toFixed(0) + '°').join(' ')}`,
      );
    }
    if (this.settle) {
      lines.push(`settle t ${this.settle.time.toFixed(2)}  rest ${this.settle.rest.toFixed(2)}  peak ω ${this.settle.peakAngular.toFixed(2)}`);
    }
    if (this.lastReport) {
      const { report: r, risk } = this.lastReport;
      lines.push(
        `last: margin ${(r.margin * 100).toFixed(1)} cm (${(r.marginRatio * 100).toFixed(0)}% of r=${(r.footprintRadius * 100).toFixed(1)} cm)`,
        `  contacts ${r.contactCount}  area ${(r.supportArea * 1e4).toFixed(0)} cm²  slope ${r.slopeDeg.toFixed(1)}°  overhang ${r.overhang.toFixed(2)}`,
        `  risk ${risk.total.toFixed(2)} = m ${risk.margin.toFixed(2)} · o ${risk.overhang.toFixed(2)} · s ${risk.slope.toFixed(2)}  (combo ≥ ${SCORING.comboRiskThreshold})`,
      );
    }
    lines.push(`score ${this.score.score}  combo ${this.score.combo}  placements ${this.score.placements}`);
    return lines;
  }

  replayJSON(): string {
    return JSON.stringify({ seed: this.seed, placements: this.placements });
  }

  /** Replays recorded placements deterministically (same seed, same build). */
  startReplay(data: { seed: number; placements: Placement[] }): void {
    this.fixedSeed = data.seed;
    this.replayQueue = [...data.placements];
    if (this.phase === 'title') this.startGame();
    else this.restart();
  }

  private runReplay(): void {
    const q = this.replayQueue;
    const h = this.held;
    if (!q || !h || q.length === 0) return;
    const next = q[0];
    if (next.level !== h.level) return;
    if (this.sim.physics.stepCount - this.aimStartStep < next.waitSteps) return;
    q.shift();
    this.commitDrop(h, next.pos, next.rot);
    if (q.length === 0) this.replayQueue = null;
  }

  // ------------------------------------------------------------ test API
  /** Resolves on the next phase change (e2e tests). */
  nextPhase(): Promise<void> {
    return new Promise((resolve) => this.resolveWaiters.push(resolve));
  }

  testApi() {
    return {
      phase: () => this.phase,
      score: () => this.score.score,
      level: () => this.level,
      seed: () => this.seed,
      heldReady: () => this.held !== null && this.held.disp.init,
      held: () => (this.held ? { x: this.held.x, z: this.held.z, yaw: this.held.yaw, pose: this.held.pose } : null),
      paused: () => this.paused,
      towerHeight: () => this.towerTopCache - this.sim.baseTop(),
      stones: () => this.sim.activeStones().length,
      setHeld: (x: number, z: number, yaw?: number) => {
        if (!this.held) return false;
        this.held.x = x;
        this.held.z = z;
        if (yaw !== undefined) this.held.yaw = yaw;
        this.held.disp.x = x;
        this.held.disp.z = z;
        return true;
      },
      drop: () => this.drop(),
      start: () => this.startGame(),
      restart: () => this.restart(),
      nextPhase: () => this.nextPhase(),
      replay: () => this.replayJSON(),
    };
  }
}
