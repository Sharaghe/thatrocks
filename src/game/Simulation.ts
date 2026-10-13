import type RAPIER from '@dimforge/rapier3d-compat';
import { GAMEPLAY, PHYSICS, WORLD } from '../config';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import type { Quat, StoneShape, Vec3 } from '../stones/StoneShape';
import type { Vec2 } from '../core/geometry2d';
import { analyzeStability, type StabilityReport, type SupportContact } from './Stability';
import { convexHull3D } from '../stones/hull3d';

export interface StoneBody {
  id: number;
  level: number;
  shape: StoneShape;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** Pose before / after the latest physics step (for render interpolation). */
  prevPos: Vec3;
  prevRot: Quat;
  pos: Vec3;
  rot: Quat;
  /** Linear velocity before the latest step (impact speed estimation). */
  preVel: Vec3;
  dropPos: Vec3;
  dropRot: Quat;
  groundContact: boolean;
  submerged: boolean;
  removed: boolean;
}

export type ContactKind = 'stone' | 'base' | 'ground';

export interface ImpactEvent {
  stone: StoneBody;
  other: StoneBody | null;
  kind: ContactKind;
  /** Normal approach speed before the impact (m/s). */
  speed: number;
  position: Vec3;
}

export interface SplashEvent {
  stone: StoneBody;
  speed: number;
  position: Vec3;
}

export interface StepReport {
  impacts: ImpactEvent[];
  splashes: SplashEvent[];
  groundTouches: StoneBody[];
  outOfBounds: StoneBody[];
}

export interface LandingInfo {
  /** Body-centre height at first contact. */
  y: number;
  contact: Vec3;
  kind: ContactKind;
}

export interface MotionSummary {
  maxLinear: number;
  maxAngular: number;
  awake: number;
}

/**
 * Physics-side model of the game: base rock, terrain, stones, events,
 * resting/failure detection and stability measurement. Has no rendering or
 * DOM dependencies, so it runs headless in tests.
 */
export class Simulation {
  readonly physics: PhysicsWorld;
  readonly stones: StoneBody[] = [];
  private byCollider = new Map<number, StoneBody>();
  private groundColliders = new Set<number>();
  private pairCooldown = new Map<string, number>();
  baseShape: StoneShape | null = null;
  basePosition: Vec3 = [0, 0, 0];
  private nextId = 0;

  constructor(physics: PhysicsWorld) {
    this.physics = physics;
  }

  get R() {
    return this.physics.R;
  }

  get world() {
    return this.physics.world;
  }

  /** Terrain/riverbed collision mesh. */
  setGroundMesh(positions: Float32Array, indices: Uint32Array): void {
    const desc = this.R.ColliderDesc.trimesh(positions, indices)
      .setFriction(PHYSICS.groundFriction)
      .setRestitution(PHYSICS.groundRestitution)
      .setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS);
    const c = this.world.createCollider(desc);
    this.groundColliders.add(c.handle);
  }

  /** Flat ground plane (used by tests). */
  setFlatGround(y: number): void {
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed().setTranslation(0, y - 0.5, 0));
    const c = this.world.createCollider(
      this.R.ColliderDesc.cuboid(40, 0.5, 40).setFriction(PHYSICS.groundFriction).setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    this.groundColliders.add(c.handle);
  }

  /** Fixed base rock; positioned so that its highest point sits at `topY`. */
  setBase(shape: StoneShape, topY: number = WORLD.baseTop): void {
    let maxY = -Infinity;
    for (let i = 1; i < shape.positions.length; i += 3) maxY = Math.max(maxY, shape.positions[i]);
    this.basePosition = [0, topY - maxY, 0];
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.fixed().setTranslation(this.basePosition[0], this.basePosition[1], this.basePosition[2]),
    );
    // Static trimesh of the hull: triangle features give robust contacts.
    const hull = convexHull3D(shape.collisionPoints);
    const indices = new Uint32Array(hull.faces.length * 3);
    hull.faces.forEach((f, i) => indices.set([f.a, f.b, f.c], i * 3));
    const desc = this.R.ColliderDesc.trimesh(shape.collisionPoints, indices);
    desc.setFriction(shape.rock.friction).setRestitution(shape.rock.restitution).setContactSkin(PHYSICS.contactSkin);
    this.world.createCollider(desc, body);
    this.baseShape = shape;
  }

  /** Collision shape matching a stone (used for landing prediction). */
  createCastShape(shape: StoneShape): RAPIER.Shape {
    return shape.borderRadius > 0
      ? new this.R.RoundConvexPolyhedron(shape.collisionPoints, null, shape.borderRadius)
      : new this.R.ConvexPolyhedron(shape.collisionPoints, null);
  }

  private hullDesc(shape: StoneShape): RAPIER.ColliderDesc {
    const desc =
      shape.borderRadius > 0
        ? this.R.ColliderDesc.roundConvexHull(shape.collisionPoints, shape.borderRadius)
        : this.R.ColliderDesc.convexHull(shape.collisionPoints);
    if (!desc) throw new Error('Convex hull construction failed');
    return desc;
  }

  addStone(shape: StoneShape, pos: Vec3, rot: Quat, level: number): StoneBody {
    const R = this.R;
    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(pos[0], pos[1], pos[2])
      .setRotation({ x: rot[0], y: rot[1], z: rot[2], w: rot[3] })
      .setLinearDamping(PHYSICS.linearDamping)
      .setAngularDamping(PHYSICS.angularDamping)
      .setCcdEnabled(true)
      .setAdditionalSolverIterations(PHYSICS.additionalSolverIterations)
      .setCanSleep(true);
    const body = this.world.createRigidBody(bodyDesc);
    const colDesc = this.hullDesc(shape);
    const [ix, iy, iz] = shape.principalInertia;
    const f = shape.inertiaFrame;
    colDesc
      .setMassProperties(shape.mass, { x: 0, y: 0, z: 0 }, { x: ix, y: iy, z: iz }, { x: f[0], y: f[1], z: f[2], w: f[3] })
      .setFriction(shape.rock.friction)
      .setRestitution(shape.rock.restitution)
      .setContactSkin(PHYSICS.contactSkin)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS | R.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(shape.mass * Math.abs(PHYSICS.gravity) * PHYSICS.impactForceThresholdWeights);
    const collider = this.world.createCollider(colDesc, body);
    const stone: StoneBody = {
      id: this.nextId++,
      level,
      shape,
      body,
      collider,
      prevPos: [...pos],
      prevRot: [...rot],
      pos: [...pos],
      rot: [...rot],
      preVel: [0, 0, 0],
      dropPos: [...pos],
      dropRot: [...rot],
      groundContact: false,
      submerged: false,
      removed: false,
    };
    this.stones.push(stone);
    this.byCollider.set(collider.handle, stone);
    return stone;
  }

  removeStone(stone: StoneBody): void {
    if (stone.removed) return;
    stone.removed = true;
    this.byCollider.delete(stone.collider.handle);
    this.world.removeRigidBody(stone.body);
  }

  clearStones(): void {
    for (const s of this.stones) this.removeStone(s);
    this.stones.length = 0;
    this.pairCooldown.clear();
    this.nextId = 0;
  }

  activeStones(): StoneBody[] {
    return this.stones.filter((s) => !s.removed);
  }

  /** One fixed physics step with event processing. */
  step(): StepReport {
    const report: StepReport = { impacts: [], splashes: [], groundTouches: [], outOfBounds: [] };
    for (const s of this.stones) {
      if (s.removed) continue;
      s.prevPos[0] = s.pos[0];
      s.prevPos[1] = s.pos[1];
      s.prevPos[2] = s.pos[2];
      s.prevRot[0] = s.rot[0];
      s.prevRot[1] = s.rot[1];
      s.prevRot[2] = s.rot[2];
      s.prevRot[3] = s.rot[3];
      const v = s.body.linvel();
      s.preVel[0] = v.x;
      s.preVel[1] = v.y;
      s.preVel[2] = v.z;
    }
    const now = this.physics.time;
    this.physics.step(
      (e) => {
        if (!e.started) return;
        const a = this.byCollider.get(e.collider1);
        const b = this.byCollider.get(e.collider2);
        if (a && this.groundColliders.has(e.collider2) && !a.groundContact) {
          a.groundContact = true;
          report.groundTouches.push(a);
        }
        if (b && this.groundColliders.has(e.collider1) && !b.groundContact) {
          b.groundContact = true;
          report.groundTouches.push(b);
        }
      },
      (e) => {
        const a = this.byCollider.get(e.collider1);
        const b = this.byCollider.get(e.collider2);
        const stone = a ?? b;
        if (!stone) return;
        const other = a && b ? (stone === a ? b : a) : null;
        const otherHandle = stone === a ? e.collider2 : e.collider1;
        const kind: ContactKind = other ? 'stone' : this.groundColliders.has(otherHandle) ? 'ground' : 'base';
        const d = e.direction;
        const v1 = stone.preVel;
        const v2 = other ? other.preVel : [0, 0, 0];
        const speed = Math.abs((v1[0] - v2[0]) * d.x + (v1[1] - v2[1]) * d.y + (v1[2] - v2[2]) * d.z);
        if (speed < 0.06) return;
        const key = e.collider1 < e.collider2 ? `${e.collider1}:${e.collider2}` : `${e.collider2}:${e.collider1}`;
        const last = this.pairCooldown.get(key) ?? -1;
        if (now - last < 0.07) return;
        this.pairCooldown.set(key, now);
        const t = stone.body.translation();
        report.impacts.push({ stone, other, kind, speed, position: [t.x, t.y, t.z] });
      },
    );

    for (const s of this.stones) {
      if (s.removed) continue;
      const t = s.body.translation();
      const r = s.body.rotation();
      s.pos[0] = t.x;
      s.pos[1] = t.y;
      s.pos[2] = t.z;
      s.rot[0] = r.x;
      s.rot[1] = r.y;
      s.rot[2] = r.z;
      s.rot[3] = r.w;
      if (!s.submerged && t.y < WORLD.waterLevel) {
        s.submerged = true;
        const v = s.body.linvel();
        report.splashes.push({ stone: s, speed: Math.hypot(v.x, v.y, v.z), position: [t.x, WORLD.waterLevel, t.z] });
        // Water drag: stones sink slowly and stop tumbling.
        s.body.setLinearDamping(2.2);
        s.body.setAngularDamping(1.6);
      }
      if (t.y < GAMEPLAY.outOfBoundsY || Math.hypot(t.x, t.z) > GAMEPLAY.outOfBoundsRadius) {
        report.outOfBounds.push(s);
      }
    }
    for (const s of report.outOfBounds) this.removeStone(s);
    return report;
  }

  motion(): MotionSummary {
    let maxLinear = 0;
    let maxAngular = 0;
    let awake = 0;
    for (const s of this.stones) {
      if (s.removed || s.body.isSleeping()) continue;
      awake++;
      const v = s.body.linvel();
      const w = s.body.angvel();
      maxLinear = Math.max(maxLinear, Math.hypot(v.x, v.y, v.z));
      maxAngular = Math.max(maxAngular, Math.hypot(w.x, w.y, w.z));
    }
    return { maxLinear, maxAngular, awake };
  }

  /** Highest point of all resting stones (or the base top). */
  towerTop(): number {
    let top = this.baseTop();
    for (const s of this.stones) {
      if (s.removed || s.groundContact) continue;
      top = Math.max(top, this.stoneTop(s));
    }
    return top;
  }

  baseTop(): number {
    if (!this.baseShape) return WORLD.baseTop;
    let maxY = -Infinity;
    for (let i = 1; i < this.baseShape.positions.length; i += 3) maxY = Math.max(maxY, this.baseShape.positions[i]);
    return maxY + this.basePosition[1];
  }

  stoneTop(s: StoneBody): number {
    const pts = s.shape.collisionPoints;
    const [qx, qy, qz, qw] = s.rot;
    let maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      const y = rotateY(pts[i], pts[i + 1], pts[i + 2], qx, qy, qz, qw);
      if (y > maxY) maxY = y;
    }
    return maxY + s.pos[1] + s.shape.borderRadius;
  }

  /** Predict where a stone at (x, z) with rotation `rot` first touches the tower when lowered. */
  castLanding(castShape: RAPIER.Shape, x: number, z: number, rot: Quat, fromY: number): LandingInfo | null {
    const maxToi = fromY + 4;
    const hit = this.world.castShape(
      { x, y: fromY, z },
      { x: rot[0], y: rot[1], z: rot[2], w: rot[3] },
      { x: 0, y: -1, z: 0 },
      castShape,
      0,
      maxToi,
      true,
    );
    if (!hit) return null;
    const y = fromY - hit.time_of_impact;
    const w = hit.witness2;
    const c = rotateVec(w.x, w.y, w.z, rot[0], rot[1], rot[2], rot[3]);
    const other = this.byCollider.get(hit.collider.handle);
    const kind: ContactKind = other ? 'stone' : this.groundColliders.has(hit.collider.handle) ? 'ground' : 'base';
    return { y, contact: [x + c[0], y + c[1], z + c[2]], kind };
  }

  /** Contacts between a stone and everything it touches, with normals oriented into the stone. */
  contactsOf(stone: StoneBody): SupportContact[] {
    const contacts: SupportContact[] = [];
    this.world.contactPairsWith(stone.collider, (other) => {
      const supporter = this.byCollider.get(other.handle);
      const supporterId = supporter ? supporter.id : this.groundColliders.has(other.handle) ? -2 : -1;
      this.world.contactPair(stone.collider, other, (manifold, flipped) => {
        const n = manifold.normal();
        const s = flipped ? 1 : -1;
        const normal = { x: n.x * s, y: n.y * s, z: n.z * s };
        for (let i = 0; i < manifold.numSolverContacts(); i++) {
          const p = manifold.solverContactPoint(i);
          contacts.push({ point: { x: p.x, y: p.y, z: p.z }, normal, supporter: supporterId });
        }
      });
    });
    return contacts;
  }

  /** Measure how stable a stone currently rests (from real contact data). */
  analyze(stone: StoneBody): StabilityReport {
    const contacts = this.contactsOf(stone);
    const footprint = this.footprint(stone);
    // Supporters' centre of mass and size
    const supporterIds = new Set(contacts.filter((c) => c.normal.y > 0.25).map((c) => c.supporter));
    let supporterCom: Vec2 | null = null;
    let supporterRadius = 0.3;
    if (supporterIds.size) {
      let mx = 0;
      let mz = 0;
      let m = 0;
      let radius = 0;
      for (const id of supporterIds) {
        const s = this.stones.find((st) => st.id === id && !st.removed);
        if (s) {
          mx += s.pos[0] * s.shape.mass;
          mz += s.pos[2] * s.shape.mass;
          m += s.shape.mass;
          radius = Math.max(radius, footprintRadius(this.footprint(s)));
        } else if (id === -1) {
          mx += this.basePosition[0] * 1e4;
          mz += this.basePosition[2] * 1e4;
          m += 1e4;
          radius = Math.max(radius, WORLD.baseRadius);
        }
      }
      if (m > 0) {
        supporterCom = { x: mx / m, y: mz / m };
        supporterRadius = radius;
      }
    }
    return analyzeStability({
      com: { x: stone.pos[0], y: stone.pos[1], z: stone.pos[2] },
      contacts,
      footprint,
      supporterCom,
      supporterRadius,
    });
  }

  /** Horizontal projection of a stone's hull (world xz). */
  footprint(stone: StoneBody): Vec2[] {
    const pts = stone.shape.collisionPoints;
    const [qx, qy, qz, qw] = stone.rot;
    const out: Vec2[] = [];
    for (let i = 0; i < pts.length; i += 3) {
      const r = rotateVec(pts[i], pts[i + 1], pts[i + 2], qx, qy, qz, qw);
      out.push({ x: r[0] + stone.pos[0], y: r[2] + stone.pos[2] });
    }
    return out;
  }

  /** Total horizontal offset of the tower's COM from the base centre (m). */
  towerLean(): number {
    let mx = 0;
    let mz = 0;
    let m = 0;
    for (const s of this.stones) {
      if (s.removed || s.groundContact) continue;
      mx += s.pos[0] * s.shape.mass;
      mz += s.pos[2] * s.shape.mass;
      m += s.shape.mass;
    }
    if (m === 0) return 0;
    return Math.hypot(mx / m - this.basePosition[0], mz / m - this.basePosition[2]);
  }

  /** Rapier debug line buffers (collider wireframes). */
  debugLines(): { vertices: Float32Array; colors: Float32Array } {
    return this.world.debugRender();
  }

  dispose(): void {
    this.physics.dispose();
  }
}

function footprintRadius(points: Vec2[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.y);
    maxZ = Math.max(maxZ, p.y);
  }
  return Math.max(0.05, Math.sqrt((maxX - minX) * (maxZ - minZ)) / 2);
}

export function rotateVec(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): Vec3 {
  // v' = v + 2w(q×v) + 2 q×(q×v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}

function rotateY(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): number {
  const tx = 2 * (qy * z - qz * y);
  const tz = 2 * (qx * y - qy * x);
  return y + qw * (2 * (qz * x - qx * z)) + (qz * tx - qx * tz);
}
