import { trackRefFromPlayerTrack } from '../api/library';
import { db } from '../store/db';
import { settings } from '../store/settings';
import type { PlaybackMode, Vibe } from '../types';
import type { BackendEvents, BackendStatus, PlaybackBackend } from './backend';
import { ConnectBackend } from './connect';
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
  mode: PlaybackMode;
}

/** Something the user needs to know about and can usually act on. */
export interface PlaybackIssue {
  kind: 'start-failed' | 'never-started';
  message: string;
  retry: () => Promise<void>;
}

/** When the tab is hidden rAF stops firing, so we fall back to a timer. */
const HIDDEN_TICK_MS = 50;
/** How long to give Spotify to actually start a track before we call it a failure. */
const PLAYBACK_WATCHDOG_MS = 5000;

export class PlaybackController {
  private _backend: PlaybackBackend;
  readonly engine = new LoopEngine({ lookaheadMs: settings.current.seekLookaheadMs });

  private activeVibe: Vibe | null = null;
  private previewRegion: LoopRegion | null = null;
  private lastSnapshot: PlaybackSnapshot | null = null;
  private rafHandle: number | null = null;
  private intervalHandle: number | null = null;
  private listeners = new Set<(view: PlaybackView) => void>();
  private issueListeners = new Set<(issue: PlaybackIssue) => void>();
  private backendHandlers: Partial<BackendEvents> = {};
  private detachBackend: (() => void) | null = null;
  private diagnostics: DiagnosticEntry[] = [];
  private volume = settings.current.defaultVolume;
  private pendingVibe: Vibe | null = null;
  /** Bumped on every ramp so an interrupted fade cannot strand the volume at zero. */
  private rampToken = 0;

  constructor() {
    this._backend = this.createBackend(settings.current.playbackMode);
    this.attachBackend();
    settings.subscribe((value) => {
      this.engine.setLookahead(value.seekLookaheadMs);
    });
    this.startTicker();
  }

  get backend(): PlaybackBackend {
    return this._backend;
  }

  get mode(): PlaybackMode {
    return this._backend.id === 'connect' ? 'connect' : 'sdk';
  }

  private createBackend(mode: PlaybackMode): PlaybackBackend {
    if (mode === 'connect') {
      return new ConnectBackend({
        deviceId: settings.current.connectDeviceId ?? null,
        pollMs: settings.current.connectPollMs,
      });
    }
    return new WebPlaybackBackend();
  }

  private attachBackend(): void {
    const off = this._backend.onState((snapshot, raw) => {
      this.lastSnapshot = snapshot;
      this.engine.onState(snapshot);
      this.notePlayability(raw);
      this.emit();
    });
    for (const [event, handler] of Object.entries(this.backendHandlers)) {
      this._backend.on(event as keyof BackendEvents, handler as BackendEvents[keyof BackendEvents]);
    }
    this.detachBackend = off;
  }

  /** Swap between in-browser playback and a remote Spotify Connect device. */
  async useMode(mode: PlaybackMode): Promise<void> {
    if (this.mode === mode) return;
    await this.stop().catch(() => undefined);
    this.detachBackend?.();
    this._backend.shutdown();
    this._backend = this.createBackend(mode);
    this.attachBackend();
    this.lastSnapshot = null;
    this.engine.reset();
    this.note(`playback mode → ${mode}`);
    await this._backend.start();
    await this.setVolume(this.volume);
    this.emit();
  }

  /** Registers a handler that survives backend swaps. */
  on<K extends keyof BackendEvents>(event: K, handler: BackendEvents[K]): void {
    this.backendHandlers[event] = handler;
    this._backend.on(event, handler);
  }

  onIssue(fn: (issue: PlaybackIssue) => void): () => void {
    this.issueListeners.add(fn);
    return () => this.issueListeners.delete(fn);
  }

  private raiseIssue(issue: PlaybackIssue): void {
    this.note(`issue: ${issue.message}`);
    for (const fn of this.issueListeners) fn(issue);
  }

  /**
   * `me.product` and `available_markets` are gone, so the only signal that a track has
   * become unplayable is what the player reports while it is loaded.
   */
  private notePlayability(raw: Spotify.PlaybackState | null): void {
    const current = raw?.track_window.current_track;
    if (!current) return;
    const cached = db.track(current.uri);
    if (!cached) {
      // Rough loop mode can surface a track the user never browsed to, so cache it
      // here rather than spending a Web API call to name it later.
      void db.putTrack(trackRefFromPlayerTrack(current));
      return;
    }
    if (current.is_playable === undefined || cached.isPlayable === current.is_playable) return;
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
      mode: this.mode,
    };
  }

  get status(): BackendStatus {
    return this._backend.status;
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
      void this._backend.seek(command.positionMs);
    }
    if (this.listeners.size > 0) this.emit();
  }

  /** Must be reachable from a click handler so `activateElement()` counts as a gesture. */
  async startVibe(vibe: Vibe): Promise<void> {
    this.pendingVibe = vibe;
    await this._backend.activate().catch(() => undefined);

    const region: LoopRegion = {
      trackUri: vibe.trackUri,
      startMs: vibe.startMs,
      endMs: vibe.endMs,
    };
    const previous = this.snapshotSelection();
    // Each ramp step is a Web API call on a Connect device, so fading there would cost
    // ~20 calls per switch. Rough loop mode hard-cuts instead.
    const shouldFade =
      settings.current.fadeOnSwitch &&
      this.mode === 'sdk' &&
      this.activeVibe !== null &&
      !this.lastSnapshot?.paused;

    if (shouldFade) await this.rampVolume(0, settings.current.fadeMs);

    this.activeVibe = vibe;
    this.previewRegion = null;
    this.engine.setEnabled(true);
    this.engine.setRegion(region);

    try {
      await this._backend.play(vibe.trackUri, vibe.startMs);
      this.note(`play "${vibe.title}" @ ${vibe.startMs}ms`);
    } catch (error) {
      // Leaving the vibe marked active would make the next tap a pause/resume of the
      // track that is still loaded — the user taps and the *previous* song resumes.
      this.restoreSelection(previous);
      this.raiseIssue({
        kind: 'start-failed',
        message: `Could not start "${vibe.title}": ${describe(error)}`,
        retry: () => this.startVibe(vibe),
      });
      throw error;
    } finally {
      if (shouldFade) await this.rampVolume(this.volume, settings.current.fadeMs);
      else await this._backend.setVolume(this.volume);
    }

    this.pendingVibe = null;
    this.emit();
    void this.watchPlaybackStarts(vibe.trackUri, () => this.startVibe(vibe));
  }

  /**
   * Spotify can accept a play request and still not start — the device was handed to
   * something else in the meantime. Nothing in the API reports that, so we watch for
   * the state event that should follow and offer a one-click recovery if it never comes.
   */
  private async watchPlaybackStarts(uri: string, retry: () => Promise<void>): Promise<void> {
    const started = await this.waitForTrack(uri, PLAYBACK_WATCHDOG_MS);
    if (started) return;
    this.raiseIssue({
      kind: 'never-started',
      message:
        'Spotify accepted the command but playback never started — the device was probably taken over.',
      retry: async () => {
        await this._backend.transferPlayback();
        await retry();
      },
    });
  }

  private waitForTrack(uri: string, timeoutMs: number): Promise<boolean> {
    if (this.lastSnapshot?.trackUri === uri && !this.lastSnapshot.paused)
      return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        off();
        resolve(ok);
      };
      const off = this._backend.onState((snapshot) => {
        if (snapshot.trackUri === uri && !snapshot.paused) finish(true);
      });
      const timer = window.setTimeout(() => finish(false), timeoutMs);
    });
  }

  private snapshotSelection(): { vibe: Vibe | null; preview: LoopRegion | null } {
    return { vibe: this.activeVibe, preview: this.previewRegion };
  }

  private restoreSelection(previous: { vibe: Vibe | null; preview: LoopRegion | null }): void {
    this.activeVibe = previous.vibe;
    this.previewRegion = previous.preview;
    const region = previous.vibe
      ? {
          trackUri: previous.vibe.trackUri,
          startMs: previous.vibe.startMs,
          endMs: previous.vibe.endMs,
        }
      : previous.preview;
    this.engine.setRegion(region);
    this.emit();
  }

  /** Re-issues the Vibe that was blocked by the browser's autoplay policy. */
  async retryPendingVibe(): Promise<void> {
    const vibe = this.pendingVibe ?? this.activeVibe;
    await this._backend.activate().catch(() => undefined);
    if (vibe) await this.startVibe(vibe);
  }

  /** Arms the loop on an unsaved range from the Vibe editor. */
  async previewRange(trackUri: string, startMs: number, endMs: number): Promise<void> {
    await this._backend.activate().catch(() => undefined);
    const region: LoopRegion = { trackUri, startMs, endMs };
    const previous = this.snapshotSelection();
    this.activeVibe = null;
    this.previewRegion = region;
    this.engine.setEnabled(true);
    this.engine.setRegion(region);
    try {
      await this._backend.play(trackUri, startMs);
    } catch (error) {
      this.restoreSelection(previous);
      this.raiseIssue({
        kind: 'start-failed',
        message: `Could not preview this loop: ${describe(error)}`,
        retry: () => this.previewRange(trackUri, startMs, endMs),
      });
      throw error;
    }
    await this._backend.setVolume(this.volume);
    this.note(`preview ${startMs}–${endMs}ms`);
    this.emit();
    void this.watchPlaybackStarts(trackUri, () => this.previewRange(trackUri, startMs, endMs));
  }

  /** Plays without arming the loop — used by "Play from start" in the editor. */
  async playFrom(trackUri: string, positionMs: number): Promise<void> {
    await this._backend.activate().catch(() => undefined);
    const previous = this.snapshotSelection();
    this.engine.setRegion(null);
    this.previewRegion = null;
    this.activeVibe = null;
    try {
      await this._backend.play(trackUri, positionMs);
    } catch (error) {
      this.restoreSelection(previous);
      this.raiseIssue({
        kind: 'start-failed',
        message: `Could not play this track: ${describe(error)}`,
        retry: () => this.playFrom(trackUri, positionMs),
      });
      throw error;
    }
    await this._backend.setVolume(this.volume);
    this.emit();
  }

  async togglePause(): Promise<void> {
    if (this.lastSnapshot?.paused) await this._backend.resume();
    else await this._backend.pause();
    this.emit();
  }

  async stop(): Promise<void> {
    this.activeVibe = null;
    this.previewRegion = null;
    this.engine.setRegion(null);
    await this._backend.pause();
    this.note('stop');
    this.emit();
  }

  async seek(positionMs: number): Promise<void> {
    await this._backend.seek(positionMs);
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
    this.rampToken += 1;
    this.volume = volume;
    await this._backend.setVolume(volume);
    this.emit();
  }

  private async rampVolume(target: number, durationMs: number): Promise<void> {
    this.rampToken += 1;
    const token = this.rampToken;
    if (durationMs <= 0) {
      await this._backend.setVolume(target);
      return;
    }
    const from = await this._backend.getVolume().catch(() => this.volume);
    const steps = Math.max(1, Math.round(durationMs / 40));
    for (let step = 1; step <= steps; step += 1) {
      // A newer ramp (or an explicit volume change) owns the volume now; bailing out
      // without finishing this one is what leaves playback silent.
      if (token !== this.rampToken) return;
      await this._backend.setVolume(from + ((target - from) * step) / steps);
      await new Promise((resolve) => setTimeout(resolve, durationMs / steps));
    }
  }

  shutdown(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    if (this.intervalHandle !== null) window.clearInterval(this.intervalHandle);
    this._backend.shutdown();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
