import { DEFAULT_SETTINGS, type Settings } from '../types';
import { clamp } from '../util/time';

const KEY = 'vibe-looper.settings';

function read(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

class SettingsStore {
  private value: Settings = read();
  private listeners = new Set<(settings: Settings) => void>();

  get current(): Settings {
    return this.value;
  }

  subscribe(fn: (settings: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(patch: Partial<Settings>): void {
    this.value = sanitise({ ...this.value, ...patch });
    localStorage.setItem(KEY, JSON.stringify(this.value));
    for (const fn of this.listeners) fn(this.value);
  }

  reset(): void {
    this.update({ ...DEFAULT_SETTINGS });
  }
}

function sanitise(settings: Settings): Settings {
  return {
    ...settings,
    seekLookaheadMs: Math.round(clamp(settings.seekLookaheadMs, 0, 600)),
    defaultVolume: clamp(settings.defaultVolume, 0, 1),
    fadeMs: Math.round(clamp(settings.fadeMs, 0, 2000)),
  };
}

export const settings = new SettingsStore();
