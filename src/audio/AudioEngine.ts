import type { RockMaterial } from '../stones/catalog';
import { clamp, clamp01 } from '../core/math';

type SoundSignature = RockMaterial['sound'];

const GROUND_SOUND: SoundSignature = { pitch: 0.45, ring: 0.15, brightness: 0.35, grit: 1.2 };

/**
 * Procedural sound design with the Web Audio API — no audio files.
 *
 * - Stone impacts: modal synthesis (inharmonic partials) + noise transient,
 *   tuned per rock type and stone size, loudness from the real impact speed.
 * - Scraping: filtered noise + crackle, driven by the sliding speed.
 * - Water: splash bursts with bubbles, continuous stream ambience.
 * - UI: soft marimba-like tones for placements, combos, records.
 *
 * Mobile: the context is created/resumed inside a user gesture (iOS), the
 * session is set to "ambient" where supported (respects the silent switch and
 * mixes with music) and audio suspends while the page is hidden.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private ui!: GainNode;
  private ambience!: GainNode;
  private noise!: AudioBuffer;
  private brown!: AudioBuffer;
  private crackle!: AudioBuffer;
  private scrapeGain!: GainNode;
  private scrapeFilter!: BiquadFilterNode;
  private crackleGain!: GainNode;
  private activeVoices = 0;
  private nextBubble = 0;
  private nextBird = 0;
  private muted = false;
  private unlocked = false;
  volume = 0.9;

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  /** Must be called from a user gesture handler (touchend/click/keydown). */
  unlock(): void {
    try {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'ambient';
    } catch {
      /* not supported */
    }
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.build();
    }
    if (this.ctx.state !== 'running') void this.ctx.resume();
    if (!this.unlocked) {
      // Silent buffer: older iOS versions only unlock after a sound is started in the gesture.
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, 22050);
      src.connect(this.ctx.destination);
      src.start(0);
      this.unlocked = true;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  /** Pause/resume with page visibility. */
  setActive(active: boolean): void {
    if (!this.ctx || !this.unlocked) return;
    if (active && this.ctx.state !== 'running') void this.ctx.resume();
    if (!active && this.ctx.state === 'running') void this.ctx.suspend();
  }

  private build(): void {
    const ctx = this.ctx!;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.ui = ctx.createGain();
    this.ui.gain.value = 0.32;
    this.ambience = ctx.createGain();
    this.ambience.gain.value = 0;
    for (const bus of [this.sfx, this.ui, this.ambience]) bus.connect(this.master);

    const sr = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, sr * 2, sr);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.brown = ctx.createBuffer(1, sr * 4, sr);
    const bd = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bd.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      bd[i] = last * 3.5;
    }
    this.crackle = ctx.createBuffer(1, sr * 2, sr);
    const cd = this.crackle.getChannelData(0);
    for (let i = 0; i < cd.length; i++) cd[i] = Math.random() < 0.004 ? (Math.random() * 2 - 1) * (0.4 + Math.random()) : 0;

    // Continuous scrape voice (silent until driven)
    const scrapeSrc = ctx.createBufferSource();
    scrapeSrc.buffer = this.noise;
    scrapeSrc.loop = true;
    this.scrapeFilter = ctx.createBiquadFilter();
    this.scrapeFilter.type = 'bandpass';
    this.scrapeFilter.frequency.value = 900;
    this.scrapeFilter.Q.value = 1.4;
    this.scrapeGain = ctx.createGain();
    this.scrapeGain.gain.value = 0;
    scrapeSrc.connect(this.scrapeFilter).connect(this.scrapeGain).connect(this.sfx);
    scrapeSrc.start();
    const crackleSrc = ctx.createBufferSource();
    crackleSrc.buffer = this.crackle;
    crackleSrc.loop = true;
    const crackleFilter = ctx.createBiquadFilter();
    crackleFilter.type = 'highpass';
    crackleFilter.frequency.value = 1800;
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    crackleSrc.connect(crackleFilter).connect(this.crackleGain).connect(this.sfx);
    crackleSrc.start();

    this.buildAmbience();
  }

  private buildAmbience(): void {
    const ctx = this.ctx!;
    // Stream body: brown noise, low-passed, with slow swells.
    const body = ctx.createBufferSource();
    body.buffer = this.brown;
    body.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 650;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.16;
    lfo.connect(lfoGain).connect(bodyGain.gain);
    body.connect(lp).connect(bodyGain).connect(this.ambience);
    // Shimmer: higher band of the water, quieter, modulated faster.
    const shimmer = ctx.createBufferSource();
    shimmer.buffer = this.noise;
    shimmer.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 0.6;
    const shGain = ctx.createGain();
    shGain.gain.value = 0.05;
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.47;
    const lfo2Gain = ctx.createGain();
    lfo2Gain.gain.value = 0.025;
    lfo2.connect(lfo2Gain).connect(shGain.gain);
    shimmer.connect(bp).connect(shGain).connect(this.ambience);
    body.start();
    shimmer.start();
    lfo.start();
    lfo2.start();
    this.ambience.gain.setTargetAtTime(0.32, ctx.currentTime, 1.5);
  }

  /** Called every frame: schedules stream bubbles and distant birds. */
  update(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (now >= this.nextBubble) {
      this.bubble(now + Math.random() * 0.05, 0.012 + Math.random() * 0.02, 380 + Math.random() * 900, this.ambience);
      this.nextBubble = now + 0.05 + Math.random() * 0.28;
    }
    if (now >= this.nextBird) {
      if (this.nextBird > 0) this.bird(now);
      this.nextBird = now + 7 + Math.random() * 14;
    }
  }

  private envGain(start: number, peak: number, attack: number, decay: number, dest: AudioNode): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(peak, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
    g.connect(dest);
    return g;
  }

  private panner(pan: number, dest: AudioNode): AudioNode {
    const ctx = this.ctx!;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      p.connect(dest);
      return p;
    }
    return dest;
  }

  /**
   * Stone impact. `speed` is the normal approach speed (m/s), `size` the
   * stone's radius (m), `mass` in kg.
   */
  impact(a: SoundSignature, b: SoundSignature | null, speed: number, size: number, mass: number, pan = 0, onGround = false): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const loud = clamp01(Math.pow(speed / 1.6, 1.15)) * (0.45 + 0.55 * clamp01(mass / 25));
    if (loud < 0.015) return;
    if (this.activeVoices > 14 && loud < 0.3) return;
    const sig = onGround ? GROUND_SOUND : b ? mix(a, b) : a;
    const now = ctx.currentTime + 0.002;
    const out = this.panner(pan, this.sfx);
    const voice = ctx.createGain();
    voice.gain.value = loud;
    voice.connect(out);
    this.activeVoices++;
    const f0 = clamp(880 * sig.pitch * Math.pow(0.18 / Math.max(0.04, size), 0.7) * (0.94 + Math.random() * 0.12), 140, 4200);
    const ratios = [1, 1.52, 2.31, 3.17, 4.43];
    let longest = 0.05;
    ratios.forEach((r, i) => {
      const freq = f0 * r * (0.97 + Math.random() * 0.06);
      if (freq > 12000) return;
      const decay = (0.035 + 0.05 * sig.ring) / (1 + i * 0.55) * (0.8 + Math.random() * 0.4);
      longest = Math.max(longest, decay);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const amp = (i === 0 ? 0.5 : 0.42 / (1 + i * 0.5)) * (i > 1 ? sig.brightness : 1);
      osc.connect(this.envGain(now, amp, 0.0015, decay * 6, voice));
      osc.start(now);
      osc.stop(now + decay * 6 + 0.05);
    });
    // Transient click (contact noise)
    const click = ctx.createBufferSource();
    click.buffer = this.noise;
    const cf = ctx.createBiquadFilter();
    cf.type = 'bandpass';
    cf.frequency.value = clamp(2400 * sig.brightness * (0.8 + Math.random() * 0.4), 500, 9000);
    cf.Q.value = 0.8;
    click.connect(cf).connect(this.envGain(now, 0.55 * (0.5 + sig.grit * 0.5), 0.001, 0.025 + sig.grit * 0.02, voice));
    click.start(now, Math.random() * 1.5, 0.08);
    // Body thump for heavy stones
    if (mass > 8 && speed > 0.35) {
      const th = ctx.createOscillator();
      th.type = 'sine';
      th.frequency.setValueAtTime(clamp(150 * Math.pow(0.2 / Math.max(0.05, size), 0.5), 70, 220), now);
      th.frequency.exponentialRampToValueAtTime(55, now + 0.12);
      th.connect(this.envGain(now, 0.55 * clamp01(mass / 30), 0.002, 0.12, voice));
      th.start(now);
      th.stop(now + 0.2);
    }
    window.setTimeout(() => {
      this.activeVoices--;
      voice.disconnect();
    }, (longest * 6 + 0.3) * 1000);
  }

  /** Continuous scraping/grinding, `intensity` ≈ sliding speed (m/s). */
  setScrape(intensity: number, sig: SoundSignature | null): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const s = clamp01(intensity / 0.5);
    const now = ctx.currentTime;
    const grit = sig?.grit ?? 0.7;
    this.scrapeGain.gain.setTargetAtTime(Math.pow(s, 1.4) * 0.22, now, 0.04);
    this.scrapeFilter.frequency.setTargetAtTime(500 + s * 1700 * (sig?.brightness ?? 1), now, 0.05);
    this.crackleGain.gain.setTargetAtTime(Math.pow(s, 1.2) * 0.5 * grit, now, 0.04);
  }

  splash(strength: number, pan = 0): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const s = clamp01(strength / 2.5) * 0.9 + 0.1;
    const now = ctx.currentTime;
    const out = this.panner(pan, this.sfx);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5200, now);
    lp.frequency.exponentialRampToValueAtTime(420, now + 0.45);
    src.connect(lp).connect(this.envGain(now, 0.5 * s, 0.004, 0.5, out));
    src.start(now, Math.random(), 0.7);
    for (let i = 0; i < 4 + Math.round(s * 6); i++) {
      this.bubble(now + 0.04 + Math.random() * 0.35, 0.04 + Math.random() * 0.05 * s, 300 + Math.random() * 700, out);
    }
  }

  private bubble(t: number, gain: number, freq: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 2.1, t + 0.035);
    osc.connect(this.envGain(t, gain, 0.002, 0.04, dest));
    osc.start(t);
    osc.stop(t + 0.07);
  }

  private bird(t: number): void {
    const ctx = this.ctx!;
    const out = this.panner(Math.random() * 1.6 - 0.8, this.ambience);
    const notes = 2 + Math.floor(Math.random() * 4);
    const base = 2600 + Math.random() * 1800;
    for (let i = 0; i < notes; i++) {
      const start = t + i * (0.09 + Math.random() * 0.05);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.2), start);
      osc.frequency.exponentialRampToValueAtTime(base * (1.25 + Math.random() * 0.3), start + 0.05);
      osc.frequency.exponentialRampToValueAtTime(base * 0.85, start + 0.08);
      osc.connect(this.envGain(start, 0.035, 0.005, 0.07, out));
      osc.start(start);
      osc.stop(start + 0.12);
    }
  }

  // ------------------------------------------------------------------ UI
  private tone(freq: number, t: number, gain: number, decay: number, dest: AudioNode = this.ui): void {
    const ctx = this.ctx!;
    for (const [mult, g] of [
      [1, 1],
      [3.99, 0.18],
      [10.1, 0.05],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      osc.connect(this.envGain(t, gain * g, 0.003, decay / (mult > 1 ? 2.5 : 1), dest));
      osc.start(t);
      osc.stop(t + decay + 0.1);
    }
  }

  click(): void {
    if (!this.ready) return;
    this.tone(1320, this.ctx!.currentTime, 0.25, 0.08);
  }

  /** Placement accepted. `tierIndex` 0..3, `combo` ≥ 0. */
  placed(tierIndex: number, combo: number): void {
    if (!this.ready) return;
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19];
    const now = this.ctx!.currentTime + 0.05;
    const root = 523.25;
    const step = scale[Math.min(scale.length - 1, tierIndex * 2)];
    this.tone(root * Math.pow(2, step / 12), now, 0.55, 0.5);
    if (combo >= 2) {
      const c = scale[Math.min(scale.length - 1, 2 + Math.min(combo, 6))];
      this.tone(root * Math.pow(2, c / 12), now + 0.09, 0.45, 0.55);
    }
  }

  closeCall(): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2;
    bp.frequency.setValueAtTime(300, now);
    bp.frequency.exponentialRampToValueAtTime(1600, now + 0.6);
    src.connect(bp).connect(this.envGain(now, 0.3, 0.35, 0.4, this.ui));
    src.start(now, 0, 1);
    this.tone(784, now + 0.5, 0.35, 0.6);
  }

  collapse(): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    src.connect(lp).connect(this.envGain(now, 0.9, 0.08, 2.2, this.sfx));
    src.start(now, 0, 2.6);
  }

  gameOver(newBest: boolean): void {
    if (!this.ready) return;
    const now = this.ctx!.currentTime + 0.1;
    const notes = newBest ? [523.25, 659.25, 783.99, 1046.5] : [587.33, 493.88, 392.0];
    notes.forEach((f, i) => this.tone(f, now + i * 0.16, 0.5, 0.7));
  }
}

function mix(a: SoundSignature, b: SoundSignature): SoundSignature {
  return {
    pitch: (a.pitch + b.pitch) / 2,
    ring: (a.ring + b.ring) / 2,
    brightness: (a.brightness + b.brightness) / 2,
    grit: (a.grit + b.grit) / 2,
  };
}
