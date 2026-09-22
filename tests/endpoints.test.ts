import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the "no removed endpoints" acceptance item. Spotify removed these in
 * Feb 2026; calling one returns 404/403 rather than degrading, so it must never
 * creep back into the source.
 */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\/audio-analysis/, why: 'GET /audio-analysis was removed (no beat/bar data exists)' },
  { pattern: /\/audio-features/, why: 'GET /audio-features was removed' },
  { pattern: /\/recommendations/, why: 'GET /recommendations was removed' },
  {
    pattern: /\/tracks\?ids=/,
    why: 'batch GET /tracks?ids= was removed — fetch one track at a time',
  },
  { pattern: /\/artists\/[^'"`]*\/top-tracks/, why: 'artist top-tracks was removed' },
  { pattern: /\/browse\//, why: 'browse/new-releases/categories were removed' },
  { pattern: /['"`]\/users\//, why: 'other users’ profiles and playlists were removed' },
];

/** Response fields Spotify no longer returns; relying on them would silently break. */
const FORBIDDEN_FIELDS = [/\.available_markets/, /\.linked_from/, /\bme\.product\b/];

/** Comments legitimately name the removed endpoints, so only real code is scanned. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('removed Spotify endpoints', () => {
  const files = sourceFiles('src');

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const { pattern, why } of FORBIDDEN) {
    it(`never calls ${pattern.source} (${why})`, () => {
      const offenders = files.filter((file) => pattern.test(codeOnly(readFileSync(file, 'utf8'))));
      expect(offenders).toEqual([]);
    });
  }

  for (const pattern of FORBIDDEN_FIELDS) {
    it(`never reads ${pattern.source}`, () => {
      const offenders = files.filter((file) => pattern.test(codeOnly(readFileSync(file, 'utf8'))));
      expect(offenders).toEqual([]);
    });
  }
});
