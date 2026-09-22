/** "mm:ss" — used on soundboard buttons and the transport bar. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "mm:ss.mmm" — the editable representation in the Vibe editor. */
export function formatPrecise(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const m = Math.floor(clamped / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** Parses "mm:ss.mmm", "m:ss", "ss.mmm" or a raw millisecond count. */
export function parsePrecise(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = /^(?:(\d+):)?(\d{1,2})(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (!match) {
    const raw = Number(trimmed);
    return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  }
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]);
  const millis = match[3] ? Number(match[3].padEnd(3, '0')) : 0;
  if (seconds > 59) return null;
  return minutes * 60000 + seconds * 1000 + millis;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
