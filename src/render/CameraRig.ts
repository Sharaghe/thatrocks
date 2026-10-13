import * as THREE from 'three';
import { CAMERA } from '../config';
import { clamp, damp, dampAngle, degToRad } from '../core/math';

export type CameraMode = 'title' | 'aim' | 'settle' | 'collapse' | 'gameover';

export interface CameraTargets {
  /** Height of the working point (held stone or tower top). */
  workY: number;
  /** Height of the tower above the base top (m). */
  towerHeight: number;
  baseY: number;
  axis: THREE.Vector3;
  mode: CameraMode;
}

/**
 * Dynamic framing camera: keeps the working height (held stone / tower top)
 * in the upper half of the screen, grows the framed span with the tower,
 * adapts to portrait/landscape, supports user orbit + zoom and adds a
 * restrained, trauma-based shake on impacts.
 */
export class CameraRig {
  azimuth = 0;
  targetAzimuth = 0;
  zoom = 1;
  private focus = new THREE.Vector3(0, 0.6, 0);
  private distance = 3;
  private pitch = degToRad(CAMERA.pitchDeg);
  private trauma = 0;
  private time = 0;
  private titleSpin = 0;
  reducedMotion = false;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  orbit(deltaRadians: number): void {
    this.targetAzimuth += deltaRadians;
  }

  zoomBy(factor: number): void {
    this.zoom = clamp(this.zoom * factor, CAMERA.zoomMin, CAMERA.zoomMax);
  }

  addShake(amount: number): void {
    if (this.reducedMotion) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Horizontal unit vectors of the current view (for camera-relative input). */
  basis(right: THREE.Vector3, forward: THREE.Vector3): void {
    forward.set(Math.sin(this.azimuth), 0, Math.cos(this.azimuth));
    right.set(-Math.cos(this.azimuth), 0, Math.sin(this.azimuth));
  }

  /** Snap without smoothing (restart). */
  reset(targets: CameraTargets): void {
    this.update(0, targets, true);
  }

  update(dt: number, t: CameraTargets, snap = false): void {
    this.time += dt;
    const cam = this.camera;
    const aspect = cam.aspect;
    const portrait = aspect < 1;
    const fov = portrait ? CAMERA.fovPortrait : CAMERA.fovLandscape;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = snap ? fov : damp(cam.fov, fov, 6, dt);
      cam.updateProjectionMatrix();
    }

    let span = clamp(CAMERA.minSpan + t.towerHeight * CAMERA.spanPerMetre, CAMERA.minSpan, CAMERA.maxSpan);
    let focusY = t.workY - span * (CAMERA.focusBias - 0.5);
    let pitch = degToRad(CAMERA.pitchDeg);
    let azimuthTarget = this.targetAzimuth;
    let followRate: number = CAMERA.followDamping;

    switch (t.mode) {
      case 'title':
        span = 2.8;
        focusY = t.baseY + 0.75;
        pitch = degToRad(7);
        this.titleSpin += dt * 0.05;
        azimuthTarget = this.targetAzimuth + Math.sin(this.titleSpin) * 0.35;
        followRate = 1.5;
        break;
      case 'collapse':
        span = clamp(t.towerHeight + 1.6, 2.2, 5);
        focusY = t.baseY + t.towerHeight * 0.4;
        pitch = degToRad(14);
        followRate = 2.2;
        break;
      case 'gameover':
        span = clamp(t.towerHeight + 2, 2.6, 5.5);
        focusY = t.baseY + t.towerHeight * 0.35;
        pitch = degToRad(16);
        this.targetAzimuth += dt * 0.07;
        azimuthTarget = this.targetAzimuth;
        followRate = 1.2;
        break;
      case 'settle':
        followRate = 2.0;
        break;
      default:
        break;
    }
    span *= this.zoom;

    const tanHalf = Math.tan(degToRad(cam.fov) / 2);
    let distance = span / 2 / tanHalf;
    // Narrow screens: keep the full placement range visible horizontally.
    const minH = CAMERA.minHorizontalSpan * this.zoom;
    distance = Math.max(distance, minH / 2 / (tanHalf * aspect));

    if (snap) {
      this.focus.set(t.axis.x, focusY, t.axis.z);
      this.distance = distance;
      this.azimuth = azimuthTarget;
      this.pitch = pitch;
    } else {
      this.focus.x = damp(this.focus.x, t.axis.x, followRate, dt);
      this.focus.y = damp(this.focus.y, focusY, followRate, dt);
      this.focus.z = damp(this.focus.z, t.axis.z, followRate, dt);
      this.distance = damp(this.distance, distance, followRate, dt);
      this.azimuth = dampAngle(this.azimuth, azimuthTarget, CAMERA.orbitDamping, dt);
      this.pitch = damp(this.pitch, pitch, 2.5, dt);
    }

    const cp = Math.cos(this.pitch);
    cam.position.set(
      this.focus.x - Math.sin(this.azimuth) * cp * this.distance,
      this.focus.y + Math.sin(this.pitch) * this.distance,
      this.focus.z - Math.cos(this.azimuth) * cp * this.distance,
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(this.focus);

    // Trauma-based shake (squared for a soft onset), decays quickly.
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma * CAMERA.shakeMax;
      const f = CAMERA.shakeFrequency;
      const tt = this.time * f;
      cam.position.x += s * (Math.sin(tt * 1.13) + Math.sin(tt * 2.71) * 0.5);
      cam.position.y += s * (Math.sin(tt * 1.37 + 1.3) + Math.sin(tt * 3.07) * 0.5);
      cam.position.z += s * (Math.sin(tt * 0.97 + 2.1) + Math.sin(tt * 2.33) * 0.5);
      cam.rotateZ(s * 0.6 * Math.sin(tt * 1.7));
      this.trauma = Math.max(0, this.trauma - CAMERA.shakeDecay * dt);
    }
  }

  get focusPoint(): THREE.Vector3 {
    return this.focus;
  }
}
