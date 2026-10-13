/**
 * Explicit, pure game state machine. All phase changes go through
 * `transition`, which makes the flow easy to test and reason about.
 */
export type GamePhase = 'loading' | 'title' | 'aiming' | 'settling' | 'collapsing' | 'gameover';

export type GameEvent =
  | { type: 'LOADED' }
  | { type: 'START' }
  | { type: 'DROP' }
  | { type: 'SETTLED' }
  | { type: 'COLLAPSE' }
  | { type: 'COLLAPSE_DONE' }
  | { type: 'RESTART' }
  | { type: 'QUIT' };

const TABLE: Record<GamePhase, Partial<Record<GameEvent['type'], GamePhase>>> = {
  loading: { LOADED: 'title' },
  title: { START: 'aiming' },
  aiming: { DROP: 'settling', COLLAPSE: 'collapsing', RESTART: 'aiming', QUIT: 'title' },
  settling: { SETTLED: 'aiming', COLLAPSE: 'collapsing', RESTART: 'aiming', QUIT: 'title' },
  collapsing: { COLLAPSE_DONE: 'gameover', RESTART: 'aiming', QUIT: 'title' },
  gameover: { RESTART: 'aiming', QUIT: 'title' },
};

/** Returns the next phase, or null when the event is not valid in this phase. */
export function transition(phase: GamePhase, event: GameEvent): GamePhase | null {
  return TABLE[phase][event.type] ?? null;
}

export class GameStateMachine {
  private current: GamePhase = 'loading';
  private listeners: ((next: GamePhase, prev: GamePhase, event: GameEvent) => void)[] = [];
  /** Seconds spent in the current phase (advanced by the game loop). */
  timeInPhase = 0;

  get phase(): GamePhase {
    return this.current;
  }

  can(event: GameEvent): boolean {
    return transition(this.current, event) !== null;
  }

  send(event: GameEvent): boolean {
    const next = transition(this.current, event);
    if (next === null) return false;
    const prev = this.current;
    this.current = next;
    this.timeInPhase = 0;
    for (const l of this.listeners) l(next, prev, event);
    return true;
  }

  onChange(listener: (next: GamePhase, prev: GamePhase, event: GameEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}
