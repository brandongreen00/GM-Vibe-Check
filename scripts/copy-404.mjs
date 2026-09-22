// GitHub Pages returns 404.html for any unknown path under the repo sub-path.
// Shipping a byte-identical copy of index.html means a deep link (or a stale
// OAuth callback URL) still boots the app instead of showing Pages' 404 page.
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(process.cwd(), 'dist');
copyFileSync(resolve(dist, 'index.html'), resolve(dist, '404.html'));
console.info('copied dist/index.html -> dist/404.html');
