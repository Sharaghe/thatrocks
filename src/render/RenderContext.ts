import * as THREE from 'three';
import { ADAPTIVE, QUALITY, type QualitySettings, type QualityTier } from '../config';

/**
 * Owns the WebGL renderer, scene and camera: pixel-ratio policy, resizing
 * (including iOS Safari's dynamic toolbars and orientation changes) and the
 * adaptive resolution controller.
 */
export class RenderContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  quality: QualitySettings;
  /** Multiplier on the pixel ratio chosen by the adaptive controller. */
  resolutionScale = 1;
  width = 1;
  height = 1;
  private frameTimes: number[] = [];
  private sampleClock = 0;
  private resizeListeners: ((w: number, h: number) => void)[] = [];
  contextLost = false;

  constructor(readonly canvas: HTMLCanvasElement, tier: QualityTier) {
    this.quality = QUALITY[tier];
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.quality.antialias,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false,
    });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.95;
    r.shadowMap.enabled = true;
    r.shadowMap.type = this.quality.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400);

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
    });

    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    // iOS reports the new size a moment after the orientation event fires.
    window.addEventListener('orientationchange', () => {
      onResize();
      setTimeout(onResize, 120);
      setTimeout(onResize, 400);
    });
    this.resize();
  }

  onResize(listener: (w: number, h: number) => void): void {
    this.resizeListeners.push(listener);
  }

  get pixelRatio(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    return Math.max(0.75, dpr * this.resolutionScale);
  }

  resize(): void {
    const vv = window.visualViewport;
    const w = Math.max(1, Math.round(vv ? vv.width : window.innerWidth));
    const h = Math.max(1, Math.round(vv ? vv.height : window.innerHeight));
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const l of this.resizeListeners) l(w, h);
  }

  /**
   * Adaptive resolution: lowers the render resolution when frames take too
   * long and slowly raises it again when there is headroom. `cpuMs` is the
   * time spent in our own frame code, used to tell a vsync cap (iOS Low Power
   * Mode, 30 fps) from real overload.
   */
  trackFrame(frameMs: number, cpuMs: number): void {
    this.frameTimes.push(frameMs);
    this.sampleClock += frameMs / 1000;
    if (this.sampleClock < ADAPTIVE.sampleSeconds) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.frameTimes = [];
    this.sampleClock = 0;
    const throttled = median > 30 && median < 36 && cpuMs < 10; // steady 30 fps cap
    if (!throttled && median > ADAPTIVE.downshiftMs && this.resolutionScale > ADAPTIVE.minResolutionScale) {
      this.resolutionScale = Math.max(ADAPTIVE.minResolutionScale, this.resolutionScale - ADAPTIVE.resolutionStep);
      this.resize();
    } else if (median < ADAPTIVE.upshiftMs && this.resolutionScale < 1) {
      this.resolutionScale = Math.min(1, this.resolutionScale + ADAPTIVE.resolutionStep / 2);
      this.resize();
    }
  }

  render(): void {
    if (this.contextLost) return;
    this.renderer.render(this.scene, this.camera);
  }
}
