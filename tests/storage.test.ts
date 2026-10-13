import { describe, expect, it } from 'vitest';
import { ScoreStore, type KeyValueStorage } from '../src/storage/ScoreStore';
import { STORAGE_KEY } from '../src/config';

class MemoryStorage implements KeyValueStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

const record = (score: number, height: number) => ({ score, height, stones: 5, date: '2026-01-01T00:00:00Z', seed: 1 });

describe('ScoreStore', () => {
  it('persists best score, height and history across instances', () => {
    const mem = new MemoryStorage();
    const a = new ScoreStore(mem);
    expect(a.recordGame(record(120, 0.8))).toEqual({ newBestScore: true, newBestHeight: true });
    expect(a.recordGame(record(90, 1.1))).toEqual({ newBestScore: false, newBestHeight: true });
    const b = new ScoreStore(mem);
    expect(b.bestScore).toBe(120);
    expect(b.bestHeight).toBeCloseTo(1.1);
    expect(b.gamesPlayed).toBe(2);
    expect(b.history[0].score).toBe(90);
  });

  it('keeps at most ten history entries', () => {
    const s = new ScoreStore(new MemoryStorage());
    for (let i = 0; i < 15; i++) s.recordGame(record(i, 0.1));
    expect(s.history).toHaveLength(10);
    expect(s.history[0].score).toBe(14);
  });

  it('stores settings', () => {
    const mem = new MemoryStorage();
    new ScoreStore(mem).updateSettings({ sound: false, quality: 'low' });
    const s = new ScoreStore(mem);
    expect(s.settings.sound).toBe(false);
    expect(s.settings.quality).toBe('low');
    expect(s.settings.haptics).toBe(true);
  });

  it('survives corrupt or foreign data', () => {
    const mem = new MemoryStorage();
    mem.setItem(STORAGE_KEY, '{not json');
    expect(new ScoreStore(mem).bestScore).toBe(0);
    mem.setItem(STORAGE_KEY, JSON.stringify({ version: 99, bestScore: 5 }));
    expect(new ScoreStore(mem).bestScore).toBe(0);
  });

  it('works without storage (private mode)', () => {
    const s = new ScoreStore(null);
    expect(s.recordGame(record(10, 0.2)).newBestScore).toBe(true);
    expect(s.bestScore).toBe(10);
  });
});
