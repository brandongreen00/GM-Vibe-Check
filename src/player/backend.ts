import { SpotifyApiError, apiRequest } from '../api/spotifyClient';
import type { PlaybackSnapshot } from './loopEngine';

export type BackendId = 'web-playback-sdk' | 'connect';

export type BackendStatus =
  | 'idle'
  | 'loading'
  | 'connecting'
  | 'ready'
  | 'not-ready'
  | 'no-device'
  | 'no-premium'
  | 'unsupported-browser'
  | 'auth-error'
  | 'error';

export interface BackendEvents {
  status: (status: BackendStatus, detail?: string) => void;
  /** The browser blocked programmatic playback until a user gesture activates the element. */
  autoplayFailed: () => void;
  playbackError: (message: string) => void;
  /** Playback moved to another Spotify device — our device is no longer active. */
  playbackMoved: () => void;
}

export type StateListener = (snapshot: PlaybackSnapshot, raw: Spotify.PlaybackState | null) => void;

/** Injected so the backends can be unit-tested without a network. */
export type ApiFn = typeof apiRequest;

/**
 * The playback surface the rest of the app talks to. Two implementations exist: the
 * Web Playback SDK (audio in this tab, tight loops) and Spotify Connect (audio on
 * another device, rough loops driven by polling).
 */
export interface PlaybackBackend {
  readonly id: BackendId;
  readonly isReady: boolean;
  readonly status: BackendStatus;
  /** Human-readable device description for the diagnostics panel. */
  readonly deviceLabel: string | null;
  /** Connect to Spotify / begin polling. */
  start(): Promise<void>;
  /** Satisfy the browser's autoplay policy. Must be reached from a user gesture. */
  activate(): Promise<void>;
  /** Load the track and start at `positionMs`. */
  play(uri: string, positionMs: number): Promise<void>;
  seek(positionMs: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setVolume(volume: number): Promise<void>;
  getVolume(): Promise<number>;
  /** Re-claim the active device slot after Spotify handed it to something else. */
  transferPlayback(): Promise<void>;
  onState(cb: StateListener): () => void;
  on<K extends keyof BackendEvents>(event: K, handler: BackendEvents[K]): void;
  /** Release the device so Spotify does not keep showing a ghost "Vibe Looper". */
  shutdown(): void;
}

/**
 * Spotify drops an idle web player out of the active-device slot, and then refuses
 * `PUT /me/player/play?device_id=…` for it. That is recoverable: re-transfer and try
 * once more, rather than leaving the user on a soundboard button that does nothing.
 */
export function needsDeviceRecovery(error: unknown): boolean {
  if (!(error instanceof SpotifyApiError)) return false;
  return error.status === 404 || error.status === 403;
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Shared plumbing for the two backends. */
export abstract class BaseBackend {
  protected stateListeners = new Set<StateListener>();
  protected handlers: Partial<BackendEvents> = {};
  status: BackendStatus = 'idle';

  onState(cb: StateListener): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  on<K extends keyof BackendEvents>(event: K, handler: BackendEvents[K]): void {
    this.handlers[event] = handler;
  }

  protected setStatus(status: BackendStatus, detail?: string): void {
    this.status = status;
    this.handlers.status?.(status, detail);
  }

  protected emitState(snapshot: PlaybackSnapshot, raw: Spotify.PlaybackState | null = null): void {
    for (const cb of this.stateListeners) cb(snapshot, raw);
  }
}
