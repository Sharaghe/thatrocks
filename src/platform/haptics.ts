export type HapticKind = 'tick' | 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'failure';

const PATTERNS: Record<HapticKind, number | number[]> = {
  tick: 6,
  light: 10,
  medium: 18,
  heavy: 32,
  success: [12, 50, 18],
  warning: [20, 60, 20],
  failure: [45, 70, 90],
};

/**
 * Vibration feedback where available.
 * - Android / Chrome: navigator.vibrate.
 * - iOS Safari has no Vibration API. Since iOS 18, toggling an
 *   `<input type="checkbox" switch>` plays the system haptic, so we keep a
 *   hidden one and toggle it (best effort; works reliably inside user
 *   gestures, silently does nothing on older iOS).
 */
export class Haptics {
  enabled = true;
  private iosLabel: HTMLLabelElement | null = null;
  private readonly canVibrate: boolean;
  private lastPulse = 0;

  constructor(isIOS: boolean) {
    this.canVibrate = typeof navigator.vibrate === 'function';
    if (!this.canVibrate && isIOS) {
      const label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.cssText = 'position:fixed;left:-100px;top:-100px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      label.appendChild(input);
      document.body.appendChild(label);
      this.iosLabel = label;
    }
  }

  get supported(): boolean {
    return this.canVibrate || this.iosLabel !== null;
  }

  pulse(kind: HapticKind): void {
    if (!this.enabled) return;
    const now = performance.now();
    if (now - this.lastPulse < 45 && kind !== 'failure') return;
    this.lastPulse = now;
    if (this.canVibrate) {
      try {
        navigator.vibrate(PATTERNS[kind]);
      } catch {
        /* ignore */
      }
      return;
    }
    if (this.iosLabel) {
      const repeats = kind === 'failure' ? 3 : kind === 'success' || kind === 'warning' ? 2 : 1;
      for (let i = 0; i < repeats; i++) {
        window.setTimeout(() => this.iosLabel?.click(), i * 90);
      }
    }
  }
}
