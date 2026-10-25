import './fit';
import './keyboard';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './theme/tokens.css';
import './theme/base.css';
import './theme/components.css';
import './theme/next.css';
import './theme/next3.css';
import './theme/next-polish.css';
import './theme/polish.css';
import './theme/polish-next.css';
import './theme/refine.css';
import './theme/fits.css';
import './theme/craft.css';
import './theme/next-top.css';
import './theme/keyboard.css';
import './theme/queue.css';
import './theme/turn.css';
import './theme/materials.css';
import './theme/scroll-depth.css';
import './theme/affect.css';
import App from './App';
// Last on purpose: the craft system layers over every sheet, including the
// ones components import themselves.
import './theme/system.css';
import { ImageLightbox } from './components/ImageLightbox';
import { PhoneNotificationHost } from './components/PhoneNotificationHost';
import { isStandaloneEntry, registerServiceWorker } from './standalone';
import { warmMarkdown } from './components/MarkdownAsync';

declare global {
  interface Window {
    __asideTelegramReady?: Promise<void>;
  }
}

async function bootstrap() {
  // `/app` resolves this immediately; Telegram pages wait for their bridge.
  // The promise is defined inline in index.html so the remote request starts
  // while this module graph is still downloading.
  await window.__asideTelegramReady;

  // Keep the phone/PWA material layer isolated from the Telegram mini app.
  // `/dev.html` is the local phone harness for the same standalone surface.
  document.documentElement.dataset.client =
    isStandaloneEntry() || location.pathname === '/dev.html'
      ? 'standalone'
      : 'telegram';

  // Installability, and only from the standalone entry point. See standalone.ts.
  registerServiceWorker();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
      {/*
        Mounted beside the app rather than inside it: any image anywhere --
        an answer, a tool step, a subagent's card -- opens it by raising a
        window event, so it must not live inside a screen that unmounts when
        the user navigates.
      */}
      <ImageLightbox />
      {isStandaloneEntry() ? <PhoneNotificationHost /> : null}
    </StrictMode>,
  );

  /*
   * Fetch the markdown renderer once the first screen is up.
   *
   * It is deliberately not on the critical path (see MarkdownAsync.tsx), but
   * it is needed the moment a thread has content, and the app restores the
   * last session on launch. This fires after the first paint has been handed
   * to the compositor, so it competes with nothing, and it overlaps the
   * `/api/thread` round trip that has to happen anyway.
   */
  requestAnimationFrame(() => {
    const warm = () => warmMarkdown();
    if ('requestIdleCallback' in window) {
      (window as unknown as {
        requestIdleCallback: (cb: () => void, o?: { timeout: number }) => void;
      }).requestIdleCallback(warm, { timeout: 500 });
    } else {
      setTimeout(warm, 0);
    }
  });
}

void bootstrap();
