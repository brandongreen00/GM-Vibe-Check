import { currentUserIdRef, fetchProfile } from '../api/library';
import { onApiEvent } from '../api/spotifyClient';
import { auth } from '../auth/tokens';
import { PlaybackController } from '../player/controller';
import { db } from '../store/db';
import { settings } from '../store/settings';
import { ui } from '../store/state';
import type { Vibe } from '../types';
import { el, mount } from '../util/dom';
import { renderEditor } from './editor';
import { installHotkeys } from './hotkeys';
import { renderLibrary } from './library';
import { renderOnboarding } from './onboarding';
import { renderSettings } from './settings';
import { renderSoundboard } from './soundboard';
import { clearBanner, mountNotifications, showBanner, toast } from './toast';
import { createTransport } from './transport';

const IOS_PATTERN = /iPad|iPhone|iPod/;

export async function startApp(root: HTMLElement): Promise<void> {
  mountNotifications(document.body);

  const callback = await auth.handleRedirectCallback();
  await db.load();

  if (!auth.isConnected) {
    renderOnboarding(root, callback.error);
    auth.subscribe(() => {
      if (auth.isConnected) void startApp(root);
    });
    return;
  }

  if (isUnsupportedMobile()) {
    showBanner(
      'mobile',
      'Spotify’s in-browser player does not work reliably on mobile browsers. Vibe Looper is desktop-first — use Chrome, Edge, Firefox or Safari on a computer.',
      'warn',
    );
  }

  const playback = new PlaybackController();
  const screenRoot = el('main', { class: 'app__main' });
  const transport = createTransport(playback);
  let disposeScreen: (() => void) | undefined;

  const header = el(
    'header',
    { class: 'app__header' },
    el('span', { class: 'app__brand' }, 'Vibe Looper'),
    el(
      'nav',
      { class: 'app__nav' },
      el(
        'button',
        { class: 'btn btn--small', onClick: () => ui.go({ name: 'soundboard' }) },
        'Soundboard',
      ),
      el(
        'button',
        { class: 'btn btn--small', onClick: () => ui.go({ name: 'library' }) },
        'Library',
      ),
      el(
        'button',
        { class: 'btn btn--small', onClick: () => ui.go({ name: 'settings' }) },
        'Settings',
      ),
    ),
  );

  mount(root, el('div', { class: 'app' }, header, screenRoot, transport.node));

  const renderScreen = () => {
    disposeScreen?.();
    disposeScreen = undefined;
    const screen = ui.screen;
    if (screen.name === 'soundboard') {
      disposeScreen = renderSoundboard(screenRoot, {
        playback,
        onEditVibe: (vibe: Vibe) =>
          ui.go({ name: 'editor', trackUri: vibe.trackUri, vibeId: vibe.id }),
      });
    } else if (screen.name === 'library') {
      renderLibrary(screenRoot);
    } else if (screen.name === 'editor') {
      disposeScreen = renderEditor(screenRoot, {
        playback,
        trackUri: screen.trackUri,
        vibeId: screen.vibeId,
      });
    } else {
      disposeScreen = renderSettings(screenRoot, {
        playback,
        onReset: () => window.location.reload(),
      });
    }
  };

  ui.subscribe(renderScreen);
  db.subscribe(() => {
    if (ui.screen.name === 'soundboard') renderScreen();
  });
  renderScreen();

  const removeHotkeys = installHotkeys(playback);

  wireSdkEvents(playback);
  wireApiEvents();

  void fetchProfile()
    .then((profile) => {
      if (!profile) return;
      currentUserIdRef.value = profile.id;
      auth.setProfile(profile.id, profile.display_name ?? profile.id);
    })
    .catch(() => undefined);

  await playback.backend.connect().catch((error: unknown) => {
    showBanner('sdk', error instanceof Error ? error.message : String(error), 'error');
  });
  await playback.setVolume(settings.current.defaultVolume);

  // Releasing the device on pagehide stops Spotify showing a ghost "Vibe Looper".
  window.addEventListener('pagehide', () => {
    removeHotkeys();
    transport.dispose();
    playback.shutdown();
  });
}

function wireSdkEvents(playback: PlaybackController): void {
  playback.backend.on('status', (status, detail) => {
    playback.note(`sdk: ${status}${detail ? ` — ${detail}` : ''}`);
    clearBanner('sdk');
    if (status === 'no-premium') {
      showBanner(
        'sdk',
        'Spotify Premium is required to play audio in the browser. Development Mode apps also require the app owner to hold Premium.',
        'error',
      );
    } else if (status === 'unsupported-browser') {
      showBanner(
        'sdk',
        'Your browser cannot run Spotify’s player (it needs Encrypted Media Extensions). Use desktop Chrome, Edge, Firefox or Safari.',
        'error',
      );
    } else if (status === 'auth-error') {
      showBanner('sdk', 'Spotify rejected the session. Reconnect from Settings.', 'error', {
        label: 'Reconnect',
        onClick: () => {
          auth.disconnect();
          window.location.reload();
        },
      });
    } else if (status === 'not-ready') {
      showBanner(
        'sdk',
        'The Vibe Looper device went offline. It usually comes back on its own.',
        'warn',
      );
    }
  });

  playback.backend.on('autoplayFailed', () => {
    showBanner('autoplay', 'Your browser blocked audio until you interact with the page.', 'warn', {
      label: 'Enable audio',
      onClick: () => {
        clearBanner('autoplay');
        void playback.retryPendingVibe();
      },
    });
  });

  playback.backend.on('playbackError', (message) => {
    playback.note(`playback error: ${message}`);
    toast(message, 'error');
  });

  playback.backend.on('playbackMoved', () => {
    showBanner('moved', 'Playback moved to another device.', 'warn', {
      label: 'Take it back',
      onClick: async () => {
        clearBanner('moved');
        await playback.backend.transferPlayback();
      },
    });
  });
}

function wireApiEvents(): void {
  onApiEvent((event) => {
    if (event.kind === 'quota-exceeded') {
      showBanner('quota', event.message, 'error');
    } else if (event.kind === 'rate-limited') {
      toast(event.message, 'warn', 3000);
    } else if (event.kind === 'auth-required') {
      showBanner('auth', event.message, 'error', {
        label: 'Reconnect',
        onClick: () => {
          auth.disconnect();
          window.location.reload();
        },
      });
    } else if (event.kind === 'forbidden') {
      console.warn(event.message);
    }
  });
}

function isUnsupportedMobile(): boolean {
  return IOS_PATTERN.test(navigator.userAgent) || /Android/.test(navigator.userAgent);
}
