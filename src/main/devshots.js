// Development only (PREMIUM_SHOT=<dir>): walks through the main screens and saves screenshots.
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(win, dir) {
  await fs.mkdir(dir, { recursive: true });
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code).catch((e) => console.error('[shot js]', e.message));
  const steps = (process.env.PREMIUM_STEPS || 'home').split(',');
  for (const step of steps) {
    const [name, code] = step.split('=');
    if (code) await js(decodeURIComponent(code));
    await wait(+process.env.PREMIUM_WAIT || 2500);
    const img = await win.webContents.capturePage();
    await fs.writeFile(path.join(dir, name + '.png'), img.toPNG());
    console.log('[shot]', name);
  }
  const logs = await js('JSON.stringify(window.__errors || [])');
  console.log('[errors]', logs);
  app.quit();
}
