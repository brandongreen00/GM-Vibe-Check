import { auth } from '../auth/tokens';

const API_BASE = 'https://api.spotify.com/v1';

export type ApiEventKind = 'rate-limited' | 'quota-exceeded' | 'forbidden' | 'auth-required';

export interface ApiEvent {
  kind: ApiEventKind;
  path: string;
  retryAfterSeconds?: number;
  message: string;
  at: number;
}

export class SpotifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
  body?: unknown;
  /** Set for endpoints whose absence should degrade a feature rather than throw. */
  tolerate403?: boolean;
  signal?: AbortSignal;
}

/** Small mutable record the Settings diagnostics panel reads. */
export const apiStatus: {
  lastRateLimitedAt: number | null;
  lastQuotaExceededAt: number | null;
  lastForbiddenPath: string | null;
} = { lastRateLimitedAt: null, lastQuotaExceededAt: null, lastForbiddenPath: null };

const listeners = new Set<(event: ApiEvent) => void>();

export function onApiEvent(fn: (event: ApiEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event: ApiEvent): void {
  if (event.kind === 'rate-limited') apiStatus.lastRateLimitedAt = event.at;
  if (event.kind === 'quota-exceeded') apiStatus.lastQuotaExceededAt = event.at;
  if (event.kind === 'forbidden') apiStatus.lastForbiddenPath = event.path;
  for (const fn of listeners) fn(event);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialises requests behind a single backoff gate: when Spotify hands back a
 * Retry-After we hold every queued call for that long instead of hammering it.
 */
let backoffUntil = 0;

async function waitForBackoff(signal?: AbortSignal): Promise<void> {
  while (Date.now() < backoffUntil) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await sleep(Math.min(1000, backoffUntil - Date.now()));
  }
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T | null> {
  const { method = 'GET', body, tolerate403 = false, signal } = options;
  let refreshed = false;
  let rateLimitRetries = 0;

  for (;;) {
    await waitForBackoff(signal);
    const token = await auth.getValidToken();
    const response = await fetch(path.startsWith('http') ? path : `${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

    if (response.status === 204 || response.status === 202) return null;

    if (response.ok) {
      const text = await response.text();
      return text ? (JSON.parse(text) as T) : null;
    }

    const rawBody = await response.text();

    if (response.status === 401 && !refreshed) {
      refreshed = true;
      await auth.refresh();
      continue;
    }

    if (response.status === 401) {
      emit({
        kind: 'auth-required',
        path,
        message: 'Your Spotify session expired. Connect again.',
        at: Date.now(),
      });
      throw new SpotifyApiError('Spotify session expired', 401, path);
    }

    if (response.status === 429) {
      const reason = extractReason(rawBody);
      if (reason === 'QUOTA_EXCEEDED') {
        emit({
          kind: 'quota-exceeded',
          path,
          message:
            'Daily Web API quota exhausted for this Spotify developer account. Playback keeps working; browsing and search resume tomorrow.',
          at: Date.now(),
        });
        throw new SpotifyApiError('Quota exceeded', 429, path, reason);
      }
      const retryAfter = Number(response.headers.get('Retry-After') ?? '1');
      const seconds = Number.isFinite(retryAfter) ? Math.max(1, retryAfter) : 1;
      emit({
        kind: 'rate-limited',
        path,
        retryAfterSeconds: seconds,
        message: `Spotify asked us to slow down — retrying in ${seconds}s.`,
        at: Date.now(),
      });
      backoffUntil = Math.max(backoffUntil, Date.now() + seconds * 1000);
      rateLimitRetries += 1;
      if (rateLimitRetries > 3) {
        throw new SpotifyApiError('Rate limited by Spotify', 429, path, reason);
      }
      continue;
    }

    if (response.status === 403) {
      emit({
        kind: 'forbidden',
        path,
        message: `Spotify refused ${path} (403). In Development Mode some endpoints are unavailable.`,
        at: Date.now(),
      });
      if (tolerate403) return null;
      throw new SpotifyApiError(spotifyMessage(rawBody) ?? 'Forbidden', 403, path);
    }

    throw new SpotifyApiError(
      spotifyMessage(rawBody) ?? `Spotify request failed (${response.status})`,
      response.status,
      path,
    );
  }
}

function extractReason(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { reason?: string } };
    return parsed.error?.reason;
  } catch {
    return undefined;
  }
}

function spotifyMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof parsed.error === 'string') return parsed.error;
    return parsed.error?.message ?? null;
  } catch {
    return body || null;
  }
}
