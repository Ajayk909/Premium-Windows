// Runs inside a hidden window: talks to YouTube's BotGuard the way youtube.com does and mints
// proof-of-origin (PO) tokens, which YouTube's video servers now ask for on web clients.
// Network requests go through the main process (window.potBridge) so there are no CORS issues.
import { getChallenge, BotGuardClient } from '../../node_modules/bgutils-js/dist/exports/botguard.js';
import { WebPoMinter } from '../../node_modules/bgutils-js/dist/exports/webpo.js';
import { buildURL, getHeaders } from '../../node_modules/bgutils-js/dist/exports/utils.js';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

async function bridgeFetch(input, init = {}) {
  const r = await window.potBridge.fetch(String(input), {
    method: init.method || 'GET',
    headers: init.headers || {},
    body: typeof init.body === 'string' ? init.body : undefined
  });
  return new Response(r.body, { status: r.status, headers: { 'content-type': r.type || 'application/json' } });
}

let minter = null;
let expiresAt = 0;
let pending = null;

async function createMinter() {
  const challenge = await getChallenge({ requestKey: REQUEST_KEY, fetchFunction: bridgeFetch });
  let js = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!js && challenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue) {
    const u = challenge.interpreterUrl.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
    js = await (await bridgeFetch(u.startsWith('//') ? 'https:' + u : u)).text();
  }
  if (!js) throw new Error('BotGuard script unavailable');
  new Function(js)();
  const bg = await BotGuardClient.create({ program: challenge.program, globalName: challenge.globalName, globalObject: window });
  const webPoSignalOutput = [];
  const botguardResponse = await bg.snapshot({ webPoSignalOutput });
  const res = await bridgeFetch(buildURL('GenerateIT'), { method: 'POST', headers: getHeaders(), body: JSON.stringify([REQUEST_KEY, botguardResponse]) });
  const it = await res.json();
  if (typeof it?.[0] !== 'string') throw new Error('No integrity token');
  const m = await WebPoMinter.create({ integrityToken: it[0], estimatedTtlSecs: it[1], mintRefreshThreshold: it[2], websafeFallbackToken: it[3] }, webPoSignalOutput);
  expiresAt = Date.now() + Math.max(300, (it[1] || 3600) - 300) * 1000;
  return m;
}

async function ensureMinter() {
  if (minter && Date.now() < expiresAt) return minter;
  if (!pending) pending = createMinter().then((m) => { minter = m; return m; }).finally(() => { pending = null; });
  return pending;
}

window.mintTokens = async (bindings) => {
  const m = await ensureMinter();
  const out = {};
  for (const b of bindings) out[b] = await m.mintAsWebsafeString(b);
  return out;
};
window.potReady = true;
