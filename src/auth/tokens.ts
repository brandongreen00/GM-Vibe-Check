import type { AuthState } from '../types';
import { SCOPES } from '../types';
import { createCodeChallenge, createCodeVerifier, createStateToken, redirectUri } from './pkce';

const STORAGE_KEY = 'vibe-looper.auth';
const VERIFIER_KEY = 'vibe-looper.pkce.verifier';
const STATE_KEY = 'vibe-looper.pkce.state';
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
/** Renew this far before the real expiry so an in-flight request never races it. */
const EXPIRY_MARGIN_MS = 60_000;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly kind: 'no_client_id' | 'state_mismatch' | 'token_request' | 'no_refresh_token',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

function readAuth(): AuthState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { clientId: '' };
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    return { ...parsed, clientId: parsed.clientId ?? '' };
  } catch {
    return { clientId: '' };
  }
}

export class Auth {
  private state: AuthState = readAuth();
  private refreshInFlight: Promise<string> | null = null;
  private listeners = new Set<(state: AuthState) => void>();

  get snapshot(): AuthState {
    return { ...this.state };
  }

  get clientId(): string {
    return this.state.clientId;
  }

  get isConnected(): boolean {
    return Boolean(this.state.clientId && this.state.refreshToken);
  }

  subscribe(fn: (state: AuthState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private patch(patch: Partial<AuthState>): void {
    this.state = { ...this.state, ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    for (const fn of this.listeners) fn(this.snapshot);
  }

  setClientId(clientId: string): void {
    this.patch({ clientId: clientId.trim() });
  }

  setProfile(userId: string, displayName: string): void {
    this.patch({ userId, displayName });
  }

  /** Kicks off the PKCE redirect. Persists the client id first so the callback can use it. */
  async beginAuthorize(clientId: string): Promise<void> {
    const id = clientId.trim();
    if (!id) throw new AuthError('Enter your Spotify Client ID first.', 'no_client_id');
    this.setClientId(id);

    const verifier = createCodeVerifier(64);
    const challenge = await createCodeChallenge(verifier);
    const stateToken = createStateToken();
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, stateToken);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: id,
      redirect_uri: redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state: stateToken,
      scope: SCOPES,
    });
    window.location.assign(`${AUTHORIZE_URL}?${params.toString()}`);
  }

  /**
   * Handles `?code=`/`?error=` on boot. Always strips the query string afterwards so a
   * reload never replays a spent authorization code.
   */
  async handleRedirectCallback(): Promise<{ handled: boolean; error?: string }> {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    const code = params.get('code');
    const returnedState = params.get('state');
    if (!error && !code) return { handled: false };

    stripQueryString();

    if (error) {
      return { handled: true, error: describeAuthorizeError(error) };
    }

    const expectedState = sessionStorage.getItem(STATE_KEY);
    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);

    if (!expectedState || expectedState !== returnedState) {
      return { handled: true, error: 'Login state mismatch — start the connection again.' };
    }
    if (!verifier) {
      return { handled: true, error: 'Login verifier missing — start the connection again.' };
    }
    if (!this.state.clientId) {
      return { handled: true, error: 'Client ID missing — paste it again and reconnect.' };
    }

    try {
      const token = await this.requestToken({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: redirectUri(),
        client_id: this.state.clientId,
        code_verifier: verifier,
      });
      this.storeToken(token);
      return { handled: true };
    } catch (err) {
      return { handled: true, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Returns a token that is valid right now, refreshing first if needed. */
  async getValidToken(): Promise<string> {
    const { accessToken, expiresAt } = this.state;
    if (accessToken && expiresAt && Date.now() < expiresAt) return accessToken;
    return this.refresh();
  }

  /** Single-flighted so a burst of 401s cannot spend the refresh token several times over. */
  refresh(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const run = async (): Promise<string> => {
      const { refreshToken, clientId } = this.state;
      if (!refreshToken || !clientId) {
        throw new AuthError('Not connected to Spotify.', 'no_refresh_token');
      }
      const token = await this.requestToken({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      });
      this.storeToken(token);
      return token.access_token;
    };
    this.refreshInFlight = run().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private storeToken(token: TokenResponse): void {
    this.patch({
      accessToken: token.access_token,
      // Spotify omits refresh_token on some refreshes; the previous one stays valid.
      refreshToken: token.refresh_token ?? this.state.refreshToken,
      expiresAt: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
      scope: token.scope ?? this.state.scope,
    });
  }

  private async requestToken(body: Record<string, string>): Promise<TokenResponse> {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AuthError(describeTokenError(response.status, text), 'token_request');
    }
    return JSON.parse(text) as TokenResponse;
  }

  /** Clears tokens but keeps the client id and all Vibe data. */
  disconnect(): void {
    this.patch({
      accessToken: undefined,
      refreshToken: undefined,
      expiresAt: undefined,
      scope: undefined,
      userId: undefined,
      displayName: undefined,
    });
  }

  forgetEverything(): void {
    localStorage.removeItem(STORAGE_KEY);
    this.state = { clientId: '' };
    for (const fn of this.listeners) fn(this.snapshot);
  }
}

function stripQueryString(): void {
  const url = window.location.pathname + window.location.hash;
  window.history.replaceState({}, document.title, url);
}

function describeAuthorizeError(error: string): string {
  if (error === 'access_denied') {
    return 'You declined the Spotify permission prompt. Connect again when you are ready.';
  }
  return `Spotify returned "${error}" during login.`;
}

function describeTokenError(status: number, body: string): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: string; error_description?: string };
    detail = parsed.error_description ?? parsed.error ?? body;
  } catch {
    /* keep the raw body */
  }
  if (status === 400 && /redirect_uri/i.test(detail)) {
    return `Spotify rejected the redirect URI. Register exactly "${redirectUri()}" in your app's settings (trailing slash included). Spotify said: ${detail}`;
  }
  if (status === 400 && /client/i.test(detail)) {
    return `Spotify rejected the Client ID. Check you pasted the Client ID (not the secret). Spotify said: ${detail}`;
  }
  return `Spotify token request failed (${status}): ${detail}`;
}

export const auth = new Auth();
