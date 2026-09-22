import type { PlaybackController } from '../player/controller';
import { db } from '../store/db';
import { ui } from '../store/state';
import { isTextEntryFocused } from '../util/dom';
import { activateVibe, activeList, hotkeyFor } from './soundboard';

/** Global soundboard hotkeys. Text entry always wins, so the editor stays usable. */
export function installHotkeys(playback: PlaybackController): () => void {
  const handler = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTextEntryFocused()) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      void playback.stop();
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      void playback.togglePause();
      return;
    }
    if (ui.screen.name !== 'soundboard') return;

    const listId = activeList();
    if (!listId) return;
    const key = event.key.toLowerCase();
    const vibes = db.vibesInList(listId);
    const match = vibes.find((vibe, index) => hotkeyFor(vibe, index) === key);
    if (!match) return;
    event.preventDefault();
    void activateVibe(playback, match);
  };

  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
