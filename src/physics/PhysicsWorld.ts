import RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS } from '../config';

export type Rapier = typeof RAPIER;

let initPromise: Promise<Rapier> | null = null;

/** Loads the Rapier WASM module once (embedded, no network fetch needed). */
export function loadRapier(): Promise<Rapier> {
  if (!initPromise) {
    initPromise = RAPIER.init().then(() => RAPIER);
  }
  return initPromise;
}

export interface ContactForceSample {
  collider1: number;
  collider2: number;
  /** Total force magnitude accumulated over the step (N). */
  force: number;
  direction: { x: number; y: number; z: number };
}

export interface CollisionSample {
  collider1: number;
  collider2: number;
  started: boolean;
}

/**
 * Thin wrapper around a Rapier world: configures the solver from the central
 * config and runs strictly fixed time steps, collecting events per step.
 */
export class PhysicsWorld {
  readonly R: Rapier;
  readonly world: RAPIER.World;
  readonly events: RAPIER.EventQueue;
  readonly dt: number;
  stepCount = 0;
  /** Seconds of simulated time since creation. */
  time = 0;
  lastStepMs = 0;

  constructor(R: Rapier, dt: number = PHYSICS.fixedDt) {
    this.R = R;
    this.dt = dt;
    this.world = new R.World({ x: 0, y: PHYSICS.gravity, z: 0 });
    this.world.timestep = dt;
    const ip = this.world.integrationParameters;
    ip.numSolverIterations = PHYSICS.solverIterations;
    ip.numInternalPgsIterations = PHYSICS.internalPgsIterations;
    ip.lengthUnit = PHYSICS.lengthUnit;
    ip.maxCcdSubsteps = PHYSICS.maxCcdSubsteps;
    this.events = new R.EventQueue(true);
  }

  /**
   * Advance exactly one fixed step. Collision and contact-force events of this
   * step are passed to the callbacks.
   */
  step(onCollision?: (e: CollisionSample) => void, onForce?: (e: ContactForceSample) => void): void {
    const t0 = performance.now();
    this.world.step(this.events);
    this.lastStepMs = performance.now() - t0;
    this.stepCount++;
    this.time += this.dt;
    if (onCollision) {
      this.events.drainCollisionEvents((h1, h2, started) => onCollision({ collider1: h1, collider2: h2, started }));
    }
    if (onForce) {
      this.events.drainContactForceEvents((e) => {
        onForce({
          collider1: e.collider1(),
          collider2: e.collider2(),
          force: e.totalForceMagnitude(),
          direction: e.maxForceDirection(),
        });
      });
    }
    this.events.clear();
  }

  dispose(): void {
    this.events.free();
    this.world.free();
  }
}
