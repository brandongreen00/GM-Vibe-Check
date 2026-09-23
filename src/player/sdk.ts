import { apiRequest } from '../api/spotifyClient';
import { auth } from '../auth/tokens';
import {
  BaseBackend,
  delay,
  needsDeviceRecovery,
  type ApiFn,
  type PlaybackBackend,
} from './backend';
import type { PlaybackSnapshot } from './loopEngine';

const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';
/** Spotify needs a moment to accept the device before it will start playback on it. */
const TRANSFER_SETTLE_MS = 400;

let sdkLoader: Promise<void> | null = null;

/** Injects the SDK script once and resolves when Spotify calls the global ready hook. */
export function loadSpotifySdk(): Promise<void> {
  if (sdkLoader) return sdkLoader;
  sdkLoader = new Promise<void>((resolve, reject) => {
    if (window.Spotify) {
      resolve();
      return;
    }
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement('script');
    script.src = SDK_SRC;
    script.async = true;
    script.onerror = () =>
      reject(new Error('Could not load the Spotify Web Playback SDK (network blocked?).'));
    document.head.appendChild(script);
  });
  return sdkLoader;
}

export interface WebPlaybackOptions {
  api?: ApiFn;
  createPlayer?: (init: Spotify.PlayerInit) => Spotify.Player;
}

export class WebPlaybackBackend extends BaseBackend implements PlaybackBackend {
  readonly id = 'web-playback-sdk' as const;

  private player: Spotify.Player | null = null;
  private deviceId: string | null = null;
  private ready = false;
  private lastState: Spotify.PlaybackState | null = null;
  private repeatSetForUri: string | null = null;
  private activated = false;
  private hadState = false;
  private readonly api: ApiFn;
  private readonly createPlayer: (init: Spotify.PlayerInit) => Spotify.Player;
  /** Tests inject a player, and must not pull in Spotify's real script. */
  private readonly needsSdkScript: boolean;

  constructor(options: WebPlaybackOptions = {}) {
    super();
    this.api = options.api ?? apiRequest;
    this.needsSdkScript = options.createPlayer === undefined;
    this.createPlayer = options.createPlayer ?? ((init) => new window.Spotify.Player(init));
  }

  get isReady(): boolean {
    return this.ready && this.deviceId !== null;
  }

  get deviceLabel(): string | null {
    return this.deviceId ? `Vibe Looper (this tab) · ${this.deviceId}` : null;
  }

  get currentDeviceId(): string | null {
    return this.deviceId;
  }

  get currentTrackUri(): string | null {
    return this.lastState?.track_window.current_track.uri ?? null;
  }

  async start(): Promise<void> {
    this.setStatus('loading');
    if (this.needsSdkScript) await loadSpotifySdk();

    const player = this.createPlayer({
      name: 'Vibe Looper',
      // The SDK calls this on connect and whenever the token expires (hourly at most).
      getOAuthToken: (cb) => {
        auth
          .getValidToken()
          .then(cb)
          .catch(() => this.setStatus('auth-error', 'Could not refresh your Spotify token.'));
      },
      volume: 0.8,
    });
    this.player = player;

    player.addListener('ready', ({ device_id }) => {
      this.deviceId = device_id;
      this.ready = true;
      this.setStatus('ready');
      void this.transferPlayback();
    });
    player.addListener('not_ready', () => {
      // Keep the device id: Spotify usually brings the same device back, and `play()`
      // re-transfers before giving up.
      this.ready = false;
      this.setStatus('not-ready', 'The Vibe Looper device went offline.');
    });
    player.addListener('player_state_changed', (state) => {
      if (state === null) {
        // Another device took over. A null state before we ever held playback is just
        // an idle device, not a takeover, so it must not raise the banner.
        this.lastState = null;
        this.repeatSetForUri = null;
        this.emitState(idleSnapshot());
        if (this.hadState) this.handlers.playbackMoved?.();
        return;
      }
      this.hadState = true;
      this.lastState = state;
      this.emitState(toSnapshot(state), state);
    });
    player.addListener('autoplay_failed', () => this.handlers.autoplayFailed?.());
    player.addListener('initialization_error', ({ message }) =>
      this.setStatus('unsupported-browser', message),
    );
    player.addListener('authentication_error', ({ message }) =>
      this.setStatus('auth-error', message),
    );
    player.addListener('account_error', ({ message }) => this.setStatus('no-premium', message));
    player.addListener('playback_error', ({ message }) => this.handlers.playbackError?.(message));

    this.setStatus('connecting');
    const connected = await player.connect();
    if (!connected) this.setStatus('error', 'Spotify refused the player connection.');
  }

  /** Makes this tab the active Connect device without starting playback. */
  async transferPlayback(): Promise<void> {
    if (!this.deviceId) return;
    await this.api('/me/player', {
      method: 'PUT',
      body: { device_ids: [this.deviceId], play: false },
      tolerate403: true,
    });
  }

  /**
   * Browsers block programmatic audio until a user gesture; the SDK exposes
   * `activateElement()` for exactly this. Must be called inside a click handler.
   */
  async activate(): Promise<void> {
    if (this.activated || !this.player) return;
    await this.player.activateElement();
    this.activated = true;
  }

  async play(uri: string, positionMs: number): Promise<void> {
    if (!this.deviceId) throw new Error('The Vibe Looper player is not ready yet.');

    // Re-using an already loaded track is both faster and one fewer Web API call.
    if (this.currentTrackUri === uri && this.ready) {
      await this.seek(positionMs);
      await this.resume();
      return;
    }

    try {
      await this.sendPlay(uri, positionMs);
    } catch (error) {
      if (!needsDeviceRecovery(error)) throw error;
      // Spotify drops an idle web player out of the active-device slot — the usual
      // reason a second vibe refuses to start. Re-claim the slot and try once more.
      this.handlers.status?.('connecting', 'Re-claiming the Vibe Looper device…');
      await this.transferPlayback();
      await delay(TRANSFER_SETTLE_MS);
      await this.sendPlay(uri, positionMs);
      this.setStatus('ready');
    }
    await this.ensureRepeatTrack(uri);
  }

  private async sendPlay(uri: string, positionMs: number): Promise<void> {
    await this.api(`/me/player/play?device_id=${encodeURIComponent(this.deviceId ?? '')}`, {
      method: 'PUT',
      body: { uris: [uri], position_ms: Math.round(positionMs) },
    });
  }

  /**
   * Repeat-track is a safety net: when a Vibe ends at the very end of the song Spotify
   * wraps back to 0 instead of stopping, and the loop engine pulls it back into range.
   */
  private async ensureRepeatTrack(uri: string): Promise<void> {
    if (!this.deviceId || this.repeatSetForUri === uri) return;
    this.repeatSetForUri = uri;
    await this.api(`/me/player/repeat?state=track&device_id=${encodeURIComponent(this.deviceId)}`, {
      method: 'PUT',
      tolerate403: true,
    }).catch(() => {
      this.repeatSetForUri = null;
    });
  }

  async seek(positionMs: number): Promise<void> {
    await this.player?.seek(Math.max(0, Math.round(positionMs)));
  }

  async pause(): Promise<void> {
    await this.player?.pause();
  }

  async resume(): Promise<void> {
    await this.player?.resume();
  }

  async setVolume(volume: number): Promise<void> {
    await this.player?.setVolume(Math.min(1, Math.max(0, volume)));
  }

  async getVolume(): Promise<number> {
    return (await this.player?.getVolume()) ?? 0;
  }

  shutdown(): void {
    this.player?.disconnect();
    this.player = null;
    this.ready = false;
    this.deviceId = null;
    this.stateListeners.clear();
  }
}

function toSnapshot(state: Spotify.PlaybackState): PlaybackSnapshot {
  return {
    positionMs: state.position,
    atMs: performance.now(),
    paused: state.paused,
    durationMs: state.duration,
    trackUri: state.track_window.current_track.uri,
  };
}

function idleSnapshot(): PlaybackSnapshot {
  return { positionMs: 0, atMs: performance.now(), paused: true, durationMs: 0, trackUri: null };
}
