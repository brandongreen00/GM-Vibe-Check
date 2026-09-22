import { el } from '../util/dom';

type ToastKind = 'info' | 'warn' | 'error';

let toastHost: HTMLElement | null = null;
let bannerHost: HTMLElement | null = null;
const banners = new Map<string, HTMLElement>();

export function mountNotifications(root: HTMLElement): void {
  bannerHost = el('div', { class: 'banners', id: 'banners' });
  toastHost = el('div', { class: 'toasts', id: 'toasts' });
  root.append(bannerHost, toastHost);
}

export function toast(message: string, kind: ToastKind = 'info', durationMs = 4000): void {
  if (!toastHost) return;
  const node = el('div', { class: `toast toast--${kind}`, role: 'status' }, message);
  toastHost.appendChild(node);
  setTimeout(() => {
    node.classList.add('toast--leaving');
    setTimeout(() => node.remove(), 300);
  }, durationMs);
}

/** Banners are sticky: they stay until the condition that raised them is cleared. */
export function showBanner(
  id: string,
  message: string,
  kind: ToastKind = 'warn',
  action?: { label: string; onClick: () => void },
): void {
  if (!bannerHost) return;
  banners.get(id)?.remove();
  const node = el(
    'div',
    { class: `banner banner--${kind}`, role: 'alert' },
    el('span', { class: 'banner__text' }, message),
    action
      ? el('button', { class: 'btn btn--small', onClick: action.onClick }, action.label)
      : null,
    el('button', { class: 'banner__close', title: 'Dismiss', onClick: () => clearBanner(id) }, '×'),
  );
  banners.set(id, node);
  bannerHost.appendChild(node);
}

export function clearBanner(id: string): void {
  banners.get(id)?.remove();
  banners.delete(id);
}
