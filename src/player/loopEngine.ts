/**
 * A→B loop engine.
 *
 * Spotify has no native section loop, so we keep a local estimate of the playhead
 * that is re-synced on every `player_state_changed` event and seek back to the loop
 * start shortly before the end point is reached.
 *
 * This module is deliberately pure: its only inputs are state snapshots plus a
 * monotonic `now`, and its only output is a "seek to X" command. That makes the
 * whole timing behaviour drivable from Vitest with a fake clock.
 */

export interface PlaybackSnapshot {
  /** Position reported by the SDK at the moment the event fired. */
  positionMs: number;
  /** Monotonic clock reading (performance.now()) when the event was observed. */
  atMs: number;
  paused: boolean;
  durationMs: number;
  trackUri: string | null;
}

export interface LoopRegion {
  trackUri: string;
  startMs: number;
  endMs: number;
}

export interface SeekCommand {
  type: 'seek';
  positionMs: number;
  /** Why we are seeking — surfaced in the diagnostics panel. */
  cause: 'loop-end' | 'wrapped';
}

export interface LoopEngineOptions {
  lookaheadMs?: number;
  /** How long to ignore further triggers after issuing a seek. */
  debounceMs?: number;
  /** How far outside the region a reported position may drift before we call it a manual scrub. */
  manualToleranceMs?: number;
}

export const DEFAULT_DEBOUNCE_MS = 300;
export const DEFAULT_MANUAL_TOLERANCE_MS = 1500;
/** A jump back past the loop start from near the end is Spotify's repeat, not the user. */
const WRAP_WINDOW_MS = 3000;
/** After this long without a confirming event we stop assuming our seek landed. */
const SEEK_CONFIRM_TIMEOUT_MS = 2000;

export class LoopEngine {
  private region: LoopRegion | null = null;
  private snapshot: PlaybackSnapshot | null = null;
  private enabled = true;
  private overridden = false;
  private ignoreUntilMs = 0;
  private awaitingSeekTo: number | null = null;
  private awaitingSince = 0;
  private seekCount = 0;

  lookaheadMs: number;
  readonly debounceMs: number;
  readonly manualToleranceMs: number;

  constructor(options: LoopEngineOptions = {}) {
    this.lookaheadMs = options.lookaheadMs ?? 150;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.manualToleranceMs = options.manualToleranceMs ?? DEFAULT_MANUAL_TOLERANCE_MS;
  }

  get activeRegion(): LoopRegion | null {
    return this.region;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** True when the user scrubbed outside the region and the loop stood down. */
  get isOverridden(): boolean {
    return this.overridden;
  }

  get seeksIssued(): number {
    return this.seekCount;
  }

  setRegion(region: LoopRegion | null): void {
    this.region = region;
    this.overridden = false;
    this.ignoreUntilMs = 0;
    this.awaitingSeekTo = null;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) this.overridden = false;
  }

  setLookahead(lookaheadMs: number): void {
    this.lookaheadMs = Math.min(600, Math.max(0, Math.round(lookaheadMs)));
  }

  /** Re-arms the loop after a manual scrub without changing the region. */
  rearm(): void {
    this.overridden = false;
    this.ignoreUntilMs = 0;
  }

  /** Feed every `player_state_changed` event here. */
  onState(snapshot: PlaybackSnapshot): void {
    const region = this.region;
    if (!region || snapshot.trackUri !== region.trackUri) {
      this.snapshot = snapshot;
      return;
    }

    if (this.awaitingSeekTo !== null) {
      const landed = Math.abs(snapshot.positionMs - this.awaitingSeekTo) <= this.manualToleranceMs;
      if (landed) {
        this.awaitingSeekTo = null;
        this.ignoreUntilMs = 0;
        this.snapshot = snapshot;
        return;
      }
      // An event queued before our seek was applied still reports the old position.
      // Trusting it would rewind our estimate to the loop end and fire a second seek,
      // so we keep the assumed position until the seek is confirmed or clearly lost.
      if (snapshot.atMs - this.awaitingSince < SEEK_CONFIRM_TIMEOUT_MS) return;
      this.awaitingSeekTo = null;
    }

    const previous = this.snapshot;
    this.snapshot = snapshot;

    const previousEstimate =
      previous && previous.trackUri === region.trackUri
        ? estimatePosition(previous, snapshot.atMs)
        : null;
    const wrapped =
      previousEstimate !== null &&
      previousEstimate >= region.endMs - WRAP_WINDOW_MS &&
      snapshot.positionMs < region.startMs;
    if (wrapped) return;

    const outside =
      snapshot.positionMs < region.startMs - this.manualToleranceMs ||
      snapshot.positionMs > region.endMs + this.manualToleranceMs;
    if (outside) this.overridden = true;
  }

  /** Current best guess of the playhead, extrapolated from the last state event. */
  estimate(nowMs: number): number | null {
    if (!this.snapshot) return null;
    return estimatePosition(this.snapshot, nowMs);
  }

  /** Call from the ticker. Returns a seek to issue, or null. */
  tick(nowMs: number): SeekCommand | null {
    const region = this.region;
    const snapshot = this.snapshot;
    if (!region || !snapshot || !this.enabled || this.overridden) return null;
    if (snapshot.paused) return null;
    if (snapshot.trackUri !== region.trackUri) return null;
    if (nowMs < this.ignoreUntilMs) return null;

    const position = estimatePosition(snapshot, nowMs);
    const boundary = Math.max(region.startMs + 1, region.endMs - this.lookaheadMs);

    let cause: SeekCommand['cause'] | null = null;
    if (position >= boundary) cause = 'loop-end';
    // Spotify's repeat-track wrapped us to the top of the song; pull back to the region.
    else if (position < region.startMs) cause = 'wrapped';
    if (!cause) return null;

    // Assume the seek lands, so the next tick does not fire a second one while we wait
    // for the confirming state event.
    this.snapshot = { ...snapshot, positionMs: region.startMs, atMs: nowMs };
    this.awaitingSeekTo = region.startMs;
    this.awaitingSince = nowMs;
    this.ignoreUntilMs = nowMs + this.debounceMs;
    this.seekCount += 1;
    return { type: 'seek', positionMs: region.startMs, cause };
  }

  reset(): void {
    this.region = null;
    this.snapshot = null;
    this.overridden = false;
    this.ignoreUntilMs = 0;
    this.awaitingSeekTo = null;
  }
}

export function estimatePosition(snapshot: PlaybackSnapshot, nowMs: number): number {
  if (snapshot.paused) return snapshot.positionMs;
  const elapsed = Math.max(0, nowMs - snapshot.atMs);
  const estimated = snapshot.positionMs + elapsed;
  return snapshot.durationMs > 0 ? Math.min(estimated, snapshot.durationMs) : estimated;
}
