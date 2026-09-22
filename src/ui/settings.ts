import { apiStatus } from '../api/spotifyClient';
import { auth } from '../auth/tokens';
import type { PlaybackController } from '../player/controller';
import { db, isExportBundle } from '../store/db';
import { settings } from '../store/settings';
import { ui } from '../store/state';
import type { TapActiveBehaviour } from '../types';
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
          el('dt', {}, 'SDK state'),
          el('dd', {}, deps.playback.backend.status),
          el('dt', {}, 'Device ID'),
          el('dd', {}, deps.playback.backend.currentDeviceId ?? '—'),
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
