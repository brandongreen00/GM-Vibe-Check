import type { PlaybackController } from '../player/controller';
import { db } from '../store/db';
import { settings } from '../store/settings';
import { ui } from '../store/state';
import { el } from '../util/dom';
import { formatClock } from '../util/time';

/** The persistent bar at the bottom of every screen. */
export function createTransport(playback: PlaybackController): {
  node: HTMLElement;
  dispose: () => void;
} {
  const trackLabel = el('span', { class: 'transport__track' }, 'Nothing playing');
  const rangeLabel = el('span', { class: 'transport__range' });
  const playButton = el(
    'button',
    {
      class: 'btn btn--round',
      title: 'Play / pause (Space)',
      onClick: () => void playback.togglePause(),
    },
    '▶',
  );
  const stopButton = el(
    'button',
    { class: 'btn btn--round', title: 'Stop (Esc)', onClick: () => void playback.stop() },
    '■',
  );
  const loopToggle = el('input', { type: 'checkbox', id: 'loop-toggle', checked: true });
  loopToggle.addEventListener('change', () => {
    playback.setLoopEnabled(loopToggle.checked);
    if (loopToggle.checked) playback.rearmLoop();
  });

  const volume = el('input', {
    type: 'range',
    min: '0',
    max: '100',
    value: String(Math.round(settings.current.defaultVolume * 100)),
    class: 'slider slider--volume',
    'aria-label': 'Volume',
  }) as HTMLInputElement;
  volume.addEventListener('input', () => {
    void playback.setVolume(Number(volume.value) / 100);
  });
  volume.addEventListener('change', () => {
    settings.update({ defaultVolume: Number(volume.value) / 100 });
  });

  const editButton = el(
    'button',
    { class: 'btn btn--small', title: 'Edit the vibe that is playing' },
    'Edit vibe',
  );
  const progressFill = el('span', { class: 'transport__fill' });
  const progress = el('div', { class: 'transport__progress' }, progressFill);
  const overrideNote = el('span', { class: 'transport__note' });
  const modeBadge = el('span', { class: 'transport__mode' });

  const node = el(
    'footer',
    { class: 'transport' },
    progress,
    el(
      'div',
      { class: 'transport__row' },
      playButton,
      stopButton,
      el('div', { class: 'transport__meta' }, trackLabel, rangeLabel, overrideNote),
      modeBadge,
      el('label', { class: 'transport__loop' }, loopToggle, ' Loop'),
      editButton,
      el('span', { class: 'transport__volume' }, '🔊', volume),
    ),
  );

  const dispose = playback.subscribe((view) => {
    const vibe = view.activeVibeId ? db.vibe(view.activeVibeId) : null;
    const track = view.trackUri ? db.track(view.trackUri) : null;
    trackLabel.textContent = track
      ? `${vibe ? `${vibe.title} · ` : ''}${track.name} — ${track.artists.join(', ')}`
      : 'Nothing playing';
    const region = vibe
      ? { startMs: vibe.startMs, endMs: vibe.endMs }
      : view.previewRegion
        ? { startMs: view.previewRegion.startMs, endMs: view.previewRegion.endMs }
        : null;
    rangeLabel.textContent = region
      ? `${formatClock(region.startMs)}–${formatClock(region.endMs)} · ${formatClock(view.positionMs)}`
      : view.durationMs > 0
        ? `${formatClock(view.positionMs)} / ${formatClock(view.durationMs)}`
        : '';
    playButton.textContent = view.paused ? '▶' : '❚❚';
    loopToggle.checked = view.loopEnabled;
    overrideNote.textContent =
      view.loopEnabled && view.loopOverridden ? 'Loop paused — you scrubbed outside it' : '';
    modeBadge.textContent = view.mode === 'connect' ? 'rough loop' : '';
    modeBadge.title =
      view.mode === 'connect'
        ? 'Playing on another Spotify device: loop points land within roughly ±500 ms.'
        : '';
    editButton.toggleAttribute('disabled', !vibe);
    editButton.onclick = vibe
      ? () => ui.go({ name: 'editor', trackUri: vibe.trackUri, vibeId: vibe.id })
      : null;

    const total = region ? region.endMs - region.startMs : view.durationMs;
    const elapsed = region ? view.positionMs - region.startMs : view.positionMs;
    const ratio = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 0;
    progressFill.style.width = `${(ratio * 100).toFixed(2)}%`;
  });

  return { node, dispose };
}
