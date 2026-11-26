// Inline hover previews: rest the mouse on a thumbnail and it starts playing, muted, like YouTube.
import { previewHooks, api, h } from './ui.js';

const shaka = window.shaka;
let sp = null;
let token = 0;
const cache = new Map();
const vid = h('video.preview-video', { muted: true, playsInline: true, loop: false });
vid.muted = true;
const bar = h('div.preview-bar', h('div'));

async function ensure() {
  if (sp) return sp;
  sp = new shaka.Player();
  await sp.attach(vid);
  sp.getNetworkingEngine().registerRequestFilter((_t, req) => {
    req.uris = req.uris.map((u) => u.replace(/^https:\/\/([a-z0-9.-]+\.googlevideo\.com)\//i, 'ytv://$1/'));
  });
  sp.configure({
    abr: { enabled: true, restrictions: { maxHeight: 480 }, defaultBandwidthEstimate: 3_000_000 },
    streaming: { bufferingGoal: 8, rebufferingGoal: 0.5, retryParameters: { maxAttempts: 1 } }
  });
  sp.addEventListener('error', () => stop());
  return sp;
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function start(v, wrap) {
  const my = ++token;
  try {
    const player = await ensure();
    let info = cache.get(v.id);
    if (!info) {
      info = await api.call('streams:get', v.id, 0);
      cache.set(v.id, info);
      if (cache.size > 40) cache.delete(cache.keys().next().value);
    }
    if (my !== token || info.kind !== 'dash') return;
    await player.unload();
    if (my !== token) return;
    wrap.append(vid, bar);
    vid.classList.remove('on');
    const startAt = info.duration > 60 ? Math.min(info.duration * 0.1, 30) : 0;
    await player.load('data:application/dash+xml;base64,' + b64(info.manifest), startAt, 'application/dash+xml');
    if (my !== token) return;
    await vid.play().catch(() => {});
    vid.classList.add('on');
    wrap.classList.add('previewing');
    const d = info.duration || 1;
    const update = () => {
      if (my !== token) return;
      bar.firstChild.style.transform = `scaleX(${Math.min(1, vid.currentTime / d)})`;
      requestAnimationFrame(update);
    };
    update();
  } catch {
    if (my === token) stop();
  }
}

function stop() {
  token++;
  vid.classList.remove('on');
  vid.parentElement?.classList.remove('previewing');
  vid.pause();
  vid.remove();
  bar.remove();
  sp?.unload().catch(() => {});
}

previewHooks.start = start;
previewHooks.stop = stop;
