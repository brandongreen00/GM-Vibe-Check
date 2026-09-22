import { apiRequest } from '../api/spotifyClient';
import {
  BaseBackend,
  delay,
  needsDeviceRecovery,
  type ApiFn,
  type PlaybackBackend,
} from './backend';
import type { PlaybackSnapshot } from './loopEngine';

/**
 * Phase 2: drive playback on another Spotify device (phone, desktop client, speaker)
 * instead of in this tab. Needed on mobile browsers and anywhere the Web Playback SDK
 * cannot run — but there is no push state, so position comes from polling and every
 * loop boundary costs a Web API call. Expect roughly ±500 ms slop: "rough loop mode".
 */

const TRANSFER_SETTLE_MS = 400;
/** Nothing is playing, so poll lazily — this is pure quota spend. */
const IDLE_POLL_MS = 5000;
/** A dragged volume slider would otherwise fire a Web API call per pixel. */
const VOLUME_THROTTLE_MS = 400;

export interface ConnectDevice {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  volumePercent: number | null;
}

interface DevicesResponse {
  devices?: Array<{
    id: string | null;
    name: string;
    type: string;
    is_active: boolean;
    is_restricted: boolean;
    volume_percent: number | null;
  }>;
}

interface PlayerItem {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists?: Array<{ name: string }>;
  album?: {
    name?: string;
    images?: Array<{ url: string; height: number | null; width: number | null }>;
  };
  is_playable?: boolean;
}

interface PlayerStateResponse {
  device?: { id: string | null; name: string; volume_percent: number | null };
  progress_ms?: number | null;
  is_playing?: boolean;
  item?: PlayerItem | null;
}

export interface ConnectOptions {
  api?: ApiFn;
  deviceId?: string | null;
  pollMs?: number;
  /** Injected in tests; defaults to the real timers and clock. */
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
}

export class ConnectBackend extends BaseBackend implements PlaybackBackend {
  readonly id = 'connect' as const;

  private readonly api: ApiFn;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => number;
  private readonly cancel: (handle: number) => void;

  private deviceId: string | null;
  private deviceName: string | null = null;
  private pollMs: number;
  private pollHandle: number | null = null;
  /** Set by shutdown() so a poll in flight cannot restart the timer afterwards. */
  private stopped = false;
  private playing = false;
  private volume = 1;
  private volumeHandle: number | null = null;
  private pendingVolume: number | null = null;

  constructor(options: ConnectOptions = {}) {
    super();
    this.api = options.api ?? apiRequest;
    this.now = options.now ?? (() => performance.now());
    this.schedule = options.schedule ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => window.clearTimeout(handle));
    this.deviceId = options.deviceId ?? null;
    this.pollMs = options.pollMs ?? 1000;
  }

  get isReady(): boolean {
    return this.deviceId !== null;
  }

  get deviceLabel(): string | null {
    if (!this.deviceId) return null;
    return `${this.deviceName ?? 'Spotify device'} · ${this.deviceId}`;
  }

  get currentDeviceId(): string | null {
    return this.deviceId;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.setStatus('connecting');
    if (!this.deviceId) {
      // Fall back to whatever Spotify currently calls active, so the user is not stuck
      // if they never picked a device.
      const devices = await this.listDevices().catch(() => [] as ConnectDevice[]);
      const active = devices.find((device) => device.isActive) ?? devices[0];
      if (active) this.deviceId = active.id;
      this.deviceName = active?.name ?? null;
    }
    if (!this.deviceId) {
      this.setStatus(
        'no-device',
        'No Spotify device is available. Open Spotify on your phone or desktop, play a second of anything, then refresh the device list.',
      );
    } else {
      this.setStatus('ready');
    }
    await this.poll();
    this.queuePoll();
  }

  async listDevices(): Promise<ConnectDevice[]> {
    const response = await this.api<DevicesResponse>('/me/player/devices', { tolerate403: true });
    return (response?.devices ?? [])
      .filter((device): device is typeof device & { id: string } => Boolean(device.id))
      .map((device) => ({
        id: device.id,
        name: device.name,
        type: device.type,
        isActive: device.is_active,
        isRestricted: device.is_restricted,
        volumePercent: device.volume_percent,
      }));
  }

  selectDevice(deviceId: string, name?: string): void {
    this.deviceId = deviceId;
    this.deviceName = name ?? null;
    this.setStatus('ready');
  }

  setPollInterval(ms: number): void {
    this.pollMs = Math.min(5000, Math.max(500, Math.round(ms)));
  }

  /** Nothing to unlock: the audio plays on another device, not in this tab. */
  async activate(): Promise<void> {}

  async transferPlayback(): Promise<void> {
    if (!this.deviceId) return;
    await this.api('/me/player', {
      method: 'PUT',
      body: { device_ids: [this.deviceId], play: false },
      tolerate403: true,
    });
  }

  async play(uri: string, positionMs: number): Promise<void> {
    if (!this.deviceId) {
      throw new Error('Pick a Spotify device in Settings before starting a vibe.');
    }
    try {
      await this.sendPlay(uri, positionMs);
    } catch (error) {
      if (!needsDeviceRecovery(error)) throw error;
      await this.transferPlayback();
      await delay(TRANSFER_SETTLE_MS);
      await this.sendPlay(uri, positionMs);
    }
    await this.api(`/me/player/repeat?state=track&device_id=${this.query()}`, {
      method: 'PUT',
      tolerate403: true,
    }).catch(() => undefined);
    this.playing = true;
    // Re-sync straight away rather than waiting out a whole poll interval.
    await this.poll();
  }

  private async sendPlay(uri: string, positionMs: number): Promise<void> {
    await this.api(`/me/player/play?device_id=${this.query()}`, {
      method: 'PUT',
      body: { uris: [uri], position_ms: Math.round(positionMs) },
    });
  }

  /** Every loop boundary spends one of these — the reason this mode is labelled rough. */
  async seek(positionMs: number): Promise<void> {
    await this.api(
      `/me/player/seek?position_ms=${Math.max(0, Math.round(positionMs))}&device_id=${this.query()}`,
      { method: 'PUT' },
    ).catch((error: unknown) => this.reportError(error));
  }

  async pause(): Promise<void> {
    this.playing = false;
    await this.api(`/me/player/pause?device_id=${this.query()}`, { method: 'PUT' }).catch(
      (error: unknown) => this.reportError(error),
    );
    await this.poll();
  }

  async resume(): Promise<void> {
    this.playing = true;
    await this.api(`/me/player/play?device_id=${this.query()}`, { method: 'PUT' }).catch(
      (error: unknown) => this.reportError(error),
    );
    await this.poll();
  }

  /**
   * Throttled, and not every Connect device accepts remote volume anyway, so a refusal
   * is not fatal.
   */
  async setVolume(volume: number): Promise<void> {
    this.volume = Math.min(1, Math.max(0, volume));
    this.pendingVolume = this.volume;
    if (this.volumeHandle !== null) return;
    await this.sendVolume();
    this.volumeHandle = this.schedule(() => {
      this.volumeHandle = null;
      // Send the last value the user landed on, not the one they dragged through.
      if (this.pendingVolume !== null) void this.sendVolume();
    }, VOLUME_THROTTLE_MS);
  }

  private async sendVolume(): Promise<void> {
    const value = this.pendingVolume;
    this.pendingVolume = null;
    if (value === null) return;
    await this.api(
      `/me/player/volume?volume_percent=${Math.round(value * 100)}&device_id=${this.query()}`,
      { method: 'PUT', tolerate403: true },
    ).catch(() => undefined);
  }

  async getVolume(): Promise<number> {
    return this.volume;
  }

  /** One `GET /me/player`, turned into the same snapshot shape the SDK emits. */
  async poll(): Promise<void> {
    if (this.stopped) return;
    let state: PlayerStateResponse | null = null;
    try {
      state = await this.api<PlayerStateResponse>('/me/player', { tolerate403: true });
    } catch (error) {
      this.reportError(error);
      return;
    }

    if (!state || !state.item) {
      this.playing = false;
      this.emitState({
        positionMs: 0,
        atMs: this.now(),
        paused: true,
        durationMs: 0,
        trackUri: null,
      });
      return;
    }

    if (state.device?.id && state.device.id !== this.deviceId) {
      // The user moved playback in the Spotify app; follow them rather than fighting it.
      this.deviceId = state.device.id;
      this.deviceName = state.device.name;
      this.handlers.playbackMoved?.();
    }
    if (state.device?.volume_percent !== null && state.device?.volume_percent !== undefined) {
      this.volume = state.device.volume_percent / 100;
    }

    const track = state.item;
    this.playing = Boolean(state.is_playing);

    const snapshot: PlaybackSnapshot = {
      // `progress_ms` is the position as of this response; network latency is the bulk
      // of the ±500 ms slop this mode is documented to have.
      positionMs: state.progress_ms ?? 0,
      atMs: this.now(),
      paused: !state.is_playing,
      durationMs: track.duration_ms,
      trackUri: track.uri,
    };
    // Shaped like an SDK state so the controller can cache the track and spot an
    // unplayable one without caring which backend it came from.
    this.emitState(snapshot, toPlayerState(state, track));
  }

  private queuePoll(): void {
    if (this.stopped) return;
    if (this.pollHandle !== null) this.cancel(this.pollHandle);
    const interval = this.playing ? this.pollMs : IDLE_POLL_MS;
    this.pollHandle = this.schedule(() => {
      void this.poll().finally(() => this.queuePoll());
    }, interval);
  }

  private query(): string {
    return encodeURIComponent(this.deviceId ?? '');
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.handlers.playbackError?.(message);
  }

  shutdown(): void {
    this.stopped = true;
    if (this.pollHandle !== null) this.cancel(this.pollHandle);
    if (this.volumeHandle !== null) this.cancel(this.volumeHandle);
    this.pollHandle = null;
    this.volumeHandle = null;
    this.stateListeners.clear();
  }
}

function toPlayerState(state: PlayerStateResponse, track: PlayerItem): Spotify.PlaybackState {
  return {
    paused: !state.is_playing,
    position: state.progress_ms ?? 0,
    duration: track.duration_ms,
    repeat_mode: 0,
    shuffle: false,
    track_window: {
      current_track: {
        id: track.id,
        uri: track.uri,
        name: track.name,
        duration_ms: track.duration_ms,
        artists: (track.artists ?? []).map((artist) => ({ name: artist.name, uri: '' })),
        album: {
          name: track.album?.name ?? '',
          uri: '',
          images: track.album?.images ?? [],
        },
        is_playable: track.is_playable,
      },
      previous_tracks: [],
      next_tracks: [],
    },
  };
}
