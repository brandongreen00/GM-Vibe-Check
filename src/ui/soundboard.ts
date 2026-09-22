import type { PlaybackController } from '../player/controller';
import { db } from '../store/db';
import { settings } from '../store/settings';
import { ui } from '../store/state';
import type { Vibe } from '../types';
import { el, mount } from '../util/dom';
import { formatClock } from '../util/time';
import { toast } from './toast';

export interface SoundboardDeps {
  playback: PlaybackController;
  onEditVibe: (vibe: Vibe) => void;
}

/** Digits first, then letters — matches the badge order the hotkey handler assumes. */
export const DEFAULT_HOTKEYS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '0',
  'q',
  'w',
  'e',
  'r',
  't',
  'y',
  'u',
  'i',
  'o',
  'p',
];

export function hotkeyFor(vibe: Vibe, index: number): string | undefined {
  return vibe.hotkey ?? DEFAULT_HOTKEYS[index];
}

export function activeList(): string | null {
  const lists = db.lists;
  if (lists.length === 0) return null;
  const existing = lists.find((list) => list.id === ui.activeListId);
  return (existing ?? lists[0])!.id;
}

/** Tapping the Vibe that is already playing toggles or stops, per the user's setting. */
export async function activateVibe(playback: PlaybackController, vibe: Vibe): Promise<void> {
  const view = playback.view;
  if (view.activeVibeId === vibe.id) {
    if (settings.current.tapActiveBehaviour === 'stop') await playback.stop();
    else await playback.togglePause();
    return;
  }
  try {
    await playback.startVibe(vibe);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
  }
}

export function renderSoundboard(root: HTMLElement, deps: SoundboardDeps): () => void {
  const listId = activeList();
  const vibes = listId ? db.vibesInList(listId) : [];
  const grid = el('div', { class: 'board' });
  const buttons = new Map<string, HTMLElement>();

  vibes.forEach((vibe, index) => {
    const track = db.track(vibe.trackUri);
    const hotkey = hotkeyFor(vibe, index);
    const button = el(
      'button',
      {
        class: 'vibe',
        type: 'button',
        style: vibe.color ? `--vibe-tint: ${vibe.color}` : '',
        'data-vibe-id': vibe.id,
        onClick: () => void activateVibe(deps.playback, vibe),
      },
      el('span', { class: 'vibe__ring' }),
      track?.albumArtUrl
        ? el('img', { class: 'vibe__art', src: track.albumArtUrl, alt: '' })
        : el('span', { class: 'vibe__art vibe__art--empty' }, '♪'),
      track?.isPlayable === false
        ? el(
            'span',
            {
              class: 'vibe__warning',
              title: 'Spotify will not play this track any more — open the vibe to re-link it.',
            },
            '⚠',
          )
        : null,
      el('span', { class: 'vibe__title' }, vibe.title),
      el(
        'span',
        { class: 'vibe__track' },
        track ? `${track.name} — ${track.artists.join(', ')}` : 'Track details not cached',
      ),
      el(
        'span',
        { class: 'vibe__range' },
        `${formatClock(vibe.startMs)}–${formatClock(vibe.endMs)}`,
      ),
      hotkey ? el('span', { class: 'vibe__hotkey' }, hotkey.toUpperCase()) : null,
      el(
        'span',
        {
          class: 'vibe__edit',
          role: 'button',
          tabindex: '0',
          title: 'Edit this vibe',
          onClick: (event: Event) => {
            event.stopPropagation();
            deps.onEditVibe(vibe);
          },
        },
        'Edit',
      ),
    );
    buttons.set(vibe.id, button);
    grid.appendChild(button);
  });

  const listSelect = el(
    'select',
    {
      class: 'select',
      'aria-label': 'Vibe list',
      onChange: (event: Event) => ui.setActiveList((event.target as HTMLSelectElement).value),
    },
    ...db.lists.map((list) =>
      el('option', { value: list.id, selected: list.id === listId }, list.name),
    ),
  );

  mount(
    root,
    el(
      'div',
      { class: 'screen screen--board' },
      el(
        'header',
        { class: 'board__header' },
        listSelect,
        el(
          'button',
          {
            class: 'btn btn--small',
            onClick: async () => {
              const name = window.prompt('Name this vibe list (e.g. "Session 4 — the swamp")');
              if (!name?.trim()) return;
              const list = await db.addList(name.trim());
              ui.setActiveList(list.id);
            },
          },
          'New list',
        ),
        listId
          ? el(
              'button',
              {
                class: 'btn btn--small',
                onClick: async () => {
                  const current = db.lists.find((list) => list.id === listId);
                  const name = window.prompt('Rename this list', current?.name ?? '');
                  if (name?.trim()) await db.renameList(listId, name.trim());
                },
              },
              'Rename',
            )
          : null,
        listId && db.lists.length > 1
          ? el(
              'button',
              {
                class: 'btn btn--small btn--danger',
                onClick: async () => {
                  const current = db.lists.find((list) => list.id === listId);
                  const count = db.vibesInList(listId).length;
                  if (
                    !window.confirm(
                      `Delete "${current?.name}" and its ${count} vibe(s)? This cannot be undone.`,
                    )
                  ) {
                    return;
                  }
                  await db.deleteList(listId);
                  const next = db.lists[0];
                  if (next) ui.setActiveList(next.id);
                },
              },
              'Delete list',
            )
          : null,
        el(
          'button',
          { class: 'btn btn--primary btn--small', onClick: () => ui.go({ name: 'library' }) },
          '+ Add vibe',
        ),
      ),
      vibes.length === 0
        ? el(
            'div',
            { class: 'empty' },
            el('p', {}, 'No vibes yet in this list.'),
            el(
              'button',
              { class: 'btn btn--primary', onClick: () => ui.go({ name: 'library' }) },
              'Add your first vibe',
            ),
            el(
              'p',
              { class: 'hint' },
              'Pick a track from your Liked Songs, scrub to the section you want, and mark its start and end.',
            ),
          )
        : grid,
    ),
  );

  // Only the active button changes per frame, so the grid itself is never re-rendered.
  return deps.playback.subscribe((view) => {
    for (const [vibeId, button] of buttons) {
      const isActive = view.activeVibeId === vibeId;
      button.classList.toggle('vibe--active', isActive);
      button.classList.toggle('vibe--paused', isActive && view.paused);
      if (!isActive) {
        button.style.removeProperty('--vibe-progress');
        continue;
      }
      const vibe = db.vibe(vibeId);
      if (!vibe) continue;
      const span = Math.max(1, vibe.endMs - vibe.startMs);
      const progress = Math.min(1, Math.max(0, (view.positionMs - vibe.startMs) / span));
      button.style.setProperty('--vibe-progress', `${(progress * 360).toFixed(1)}deg`);
    }
  });
}
