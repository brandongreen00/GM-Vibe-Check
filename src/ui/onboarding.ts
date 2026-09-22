import { redirectUri } from '../auth/pkce';
import { auth } from '../auth/tokens';
import { el, mount } from '../util/dom';
import { toast } from './toast';

const DEV_REDIRECT_URI = 'http://127.0.0.1:5173/';

function copyButton(value: string): HTMLElement {
  return el(
    'button',
    {
      class: 'btn btn--small',
      type: 'button',
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast('Copied to clipboard.');
        } catch {
          toast('Copy failed — select the text and copy it manually.', 'warn');
        }
      },
    },
    'Copy',
  );
}

function copyRow(value: string): HTMLElement {
  return el(
    'div',
    { class: 'copy-row' },
    el('code', { class: 'copy-row__value' }, value),
    copyButton(value),
  );
}

export function renderOnboarding(root: HTMLElement, initialError?: string): void {
  const input = el('input', {
    type: 'text',
    id: 'client-id',
    class: 'input',
    placeholder: 'e.g. 1a2b3c4d5e6f7890abcdef1234567890',
    autocomplete: 'off',
    spellcheck: false,
    value: auth.clientId,
  });

  const connect = async () => {
    try {
      await auth.beginAuthorize(input.value);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') void connect();
  });

  mount(
    root,
    el(
      'div',
      { class: 'onboarding' },
      el('h1', { class: 'onboarding__title' }, 'Vibe Looper'),
      el(
        'p',
        { class: 'lede' },
        'A soundboard for game masters: mark the best section of a track you already have on Spotify, then loop it with one tap at the table.',
      ),
      el(
        'p',
        { class: 'lede' },
        'You need Spotify Premium, and you create your own free "app" in Spotify\'s dashboard so the connection is yours alone. Nothing leaves your browser — your Client ID and your Vibes are stored only on this device.',
      ),
      initialError ? el('div', { class: 'banner banner--error' }, initialError) : null,
      el(
        'ol',
        { class: 'steps' },
        el(
          'li',
          {},
          el('strong', {}, 'Create an app. '),
          'Open the ',
          el(
            'a',
            {
              href: 'https://developer.spotify.com/dashboard',
              target: '_blank',
              rel: 'noreferrer noopener',
            },
            'Spotify Developer Dashboard',
          ),
          ' and click Create app. Any name and description will do. Under "Which API/SDKs are you planning to use?" tick ',
          el('strong', {}, 'Web API'),
          ' and ',
          el('strong', {}, 'Web Playback SDK'),
          '.',
        ),
        el(
          'li',
          {},
          el('strong', {}, 'Add this exact Redirect URI. '),
          'Paste it into the Redirect URIs field and press Add, then Save:',
          copyRow(redirectUri()),
          el(
            'details',
            { class: 'details' },
            el('summary', {}, 'Developing locally?'),
            el(
              'p',
              {},
              'Also add the dev server URL. Spotify no longer accepts "localhost" — use the IPv4 literal:',
            ),
            copyRow(DEV_REDIRECT_URI),
          ),
        ),
        el(
          'li',
          {},
          el('strong', {}, 'Copy the Client ID. '),
          "It is on the app's settings page. Do ",
          el('strong', {}, 'not'),
          ' copy the Client Secret — this app uses PKCE and never asks for one.',
        ),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'label', for: 'client-id' }, 'Your Spotify Client ID'),
        input,
        el('button', { class: 'btn btn--primary', onClick: connect }, 'Connect Spotify'),
      ),
      el(
        'details',
        { class: 'details' },
        el('summary', {}, 'Something went wrong?'),
        el(
          'ul',
          { class: 'bullets' },
          el(
            'li',
            {},
            el('strong', {}, '"INVALID_CLIENT: Invalid redirect URI" '),
            'means the URI in your dashboard does not match byte-for-byte. Check the trailing slash, http vs https, and that you used 127.0.0.1 rather than localhost.',
          ),
          el(
            'li',
            {},
            'Spotify Development Mode apps allow up to 5 listeners, and the app owner must hold Premium. If Premium lapses, the app stops working until it is renewed.',
          ),
          el(
            'li',
            {},
            'Playback happens in this browser tab and needs a desktop browser with Encrypted Media Extensions: Chrome, Edge, Firefox or Safari. Mobile browsers are not supported.',
          ),
        ),
      ),
    ),
  );
}
