import { describe, expect, it, vi } from 'vitest';
import { SpotifyApiError } from '../src/api/spotifyClient';
import { needsDeviceRecovery } from '../src/player/backend';
import { ConnectBackend } from '../src/player/connect';
import { LoopEngine, type PlaybackSnapshot } from '../src/player/loopEngine';
import { WebPlaybackBackend } from '../src/player/sdk';

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

/** Records every request and replays queued outcomes, newest rule first. */
function fakeApi(
  rules: Array<{ match: RegExp; throws?: unknown; returns?: unknown; once?: boolean }> = [],
) {
  const calls: Call[] = [];
  const remaining = [...rules];
  const api = vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    calls.push({ path, method: options.method ?? 'GET', body: options.body });
    const index = remaining.findIndex((rule) => rule.match.test(path));
    if (index === -1) return null;
    const rule = remaining[index]!;
    if (rule.once !== false) remaining.splice(index, 1);
    if (rule.throws) throw rule.throws;
    return rule.returns ?? null;
  });
  return { api: api as never, calls };
}

/** Minimal stand-in for Spotify.Player — only what the backend actually touches. */
function fakePlayer() {
  const listeners: Record<string, Array<(payload: never) => void>> = {};
  const seeks: number[] = [];
  const player = {
    addListener(event: string, cb: (payload: never) => void) {
      (listeners[event] ??= []).push(cb);
      return true;
    },
    connect: async () => true,
    disconnect() {},
    activateElement: async () => undefined,
    getCurrentState: async () => null,
    seek: async (ms: number) => {
      seeks.push(ms);
    },
    pause: async () => undefined,
    resume: async () => undefined,
    setVolume: async () => undefined,
    getVolume: async () => 1,
  } as unknown as Spotify.Player;
  const emit = (event: string, payload?: unknown) => {
    for (const cb of listeners[event] ?? []) cb(payload as never);
  };
  return { player, emit, seeks };
}

async function readyBackend(rules: Parameters<typeof fakeApi>[0] = []) {
  const { api, calls } = fakeApi(rules);
  const { player, emit, seeks } = fakePlayer();
  const backend = new WebPlaybackBackend({ api, createPlayer: () => player });
  await backend.start();
  emit('ready', { device_id: 'device-1' });
  await Promise.resolve();
  return { backend, calls, emit, seeks };
}

describe('needsDeviceRecovery', () => {
  it('recovers from the statuses Spotify uses for a device it has dropped', () => {
    expect(
      needsDeviceRecovery(new SpotifyApiError('Device not found', 404, '/me/player/play')),
    ).toBe(true);
    expect(needsDeviceRecovery(new SpotifyApiError('Forbidden', 403, '/me/player/play'))).toBe(
      true,
    );
  });

  it('does not swallow other failures', () => {
    expect(needsDeviceRecovery(new SpotifyApiError('Bad request', 400, '/x'))).toBe(false);
    expect(needsDeviceRecovery(new SpotifyApiError('Server error', 500, '/x'))).toBe(false);
    expect(needsDeviceRecovery(new Error('offline'))).toBe(false);
  });
});

describe('WebPlaybackBackend', () => {
  it('claims the device once it is ready', async () => {
    const { calls } = await readyBackend();
    expect(calls.map((call) => call.path)).toContain('/me/player');
  });

  it('starts a track and sets repeat as the end-of-track safety net', async () => {
    const { backend, calls } = await readyBackend();
    await backend.play('spotify:track:one', 60_000);
    const play = calls.find((call) => call.path.startsWith('/me/player/play'));
    expect(play?.method).toBe('PUT');
    expect(play?.body).toEqual({ uris: ['spotify:track:one'], position_ms: 60_000 });
    expect(calls.some((call) => call.path.startsWith('/me/player/repeat?state=track'))).toBe(true);
  });

  // The reported bug: after a first vibe loops, Spotify drops the idle web player out
  // of the active-device slot and every later play 404s.
  it('re-transfers and retries once when Spotify has dropped the device', async () => {
    const { backend, calls } = await readyBackend([
      {
        match: /\/me\/player\/play/,
        throws: new SpotifyApiError('Device not found', 404, '/me/player/play'),
      },
    ]);
    await backend.play('spotify:track:two', 1_000);
    const plays = calls.filter((call) => call.path.startsWith('/me/player/play'));
    const transfers = calls.filter((call) => call.path === '/me/player');
    expect(plays).toHaveLength(2);
    // One transfer on ready, one to re-claim the slot before the retry.
    expect(transfers).toHaveLength(2);
  });

  it('gives up on failures that a re-transfer cannot fix', async () => {
    const { backend } = await readyBackend([
      {
        match: /\/me\/player\/play/,
        throws: new SpotifyApiError('Bad request', 400, '/me/player/play'),
      },
    ]);
    await expect(backend.play('spotify:track:three', 0)).rejects.toThrow('Bad request');
  });

  it('reuses the loaded track instead of spending another Web API call', async () => {
    const { backend, calls, emit, seeks } = await readyBackend();
    emit('player_state_changed', {
      paused: false,
      position: 0,
      duration: 240_000,
      repeat_mode: 0,
      shuffle: false,
      track_window: {
        current_track: {
          id: 'one',
          uri: 'spotify:track:one',
          name: 'One',
          duration_ms: 240_000,
          artists: [],
          album: { name: '', uri: '', images: [] },
        },
        previous_tracks: [],
        next_tracks: [],
      },
    });
    const before = calls.length;
    await backend.play('spotify:track:one', 30_000);
    expect(calls.length).toBe(before);
    expect(seeks).toEqual([30_000]);
  });
});

describe('ConnectBackend', () => {
  const nowRef = { value: 0 };
  const playerState = (positionMs: number, isPlaying = true) => ({
    device: { id: 'phone-1', name: 'Pixel', volume_percent: 70 },
    progress_ms: positionMs,
    is_playing: isPlaying,
    item: {
      id: 'one',
      uri: 'spotify:track:one',
      name: 'One',
      duration_ms: 240_000,
      artists: [{ name: 'Someone' }],
      album: { name: 'Album', images: [{ url: 'art', height: 64, width: 64 }] },
    },
  });

  function makeBackend(rules: Parameters<typeof fakeApi>[0] = []) {
    const { api, calls } = fakeApi(rules);
    const backend = new ConnectBackend({
      api,
      deviceId: 'phone-1',
      pollMs: 1000,
      now: () => nowRef.value,
      schedule: () => 0,
      cancel: () => undefined,
    });
    return { backend, calls };
  }

  it('lists controllable devices', async () => {
    const { backend } = makeBackend([
      {
        match: /\/me\/player\/devices/,
        returns: {
          devices: [
            {
              id: 'phone-1',
              name: 'Pixel',
              type: 'Smartphone',
              is_active: true,
              is_restricted: false,
              volume_percent: 70,
            },
            {
              id: null,
              name: 'Ghost',
              type: 'Unknown',
              is_active: false,
              is_restricted: true,
              volume_percent: null,
            },
          ],
        },
      },
    ]);
    const devices = await backend.listDevices();
    expect(devices).toEqual([
      {
        id: 'phone-1',
        name: 'Pixel',
        type: 'Smartphone',
        isActive: true,
        isRestricted: false,
        volumePercent: 70,
      },
    ]);
  });

  it('plays on the chosen device and re-syncs immediately', async () => {
    const { backend, calls } = makeBackend([
      { match: /^\/me\/player$/, returns: playerState(60_000) },
    ]);
    await backend.play('spotify:track:one', 60_000);
    const play = calls.find((call) => call.path.startsWith('/me/player/play'));
    expect(play?.path).toContain('device_id=phone-1');
    expect(play?.body).toEqual({ uris: ['spotify:track:one'], position_ms: 60_000 });
    // A poll follows the play rather than waiting out a whole interval.
    expect(calls.some((call) => call.path === '/me/player')).toBe(true);
  });

  it('recovers a dropped device on play, like the SDK backend', async () => {
    const { backend, calls } = makeBackend([
      {
        match: /\/me\/player\/play/,
        throws: new SpotifyApiError('Device not found', 404, '/me/player/play'),
      },
    ]);
    await backend.play('spotify:track:one', 0);
    expect(calls.filter((call) => call.path.startsWith('/me/player/play'))).toHaveLength(2);
    expect(calls.some((call) => call.path === '/me/player' && call.method === 'PUT')).toBe(true);
  });

  it('turns a polled player state into a loop-engine snapshot', async () => {
    const { backend } = makeBackend([{ match: /^\/me\/player$/, returns: playerState(12_345) }]);
    const seen: PlaybackSnapshot[] = [];
    backend.onState((snapshot) => seen.push(snapshot));
    nowRef.value = 5_000;
    await backend.poll();
    expect(seen).toEqual([
      {
        positionMs: 12_345,
        atMs: 5_000,
        paused: false,
        durationMs: 240_000,
        trackUri: 'spotify:track:one',
      },
    ]);
  });

  it('reports an idle player as nothing playing', async () => {
    const { backend } = makeBackend([{ match: /^\/me\/player$/, returns: null }]);
    const seen: PlaybackSnapshot[] = [];
    backend.onState((snapshot) => seen.push(snapshot));
    await backend.poll();
    expect(seen[0]?.trackUri).toBeNull();
    expect(seen[0]?.paused).toBe(true);
  });

  it('seeks over the Web API, which is what makes the loop rough', async () => {
    const { backend, calls } = makeBackend();
    await backend.seek(60_000);
    expect(calls[0]?.path).toBe('/me/player/seek?position_ms=60000&device_id=phone-1');
    expect(calls[0]?.method).toBe('PUT');
  });

  it('drives a full loop when wired to the engine', async () => {
    const { backend, calls } = makeBackend([
      { match: /^\/me\/player$/, returns: playerState(60_000) },
    ]);
    const engine = new LoopEngine({ lookaheadMs: 400 });
    engine.setRegion({ trackUri: 'spotify:track:one', startMs: 60_000, endMs: 72_000 });
    backend.onState((snapshot) => engine.onState(snapshot));
    nowRef.value = 0;
    await backend.poll();

    expect(engine.tick(11_000)).toBeNull();
    const command = engine.tick(11_700);
    expect(command?.positionMs).toBe(60_000);
    await backend.seek(command!.positionMs);
    expect(calls.some((call) => call.path.includes('/me/player/seek?position_ms=60000'))).toBe(
      true,
    );
  });

  it('refuses to play with no device chosen', async () => {
    const { api } = fakeApi();
    const backend = new ConnectBackend({
      api,
      deviceId: null,
      schedule: () => 0,
      cancel: () => undefined,
    });
    await expect(backend.play('spotify:track:one', 0)).rejects.toThrow(/Pick a Spotify device/);
  });

  it('clamps the poll interval to a quota-sane range', () => {
    const { backend } = makeBackend();
    backend.setPollInterval(50);
    expect(backend['pollMs']).toBe(500);
    backend.setPollInterval(99_999);
    expect(backend['pollMs']).toBe(5000);
  });
});

describe('ConnectBackend quota discipline', () => {
  it('throttles a dragged volume slider into two calls, ending on the final value', async () => {
    const calls: string[] = [];
    const api = (async (path: string) => {
      calls.push(path);
      return null;
    }) as never;
    const scheduled: Array<() => void> = [];
    const backend = new ConnectBackend({
      api,
      deviceId: 'phone-1',
      schedule: (fn) => scheduled.push(fn),
      cancel: () => undefined,
    });

    await backend.setVolume(0.1);
    await backend.setVolume(0.2);
    await backend.setVolume(0.9);
    expect(calls).toEqual(['/me/player/volume?volume_percent=10&device_id=phone-1']);

    scheduled.at(-1)?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([
      '/me/player/volume?volume_percent=10&device_id=phone-1',
      '/me/player/volume?volume_percent=90&device_id=phone-1',
    ]);
  });
});
