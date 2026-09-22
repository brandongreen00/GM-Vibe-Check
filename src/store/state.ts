export type Screen =
  | { name: 'soundboard' }
  | { name: 'library'; relinkVibeId?: string }
  | { name: 'editor'; trackUri: string; vibeId?: string }
  | { name: 'settings' };

const LAST_LIST_KEY = 'vibe-looper.last-list';

/** Screen + selected list. Deliberately not URL-routed: GitHub Pages sub-paths and the
 *  OAuth callback are far simpler when the app only ever lives at its root URL. */
class UiState {
  private listeners = new Set<() => void>();
  screen: Screen = { name: 'soundboard' };
  activeListId: string | null = localStorage.getItem(LAST_LIST_KEY);

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.listeners) fn();
  }

  go(screen: Screen): void {
    this.screen = screen;
    this.notify();
  }

  setActiveList(listId: string): void {
    this.activeListId = listId;
    localStorage.setItem(LAST_LIST_KEY, listId);
    this.notify();
  }
}

export const ui = new UiState();
