import { fetchTrack } from '../api/library';
import type { PlaybackController } from '../player/controller';
import { db } from '../store/db';
import { ui } from '../store/state';
import { MIN_VIBE_LENGTH_MS, type TrackRef, type Vibe } from '../types';
import { el, mount } from '../util/dom';
import { uuid } from '../util/id';
import { clamp, formatClock, formatPrecise, parsePrecise } from '../util/time';
import { toast } from './toast';

const SNAP_MS = 100;
const FINE_SNAP_MS = 10;
const COLORS = ['#7c5cff', '#2f9e6e', '#c2562c', '#2e6fb7', '#a8324a', '#6b6f76'];

export interface EditorDeps {
  playback: PlaybackController;
  trackUri: string;
  vibeId?: string;
}

/** With audio-analysis gone there is no waveform or beat grid to draw — the user dials
 *  the section in by ear, so preview and nudge controls are the important part. */
export function renderEditor(root: HTMLElement, deps: EditorDeps): () => void {
  const existing = deps.vibeId ? db.vibe(deps.vibeId) : undefined;
  let track = db.track(deps.trackUri);

  let startMs = existing?.startMs ?? 0;
  let endMs = existing?.endMs ?? Math.min(track?.durationMs ?? 30_000, 30_000);
  let color = existing?.color ?? COLORS[0]!;

  const durationMs = () => track?.durationMs ?? Math.max(endMs + 30_000, 60_000);

  const rangeBar = el('div', { class: 'scrub' });
  const selection = el('div', { class: 'scrub__selection' });
  const startHandle = el('div', {
    class: 'scrub__handle scrub__handle--start',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Loop start',
  });
  const endHandle = el('div', {
    class: 'scrub__handle scrub__handle--end',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Loop end',
  });
  const playhead = el('div', { class: 'scrub__playhead' });
  rangeBar.append(selection, startHandle, endHandle, playhead);

  const startInput = el('input', {
    class: 'input input--time',
    value: formatPrecise(startMs),
  }) as HTMLInputElement;
  const endInput = el('input', {
    class: 'input input--time',
    value: formatPrecise(endMs),
  }) as HTMLInputElement;
  const lengthLabel = el('span', { class: 'hint' });
  const titleInput = el('input', {
    class: 'input',
    placeholder: 'Tavern ambience',
    value: existing?.title ?? '',
  }) as HTMLInputElement;
  const hotkeyInput = el('input', {
    class: 'input input--hotkey',
    maxlength: '1',
    placeholder: 'auto',
    value: existing?.hotkey ?? '',
  }) as HTMLInputElement;
  const listSelect = el(
    'select',
    { class: 'select' },
    ...db.lists.map((list) =>
      el(
        'option',
        {
          value: list.id,
          selected: list.id === (existing?.listId ?? ui.activeListId ?? db.lists[0]?.id),
        },
        list.name,
      ),
    ),
  ) as HTMLSelectElement;

  function refreshRange(): void {
    const total = durationMs();
    startMs = clamp(startMs, 0, Math.max(0, total - MIN_VIBE_LENGTH_MS));
    endMs = clamp(endMs, startMs + MIN_VIBE_LENGTH_MS, total);
    selection.style.left = `${(startMs / total) * 100}%`;
    selection.style.width = `${((endMs - startMs) / total) * 100}%`;
    startHandle.style.left = `${(startMs / total) * 100}%`;
    endHandle.style.left = `${(endMs / total) * 100}%`;
    startInput.value = formatPrecise(startMs);
    endInput.value = formatPrecise(endMs);
    lengthLabel.textContent = `Length ${formatClock(endMs - startMs)} · track ${formatClock(total)}`;
  }

  function positionFromEvent(event: PointerEvent, fine: boolean): number {
    const rect = rangeBar.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const snap = fine ? FINE_SNAP_MS : SNAP_MS;
    return Math.round((ratio * durationMs()) / snap) * snap;
  }

  function dragHandle(handle: HTMLElement, which: 'start' | 'end'): void {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const move = (moveEvent: PointerEvent) => {
        const value = positionFromEvent(moveEvent, moveEvent.shiftKey);
        if (which === 'start') startMs = Math.min(value, endMs - MIN_VIBE_LENGTH_MS);
        else endMs = Math.max(value, startMs + MIN_VIBE_LENGTH_MS);
        refreshRange();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? FINE_SNAP_MS : SNAP_MS;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -step : step;
      if (which === 'start') startMs = Math.min(startMs + delta, endMs - MIN_VIBE_LENGTH_MS);
      else endMs = Math.max(endMs + delta, startMs + MIN_VIBE_LENGTH_MS);
      refreshRange();
    });
  }

  dragHandle(startHandle, 'start');
  dragHandle(endHandle, 'end');

  rangeBar.addEventListener('pointerdown', (event) => {
    if (event.target !== rangeBar && event.target !== selection) return;
    void deps.playback.playFrom(deps.trackUri, positionFromEvent(event, event.shiftKey));
  });

  startInput.addEventListener('change', () => {
    const value = parsePrecise(startInput.value);
    if (value === null) {
      toast('Use mm:ss.mmm, for example 1:24.500', 'warn');
    } else {
      startMs = value;
    }
    refreshRange();
  });
  endInput.addEventListener('change', () => {
    const value = parsePrecise(endInput.value);
    if (value === null) {
      toast('Use mm:ss.mmm, for example 1:36.250', 'warn');
    } else {
      endMs = value;
    }
    refreshRange();
  });

  const nudge = (which: 'start' | 'end', deltaMs: number) =>
    el(
      'button',
      {
        class: 'btn btn--small',
        onClick: () => {
          if (which === 'start') startMs = Math.min(startMs + deltaMs, endMs - MIN_VIBE_LENGTH_MS);
          else endMs = Math.max(endMs + deltaMs, startMs + MIN_VIBE_LENGTH_MS);
          refreshRange();
        },
      },
      `${deltaMs > 0 ? '+' : '−'}${Math.abs(deltaMs) >= 1000 ? `${Math.abs(deltaMs) / 1000}s` : `${Math.abs(deltaMs)}ms`}`,
    );

  const setFromPlayhead = (which: 'start' | 'end') => {
    const position = Math.round(deps.playback.view.positionMs);
    if (which === 'start') startMs = Math.min(position, endMs - MIN_VIBE_LENGTH_MS);
    else endMs = Math.max(position, startMs + MIN_VIBE_LENGTH_MS);
    refreshRange();
  };

  const save = async (): Promise<void> => {
    const title = titleInput.value.trim();
    if (!title) {
      toast('Give the vibe a title so you can find it on the board.', 'warn');
      titleInput.focus();
      return;
    }
    if (endMs - startMs < MIN_VIBE_LENGTH_MS) {
      toast('A vibe must be at least one second long.', 'warn');
      return;
    }
    const listId = listSelect.value;
    const vibe: Vibe = {
      id: existing?.id ?? uuid(),
      listId,
      title,
      trackUri: deps.trackUri,
      startMs,
      endMs,
      color,
      hotkey: hotkeyInput.value.trim().toLowerCase() || undefined,
      order: existing?.order ?? db.nextOrder(listId),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    await db.saveVibe(vibe);
    ui.setActiveList(listId);
    toast(`Saved "${title}".`);
    ui.go({ name: 'soundboard' });
  };

  const unplayableNotice = el('div', {});
  function renderUnplayable(): void {
    if (track?.isPlayable !== false) {
      mount(unplayableNotice);
      return;
    }
    mount(
      unplayableNotice,
      el(
        'p',
        { class: 'notice' },
        'Spotify will not play this track any more. Point this vibe at another recording — the loop points are kept.',
        existing
          ? el(
              'button',
              {
                class: 'btn btn--small',
                onClick: () => ui.go({ name: 'library', relinkVibeId: existing.id }),
              },
              'Re-link track',
            )
          : null,
      ),
    );
  }

  const header = el('div', { class: 'editor__header' });
  function renderHeader(): void {
    mount(
      header,
      track?.albumArtUrl
        ? el('img', { class: 'editor__art', src: track.albumArtUrl, alt: '' })
        : null,
      el(
        'div',
        {},
        el('h2', { class: 'editor__track' }, track?.name ?? 'Loading track…'),
        el('p', { class: 'hint' }, track ? `${track.artists.join(', ')} · ${track.albumName}` : ''),
      ),
    );
  }
  renderHeader();
  renderUnplayable();

  mount(
    root,
    el(
      'div',
      { class: 'screen screen--editor' },
      el(
        'header',
        { class: 'library__header' },
        el('h2', {}, existing ? 'Edit vibe' : 'New vibe'),
        el(
          'button',
          { class: 'btn btn--small', onClick: () => ui.go({ name: 'soundboard' }) },
          '← Soundboard',
        ),
      ),
      header,
      unplayableNotice,
      rangeBar,
      el(
        'div',
        { class: 'editor__times' },
        el(
          'label',
          { class: 'field field--inline' },
          el('span', { class: 'label' }, 'Start'),
          startInput,
        ),
        el(
          'label',
          { class: 'field field--inline' },
          el('span', { class: 'label' }, 'End'),
          endInput,
        ),
        lengthLabel,
      ),
      el(
        'div',
        { class: 'editor__controls' },
        el(
          'button',
          {
            class: 'btn',
            onClick: () => void deps.playback.playFrom(deps.trackUri, startMs),
          },
          'Play from start',
        ),
        el(
          'button',
          {
            class: 'btn btn--primary',
            onClick: () => void deps.playback.previewRange(deps.trackUri, startMs, endMs),
          },
          'Preview loop',
        ),
        el(
          'button',
          { class: 'btn btn--small', onClick: () => setFromPlayhead('start') },
          'Set start = playhead  [ ',
        ),
        el(
          'button',
          { class: 'btn btn--small', onClick: () => setFromPlayhead('end') },
          'Set end = playhead  ] ',
        ),
      ),
      el(
        'div',
        { class: 'editor__nudges' },
        el('span', { class: 'label' }, 'Start'),
        nudge('start', -1000),
        nudge('start', -100),
        nudge('start', 100),
        nudge('start', 1000),
        el('span', { class: 'label' }, 'End'),
        nudge('end', -1000),
        nudge('end', -100),
        nudge('end', 100),
        nudge('end', 1000),
      ),
      el(
        'div',
        { class: 'editor__form' },
        el('label', { class: 'field' }, el('span', { class: 'label' }, 'Title'), titleInput),
        el('label', { class: 'field' }, el('span', { class: 'label' }, 'List'), listSelect),
        el('label', { class: 'field' }, el('span', { class: 'label' }, 'Hotkey'), hotkeyInput),
        el(
          'div',
          { class: 'field' },
          el('span', { class: 'label' }, 'Colour'),
          el(
            'div',
            { class: 'swatches' },
            ...COLORS.map((value) => {
              const swatch = el('button', {
                class: `swatch ${value === color ? 'swatch--active' : ''}`,
                style: `background:${value}`,
                title: value,
                type: 'button',
              });
              swatch.addEventListener('click', () => {
                color = value;
                for (const node of swatch.parentElement?.children ?? []) {
                  node.classList.remove('swatch--active');
                }
                swatch.classList.add('swatch--active');
              });
              return swatch;
            }),
          ),
        ),
      ),
      el(
        'div',
        { class: 'editor__actions' },
        el('button', { class: 'btn btn--primary', onClick: () => void save() }, 'Save vibe'),
        existing
          ? el(
              'button',
              {
                class: 'btn',
                onClick: async () => {
                  const copy: Vibe = {
                    ...existing,
                    id: uuid(),
                    title: `${titleInput.value.trim() || existing.title} (copy)`,
                    startMs,
                    endMs,
                    color,
                    hotkey: undefined,
                    order: db.nextOrder(existing.listId),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                  };
                  await db.saveVibe(copy);
                  toast('Duplicated.');
                  ui.go({ name: 'soundboard' });
                },
              },
              'Duplicate',
            )
          : null,
        existing
          ? el(
              'button',
              {
                class: 'btn btn--danger',
                onClick: async () => {
                  if (!window.confirm(`Delete "${existing.title}"?`)) return;
                  await db.deleteVibe(existing.id);
                  toast('Deleted.');
                  ui.go({ name: 'soundboard' });
                },
              },
              'Delete',
            )
          : null,
      ),
      el(
        'p',
        { class: 'hint' },
        'Tip: press [ and ] while listening to drop the start and end at the playhead, then fine-tune with the nudge buttons. Hold Shift while dragging a handle for 10 ms precision.',
      ),
    ),
  );

  refreshRange();

  // Re-hydrate the track if it only exists as a URI (imported data, cleared cache).
  if (!track) {
    void fetchTrack(deps.trackUri)
      .then((fetched: TrackRef | null) => {
        if (!fetched) return;
        track = fetched;
        if (!existing) endMs = Math.min(fetched.durationMs, 30_000);
        renderHeader();
        renderUnplayable();
        refreshRange();
      })
      .catch((error: unknown) =>
        toast(error instanceof Error ? error.message : String(error), 'error'),
      );
  }

  const keyHandler = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)
      return;
    if (event.key === '[') {
      event.preventDefault();
      setFromPlayhead('start');
    } else if (event.key === ']') {
      event.preventDefault();
      setFromPlayhead('end');
    }
  };
  window.addEventListener('keydown', keyHandler);

  const unsubscribe = deps.playback.subscribe((view) => {
    if (view.trackUri !== deps.trackUri) {
      playhead.style.display = 'none';
      return;
    }
    playhead.style.display = '';
    playhead.style.left = `${(view.positionMs / durationMs()) * 100}%`;
  });

  return () => {
    window.removeEventListener('keydown', keyHandler);
    unsubscribe();
  };
}
