import type { QualityChoice, Settings } from '../storage/ScoreStore';

export type ScreenId = 'loading' | 'title' | 'game' | 'over' | 'pause' | 'none';

export interface HudCallbacks {
  start(): void;
  again(): void;
  menu(): void;
  pause(): void;
  resume(): void;
  restart(): void;
  drop(): void;
  flip(): void;
  /** Rotate-button hold state: -1 left, 1 right, 0 released. */
  rotateHold(direction: -1 | 0 | 1): void;
  rotateStep(direction: -1 | 1): void;
  settingsChanged(patch: Partial<Settings>): void;
  fullscreen(): void;
  uiTap(): void;
}

export interface GameOverInfo {
  score: number;
  height: number;
  stones: number;
  maxCombo: number;
  best: number;
  newBest: boolean;
  newBestHeight: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** DOM HUD, screens and settings. Rendering-agnostic. */
export class Hud {
  private readonly screens = {
    loading: $('screen-loading'),
    title: $('screen-title'),
    over: $('screen-over'),
    pause: $('screen-pause'),
  };
  private readonly hud = $('hud');
  private readonly score = $('score');
  private readonly height = $('height');
  private readonly combo = $('combo');
  private readonly hint = $('hint');
  private readonly controls = $('controls');
  private readonly popups = $('popups');
  private readonly slowmo = $('slowmo');
  private readonly drop = $<HTMLButtonElement>('btn-drop');
  private hintTimer = 0;
  private shownScore = 0;
  private targetScore = 0;
  private lastPausedFromTitle = false;

  constructor(private readonly cb: HudCallbacks) {
    const tap = (id: string, fn: () => void) =>
      $(id).addEventListener('click', (e) => {
        e.preventDefault();
        cb.uiTap();
        fn();
      });
    tap('btn-start', () => cb.start());
    tap('btn-again', () => cb.again());
    tap('btn-menu', () => cb.menu());
    tap('btn-pause', () => cb.pause());
    tap('btn-resume', () => cb.resume());
    tap('btn-restart', () => cb.restart());
    tap('btn-quit', () => cb.menu());
    tap('btn-title-settings', () => {
      this.lastPausedFromTitle = true;
      this.show('pause');
    });
    tap('btn-fullscreen', () => cb.fullscreen());

    // Drop fires on pointerdown for minimal latency; flip on click.
    this.drop.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cb.drop();
    });
    tap('btn-flip', () => cb.flip());
    this.bindRotate('btn-rot-left', -1);
    this.bindRotate('btn-rot-right', 1);

    const sound = $<HTMLInputElement>('set-sound');
    const haptics = $<HTMLInputElement>('set-haptics');
    const quality = $<HTMLSelectElement>('set-quality');
    const debug = $<HTMLInputElement>('set-debug');
    sound.addEventListener('change', () => cb.settingsChanged({ sound: sound.checked }));
    haptics.addEventListener('change', () => cb.settingsChanged({ haptics: haptics.checked }));
    quality.addEventListener('change', () => cb.settingsChanged({ quality: quality.value as QualityChoice }));
    debug.addEventListener('change', () => cb.settingsChanged({ debug: debug.checked }));
  }

  /** Rotate buttons: tap = 15° step, hold = continuous rotation. */
  private bindRotate(id: string, dir: -1 | 1) {
    const el = $(id);
    let holdTimer = 0;
    let holding = false;
    const release = () => {
      window.clearTimeout(holdTimer);
      el.classList.remove('held');
      if (holding) this.cb.rotateHold(0);
      holding = false;
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cb.uiTap();
      el.classList.add('held');
      this.cb.rotateStep(dir);
      holdTimer = window.setTimeout(() => {
        holding = true;
        this.cb.rotateHold(dir);
      }, 260);
    });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
  }

  get pausedFromTitle(): boolean {
    return this.lastPausedFromTitle;
  }

  show(screen: ScreenId): void {
    if (screen !== 'pause') this.lastPausedFromTitle = false;
    this.screens.loading.hidden = screen !== 'loading';
    this.screens.title.hidden = screen !== 'title';
    this.screens.over.hidden = screen !== 'over';
    this.screens.pause.hidden = screen !== 'pause';
    this.hud.hidden = !(screen === 'game' || screen === 'pause' || screen === 'none');
  }

  setLoading(progress: number, text: string): void {
    $('loader-bar').style.width = `${Math.round(progress * 100)}%`;
    $('loader-text').textContent = text;
  }

  setTitleInfo(best: number, bestHeight: number, showInstallHint: boolean): void {
    $('title-best').textContent = best > 0 ? `Best ${best.toLocaleString()} · ${bestHeight.toFixed(2)} m` : '';
    $('install-hint').hidden = !showInstallHint;
  }

  setSettings(s: Settings, hapticsSupported: boolean, fullscreenSupported: boolean): void {
    $<HTMLInputElement>('set-sound').checked = s.sound;
    $<HTMLInputElement>('set-haptics').checked = s.haptics;
    $<HTMLSelectElement>('set-quality').value = s.quality;
    $<HTMLInputElement>('set-debug').checked = s.debug;
    $('row-haptics').hidden = !hapticsSupported;
    $('btn-fullscreen').hidden = !fullscreenSupported;
  }

  setScore(score: number, animate = true): void {
    this.targetScore = score;
    if (!animate) {
      this.shownScore = score;
      this.score.textContent = score.toLocaleString();
    } else {
      this.score.classList.remove('bump');
      void this.score.offsetWidth;
      this.score.classList.add('bump');
      window.setTimeout(() => this.score.classList.remove('bump'), 260);
    }
  }

  setHeight(metres: number): void {
    this.height.innerHTML = `${metres.toFixed(2)}<span class="unit">m</span>`;
  }

  setCombo(combo: number, multiplier: number): void {
    if (combo >= 2) {
      this.combo.textContent = `Combo ×${multiplier.toFixed(2).replace(/\.?0+$/, '')} · ${combo} in a row`;
      this.combo.classList.add('show');
    } else {
      this.combo.classList.remove('show');
    }
  }

  setControlsActive(active: boolean): void {
    this.controls.classList.toggle('inactive', !active);
    this.drop.disabled = !active;
  }

  showHint(text: string, seconds = 5): void {
    this.hint.textContent = text;
    this.hint.classList.remove('fade');
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hint.classList.add('fade'), seconds * 1000);
  }

  hideHint(): void {
    this.hint.classList.add('fade');
  }

  setSlowMotion(on: boolean): void {
    this.slowmo.classList.toggle('on', on);
  }

  popup(x: number, y: number, main: string, sub: string, cls = ''): void {
    const el = document.createElement('div');
    el.className = `popup ${cls}`;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const pts = document.createElement('div');
    pts.className = 'pts';
    pts.textContent = main;
    el.appendChild(pts);
    if (sub) {
      const tier = document.createElement('div');
      tier.className = 'tier';
      tier.textContent = sub;
      el.appendChild(tier);
    }
    this.popups.appendChild(el);
    window.setTimeout(() => el.remove(), 1700);
  }

  clearPopups(): void {
    this.popups.replaceChildren();
  }

  showGameOver(info: GameOverInfo): void {
    $('over-score').textContent = info.score.toLocaleString();
    $('over-height').textContent = `${info.height.toFixed(2)} m`;
    $('over-stones').textContent = String(info.stones);
    $('over-combo').textContent = String(info.maxCombo);
    $('over-best').textContent = info.best.toLocaleString();
    $('over-badge').hidden = !(info.newBest || info.newBestHeight);
    $('over-badge').textContent = info.newBest ? 'New best score' : 'New height record';
    $('over-kicker').textContent = info.stones === 0 ? 'Into the stream' : 'The tower fell';
    this.show('over');
  }

  /** Smoothly counts the score display up (called every frame). */
  update(dt: number): void {
    if (this.shownScore !== this.targetScore) {
      const diff = this.targetScore - this.shownScore;
      const step = Math.max(1, Math.ceil(Math.abs(diff) * Math.min(1, dt * 9)));
      this.shownScore += Math.sign(diff) * Math.min(Math.abs(diff), step);
      this.score.textContent = this.shownScore.toLocaleString();
    }
  }
}
