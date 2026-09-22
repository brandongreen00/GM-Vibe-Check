import { createStore, get, set, clear as clearStore } from 'idb-keyval';
import type { ExportBundle, TrackRef, Vibe, VibeList } from '../types';
import { uuid } from '../util/id';

const store = createStore('vibe-looper', 'data');

const KEY_LISTS = 'lists';
const KEY_VIBES = 'vibes';
const KEY_TRACKS = 'tracks';
const KEY_LIKED = 'liked-cache';

export interface LikedCache {
  uris: string[];
  syncedAt: number;
}

interface Snapshot {
  lists: VibeList[];
  vibes: Vibe[];
  tracks: Record<string, TrackRef>;
}

/**
 * Everything is mirrored in memory so the UI can render synchronously; writes are
 * fire-and-forget into IndexedDB.
 */
class VibeDb {
  private data: Snapshot = { lists: [], vibes: [], tracks: {} };
  private listeners = new Set<() => void>();
  private ready = false;

  async load(): Promise<void> {
    const [lists, vibes, tracks] = await Promise.all([
      get<VibeList[]>(KEY_LISTS, store),
      get<Vibe[]>(KEY_VIBES, store),
      get<Record<string, TrackRef>>(KEY_TRACKS, store),
    ]);
    this.data = { lists: lists ?? [], vibes: vibes ?? [], tracks: tracks ?? {} };
    if (this.data.lists.length === 0) {
      this.data.lists = [createList('My first session')];
      await set(KEY_LISTS, this.data.lists, store);
    }
    this.ready = true;
    this.notify();
  }

  get isReady(): boolean {
    return this.ready;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  get lists(): VibeList[] {
    return [...this.data.lists].sort((a, b) => a.order - b.order);
  }

  get vibes(): Vibe[] {
    return this.data.vibes;
  }

  vibesInList(listId: string): Vibe[] {
    return this.data.vibes.filter((v) => v.listId === listId).sort((a, b) => a.order - b.order);
  }

  vibe(id: string): Vibe | undefined {
    return this.data.vibes.find((v) => v.id === id);
  }

  track(uri: string): TrackRef | undefined {
    return this.data.tracks[uri];
  }

  get tracks(): TrackRef[] {
    return Object.values(this.data.tracks);
  }

  async putTrack(track: TrackRef): Promise<void> {
    this.data.tracks[track.uri] = track;
    await set(KEY_TRACKS, this.data.tracks, store);
    this.notify();
  }

  async putTracks(tracks: TrackRef[]): Promise<void> {
    for (const track of tracks) this.data.tracks[track.uri] = track;
    await set(KEY_TRACKS, this.data.tracks, store);
    this.notify();
  }

  async saveVibe(vibe: Vibe): Promise<void> {
    const index = this.data.vibes.findIndex((v) => v.id === vibe.id);
    if (index >= 0) this.data.vibes[index] = vibe;
    else this.data.vibes.push(vibe);
    await set(KEY_VIBES, this.data.vibes, store);
    this.notify();
  }

  async deleteVibe(id: string): Promise<void> {
    this.data.vibes = this.data.vibes.filter((v) => v.id !== id);
    await set(KEY_VIBES, this.data.vibes, store);
    this.notify();
  }

  nextOrder(listId: string): number {
    const inList = this.vibesInList(listId);
    return inList.length === 0 ? 0 : Math.max(...inList.map((v) => v.order)) + 1;
  }

  async addList(name: string): Promise<VibeList> {
    const list = createList(name, this.data.lists.length);
    this.data.lists.push(list);
    await set(KEY_LISTS, this.data.lists, store);
    this.notify();
    return list;
  }

  async renameList(id: string, name: string): Promise<void> {
    const list = this.data.lists.find((l) => l.id === id);
    if (!list) return;
    list.name = name;
    await set(KEY_LISTS, this.data.lists, store);
    this.notify();
  }

  async deleteList(id: string): Promise<void> {
    this.data.lists = this.data.lists.filter((l) => l.id !== id);
    this.data.vibes = this.data.vibes.filter((v) => v.listId !== id);
    if (this.data.lists.length === 0) this.data.lists = [createList('My first session')];
    await Promise.all([
      set(KEY_LISTS, this.data.lists, store),
      set(KEY_VIBES, this.data.vibes, store),
    ]);
    this.notify();
  }

  async likedCache(): Promise<LikedCache | undefined> {
    return get<LikedCache>(KEY_LIKED, store);
  }

  async setLikedCache(cache: LikedCache): Promise<void> {
    await set(KEY_LIKED, cache, store);
  }

  exportBundle(): ExportBundle {
    return {
      version: 1,
      lists: this.lists,
      vibes: [...this.data.vibes],
      tracks: this.tracks,
    };
  }

  /**
   * `merge` keeps existing rows and adds unknown ids; `replace` swaps the whole library.
   * Either way the caller has already confirmed with the user.
   */
  async importBundle(bundle: ExportBundle, mode: 'merge' | 'replace'): Promise<void> {
    if (mode === 'replace') {
      this.data = { lists: [...bundle.lists], vibes: [...bundle.vibes], tracks: {} };
      for (const track of bundle.tracks) this.data.tracks[track.uri] = track;
    } else {
      const listIds = new Set(this.data.lists.map((l) => l.id));
      for (const list of bundle.lists) if (!listIds.has(list.id)) this.data.lists.push(list);
      const vibeIds = new Set(this.data.vibes.map((v) => v.id));
      for (const vibe of bundle.vibes) if (!vibeIds.has(vibe.id)) this.data.vibes.push(vibe);
      for (const track of bundle.tracks) this.data.tracks[track.uri] ??= track;
    }
    if (this.data.lists.length === 0) this.data.lists = [createList('My first session')];
    await Promise.all([
      set(KEY_LISTS, this.data.lists, store),
      set(KEY_VIBES, this.data.vibes, store),
      set(KEY_TRACKS, this.data.tracks, store),
    ]);
    this.notify();
  }

  async wipe(): Promise<void> {
    await clearStore(store);
    this.data = { lists: [createList('My first session')], vibes: [], tracks: {} };
    await set(KEY_LISTS, this.data.lists, store);
    this.notify();
  }
}

function createList(name: string, order = 0): VibeList {
  return { id: uuid(), name, order, createdAt: Date.now() };
}

export function isExportBundle(value: unknown): value is ExportBundle {
  if (typeof value !== 'object' || value === null) return false;
  const bundle = value as Partial<ExportBundle>;
  return (
    bundle.version === 1 &&
    Array.isArray(bundle.lists) &&
    Array.isArray(bundle.vibes) &&
    Array.isArray(bundle.tracks)
  );
}

export const db = new VibeDb();
