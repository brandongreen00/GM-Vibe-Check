import { db } from '../store/db';
import type { TrackRef } from '../types';
import { trackIdFromUri } from '../util/id';
import { apiRequest } from './spotifyClient';

export interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

export interface ApiTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists: Array<{ name: string }>;
  album: { name: string; images: SpotifyImage[] };
  is_playable?: boolean;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  imageUrl?: string;
  ownedByUser: boolean;
  trackCount: number | null;
}

interface Paged<T> {
  items: T[];
  total?: number;
  next?: string | null;
}

/** Smallest image that is still big enough for a soundboard thumbnail. */
export function pickArt(images: SpotifyImage[] | undefined): string | undefined {
  if (!images || images.length === 0) return undefined;
  const usable = images
    .filter((image) => (image.height ?? 0) >= 64)
    .sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
  return (usable[0] ?? images[images.length - 1])?.url;
}

export function toTrackRef(track: ApiTrack): TrackRef {
  return {
    uri: track.uri,
    id: track.id,
    name: track.name,
    artists: track.artists.map((artist) => artist.name),
    albumName: track.album?.name ?? '',
    albumArtUrl: pickArt(track.album?.images),
    durationMs: track.duration_ms,
    isPlayable: track.is_playable,
    cachedAt: Date.now(),
  };
}

/**
 * `GET /v1/tracks?ids=` was removed in Feb 2026, so re-hydration is one track at a
 * time. Anything already in IndexedDB is reused unless `force` is set.
 */
export async function fetchTrack(uri: string, force = false): Promise<TrackRef | null> {
  const cached = db.track(uri);
  if (cached && !force) return cached;
  const track = await apiRequest<ApiTrack>(`/tracks/${trackIdFromUri(uri)}`);
  if (!track) return cached ?? null;
  const ref = toTrackRef(track);
  await db.putTrack(ref);
  return ref;
}

export async function fetchProfile(): Promise<{ id: string; display_name?: string } | null> {
  return apiRequest<{ id: string; display_name?: string }>('/me');
}

const LIKED_PAGE_SIZE = 50;

interface SavedTrackItem {
  track?: ApiTrack;
  item?: ApiTrack;
}

/** One page of Liked Songs. Returns the tracks plus whether more pages exist. */
export async function fetchLikedPage(
  offset: number,
): Promise<{ tracks: TrackRef[]; total: number; hasMore: boolean }> {
  const page = await apiRequest<Paged<SavedTrackItem>>(
    `/me/tracks?limit=${LIKED_PAGE_SIZE}&offset=${offset}`,
  );
  const items = page?.items ?? [];
  const tracks = items
    .map((entry) => entry.track ?? entry.item)
    .filter((track): track is ApiTrack => Boolean(track?.uri))
    .map(toTrackRef);
  await db.putTracks(tracks);
  const total = page?.total ?? offset + tracks.length;
  return { tracks, total, hasMore: offset + items.length < total && items.length > 0 };
}

export async function fetchPlaylists(offset = 0): Promise<{
  playlists: PlaylistSummary[];
  hasMore: boolean;
}> {
  const page = await apiRequest<
    Paged<{
      id: string;
      name: string;
      images?: SpotifyImage[];
      owner?: { id: string };
      collaborative?: boolean;
      items?: { total?: number };
      tracks?: { total?: number };
    }>
  >(`/me/playlists?limit=50&offset=${offset}`);
  const items = page?.items ?? [];
  const currentUserId = currentUserIdRef.value;
  const playlists = items.map((playlist) => ({
    id: playlist.id,
    name: playlist.name,
    imageUrl: pickArt(playlist.images),
    ownedByUser:
      Boolean(playlist.collaborative) ||
      (currentUserId !== null && playlist.owner?.id === currentUserId),
    trackCount: playlist.items?.total ?? playlist.tracks?.total ?? null,
  }));
  return { playlists, hasMore: items.length === 50 };
}

/** Lets `fetchPlaylists` flag which playlists Spotify will actually hand us contents for. */
export const currentUserIdRef: { value: string | null } = { value: null };

interface PlaylistItemsResponse {
  // Feb 2026 renamed the wrapper: playlist.tracks.items[].track → playlist.items.items[].item
  items?: Array<{ item?: ApiTrack; track?: ApiTrack }> | { items?: Array<{ item?: ApiTrack }> };
}

/**
 * Spotify only returns contents for playlists the user owns or collaborates on;
 * followed playlists come back without an `items` key at all.
 */
export async function fetchPlaylistTracks(
  playlistId: string,
): Promise<{ tracks: TrackRef[]; contentsAvailable: boolean }> {
  const response = await apiRequest<PlaylistItemsResponse>(
    `/playlists/${playlistId}/items?limit=50`,
    { tolerate403: true },
  );
  if (!response || !response.items) return { tracks: [], contentsAvailable: false };
  const entries = Array.isArray(response.items) ? response.items : (response.items.items ?? []);
  const tracks = entries
    .map(
      (entry) =>
        ('item' in entry ? entry.item : undefined) ?? (entry as { track?: ApiTrack }).track,
    )
    .filter((track): track is ApiTrack => Boolean(track?.uri))
    .map(toTrackRef);
  await db.putTracks(tracks);
  return { tracks, contentsAvailable: true };
}

/** Search caps out at 10 results in Development Mode. */
export async function searchTracks(query: string, signal?: AbortSignal): Promise<TrackRef[]> {
  if (!query.trim()) return [];
  const response = await apiRequest<{ tracks?: Paged<ApiTrack> }>(
    `/search?type=track&limit=10&q=${encodeURIComponent(query)}`,
    { signal },
  );
  const tracks = (response?.tracks?.items ?? [])
    .filter((track) => Boolean(track?.uri))
    .map(toTrackRef);
  await db.putTracks(tracks);
  return tracks;
}
