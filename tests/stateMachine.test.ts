import { describe, expect, it, vi } from 'vitest';
import { GameStateMachine, transition, type GamePhase } from '../src/game/GameStateMachine';

describe('transition table', () => {
  it('follows the core loop', () => {
    let p: GamePhase = 'loading';
    p = transition(p, { type: 'LOADED' })!;
    expect(p).toBe('title');
    p = transition(p, { type: 'START' })!;
    expect(p).toBe('aiming');
    p = transition(p, { type: 'DROP' })!;
    expect(p).toBe('settling');
    p = transition(p, { type: 'SETTLED' })!;
    expect(p).toBe('aiming');
    p = transition(p, { type: 'DROP' })!;
    p = transition(p, { type: 'COLLAPSE' })!;
    expect(p).toBe('collapsing');
    p = transition(p, { type: 'COLLAPSE_DONE' })!;
    expect(p).toBe('gameover');
    p = transition(p, { type: 'RESTART' })!;
    expect(p).toBe('aiming');
  });

  it('lets a tower collapse while the player is still aiming', () => {
    expect(transition('aiming', { type: 'COLLAPSE' })).toBe('collapsing');
  });

  it('rejects invalid events', () => {
    expect(transition('title', { type: 'DROP' })).toBeNull();
    expect(transition('settling', { type: 'DROP' })).toBeNull();
    expect(transition('gameover', { type: 'SETTLED' })).toBeNull();
    expect(transition('loading', { type: 'START' })).toBeNull();
    expect(transition('collapsing', { type: 'SETTLED' })).toBeNull();
  });

  it('allows an immediate restart from every in-game phase', () => {
    for (const p of ['aiming', 'settling', 'collapsing', 'gameover'] as GamePhase[]) {
      expect(transition(p, { type: 'RESTART' })).toBe('aiming');
    }
  });
});

describe('GameStateMachine', () => {
  it('notifies listeners with next/prev phase and resets the phase timer', () => {
    const fsm = new GameStateMachine();
    const listener = vi.fn();
    fsm.onChange(listener);
    fsm.timeInPhase = 3;
    expect(fsm.send({ type: 'LOADED' })).toBe(true);
    expect(listener).toHaveBeenCalledWith('title', 'loading', { type: 'LOADED' });
    expect(fsm.timeInPhase).toBe(0);
  });

  it('ignores invalid events without notifying', () => {
    const fsm = new GameStateMachine();
    const listener = vi.fn();
    fsm.onChange(listener);
    expect(fsm.send({ type: 'DROP' })).toBe(false);
    expect(fsm.phase).toBe('loading');
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribes listeners', () => {
    const fsm = new GameStateMachine();
    const listener = vi.fn();
    const off = fsm.onChange(listener);
    off();
    fsm.send({ type: 'LOADED' });
    expect(listener).not.toHaveBeenCalled();
  });
});
