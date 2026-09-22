/**
 * Minimal typings for the bits of the Web Playback SDK we actually call.
 * Hand-written on purpose — a third-party wrapper would be far more surface
 * area than this app needs.
 */
declare namespace Spotify {
  interface Artist {
    name: string;
    uri: string;
  }

  interface Album {
    name: string;
    uri: string;
    images: Array<{ url: string; height: number | null; width: number | null }>;
  }

  interface Track {
    id: string | null;
    uri: string;
    name: string;
    duration_ms: number;
    artists: Artist[];
    album: Album;
    is_playable?: boolean;
  }

  interface PlaybackState {
    paused: boolean;
    position: number;
    duration: number;
    repeat_mode: number;
    shuffle: boolean;
    track_window: {
      current_track: Track;
      previous_tracks: Track[];
      next_tracks: Track[];
    };
  }

  interface Error {
    message: string;
  }

  interface PlayerInit {
    name: string;
    getOAuthToken: (cb: (token: string) => void) => void;
    volume?: number;
  }

  class Player {
    constructor(init: PlayerInit);
    connect(): Promise<boolean>;
    disconnect(): void;
    activateElement(): Promise<void>;
    getCurrentState(): Promise<PlaybackState | null>;
    setName(name: string): Promise<void>;
    getVolume(): Promise<number>;
    setVolume(volume: number): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    togglePlay(): Promise<void>;
    seek(positionMs: number): Promise<void>;
    previousTrack(): Promise<void>;
    nextTrack(): Promise<void>;
    addListener(event: 'ready' | 'not_ready', cb: (data: { device_id: string }) => void): boolean;
    addListener(event: 'player_state_changed', cb: (state: PlaybackState | null) => void): boolean;
    addListener(event: 'autoplay_failed', cb: () => void): boolean;
    addListener(
      event: 'initialization_error' | 'authentication_error' | 'account_error' | 'playback_error',
      cb: (error: Error) => void,
    ): boolean;
    removeListener(event: string, cb?: (...args: unknown[]) => void): boolean;
  }
}

interface Window {
  Spotify: typeof Spotify;
  onSpotifyWebPlaybackSDKReady: () => void;
}
