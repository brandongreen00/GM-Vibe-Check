# Vibe Looper

A Game Master's Spotify soundboard. Mark the best twelve seconds of a track you already
have on Spotify, give it a name like **Tavern ambience** or **Boss fight build-up**, and
tap one big button at the table to loop that section until you tap another.

Everything runs in your browser. There is no backend, no account on our side, and no
audio is downloaded or altered — the app only tells Spotify's own player where to play
and when to seek.

---

## Before you start: two hard requirements

1. **You need Spotify Premium.** Spotify's Web Playback SDK refuses to play for free
   accounts, and Development Mode apps additionally require the _app owner_ to hold
   Premium. If that subscription lapses, the app stops working until it is renewed.
2. **You need your own Spotify Client ID.** Spotify caps a Development Mode app at five
   listed users, so a single shared app could never work. You create a free app in
   Spotify's dashboard and paste its Client ID into Vibe Looper, where it is stored only
   in your browser's `localStorage`.

Vibe Looper can play audio two ways, switchable in **Settings → Where audio plays**:

|                          | **This browser tab** (default)     | **Another Spotify device**                  |
| ------------------------ | ---------------------------------- | ------------------------------------------- |
| How                      | Spotify Web Playback SDK           | Spotify Connect, over the Web API           |
| Loop accuracy            | tight, ~±150 ms                    | rough, ~±500 ms                             |
| Needs                    | desktop Chrome/Edge/Firefox/Safari | anything, including phones                  |
| Quota cost while looping | none                               | one poll per second, plus one call per loop |

In-browser playback is the better experience, so it stays the default. Use **another
device** on a phone or tablet, or if your browser cannot run Spotify's player — the audio
then comes out of your phone's Spotify app, your desktop client or a speaker, and Vibe
Looper just drives it.

## Setting up your Spotify app (about two minutes)

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and
   click **Create app**. The name and description do not matter.
2. Under _Which API/SDKs are you planning to use?_ tick **Web API** and
   **Web Playback SDK**.
3. In **Redirect URIs**, paste the deployed app URL — for this repository that is
   `https://<your-github-username>.github.io/GM-Vibe-Check/` — press **Add**, then
   **Save**. The onboarding screen shows the exact string with a copy button; use that
   rather than typing it.
4. Open the app's **Settings** page and copy the **Client ID**. Do **not** copy the
   Client Secret — Vibe Looper uses Authorization Code with PKCE and never asks for one.
5. Paste the Client ID into Vibe Looper and press **Connect Spotify**.

### Redirect URI rules (enforced by Spotify since Nov 2025)

- It must match **byte-for-byte**, including the trailing slash and letter case.
- It must be HTTPS, except for loopback IP addresses.
- `localhost` is **not** accepted. For local development register the IPv4 literal
  `http://127.0.0.1:5173/`.

If Spotify shows _INVALID_CLIENT: Invalid redirect URI_ before it ever returns to the
app, one of those three rules is being broken — almost always the trailing slash.

## Using it

- **Library** → _Liked Songs_, _Playlists_ or _Search_ → click a track.
- **Vibe editor** → drag the two handles (hold <kbd>Shift</kbd> for 10 ms precision), or
  play the track and press <kbd>[</kbd> and <kbd>]</kbd> to drop the start and end at the
  playhead. **Preview loop** arms the loop on the unsaved range so you can dial it in by
  ear. Give it a title, a list, a colour and optionally a hotkey, then save.
- **Soundboard** → one button per Vibe. Tap to play and loop; tap another to switch; tap
  the playing one to pause (or stop, your choice in Settings).
- **Hotkeys** → `1`–`9`, `0`, then `q w e r t y u i o p` map to the Vibes in the current
  list in order, overridable per Vibe. <kbd>Space</kbd> pauses, <kbd>Esc</kbd> stops.
  Hotkeys are disabled while you are typing.
- **Settings** → where audio plays, seek lookahead, fade between Vibes, JSON
  export/import, disconnect, reset, and a diagnostics panel that logs every loop seek.

### Rough loop mode (playing on another device)

Spotify pushes no playback state for remote devices, so Vibe Looper polls
`GET /me/player` (once a second by default, adjustable 0.5–5 s in Settings) and
extrapolates the playhead between polls. Loop boundaries therefore land within roughly
±500 ms instead of ±150 ms, and every boundary spends a `PUT /me/player/seek`.

Budget for it: a one-second poll is about 3,600 calls an hour on top of one call per
loop — a 10-second loop running for an hour adds another 360. That quota is shared
across your whole Spotify developer account, so raise the poll interval if you hit the
`QUOTA_EXCEEDED` banner. Fades are skipped in this mode (each ramp step would be another
call), and remote volume is throttled; some devices refuse remote volume entirely.

### If loops overshoot or cut early

Spotify's seek takes somewhere between 100 ms and 400 ms depending on your connection,
so the loop engine seeks slightly _before_ the end point. That margin is the
**seek lookahead** setting (default 150 ms, range 0–600 ms):

- loops **overshoot** the end → raise it;
- loops **cut early** → lower it.

### If a vibe refuses to start

Spotify drops an idle web player out of the active-device slot, after which
`PUT /me/player/play` for it fails. Vibe Looper handles this by re-claiming the device
and retrying once; if it still cannot start, a banner explains why and offers a retry
rather than leaving you with a button that does nothing. If a play request is accepted
but nothing actually starts within five seconds — usually because another device grabbed
playback — the same banner offers **Take back & retry**.

## What Spotify's Development Mode does and does not allow

Development Mode is the only realistic tier for a personal tool: Extended Quota Mode
requires a registered business with a launched product and 250k+ monthly active users.

- Up to **5 users per app**, each added by hand to the allowlist in your dashboard.
- A developer account may hold up to 25 Client IDs, but **API quota is shared per
  developer account**, not per Client ID. Exhausting it returns HTTP 429 with
  `reason: QUOTA_EXCEEDED`; Vibe Looper shows a persistent banner and keeps working for
  playback, since seek/pause/resume go through the SDK rather than the Web API.
- Ordinary rate limiting also returns 429, but with a `Retry-After` header. The app
  backs off for that long and retries.

**Endpoints removed in Feb 2026 that this app therefore never calls:**
`/audio-analysis`, `/audio-features` (so there is **no beat grid or waveform** — loop
points are set by ear, on purpose), batch `/tracks?ids=`, `/recommendations`, artist
top-tracks, browse/new-releases/categories, and other users' profiles and playlists.
A Vitest suite (`tests/endpoints.test.ts`) fails the build if any of them reappear.

Two consequences worth knowing:

- **Playlists you merely follow return metadata only.** Spotify exposes contents only
  for playlists you own or collaborate on; the app tells you to save those tracks to
  your Liked Songs instead.
- **Premium cannot be pre-checked.** `me.product` was removed, so the app detects a
  non-Premium account from the SDK's `account_error` event and explains it then.

Changelogs: [Feb 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026),
[Feb 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide),
[July 2026 quota changes](https://developer.spotify.com/documentation/web-api/references/changes/july-2026).

## Local development

```bash
npm install
npm run dev        # serves http://127.0.0.1:5173/
```

Register `http://127.0.0.1:5173/` as a second Redirect URI in your Spotify app.
Do not use `localhost` — Spotify rejects it.

```bash
npm test           # Vitest: loop engine, backends, removed-endpoint guard
npm run lint
npm run build      # typecheck, bundle to dist/, copy index.html to 404.html
```

`vite.config.ts` sets `base: '/GM-Vibe-Check/'` to match the GitHub Pages sub-path. If
you fork this under a different repository name, change that value to match, since the
onboarding screen derives the redirect URI from it. The `404.html` copy means a stale
deep link still boots the app instead of hitting Pages' own 404.

Pushing to `main` builds and deploys through `.github/workflows/deploy.yml`; enable
Pages with **Source: GitHub Actions** in the repository settings once.

## How the loop works

Spotify has no native A–B loop, so `src/player/loopEngine.ts` implements one:

- every `player_state_changed` event records `{position, timestamp, paused, duration,
trackUri}` — the SDK reports position at the moment of the event, it does not stream it;
- a `requestAnimationFrame` ticker (a 50 ms timer while the tab is hidden, because rAF
  stops in background tabs) extrapolates the current position from that snapshot;
- one seek-lookahead before the end point it issues `player.seek(startMs)`, assumes the
  seek landed, and debounces for 300 ms so a late state event cannot trigger a second seek;
- repeat-track is set on the Spotify side as a safety net: if a Vibe ends at the very end
  of the song, Spotify wraps to 0 rather than stopping, and the engine pulls it back;
- scrubbing outside the loop region stands the loop down until you re-arm it with the
  **Loop** toggle in the transport bar.

The engine is pure — its inputs are state snapshots and a clock, its output is a "seek
to X" command — so `tests/loopEngine.test.ts` drives ten minutes of looping with a fake
clock and asserts no drift, no overshoot beyond the lookahead, and no double seeks.

Both playback routes sit behind the `PlaybackBackend` interface
(`src/player/backend.ts`): `src/player/sdk.ts` plays in this tab, `src/player/connect.ts`
drives another device by polling and seeking over the Web API. The loop engine, the
soundboard and the editor are identical either way — only the precision differs.

## Privacy

- Your Client ID, tokens and settings live in `localStorage`; your Vibes and cached track
  details live in IndexedDB. Both are on your device only.
- The app talks to `accounts.spotify.com`, `api.spotify.com` and `sdk.scdn.co`, and to
  nothing else. There is no analytics, no telemetry and no server of ours.
- **Disconnect** clears tokens and keeps your Vibes. **Reset everything** wipes the lot.
  Export to JSON first if you want a backup.

## Spotify policy note

Vibe Looper is a personal, non-commercial tool. It issues play, pause and seek commands
to Spotify's own player and does not download, cache, alter, remix or redistribute any
audio, does not synchronise Spotify content with visual media, and does not broadcast it.
Keep it that way: do not add crossfading with other audio sources, recording, or public
playback — those uses are prohibited by the Spotify Developer Terms and the Web Playback
SDK terms.

## Licence

MIT — see [LICENSE](LICENSE).
