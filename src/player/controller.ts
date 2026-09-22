import { db } from '../store/db';
import { settings } from '../store/settings';
import type { Vibe } from '../types';
import { LoopEngine, type LoopRegion, type PlaybackSnapshot } from './loopEngine';
import { WebPlaybackBackend } from './sdk';

export interface DiagnosticEntry {
  at: number;
  message: string;
}

export interface PlaybackView {
  activeVibeId: string | null;
  /** Set while previewing an unsaved range from the editor. */
  previewRegion: LoopRegion | null;
  trackUri: string | null;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  loopEnabled: boolean;
  loopOverridden: boolean;
  volume: number;
}

/** When the tab is hidden rAF stops firing, so we fall back to a timer. */
const HIDDEN_TICK_MS = 50;

export class PlaybackController {
  readonly backend = new WebPlaybackBackend();
  readonly engine = new LoopEngine({ lookaheadMs: settings.current.seekLookaheadMs });

  private activeVibe: Vibe | null = null;
  private previewRegion: LoopRegion | null = null;
  private lastSnapshot: PlaybackSnapshot | null = null;
  private rafHandle: number | null = null;
  private intervalHandle: number | null = null;
  private listeners = new Set<(view: PlaybackView) => void>();
  private diagnostics: DiagnosticEntry[] = [];
  private volume = settings.current.defaultVolume;
  private pendingVibe: Vibe | null = null;

  constructor() {
    this.backend.onState((snapshot, raw) => {
      this.lastSnapshot = snapshot;
      this.engine.onState(snapshot);
      this.notePlayability(raw);
      this.emit();
    });
    settings.subscribe((value) => {
      this.engine.setLookahead(value.seekLookaheadMs);
    });
    this.startTicker();
  }

  /**
   * `me.product` and `available_markets` are gone, so the only signal that a track has
   * become unplayable is what the player reports while it is loaded.
   */
  private notePlayability(raw: Spotify.PlaybackState | null): void {
    const current = raw?.track_window.current_track;
    if (!current || current.is_playable === undefined) return;
    const cached = db.track(current.uri);
    if (!cached || cached.isPlayable === current.is_playable) return;
    void db.putTrack({ ...cached, isPlayable: current.is_playable });
    if (!current.is_playable) this.note(`track not playable: ${current.uri}`);
  }

  subscribe(fn: (view: PlaybackView) => void): () => void {
    this.listeners.add(fn);
    fn(this.view);
    return () => this.listeners.delete(fn);
  }

  get view(): PlaybackView {
    const estimate = this.engine.estimate(performance.now());
    return {
      activeVibeId: this.activeVibe?.id ?? null,
      previewRegion: this.previewRegion,
      trackUri: this.lastSnapshot?.trackUri ?? null,
      positionMs: estimate ?? this.lastSnapshot?.positionMs ?? 0,
      durationMs: this.lastSnapshot?.durationMs ?? 0,
      paused: this.lastSnapshot?.paused ?? true,
      loopEnabled: this.engine.isEnabled,
      loopOverridden: this.engine.isOverridden,
      volume: this.volume,
    };
  }

  get log(): DiagnosticEntry[] {
    return this.diagnostics;
  }

  note(message: string): void {
    this.diagnostics.unshift({ at: Date.now(), message });
    if (this.diagnostics.length > 100) this.diagnostics.length = 100;
  }

  private emit(): void {
    const view = this.view;
    for (const fn of this.listeners) fn(view);
  }

  private startTicker(): void {
    const tick = () => {
      this.runTick();
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.intervalHandle === null) {
          this.intervalHandle = window.setInterval(() => this.runTick(), HIDDEN_TICK_MS);
        }
      } else if (this.intervalHandle !== null) {
        window.clearInterval(this.intervalHandle);
        this.intervalHandle = null;
      }
    });
  }

  private runTick(): void {
    const command = this.engine.tick(performance.now());
    if (command) {
      this.note(
        `seek → ${Math.round(command.positionMs)}ms (${command.cause}, lookahead ${this.engine.lookaheadMs}ms)`,
      );
      void this.backend.seek(command.positionMs);
    }
    if (this.listeners.size > 0) this.emit();
  }

  /** Must be reachable from a click handler so `activateElement()` counts as a gesture. */
  async startVibe(vibe: Vibe): Promise<void> {
    this.pendingVibe = vibe;
    await this.backend.activate().catch(() => undefined);

    const region: LoopRegion = {
      trackUri: vibe.trackUri,
      startMs: vibe.startMs,
      endMs: vibe.endMs,
    };
    const switchingTrack = this.lastSnapshot?.trackUri !== vibe.trackUri;
    const shouldFade =
      settings.current.fadeOnSwitch && this.activeVibe !== null && !this.lastSnapshot?.paused;

    if (shouldFade) await this.rampVolume(0, settings.current.fadeMs);

    this.activeVibe = vibe;
    this.previewRegion = null;
    this.engine.setEnabled(true);
    this.engine.setRegion(region);

    try {
      await this.backend.play(vibe.trackUri, vibe.startMs);
      this.note(`play "${vibe.title}" @ ${vibe.startMs}ms${switchingTrack ? ' (new track)' : ''}`);
    } finally {
      if (shouldFade) await this.rampVolume(this.volume, settings.current.fadeMs);
      else await this.backend.setVolume(this.volume);
    }
    this.pendingVibe = null;
    this.emit();
  }

  /** Re-issues the Vibe that was blocked by the browser's autoplay policy. */
  async retryPendingVibe(): Promise<void> {
    const vibe = this.pendingVibe ?? this.activeVibe;
    await this.backend.activate().catch(() => undefined);
    if (vibe) await this.startVibe(vibe);
  }

  /** Arms the loop on an unsaved range from the Vibe editor. */
  async previewRange(trackUri: string, startMs: number, endMs: number): Promise<void> {
    await this.backend.activate().catch(() => undefined);
    const region: LoopRegion = { trackUri, startMs, endMs };
    this.activeVibe = null;
    this.previewRegion = region;
    this.engine.setEnabled(true);
    this.engine.setRegion(region);
    await this.backend.play(trackUri, startMs);
    await this.backend.setVolume(this.volume);
    this.note(`preview ${startMs}–${endMs}ms`);
    this.emit();
  }

  /** Plays without arming the loop — used by "Play from start" in the editor. */
  async playFrom(trackUri: string, positionMs: number): Promise<void> {
    await this.backend.activate().catch(() => undefined);
    this.engine.setRegion(null);
    this.previewRegion = null;
    this.activeVibe = null;
    await this.backend.play(trackUri, positionMs);
    await this.backend.setVolume(this.volume);
    this.emit();
  }

  async togglePause(): Promise<void> {
    if (this.lastSnapshot?.paused) await this.backend.resume();
    else await this.backend.pause();
    this.emit();
  }

  async stop(): Promise<void> {
    this.activeVibe = null;
    this.previewRegion = null;
    this.engine.setRegion(null);
    await this.backend.pause();
    this.note('stop');
    this.emit();
  }

  async seek(positionMs: number): Promise<void> {
    await this.backend.seek(positionMs);
  }

  setLoopEnabled(enabled: boolean): void {
    this.engine.setEnabled(enabled);
    this.emit();
  }

  rearmLoop(): void {
    this.engine.rearm();
    this.emit();
  }

  async setVolume(volume: number): Promise<void> {
    this.volume = volume;
    await this.backend.setVolume(volume);
    this.emit();
  }

  private async rampVolume(target: number, durationMs: number): Promise<void> {
    if (durationMs <= 0) {
      await this.backend.setVolume(target);
      return;
    }
    const from = await this.backend.getVolume().catch(() => this.volume);
    const steps = Math.max(1, Math.round(durationMs / 40));
    for (let step = 1; step <= steps; step += 1) {
      const value = from + ((target - from) * step) / steps;
      await this.backend.setVolume(value);
      await new Promise((resolve) => setTimeout(resolve, durationMs / steps));
    }
  }

  shutdown(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    if (this.intervalHandle !== null) window.clearInterval(this.intervalHandle);
    this.backend.shutdown();
  }
}
