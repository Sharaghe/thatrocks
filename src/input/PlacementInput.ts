/**
 * Touch / mouse / keyboard input for placing stones.
 *
 * Touch (mobile-first):
 *   1 finger drag      → move the stone (relative, trackpad-like: the finger
 *                         never covers the stone; slow drags are finer)
 *   2 finger twist     → rotate the stone
 *   2 finger pinch     → zoom
 *   2 finger side pan  → orbit the camera
 *   3 finger tap       → toggle debug overlay
 * Two-finger gestures lock to whichever component (twist/pinch/pan) clearly
 * dominates first, so a twist never accidentally zooms.
 *
 * Mouse: left drag move · right drag orbit · wheel rotate · ctrl/⌘/shift+wheel zoom.
 * Keys: arrows/WASD move · Q/E rotate · Z/X orbit · F flip · Space drop · R restart · ` debug.
 */
export interface InputSink {
  moveBy(dxPx: number, dyPx: number, speedPxPerSec: number): void;
  rotateBy(radians: number): void;
  orbitBy(radians: number): void;
  zoomBy(factor: number): void;
  drop(): void;
  flip(): void;
  restart(): void;
  togglePause(): void;
  toggleDebug(): void;
  /** Any user gesture (used to unlock audio on iOS). */
  gesture(): void;
}

interface TrackedPointer {
  x: number;
  y: number;
  t: number;
  type: string;
  button: number;
}

type Lock = 'none' | 'twist' | 'pinch' | 'pan';

const LOCK_THRESHOLD_PX = 14;
const MOUSE_ORBIT_PER_PX = 0.006;
const TOUCH_ORBIT_PER_PX = 0.009;

export class PlacementInput {
  enabled = true;
  private pointers = new Map<number, TrackedPointer>();
  private lock: Lock = 'none';
  private lockAccum = { twist: 0, pinch: 0, pan: 0 };
  private prevTwo: { cx: number; cy: number; dist: number; angle: number } | null = null;
  private keys = new Set<string>();
  private threeFingerStart = 0;
  private maxPointers = 0;

  constructor(
    private readonly el: HTMLElement,
    private readonly sink: InputSink,
  ) {
    el.addEventListener('pointerdown', this.onDown, { passive: false });
    window.addEventListener('pointermove', this.onMove, { passive: false });
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private onDown = (e: PointerEvent) => {
    e.preventDefault();
    this.sink.gesture();
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp, type: e.pointerType, button: e.button });
    this.maxPointers = Math.max(this.maxPointers, this.pointers.size);
    if (this.pointers.size === 2) this.beginTwo();
    if (this.pointers.size === 3) this.threeFingerStart = e.timeStamp;
  };

  private onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    const dt = Math.max(1, e.timeStamp - p.t) / 1000;
    p.x = e.clientX;
    p.y = e.clientY;
    p.t = e.timeStamp;
    if (!this.enabled) return;
    if (this.pointers.size === 1) {
      if (p.type === 'mouse' && (p.button === 2 || p.button === 1)) {
        this.sink.orbitBy(-dx * MOUSE_ORBIT_PER_PX);
        if (Math.abs(dy) > 0) this.sink.zoomBy(Math.exp(dy * 0.004));
      } else if (this.maxPointers === 1) {
        this.sink.moveBy(dx, dy, Math.hypot(dx, dy) / dt);
      }
    } else if (this.pointers.size === 2) {
      this.updateTwo();
    }
  };

  private onUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    if (this.pointers.size === 3 && e.timeStamp - this.threeFingerStart < 350) this.sink.toggleDebug();
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) {
      this.prevTwo = null;
      this.lock = 'none';
    }
    if (this.pointers.size === 0) this.maxPointers = 0;
    this.sink.gesture();
  };

  private twoState() {
    const [a, b] = [...this.pointers.values()];
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  private beginTwo() {
    this.prevTwo = this.twoState();
    this.lock = 'none';
    this.lockAccum = { twist: 0, pinch: 0, pan: 0 };
  }

  private updateTwo() {
    if (!this.prevTwo) return this.beginTwo();
    const s = this.twoState();
    let dAngle = s.angle - this.prevTwo.angle;
    if (dAngle > Math.PI) dAngle -= Math.PI * 2;
    if (dAngle < -Math.PI) dAngle += Math.PI * 2;
    const dDist = s.dist - this.prevTwo.dist;
    const dCx = s.cx - this.prevTwo.cx;
    const radius = Math.max(20, s.dist / 2);
    if (this.lock === 'none') {
      this.lockAccum.twist += Math.abs(dAngle) * radius;
      this.lockAccum.pinch += Math.abs(dDist);
      this.lockAccum.pan += Math.abs(dCx);
      const { twist, pinch, pan } = this.lockAccum;
      const max = Math.max(twist, pinch, pan);
      if (max > LOCK_THRESHOLD_PX) this.lock = max === twist ? 'twist' : max === pinch ? 'pinch' : 'pan';
    }
    if (this.lock === 'twist') this.sink.rotateBy(-dAngle);
    else if (this.lock === 'pinch' && this.prevTwo.dist > 1) this.sink.zoomBy(this.prevTwo.dist / s.dist);
    else if (this.lock === 'pan') this.sink.orbitBy(-dCx * TOUCH_ORBIT_PER_PX);
    this.prevTwo = s;
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.enabled) return;
    // Trackpad pinch arrives as ctrl+wheel.
    if (e.ctrlKey || e.metaKey || e.shiftKey) this.sink.zoomBy(Math.exp(e.deltaY * 0.0025));
    else this.sink.rotateBy(e.deltaY * 0.0025);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    this.sink.gesture();
    if (e.repeat && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) return;
    this.keys.add(e.code);
    switch (e.code) {
      case 'Space':
      case 'Enter':
        e.preventDefault();
        if (this.enabled) this.sink.drop();
        break;
      case 'KeyF':
        if (this.enabled) this.sink.flip();
        break;
      case 'KeyR':
        this.sink.restart();
        break;
      case 'Escape':
      case 'KeyP':
        this.sink.togglePause();
        break;
      case 'Backquote':
        this.sink.toggleDebug();
        break;
      default:
        break;
    }
  };

  /** Continuous keyboard actions. */
  update(dt: number): void {
    if (!this.enabled || this.keys.size === 0) return;
    const k = this.keys;
    const speed = 260 * dt; // px-equivalent per frame
    let dx = 0;
    let dy = 0;
    if (k.has('ArrowLeft') || k.has('KeyA')) dx -= speed;
    if (k.has('ArrowRight') || k.has('KeyD')) dx += speed;
    if (k.has('ArrowUp') || k.has('KeyW')) dy -= speed;
    if (k.has('ArrowDown') || k.has('KeyS')) dy += speed;
    if (dx || dy) this.sink.moveBy(dx, dy, 250);
    if (k.has('KeyQ')) this.sink.rotateBy(-1.6 * dt);
    if (k.has('KeyE')) this.sink.rotateBy(1.6 * dt);
    if (k.has('KeyZ')) this.sink.orbitBy(1.2 * dt);
    if (k.has('KeyX')) this.sink.orbitBy(-1.2 * dt);
  }
}

/**
 * iOS Safari: block page scrolling, rubber-banding, pinch-zoom and
 * double-tap-zoom everywhere except in scrollable panels.
 */
export function lockPageGestures(): void {
  const allowScroll = (el: EventTarget | null) => el instanceof Element && el.closest('[data-scrollable]') !== null;
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!allowScroll(e.target)) e.preventDefault();
    },
    { passive: false },
  );
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  let lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now();
      if (now - lastTouchEnd < 320 && !allowScroll(e.target)) e.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false },
  );
}
