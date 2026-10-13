import './ui/styles.css';
import { loadRapier, PhysicsWorld } from './physics/PhysicsWorld';
import { Simulation } from './game/Simulation';
import { Game, type Placement } from './game/Game';
import { RenderContext } from './render/RenderContext';
import { generateSurfaceTextures } from './render/TextureFactory';
import { Environment } from './render/Environment';
import { Effects } from './render/Effects';
import { StoneFactory } from './stones/StoneFactory';
import { baseRockRecipe } from './world/baseRock';
import { Terrain } from './world/terrain';
import { AudioEngine } from './audio/AudioEngine';
import { Haptics } from './platform/haptics';
import { detectDevice, pickQualityTier } from './platform/device';
import { ScoreStore, safeLocalStorage, type Settings } from './storage/ScoreStore';
import { Hud } from './ui/Hud';
import { DebugOverlay } from './ui/DebugOverlay';
import { PlacementInput, lockPageGestures } from './input/PlacementInput';

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function fatal(message: string, detail?: unknown): void {
  console.error(message, detail);
  const el = document.getElementById('fatal')!;
  el.hidden = false;
  el.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = message;
  const btn = document.createElement('button');
  btn.className = 'primary-btn';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => location.reload());
  el.append(p, btn);
  for (const id of ['screen-loading', 'screen-title', 'hud']) document.getElementById(id)!.hidden = true;
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  lockPageGestures();
  const device = detectDevice();
  const params = new URLSearchParams(location.search);
  const store = new ScoreStore(safeLocalStorage());
  const qualityParam = params.get('quality');
  const tier = pickQualityTier(device, qualityParam ?? (store.settings.quality !== 'auto' ? store.settings.quality : null));
  const seedParam = params.get('seed');
  const fixedSeed = seedParam !== null && /^\d+$/.test(seedParam) ? Number(seedParam) : null;

  let game: Game | null = null;
  const audio = new AudioEngine();
  const haptics = new Haptics(device.isIOS);
  const fullscreenSupported = Boolean(
    document.fullscreenEnabled || (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled,
  );

  const hud = new Hud({
    start: () => {
      audio.unlock();
      game?.startGame();
    },
    again: () => game?.restart(),
    menu: () => game?.quitToTitle(),
    pause: () => game?.setPaused(true),
    resume: () => {
      if (hud.pausedFromTitle) hud.show('title');
      else game?.setPaused(false);
    },
    restart: () => game?.restart(),
    drop: () => game?.drop(),
    flip: () => game?.flip(),
    rotateHold: (dir) => game?.rotateHold(dir),
    rotateStep: (dir) => game?.rotateStep(dir),
    settingsChanged: (patch: Partial<Settings>) => {
      store.updateSettings(patch);
      if (patch.sound) audio.unlock();
      game?.applySettings(store.settings);
      if (patch.debug !== undefined) game?.setDebug(patch.debug);
      if (patch.quality !== undefined) location.reload();
    },
    fullscreen: () => {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      if (document.fullscreenElement) void document.exitFullscreen();
      else if (el.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
      else el.webkitRequestFullscreen?.();
    },
    uiTap: () => {
      if (store.settings.sound) audio.unlock();
      audio.click();
      haptics.pulse('tick');
    },
  });
  hud.show('loading');
  hud.setLoading(0.05, 'Waking the river…');

  if (!webglAvailable()) {
    fatal('Rock Stack needs WebGL, which is not available in this browser.');
    return;
  }

  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const ctx = new RenderContext(canvas, tier);
  await nextFrame();

  hud.setLoading(0.15, 'Loading physics…');
  const R = await loadRapier();

  hud.setLoading(0.3, 'Weathering stone textures…');
  await nextFrame();
  const textures = generateSurfaceTextures(ctx.renderer, ctx.quality.textureSize);

  hud.setLoading(0.45, 'Finding a base rock…');
  const factory = new StoneFactory(4);
  const baseShape = await factory.get('base', baseRockRecipe());

  hud.setLoading(0.6, 'Shaping the riverbank…');
  await nextFrame();
  const terrain = new Terrain();
  const sim = new Simulation(new PhysicsWorld(R));
  const ground = terrain.gridMesh(32, 80);
  sim.setGroundMesh(ground.positions, ground.indices);
  sim.setBase(baseShape);
  sim.step(); // builds the broad phase so scene queries work immediately

  const env = new Environment(ctx.renderer, ctx.scene, {
    quality: ctx.quality,
    textures,
    terrain,
    baseShape,
    basePosition: sim.basePosition,
  });
  const effects = new Effects(ctx.quality.scatterDensity);
  // Diagnostics: ?env=0 disables image-based light, ?shadows=0 disables shadow maps.
  if (params.get('env') === '0') ctx.scene.environment = null;
  if (params.get('shadows') === '0') ctx.renderer.shadowMap.enabled = false;

  hud.setLoading(0.85, 'Compiling shaders…');
  await nextFrame();

  const debugEl = document.getElementById('debug')!;
  let debug!: DebugOverlay;
  const input = new PlacementInput(canvas, {
    moveBy: (dx, dy, speed) => game?.moveBy(dx, dy, speed),
    rotateBy: (r) => game?.rotateBy(r),
    orbitBy: (r) => game?.orbitBy(r),
    zoomBy: (f) => game?.zoomBy(f),
    drop: () => game?.drop(),
    flip: () => game?.flip(),
    restart: () => {
      if (game && (game.phase === 'gameover' || game.isPaused)) game.restart();
    },
    togglePause: () => game?.togglePause(),
    toggleDebug: () => game?.toggleDebug(),
    gesture: () => game?.gesture(),
  });
  debug = new DebugOverlay(debugEl, {
    copyReplay: () => {
      const json = game?.replayJSON() ?? '';
      const encoded = btoa(json);
      const url = `${location.origin}${location.pathname}?replay=${encoded}`;
      void navigator.clipboard?.writeText(url).catch(() => undefined);
      console.info('Replay URL:', url);
    },
    toggleChanged: () => game?.updateDebugVisuals(),
  });

  game = new Game({
    ctx,
    sim,
    env,
    effects,
    factory,
    textures,
    audio,
    haptics,
    store,
    hud,
    debug,
    input,
    fixedSeed,
    reducedMotion: device.prefersReducedMotion,
    qualityLabel: `${tier}${device.isIPad ? ' · iPad' : device.isIPhone ? ' · iPhone' : ''}`,
  });
  game.applySettings(store.settings);
  hud.setSettings(store.settings, haptics.supported, fullscreenSupported);
  effects.setViewport(ctx.height, ctx.camera.fov);
  ctx.onResize((_w, h) => effects.setViewport(h, ctx.camera.fov));

  // Warm up shader programs so the first frames do not stutter.
  try {
    game.prewarm();
  } catch (err) {
    console.warn('Shader prewarm failed', err);
  }
  hud.setLoading(1, 'Ready');
  game.loaded();
  hud.setTitleInfo(store.bestScore, store.bestHeight, device.isIOS && !device.standalone);
  if (store.settings.debug || params.has('debug')) game.setDebug(true);

  const replay = params.get('replay');
  if (replay) {
    try {
      const data = JSON.parse(atob(replay)) as { seed: number; placements: Placement[] };
      game.startReplay(data);
    } catch (e) {
      console.warn('Invalid replay', e);
    }
  }

  // Pause and silence when the app goes to the background (iOS app switcher, lock screen).
  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState === 'visible';
    audio.setActive(visible);
    if (!visible && game && (game.phase === 'aiming' || game.phase === 'settling')) game.setPaused(true);
  });
  window.addEventListener('pagehide', () => audio.setActive(false));
  canvas.addEventListener('webglcontextlost', () => fatal('The graphics context was lost (the system reclaimed GPU memory).'));

  let last = performance.now();
  let failures = 0;
  const loop = (now: number) => {
    // Schedule first: one bad frame must not silently stop the game loop.
    requestAnimationFrame(loop);
    const dt = (now - last) / 1000;
    last = now;
    try {
      game!.update(dt);
      failures = 0;
    } catch (err) {
      failures++;
      console.error('Frame failed', err);
      if (failures > 30) fatal('Rock Stack stopped after repeated errors.', err);
    }
  };
  requestAnimationFrame(loop);

  (window as unknown as { __rockstack: unknown }).__rockstack = game.testApi();
}

boot().catch((err) => fatal('Rock Stack failed to start.', err));

// Offline play for the home-screen app (production builds only).
// Skipped when embedded in a frame (e.g. a preview), where it cannot apply.
if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol === 'https:' && window.self === window.top) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
