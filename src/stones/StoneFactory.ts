import { generateStoneShape, type StoneShape } from './StoneShape';
import type { StoneRecipe } from './catalog';

/**
 * Generates stone shapes off the main thread (≈50–120 ms each) so spawning
 * never stalls a frame. Falls back to synchronous generation when module
 * workers are unavailable.
 */
export class StoneFactory {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (s: StoneShape) => void; reject: (e: Error) => void }>();
  private cache = new Map<string, Promise<StoneShape>>();

  constructor(private detail = 4) {
    try {
      this.worker = new Worker(new URL('./stoneWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ id: number; shape?: StoneShape; error?: string }>) => {
        const job = this.pending.get(e.data.id);
        if (!job) return;
        this.pending.delete(e.data.id);
        if (e.data.shape) job.resolve(e.data.shape);
        else job.reject(new Error(e.data.error ?? 'stone generation failed'));
      };
      this.worker.onerror = () => this.disableWorker();
    } catch {
      this.worker = null;
    }
  }

  private disableWorker() {
    this.worker?.terminate();
    this.worker = null;
    for (const job of this.pending.values()) job.reject(new Error('worker failed'));
    this.pending.clear();
  }

  /** Generate (or fetch the prefetched) shape for a recipe. `key` identifies it in the cache. */
  get(key: string, recipe: StoneRecipe): Promise<StoneShape> {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const promise = this.generate(recipe).catch(() => generateStoneShape(recipe, { detail: this.detail }));
    this.cache.set(key, promise);
    if (this.cache.size > 8) {
      const first = this.cache.keys().next().value;
      if (first !== undefined && first !== key) this.cache.delete(first);
    }
    return promise;
  }

  private generate(recipe: StoneRecipe): Promise<StoneShape> {
    if (!this.worker) return Promise.resolve(generateStoneShape(recipe, { detail: this.detail }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, recipe, detail: this.detail });
    });
  }

  clearCache(): void {
    this.cache.clear();
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
