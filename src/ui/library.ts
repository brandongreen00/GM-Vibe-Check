import {
  fetchLikedPage,
  fetchPlaylistTracks,
  fetchPlaylists,
  searchTracks,
  type PlaylistSummary,
} from '../api/library';
import { db } from '../store/db';
import { ui } from '../store/state';
import { MIN_VIBE_LENGTH_MS, type TrackRef } from '../types';
import { el, mount } from '../util/dom';
import { formatClock } from '../util/time';
import { toast } from './toast';

type Tab = 'liked' | 'playlists' | 'search';

interface LibraryState {
  tab: Tab;
  likedUris: string[];
  likedSyncedAt: number | null;
  likedOffset: number;
  likedHasMore: boolean;
  loading: boolean;
  playlists: PlaylistSummary[];
  openPlaylistId: string | null;
  playlistTracks: TrackRef[];
  playlistUnavailable: boolean;
  searchQuery: string;
  searchResults: TrackRef[];
}

const state: LibraryState = {
  tab: 'liked',
  likedUris: [],
  likedSyncedAt: null,
  likedOffset: 0,
  likedHasMore: true,
  loading: false,
  playlists: [],
  openPlaylistId: null,
  playlistTracks: [],
  playlistUnavailable: false,
  searchQuery: '',
  searchResults: [],
};

let searchTimer: number | undefined;
let searchAbort: AbortController | null = null;

/** In relink mode, picking a track repoints an existing Vibe instead of creating one. */
async function chooseTrack(track: TrackRef): Promise<void> {
  const screen = ui.screen;
  const relinkVibeId = screen.name === 'library' ? screen.relinkVibeId : undefined;
  if (!relinkVibeId) {
    ui.go({ name: 'editor', trackUri: track.uri });
    return;
  }
  const vibe = db.vibe(relinkVibeId);
  if (!vibe) {
    ui.go({ name: 'editor', trackUri: track.uri });
    return;
  }
  const endMs = Math.min(vibe.endMs, track.durationMs);
  const startMs = Math.min(vibe.startMs, Math.max(0, endMs - MIN_VIBE_LENGTH_MS));
  await db.saveVibe({ ...vibe, trackUri: track.uri, startMs, endMs, updatedAt: Date.now() });
  toast(`"${vibe.title}" now points at ${track.name}. Check the loop points.`);
  ui.go({ name: 'editor', trackUri: track.uri, vibeId: vibe.id });
}

function trackRow(track: TrackRef): HTMLElement {
  return el(
    'button',
    {
      class: 'track',
      type: 'button',
      onClick: () => void chooseTrack(track),
    },
    track.albumArtUrl
      ? el('img', { class: 'track__art', src: track.albumArtUrl, alt: '' })
      : el('span', { class: 'track__art track__art--empty' }, '♪'),
    el(
      'span',
      { class: 'track__meta' },
      el('span', { class: 'track__name' }, track.name),
      el('span', { class: 'track__artist' }, track.artists.join(', ')),
    ),
    el('span', { class: 'track__duration' }, formatClock(track.durationMs)),
  );
}

async function loadLikedPage(rerender: () => void): Promise<void> {
  if (state.loading || !state.likedHasMore) return;
  state.loading = true;
  rerender();
  try {
    const { tracks, hasMore } = await fetchLikedPage(state.likedOffset);
    const uris = tracks.map((track) => track.uri);
    state.likedUris = [...state.likedUris, ...uris.filter((uri) => !state.likedUris.includes(uri))];
    state.likedOffset += tracks.length;
    state.likedHasMore = hasMore;
    state.likedSyncedAt = Date.now();
    await db.setLikedCache({ uris: state.likedUris, syncedAt: state.likedSyncedAt });
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
    state.likedHasMore = false;
  } finally {
    state.loading = false;
    rerender();
  }
}

async function ensureLikedLoaded(rerender: () => void): Promise<void> {
  if (state.likedUris.length > 0) return;
  const cache = await db.likedCache();
  if (cache && cache.uris.length > 0) {
    // Cached list renders instantly; quota is per developer account, so we do not
    // re-pull a 2,000 track library on every visit.
    state.likedUris = cache.uris;
    state.likedSyncedAt = cache.syncedAt;
    state.likedOffset = cache.uris.length;
    rerender();
    return;
  }
  await loadLikedPage(rerender);
}

async function refreshLiked(rerender: () => void): Promise<void> {
  state.likedUris = [];
  state.likedOffset = 0;
  state.likedHasMore = true;
  await loadLikedPage(rerender);
}

async function ensurePlaylists(rerender: () => void): Promise<void> {
  if (state.playlists.length > 0 || state.loading) return;
  state.loading = true;
  rerender();
  try {
    const { playlists } = await fetchPlaylists();
    state.playlists = playlists;
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    state.loading = false;
    rerender();
  }
}

async function openPlaylist(id: string, rerender: () => void): Promise<void> {
  state.openPlaylistId = id;
  state.playlistTracks = [];
  state.playlistUnavailable = false;
  state.loading = true;
  rerender();
  try {
    const { tracks, contentsAvailable } = await fetchPlaylistTracks(id);
    state.playlistTracks = tracks;
    state.playlistUnavailable = !contentsAvailable;
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error');
    state.playlistUnavailable = true;
  } finally {
    state.loading = false;
    rerender();
  }
}

function runSearch(query: string, rerender: () => void): void {
  state.searchQuery = query;
  window.clearTimeout(searchTimer);
  searchAbort?.abort();
  if (!query.trim()) {
    state.searchResults = [];
    rerender();
    return;
  }
  searchTimer = window.setTimeout(async () => {
    const controller = new AbortController();
    searchAbort = controller;
    state.loading = true;
    rerender();
    try {
      state.searchResults = await searchTracks(query, controller.signal);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        toast(error instanceof Error ? error.message : String(error), 'error');
      }
    } finally {
      state.loading = false;
      rerender();
    }
  }, 400);
}

/** Doubles as the infinite-scroll sentinel: scrolling it into view loads the next page. */
function loadMoreButton(rerender: () => void): HTMLElement {
  const button = el(
    'button',
    { class: 'btn btn--wide', onClick: () => void loadLikedPage(rerender) },
    state.loading ? 'Loading…' : 'Load more',
  );
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && !state.loading) {
      void loadLikedPage(rerender);
    }
  });
  observer.observe(button);
  // The button is discarded on every re-render, so the observer must go with it.
  queueMicrotask(() => {
    if (!button.isConnected) observer.disconnect();
  });
  return button;
}

export function renderLibrary(root: HTMLElement): void {
  const rerender = () => renderLibrary(root);

  const tabButton = (tab: Tab, label: string) =>
    el(
      'button',
      {
        class: `tab ${state.tab === tab ? 'tab--active' : ''}`,
        onClick: () => {
          state.tab = tab;
          rerender();
          if (tab === 'liked') void ensureLikedLoaded(rerender);
          if (tab === 'playlists') void ensurePlaylists(rerender);
        },
      },
      label,
    );

  let body: HTMLElement;
  if (state.tab === 'liked') {
    const tracks = state.likedUris
      .map((uri) => db.track(uri))
      .filter((track): track is TrackRef => Boolean(track));
    body = el(
      'div',
      { class: 'library__body' },
      el(
        'div',
        { class: 'library__toolbar' },
        el(
          'span',
          { class: 'hint' },
          state.likedSyncedAt
            ? `Last synced ${new Date(state.likedSyncedAt).toLocaleString()} · ${tracks.length} loaded`
            : 'Not synced yet',
        ),
        el(
          'button',
          { class: 'btn btn--small', onClick: () => void refreshLiked(rerender) },
          'Refresh',
        ),
      ),
      el('div', { class: 'track-list' }, ...tracks.map(trackRow)),
      state.likedHasMore
        ? loadMoreButton(rerender)
        : el('p', { class: 'hint' }, 'That is all of your Liked Songs.'),
    );
  } else if (state.tab === 'playlists') {
    body = state.openPlaylistId
      ? el(
          'div',
          { class: 'library__body' },
          el(
            'button',
            {
              class: 'btn btn--small',
              onClick: () => {
                state.openPlaylistId = null;
                rerender();
              },
            },
            '← All playlists',
          ),
          state.playlistUnavailable
            ? el(
                'p',
                { class: 'notice' },
                'Spotify only exposes the contents of playlists you own or collaborate on. Save the tracks you want to your Liked Songs instead.',
              )
            : el('div', { class: 'track-list' }, ...state.playlistTracks.map(trackRow)),
        )
      : el(
          'div',
          { class: 'library__body' },
          state.loading ? el('p', { class: 'hint' }, 'Loading playlists…') : null,
          el(
            'div',
            { class: 'track-list' },
            ...state.playlists.map((playlist) =>
              el(
                'button',
                { class: 'track', onClick: () => void openPlaylist(playlist.id, rerender) },
                playlist.imageUrl
                  ? el('img', { class: 'track__art', src: playlist.imageUrl, alt: '' })
                  : el('span', { class: 'track__art track__art--empty' }, '≡'),
                el(
                  'span',
                  { class: 'track__meta' },
                  el('span', { class: 'track__name' }, playlist.name),
                  el(
                    'span',
                    { class: 'track__artist' },
                    playlist.ownedByUser ? 'Yours' : 'Followed — contents may be unavailable',
                  ),
                ),
                el(
                  'span',
                  { class: 'track__duration' },
                  playlist.trackCount === null ? '' : `${playlist.trackCount}`,
                ),
              ),
            ),
          ),
        );
  } else {
    const input = el('input', {
      class: 'input',
      type: 'search',
      placeholder: 'Search Spotify for a track…',
      value: state.searchQuery,
      autocomplete: 'off',
    }) as HTMLInputElement;
    input.addEventListener('input', () => runSearch(input.value, rerender));
    body = el(
      'div',
      { class: 'library__body' },
      input,
      el('p', { class: 'hint' }, 'Development Mode caps search at 10 results.'),
      state.loading ? el('p', { class: 'hint' }, 'Searching…') : null,
      el('div', { class: 'track-list' }, ...state.searchResults.map(trackRow)),
    );
    queueMicrotask(() => input.focus());
  }

  mount(
    root,
    el(
      'div',
      { class: 'screen screen--library' },
      el(
        'header',
        { class: 'library__header' },
        el(
          'h2',
          {},
          ui.screen.name === 'library' && ui.screen.relinkVibeId
            ? 'Pick a replacement track'
            : 'Pick a track',
        ),
        el(
          'button',
          { class: 'btn btn--small', onClick: () => ui.go({ name: 'soundboard' }) },
          '← Soundboard',
        ),
      ),
      el(
        'nav',
        { class: 'tabs' },
        tabButton('liked', 'Liked Songs'),
        tabButton('playlists', 'Playlists'),
        tabButton('search', 'Search'),
      ),
      body,
    ),
  );

  if (state.tab === 'liked') void ensureLikedLoaded(rerender);
}
