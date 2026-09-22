export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function trackIdFromUri(uri: string): string {
  const parts = uri.split(':');
  return parts[parts.length - 1] ?? uri;
}
