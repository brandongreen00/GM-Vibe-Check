import { apiStatus } from '../api/spotifyClient';
import { auth } from '../auth/tokens';
import type { ConnectBackend, ConnectDevice } from '../player/connect';
import type { PlaybackController } from '../player/controller';
import { db, isExportBundle } from '../store/db';
import { settings } from '../store/settings';
import { ui } from '../store/state';
import type { PlaybackMode, TapActiveBehaviour } from '../types';
import { el, mount } from '../util/dom';
import { toast } from './toast';

export interface SettingsDeps {
  playback: PlaybackController;
  onReset: () => void;
}

function timestamp(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleString() : 'never';
}

function exportJson(): void {
  const bundle = db.exportBundle();
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', {
    href: url,
    download: `vibe-looper-${new Date().toISOString().slice(0, 10)}.json`,
  });
  link.click();
  URL.revokeObjectURL(url);
}

async function importJson(mode: 'merge' | 'replace'): Promise<void> {
  const input = el('input', { type: 'file', accept: 'application/json' }) as HTMLInputElement;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isExportBundle(parsed)) {
        toast('That file is not a Vibe Looper export (expected version 1).', 'error');
        return;
      }
      if (
        mode === 'replace' &&
        !window.confirm('Replace every list and vibe on this device with the file contents?')
      ) {
        return;
      }
      await db.importBundle(parsed, mode);
      toast(`Imported ${parsed.vibes.length} vibe(s).`);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  });
  input.click();
}

export function renderSettings(root: HTMLElement, deps: SettingsDeps): () => void {
  const rerender = () => renderSettings(root, deps);
  const current = settings.current;

  const lookahead = el('input', {
    type: 'range',
    min: '0',
    max: '600',
    step: '10',
    value: String(current.seekLookaheadMs),
    class: 'slider',
  }) as HTMLInputElement;
  const lookaheadValue = el('output', {}, `${current.seekLookaheadMs} ms`);
  lookahead.addEventListener('input', () => {
    lookaheadValue.textContent = `${lookahead.value} ms`;
    settings.update({ seekLookaheadMs: Number(lookahead.value) });
  });

  const volume = el('input', {
    type: 'range',
    min: '0',
    max: '100',
    value: String(Math.round(current.defaultVolume * 100)),
    class: 'slider',
  }) as HTMLInputElement;
  volume.addEventListener('change', () =>
    settings.update({ defaultVolume: Number(volume.value) / 100 }),
  );

  const fadeToggle = el('input', {
    type: 'checkbox',
    checked: current.fadeOnSwitch,
  }) as HTMLInputElement;
  fadeToggle.addEventListener('change', () =>
    settings.update({ fadeOnSwitch: fadeToggle.checked }),
  );

  const fadeMs = el('input', {
    type: 'number',
    min: '0',
    max: '2000',
    step: '50',
    value: String(current.fadeMs),
    class: 'input input--number',
  }) as HTMLInputElement;
  fadeMs.addEventListener('change', () => settings.update({ fadeMs: Number(fadeMs.value) }));

  const tapBehaviour = el(
    'select',
    { class: 'select' },
    el(
      'option',
      { value: 'toggle', selected: current.tapActiveBehaviour === 'toggle' },
      'Pause / resume',
    ),
    el('option', { value: 'stop', selected: current.tapActiveBehaviour === 'stop' }, 'Stop'),
  ) as HTMLSelectElement;
  tapBehaviour.addEventListener('change', () =>
    settings.update({ tapActiveBehaviour: tapBehaviour.value as TapActiveBehaviour }),
  );

  const authState = auth.snapshot;
  const view = deps.playback.view;
  const playbackPanel = renderPlaybackDevicePanel(deps, rerender);

  mount(
    root,
    el(
      'div',
      { class: 'screen screen--settings' },
      el(
        'header',
        { class: 'library__header' },
        el('h2', {}, 'Settings'),
        el(
          'button',
          { class: 'btn btn--small', onClick: () => ui.go({ name: 'soundboard' }) },
          '← Soundboard',
        ),
      ),
      el(
        'section',
        { class: 'panel' },
        el('h3', {}, 'Playback'),
        el(
          'label',
          { class: 'field' },
          el('span', { class: 'label' }, 'Seek lookahead'),
          lookahead,
          lookaheadValue,
          el(
            'span',
            { class: 'hint' },
            'How early we seek before the loop end, to hide Spotify’s seek latency. If your loops overshoot the end, raise this; if they cut early, lower it.',
          ),
        ),
        el('label', { class: 'field' }, el('span', { class: 'label' }, 'Default volume'), volume),
        el(
          'label',
          { class: 'field field--inline' },
          fadeToggle,
          el('span', { class: 'label' }, 'Fade when switching vibes'),
        ),
        el(
          'label',
          { class: 'field field--inline' },
          el('span', { class: 'label' }, 'Fade length (ms)'),
          fadeMs,
        ),
        el(
          'label',
          { class: 'field field--inline' },
          el('span', { class: 'label' }, 'Tapping the playing vibe'),
          tapBehaviour,
        ),
      ),
      playbackPanel,
      el(
        'section',
        { class: 'panel' },
        el('h3', {}, 'Your data'),
        el(
          'div',
          { class: 'row' },
          el('button', { class: 'btn', onClick: exportJson }, 'Export JSON'),
          el('button', { class: 'btn', onClick: () => void importJson('merge') }, 'Import (merge)'),
          el(
            'button',
            { class: 'btn', onClick: () => void importJson('replace') },
            'Import (replace)',
          ),
        ),
        el(
          'p',
          { class: 'hint' },
          'Exports include the cached track details, so an imported file renders before any Spotify call.',
        ),
      ),
      el(
        'section',
        { class: 'panel' },
        el('h3', {}, 'Spotify connection'),
        el('p', { class: 'hint' }, `Client ID: ${authState.clientId || '—'}`),
        el(
          'p',
          { class: 'hint' },
          `Signed in as: ${authState.displayName ?? authState.userId ?? '—'}`,
        ),
        el(
          'div',
          { class: 'row' },
          el(
            'button',
            {
              class: 'btn',
              onClick: () => {
                auth.disconnect();
                toast('Disconnected. Your vibes are untouched.');
                deps.onReset();
              },
            },
            'Disconnect',
          ),
          el(
            'button',
            {
              class: 'btn btn--danger',
              onClick: async () => {
                if (
                  !window.confirm(
                    'Erase the Client ID, tokens, settings and every vibe on this device?',
                  )
                ) {
                  return;
                }
                await db.wipe();
                auth.forgetEverything();
                settings.reset();
                localStorage.clear();
                toast('Everything wiped.');
                deps.onReset();
              },
            },
            'Reset everything',
          ),
        ),
      ),
      el(
        'section',
        { class: 'panel' },
        el('h3', {}, 'Diagnostics'),
        el(
          'dl',
          { class: 'diagnostics' },
          el('dt', {}, 'Backend state'),
          el('dd', {}, deps.playback.status),
          el('dt', {}, 'Playback mode'),
          el('dd', {}, view.mode === 'connect' ? 'Another device (rough loop)' : 'This browser'),
          el('dt', {}, 'Device'),
          el('dd', {}, deps.playback.backend.deviceLabel ?? '—'),
          el('dt', {}, 'Token expires'),
          el('dd', {}, timestamp(authState.expiresAt)),
          el('dt', {}, 'Last rate limit (429)'),
          el('dd', {}, timestamp(apiStatus.lastRateLimitedAt)),
          el('dt', {}, 'Last quota exhaustion'),
          el('dd', {}, timestamp(apiStatus.lastQuotaExceededAt)),
          el('dt', {}, 'Last 403 path'),
          el('dd', {}, apiStatus.lastForbiddenPath ?? '—'),
          el('dt', {}, 'Loop seeks issued'),
          el('dd', {}, String(deps.playback.engine.seeksIssued)),
          el('dt', {}, 'Loop armed'),
          el(
            'dd',
            {},
            view.loopEnabled ? (view.loopOverridden ? 'yes (stood down)' : 'yes') : 'no',
          ),
        ),
        el('button', { class: 'btn btn--small', onClick: rerender }, 'Refresh'),
        el(
          'pre',
          { class: 'log' },
          deps.playback.log
            .slice(0, 40)
            .map((entry) => `${new Date(entry.at).toLocaleTimeString()}  ${entry.message}`)
            .join('\n') || 'No playback events yet.',
        ),
      ),
    ),
  );

  return () => undefined;
}

/**
 * Phase 2: choose between in-browser playback and driving another Spotify device.
 * The Connect route is the only one that works on mobile or without Premium-capable
 * EME, at the cost of loop precision and Web API quota.
 */
function renderPlaybackDevicePanel(deps: SettingsDeps, rerender: () => void): HTMLElement {
  const mode = settings.current.playbackMode;
  const panel = el('section', { class: 'panel' }, el('h3', {}, 'Where audio plays'));

  const choose = async (next: PlaybackMode) => {
    if (next === settings.current.playbackMode) return;
    settings.update({ playbackMode: next });
    try {
      await deps.playback.useMode(next);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
    rerender();
  };

  const option = (value: PlaybackMode, label: string, description: string) => {
    const input = el('input', {
      type: 'radio',
      name: 'playback-mode',
      value,
      checked: mode === value,
    });
    input.addEventListener('change', () => void choose(value));
    return el(
      'label',
      { class: 'choice' },
      input,
      el('span', {}, el('strong', {}, label), el('span', { class: 'hint' }, description)),
    );
  };

  panel.append(
    option(
      'sdk',
      'This browser tab',
      'Tight loops (±150 ms) and no Web API calls while looping. Needs Spotify Premium and a desktop browser with EME.',
    ),
    option(
      'connect',
      'Another Spotify device — rough loop mode',
      'Plays on your phone, desktop client or speaker. Works anywhere, but loop points land within roughly ±500 ms and every loop spends Web API quota.',
    ),
  );

  if (mode !== 'connect') return panel;

  const backend = deps.playback.backend;
  if (backend.id !== 'connect') return panel;
  const connect = backend as ConnectBackend;
  const deviceList = el(
    'div',
    { class: 'track-list' },
    el('p', { class: 'hint' }, 'Loading devices…'),
  );

  const loadDevices = async (): Promise<void> => {
    try {
      const devices = await connect.listDevices();
      mount(
        deviceList,
        ...(devices.length === 0
          ? [
              el(
                'p',
                { class: 'notice' },
                'Spotify lists no devices. Open Spotify on your phone or computer and play a second of anything, then refresh this list.',
              ),
            ]
          : devices.map((device: ConnectDevice) =>
              el(
                'button',
                {
                  class: 'track',
                  onClick: () => {
                    connect.selectDevice(device.id, device.name);
                    settings.update({ connectDeviceId: device.id });
                    toast(`Playing on ${device.name}.`);
                    rerender();
                  },
                },
                el('span', { class: 'track__art track__art--empty' }, deviceGlyph(device.type)),
                el(
                  'span',
                  { class: 'track__meta' },
                  el('span', { class: 'track__name' }, device.name),
                  el(
                    'span',
                    { class: 'track__artist' },
                    [
                      device.type,
                      device.isActive ? 'active' : null,
                      device.isRestricted ? 'restricted — cannot be controlled' : null,
                      settings.current.connectDeviceId === device.id ? 'selected' : null,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  ),
                ),
              ),
            )),
      );
    } catch (error) {
      mount(
        deviceList,
        el('p', { class: 'notice' }, error instanceof Error ? error.message : String(error)),
      );
    }
  };
  void loadDevices();

  const poll = el('input', {
    type: 'range',
    min: '500',
    max: '5000',
    step: '250',
    value: String(settings.current.connectPollMs),
    class: 'slider',
  }) as HTMLInputElement;
  const pollValue = el('output', {}, `${settings.current.connectPollMs} ms`);
  poll.addEventListener('input', () => {
    pollValue.textContent = `${poll.value} ms`;
  });
  poll.addEventListener('change', () => {
    settings.update({ connectPollMs: Number(poll.value) });
    connect.setPollInterval(Number(poll.value));
  });

  panel.append(
    el(
      'div',
      { class: 'library__toolbar' },
      el('span', { class: 'label' }, 'Device'),
      el('button', { class: 'btn btn--small', onClick: () => void loadDevices() }, 'Refresh list'),
    ),
    deviceList,
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'label' }, 'Position polling'),
      poll,
      pollValue,
      el(
        'span',
        { class: 'hint' },
        'Rough loop mode has no push updates, so it asks Spotify where the playhead is. Faster polling tightens the loop; slower polling spends less of your daily quota. A one-second poll is about 3,600 calls an hour, plus one per loop.',
      ),
    ),
  );
  return panel;
}

function deviceGlyph(type: string): string {
  const kind = type.toLowerCase();
  if (kind.includes('phone')) return '📱';
  if (kind.includes('speaker')) return '🔈';
  if (kind.includes('tv') || kind.includes('cast')) return '📺';
  return '💻';
}
