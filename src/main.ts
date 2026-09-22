import './styles.css';
import { startApp } from './ui/app';

const root = document.getElementById('app');
if (root) {
  void startApp(root).catch((error: unknown) => {
    root.innerHTML = '';
    const message = document.createElement('p');
    message.className = 'banner banner--error';
    message.textContent = error instanceof Error ? error.message : String(error);
    root.appendChild(message);
  });
}
