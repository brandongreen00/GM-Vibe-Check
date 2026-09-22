import type { PlaybackSnapshot } from './loopEngine';

/**
 * The playback surface the rest of the app talks to. Phase 1 implements this with the
 * Web Playback SDK; a Spotify Connect backend (polling `GET /me/player`, seeking over
 * the Web API) can be slotted in behind the same interface later.
 */
export interface PlaybackBackend {
  readonly id: 'web-playback-sdk' | 'connect';
  readonly isReady: boolean;
  /** Load the track and start at `positionMs`. */
  play(uri: string, positionMs: number): Promise<void>;
  seek(positionMs: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setVolume(volume: number): Promise<void>;
  getVolume(): Promise<number>;
  /** Fires on every playback state change the backend observes. */
  onState(cb: (snapshot: PlaybackSnapshot, raw: Spotify.PlaybackState | null) => void): () => void;
  /** Release the device so Spotify does not keep showing a ghost "Vibe Looper". */
  shutdown(): void;
}
