import { describe, expect, it } from 'vitest';
import { LoopEngine, estimatePosition, type PlaybackSnapshot } from '../src/player/loopEngine';

const TRACK = 'spotify:track:abc';

function snapshot(partial: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot {
  return {
    positionMs: 0,
    atMs: 0,
    paused: false,
    durationMs: 240_000,
    trackUri: TRACK,
    ...partial,
  };
}

/** Drives the engine like the real ticker, feeding a state event back after each seek. */
function runTicker(
  engine: LoopEngine,
  options: { fromMs: number; toMs: number; stepMs: number; seekLatencyMs?: number },
): { seeks: number[]; overshoots: number[] } {
  const { fromMs, toMs, stepMs, seekLatencyMs = 120 } = options;
  const seeks: number[] = [];
  const overshoots: number[] = [];
  const pendingEvents: Array<{ atMs: number; snapshot: PlaybackSnapshot }> = [];

  for (let now = fromMs; now <= toMs; now += stepMs) {
    while (pendingEvents.length > 0 && pendingEvents[0]!.atMs <= now) {
      const event = pendingEvents.shift()!;
      engine.onState(event.snapshot);
    }
    const estimateBefore = engine.estimate(now);
    const command = engine.tick(now);
    if (command) {
      seeks.push(now);
      const region = engine.activeRegion!;
      overshoots.push((estimateBefore ?? 0) - region.endMs);
      // Spotify confirms the seek a little later, reporting the post-seek position.
      pendingEvents.push({
        atMs: now + seekLatencyMs,
        snapshot: snapshot({
          positionMs: command.positionMs + seekLatencyMs,
          atMs: now + seekLatencyMs,
        }),
      });
    }
  }
  return { seeks, overshoots };
}

describe('estimatePosition', () => {
  it('extrapolates while playing', () => {
    expect(estimatePosition(snapshot({ positionMs: 1000, atMs: 500 }), 1500)).toBe(2000);
  });

  it('freezes while paused', () => {
    expect(estimatePosition(snapshot({ positionMs: 1000, atMs: 500, paused: true }), 9000)).toBe(
      1000,
    );
  });

  it('never runs past the track duration', () => {
    expect(
      estimatePosition(snapshot({ positionMs: 239_000, atMs: 0, durationMs: 240_000 }), 10_000),
    ).toBe(240_000);
  });
});

describe('LoopEngine', () => {
  it('seeks back to the start a lookahead before the end', () => {
    const engine = new LoopEngine({ lookaheadMs: 150 });
    engine.setRegion({ trackUri: TRACK, startMs: 30_000, endMs: 42_000 });
    engine.onState(snapshot({ positionMs: 30_000, atMs: 0 }));

    expect(engine.tick(11_000)).toBeNull();
    const command = engine.tick(11_900);
    expect(command).toEqual({ type: 'seek', positionMs: 30_000, cause: 'loop-end' });
  });

  it('does not fire twice for one boundary crossing', () => {
    const engine = new LoopEngine({ lookaheadMs: 150 });
    engine.setRegion({ trackUri: TRACK, startMs: 0, endMs: 12_000 });
    engine.onState(snapshot({ positionMs: 0, atMs: 0 }));

    expect(engine.tick(11_900)).not.toBeNull();
    expect(engine.tick(11_950)).toBeNull();
    expect(engine.tick(12_100)).toBeNull();
  });

  it('ignores a stale event that still reports the pre-seek position', () => {
    const engine = new LoopEngine({ lookaheadMs: 150 });
    engine.setRegion({ trackUri: TRACK, startMs: 0, endMs: 12_000 });
    engine.onState(snapshot({ positionMs: 0, atMs: 0 }));
    expect(engine.tick(11_900)).not.toBeNull();

    // Event emitted just before the seek was applied.
    engine.onState(snapshot({ positionMs: 11_890, atMs: 11_920 }));
    expect(engine.tick(12_300)).toBeNull();
    expect(engine.seeksIssued).toBe(1);
  });

  it('loops a 12s section for 10 minutes without drift or double seeks', () => {
    const engine = new LoopEngine({ lookaheadMs: 150 });
    const startMs = 60_000;
    const endMs = 72_000;
    engine.setRegion({ trackUri: TRACK, startMs, endMs });
    engine.onState(snapshot({ positionMs: startMs, atMs: 0 }));

    const { seeks, overshoots } = runTicker(engine, { fromMs: 0, toMs: 600_000, stepMs: 16 });

    // ~12s per lap over ten minutes.
    expect(seeks.length).toBeGreaterThanOrEqual(48);
    expect(seeks.length).toBeLessThanOrEqual(52);

    // Every loop triggers within the lookahead window — no creeping drift.
    for (const overshoot of overshoots) {
      expect(overshoot).toBeLessThan(0);
      expect(overshoot).toBeGreaterThan(-300);
    }

    // Laps stay evenly spaced from first to last: no accumulated error.
    const gaps = seeks.slice(1).map((value, index) => value - seeks[index]!);
    for (const gap of gaps) {
      expect(Math.abs(gap - 12_000)).toBeLessThan(400);
    }
  });

  it('stands down when the user scrubs outside the region', () => {
    const engine = new LoopEngine({ lookaheadMs: 150 });
    engine.setRegion({ trackUri: TRACK, startMs: 10_000, endMs: 22_000 });
    engine.onState(snapshot({ positionMs: 10_000, atMs: 0 }));

    engine.onState(snapshot({ positionMs: 120_000, atMs: 5_000 }));
    expect(engine.isOverridden).toBe(true);
    expect(engine.tick(20_000)).toBeNull();

    engine.rearm();
    engine.onState(snapshot({ positionMs: 21_000, atMs: 21_000 }));
    expect(engine.tick(22_600)).not.toBeNull();
  });

  it('treats a repeat-track wrap as a loop, not a manual scrub', () => {
    const engine = new LoopEngine({ lookaheadMs: 0 });
    const durationMs = 100_000;
    engine.setRegion({ trackUri: TRACK, startMs: 80_000, endMs: durationMs });
    engine.onState(snapshot({ positionMs: 99_000, atMs: 0, durationMs }));

    // Spotify's own repeat wrapped to 0 before our lookahead fired.
    engine.onState(snapshot({ positionMs: 200, atMs: 1_100, durationMs }));
    expect(engine.isOverridden).toBe(false);

    const command = engine.tick(1_120);
    expect(command).toEqual({ type: 'seek', positionMs: 80_000, cause: 'wrapped' });
  });

  it('stays quiet while paused, for a different track, or when disabled', () => {
    const engine = new LoopEngine({ lookaheadMs: 150 });
    engine.setRegion({ trackUri: TRACK, startMs: 0, endMs: 5_000 });

    engine.onState(snapshot({ positionMs: 4_900, atMs: 0, paused: true }));
    expect(engine.tick(10_000)).toBeNull();

    engine.onState(snapshot({ positionMs: 4_900, atMs: 0, trackUri: 'spotify:track:other' }));
    expect(engine.tick(10_000)).toBeNull();

    engine.setEnabled(false);
    engine.onState(snapshot({ positionMs: 4_900, atMs: 0 }));
    expect(engine.tick(10_000)).toBeNull();

    engine.setEnabled(true);
    expect(engine.tick(10_100)).not.toBeNull();
  });

  it('clamps the lookahead to the documented 0–600ms range', () => {
    const engine = new LoopEngine();
    engine.setLookahead(5_000);
    expect(engine.lookaheadMs).toBe(600);
    engine.setLookahead(-20);
    expect(engine.lookaheadMs).toBe(0);
  });

  it('never seeks past the start when the lookahead exceeds the region length', () => {
    const engine = new LoopEngine({ lookaheadMs: 600 });
    engine.setRegion({ trackUri: TRACK, startMs: 0, endMs: 1_000 });
    engine.onState(snapshot({ positionMs: 0, atMs: 0 }));
    expect(engine.tick(1)).toBeNull();
    expect(engine.tick(500)).not.toBeNull();
  });
});
