export interface DebugToggles {
  colliders: boolean;
  contacts: boolean;
  slowmo: boolean;
}

export interface DebugActions {
  copyReplay(): void;
  toggleChanged(t: DebugToggles): void;
}

/**
 * Developer overlay: FPS/frame timing, physics step cost, body counts, the
 * last stability evaluation, held-stone physical properties, seed and quality.
 * Toggle via the settings, a three-finger tap, the ` key or `?debug`.
 */
export class DebugOverlay {
  readonly toggles: DebugToggles = { colliders: false, contacts: true, slowmo: false };
  private readonly text: HTMLPreElement;
  private visible = false;
  private frames = 0;
  private acc = 0;
  private fps = 0;
  private worstFrame = 0;
  private refresh = 0;

  constructor(
    private readonly el: HTMLElement,
    private readonly actions: DebugActions,
  ) {
    this.text = document.createElement('pre');
    this.text.style.margin = '0';
    el.appendChild(this.text);
    const row = document.createElement('div');
    row.className = 'row';
    const mk = (label: string, key: keyof DebugToggles) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.classList.toggle('on', this.toggles[key]);
      b.addEventListener('click', () => {
        this.toggles[key] = !this.toggles[key];
        b.classList.toggle('on', this.toggles[key]);
        this.actions.toggleChanged(this.toggles);
      });
      row.appendChild(b);
    };
    mk('colliders', 'colliders');
    mk('contacts', 'contacts');
    mk('slow ×0.25', 'slowmo');
    const copy = document.createElement('button');
    copy.textContent = 'copy replay';
    copy.addEventListener('click', () => this.actions.copyReplay());
    row.appendChild(copy);
    el.appendChild(row);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.hidden = !v;
    this.actions.toggleChanged(this.toggles);
  }

  frame(dtMs: number): void {
    this.frames++;
    this.acc += dtMs;
    this.worstFrame = Math.max(this.worstFrame, dtMs);
    if (this.acc >= 500) {
      this.fps = (this.frames * 1000) / this.acc;
      this.frames = 0;
      this.acc = 0;
    }
  }

  /** `lines` is evaluated lazily, ~4×/s, only while visible. */
  update(dtMs: number, lines: () => string[]): void {
    if (!this.visible) return;
    this.refresh += dtMs;
    if (this.refresh < 250) return;
    this.refresh = 0;
    this.text.textContent = [`fps ${this.fps.toFixed(0)}  worst ${this.worstFrame.toFixed(1)} ms`, ...lines()].join('\n');
    this.worstFrame = 0;
  }
}
