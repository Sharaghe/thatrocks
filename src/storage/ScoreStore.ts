import { STORAGE_KEY } from '../config';

export type QualityChoice = 'auto' | 'low' | 'medium' | 'high';

export interface Settings {
  sound: boolean;
  haptics: boolean;
  quality: QualityChoice;
  debug: boolean;
}

export interface GameRecord {
  score: number;
  height: number;
  stones: number;
  date: string;
  seed: number;
}

export interface SaveData {
  version: 1;
  bestScore: number;
  bestHeight: number;
  gamesPlayed: number;
  history: GameRecord[];
  settings: Settings;
}

export const defaultSettings = (): Settings => ({ sound: true, haptics: true, quality: 'auto', debug: false });

const emptySave = (): SaveData => ({
  version: 1,
  bestScore: 0,
  bestHeight: 0,
  gamesPlayed: 0,
  history: [],
  settings: defaultSettings(),
});

/** Minimal Storage subset (lets tests inject an in-memory implementation). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function safeLocalStorage(): KeyValueStorage | null {
  try {
    const s = window.localStorage;
    const probe = '__rockstack_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    // Private mode / disabled storage: keep scores for this session only.
    return null;
  }
}

export interface RecordResult {
  newBestScore: boolean;
  newBestHeight: boolean;
}

/** Local high scores and settings (localStorage, versioned, corruption tolerant). */
export class ScoreStore {
  private data: SaveData;

  constructor(private readonly storage: KeyValueStorage | null) {
    this.data = this.load();
  }

  private load(): SaveData {
    if (!this.storage) return emptySave();
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return emptySave();
      const parsed = JSON.parse(raw) as Partial<SaveData>;
      if (parsed.version !== 1) return emptySave();
      const base = emptySave();
      return {
        ...base,
        ...parsed,
        bestScore: Number.isFinite(parsed.bestScore) ? Number(parsed.bestScore) : 0,
        bestHeight: Number.isFinite(parsed.bestHeight) ? Number(parsed.bestHeight) : 0,
        history: Array.isArray(parsed.history) ? parsed.history.slice(0, 10) : [],
        settings: { ...base.settings, ...(parsed.settings ?? {}) },
      };
    } catch {
      return emptySave();
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      /* quota / private mode: ignore */
    }
  }

  get bestScore(): number {
    return this.data.bestScore;
  }

  get bestHeight(): number {
    return this.data.bestHeight;
  }

  get gamesPlayed(): number {
    return this.data.gamesPlayed;
  }

  get history(): readonly GameRecord[] {
    return this.data.history;
  }

  get settings(): Readonly<Settings> {
    return this.data.settings;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.persist();
  }

  recordGame(record: GameRecord): RecordResult {
    const result: RecordResult = {
      newBestScore: record.score > this.data.bestScore,
      newBestHeight: record.height > this.data.bestHeight,
    };
    this.data.bestScore = Math.max(this.data.bestScore, record.score);
    this.data.bestHeight = Math.max(this.data.bestHeight, record.height);
    this.data.gamesPlayed += 1;
    this.data.history = [record, ...this.data.history].slice(0, 10);
    this.persist();
    return result;
  }
}
