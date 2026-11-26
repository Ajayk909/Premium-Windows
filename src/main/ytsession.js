// The hidden YouTube player runs in its own browser session ("persist:ytplayer"):
//  - a normal Chrome user agent and YouTube's cookie-consent cookie, so the watch page loads cleanly
//  - ad and tracker blocking with Ghostery's engine and its prebuilt lists (EasyList, uBlock
//    Origin filters…). The lists are downloaded and cached, then refreshed every 3 days, so
//    blocking keeps up with YouTube on its own.
//  - a small built-in block list that works even before (or without) the downloaded lists
import { session, net } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PARTITION = 'persist:ytplayer';
export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

const BASIC_BLOCK = [
  '*://*.doubleclick.net/*',
  '*://*.googleadservices.com/*',
  '*://*.googlesyndication.com/*',
  '*://*.google-analytics.com/*',
  '*://www.youtube.com/pagead/*',
  '*://www.youtube.com/api/stats/ads*',
  '*://www.youtube.com/api/stats/qoe?*adformat*',
  '*://www.youtube.com/ptracking*',
  '*://www.youtube.com/get_midroll_*',
  '*://www.youtube.com/youtubei/v1/log_event*',
  '*://www.youtube.com/generate_204*'
];

export async function setup(userData) {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(CHROME_UA);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen' || permission === 'media'));
  const twoYears = Math.floor(Date.now() / 1000) + 2 * 365 * 86400;
  for (const c of [{ name: 'SOCS', value: 'CAI' }, { name: 'CONSENT', value: 'YES+' }]) {
    await ses.cookies.set({ url: 'https://www.youtube.com', domain: '.youtube.com', path: '/', secure: true, expirationDate: twoYears, ...c }).catch(() => {});
  }

  // Built-in list first, so nothing slips through while the full lists load.
  ses.webRequest.onBeforeRequest({ urls: BASIC_BLOCK }, (_d, cb) => cb({ cancel: true }));

  // Ghostery engine (replaces the built-in listener once it's ready).
  (async () => {
    try {
      const { ElectronBlocker } = await import('@ghostery/adblocker-electron');
      const cacheFile = path.join(userData, 'adblock-engine.bin');
      const stat = await fs.stat(cacheFile).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 3 * 86400 * 1000) await fs.rm(cacheFile, { force: true });
      const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking((url, init) => net.fetch(url, init), {
        path: cacheFile,
        read: fs.readFile,
        write: fs.writeFile
      });
      blocker.enableBlockingInSession(ses);
      console.log('[adblock] Ghostery engine active');
    } catch (e) {
      console.warn('[adblock] using the built-in list only:', e?.message || e);
    }
  })();

  return ses;
}
