/** Persisted in localStorage. Never contains a client secret — PKCE does not need one. */
export interface AuthState {
  clientId: string;
  accessToken?: string;
  refreshToken?: string;
  /** epoch ms, already includes a 60s safety margin */
  expiresAt?: number;
  scope?: string;
  userId?: string;
  displayName?: string;
}

export type TapActiveBehaviour = 'toggle' | 'stop';

export interface Settings {
  /** Compensates for seek latency at the loop boundary. 0..600 */
  seekLookaheadMs: number;
  defaultVolume: number;
  fadeOnSwitch: boolean;
  fadeMs: number;
  tapActiveBehaviour: TapActiveBehaviour;
}

export interface TrackRef {
  /** "spotify:track:…" — canonical key everywhere in the app */
  uri: string;
  id: string;
  name: string;
  artists: string[];
  albumName: string;
  albumArtUrl?: string;
  durationMs: number;
  /** undefined = unknown; false = Spotify refused to play it on this account. */
  isPlayable?: boolean;
  cachedAt: number;
}

export interface Vibe {
  id: string;
  listId: string;
  title: string;
  trackUri: string;
  startMs: number;
  /** exclusive; always > startMs + 1000 */
  endMs: number;
  color?: string;
  hotkey?: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface VibeList {
  id: string;
  name: string;
  order: number;
  createdAt: number;
}

export interface ExportBundle {
  version: 1;
  lists: VibeList[];
  vibes: Vibe[];
  tracks: TrackRef[];
}

export const MIN_VIBE_LENGTH_MS = 1000;

export const DEFAULT_SETTINGS: Settings = {
  seekLookaheadMs: 150,
  defaultVolume: 0.8,
  fadeOnSwitch: true,
  fadeMs: 400,
  tapActiveBehaviour: 'toggle',
};

export const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-library-read',
  'playlist-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
].join(' ');
