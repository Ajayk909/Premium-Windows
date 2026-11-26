// The video engine: YouTube's own web player, running hidden in a <webview> behind Premium's
// controls. Because it's YouTube's player, seeking, 4K/8K, live and new formats just work, and
// YouTube keeps it up to date. Ads are stripped/blocked (see src/engine/preload.cjs and
// src/main/ytsession.js).
//
// `media` below behaves like a <video> element (currentTime, paused, play(), events…), so the
// rest of the player can treat it as one.
import { h } from './ui.js';

const PREFIX = '__PRM__';
const QUALITY = { tiny: 144, small: 240, medium: 360, large: 480, hd720: 720, hd1080: 1080, hd1440: 1440, hd2160: 2160, hd2880: 2880, highres: 4320 };
export const qualityHeight = (q) => QUALITY[q] || 0;
export const qualityName = (height) => Object.keys(QUALITY).find((k) => QUALITY[k] === height) || 'auto';

export const webview = h('webview', {
  class: 'engine',
  partition: 'persist:ytplayer',
  allowpopups: false,
  tabIndex: -1,
  webpreferences: 'backgroundThrottling=no'
});

let loaded = false;      // a youtube.com watch page is up
let apiReady = false;    // window.__prm exists and the player API answered
let queue = [];          // commands waiting for the page
let s = { t: 0, d: 0, paused: true, ended: false, rs: 0, buf: [], rate: 1, vol: 1, muted: false, levels: [], tracks: [] };
let sAt = performance.now();
let wantId = null;
let loadAt = 0;
let lastErrFor = null;
let seenWant = false;

class Media extends EventTarget {
  get currentTime() {
    if (s.paused || s.ended || s.rs < 3 || s.ad) return s.t;
    return Math.min(s.d || Infinity, s.t + ((performance.now() - sAt) / 1000) * (s.rate || 1));
  }
  set currentTime(t) { seek(t); }
  get duration() { return s.d || NaN; }
  get paused() { return !!s.paused; }
  get ended() { return !!s.ended; }
  get readyState() { return s.rs || 0; }
  get volume() { return s.vol ?? 1; }
  set volume(v) { s.vol = v; run(`__prm.volume(${+v})`); this.dispatchEvent(new Event('volumechange')); }
  get muted() { return !!s.muted; }
  set muted(m) { s.muted = !!m; run(`__prm.mute(${!!m})`); this.dispatchEvent(new Event('volumechange')); }
  get playbackRate() { return s.rate || 1; }
  set playbackRate(r) { s.rate = r; run(`__prm.rate(${+r})`); }
  get videoWidth() { return s.w || 0; }
  get videoHeight() { return s.h || 0; }
  get buffered() {
    const b = s.buf || [];
    return { length: b.length, start: (i) => b[i][0], end: (i) => b[i][1] };
  }
  play() { s.paused = false; s.ended = false; sAt = performance.now(); run('__prm.play()'); this.dispatchEvent(new Event('play')); return Promise.resolve(); }
  pause() { s.t = this.currentTime; s.paused = true; run('__prm.pause()'); this.dispatchEvent(new Event('pause')); }
  getVideoPlaybackQuality() { return { droppedVideoFrames: s.dropped || 0, totalVideoFrames: s.frames || 0 }; }
}

export const media = new Media();
export const state = () => s;

function run(code) {
  if (!apiReady) { queue.push(code); return; }
  webview.executeJavaScript(`try{${code}}catch(e){}`).catch(() => {});
}

function flush() {
  const q = queue;
  queue = [];
  for (const c of q) webview.executeJavaScript(`try{${c}}catch(e){}`).catch(() => {});
}

/** Play a video. Options: start (seconds), loop (Shorts). */
export function load(id, opts = {}) {
  wantId = id;
  seenWant = false;
  loadAt = performance.now();
  lastErrFor = null;
  s = { ...s, t: opts.start || 0, d: 0, paused: false, ended: false, rs: 0, buf: [], w: 0, h: 0, levels: [], tracks: [], ad: false, err: null, id: null };
  sAt = performance.now();
  if (!loaded) {
    loaded = true;
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}${opts.start ? `&t=${Math.floor(opts.start)}s` : ''}`;
    webview.src = url;
    queue = queue.filter((c) => !c.startsWith('__prm.load(') && !c.startsWith('__prm.adopt('));
    queue.push(`__prm.adopt(${JSON.stringify(id)}, ${JSON.stringify({ loop: !!opts.loop })})`);
  } else {
    queue = queue.filter((c) => !c.startsWith('__prm.load(') && !c.startsWith('__prm.adopt('));
    run(`__prm.load(${JSON.stringify(id)}, ${+(opts.start || 0)}, ${JSON.stringify({ loop: !!opts.loop })})`);
  }
  media.dispatchEvent(new Event('waiting'));
}

export function seek(t) {
  s.t = Math.max(0, t);
  sAt = performance.now();
  run(`__prm.seek(${+s.t})`);
  media.dispatchEvent(new Event('seeked'));
}

export function stop() {
  wantId = null;
  run('__prm.stop()');
  s = { ...s, paused: true, t: 0 };
}

export function setQuality(height) { run(`__prm.quality(${JSON.stringify(height ? qualityName(height) : 'auto')})`); }
export function setCaptions(track, size = 0) { run(`__prm.captions(${JSON.stringify(track ? track.lang + (track.auto ? ':asr' : '') : null)}, ${+size})`); }
export function setLoop(on) { run(`__prm.loop(${!!on})`); }
export function pip() { if (apiReady) webview.executeJavaScript('__prm.pip()', true).catch(() => {}); }
export function setVisible(on) { webview.classList.toggle('hidden-video', !on); }

// ---------- Messages from the page ----------

let prev = { paused: true, rs: 0, ended: false, d: 0, muted: false, vol: 1, id: null };

function apply(next) {
  const now = performance.now();
  // Ignore stale reports from the previous video while a new one loads.
  if (wantId && next.id && next.id !== wantId) {
    // YouTube moved on to its own autoplay pick: stop it (Premium decides what plays next).
    if (seenWant) { run('__prm.pause()'); seenWant = false; }
    else if (now - loadAt > 8000) { loadAt = now; run(`__prm.load(${JSON.stringify(wantId)}, ${+(s.t || 0)}, {})`); }
    return;
  }
  if (wantId && next.id === wantId) seenWant = true;
  if (!next.ready && !next.id) return;
  if (next.ready && !apiReady) { apiReady = true; flush(); }

  const wasSeekingRecently = now - sAt < 400 && Math.abs(next.t - s.t) > 1.5 && !next.paused;
  s = { ...s, ...next };
  if (!wasSeekingRecently || next.paused) sAt = now; else s.t = media.currentTime;

  if (next.d && next.d !== prev.d) { media.dispatchEvent(new Event('durationchange')); if (!prev.d) media.dispatchEvent(new Event('loadedmetadata')); }
  if (next.paused !== prev.paused) media.dispatchEvent(new Event(next.paused ? 'pause' : 'play'));
  const playingNow = !next.paused && next.rs >= 3 && !next.ad;
  const playingBefore = !prev.paused && prev.rs >= 3 && !prev.ad;
  if (playingNow && !playingBefore) { media.dispatchEvent(new Event('canplay')); media.dispatchEvent(new Event('playing')); }
  if (!next.paused && next.rs < 3 && prev.rs >= 3) media.dispatchEvent(new Event('waiting'));
  if (next.ended && !prev.ended && next.d && next.t > next.d - 2) media.dispatchEvent(new Event('ended'));
  if (next.muted !== prev.muted || Math.abs((next.vol ?? 1) - (prev.vol ?? 1)) > 0.001) media.dispatchEvent(new Event('volumechange'));
  if (next.ad !== prev.ad) media.dispatchEvent(new CustomEvent('ad', { detail: next.ad }));
  if (next.err && lastErrFor !== wantId) { lastErrFor = wantId; media.dispatchEvent(new CustomEvent('error', { detail: next.err })); }
  if ((next.tracks || []).length !== (prev.tracks || []).length || next.id !== prev.id) media.dispatchEvent(new Event('tracks'));
  if ((next.levels || []).join() !== (prev.levels || []).join() || next.q !== prev.q) media.dispatchEvent(new Event('quality'));
  prev = { ...next };
}

webview.addEventListener('console-message', (e) => {
  const msg = e.message || '';
  if (!msg.startsWith(PREFIX)) return;
  let data;
  try { data = JSON.parse(msg.slice(PREFIX.length)); } catch { return; }
  if (data.type === 'state' || data.type === 'event') apply(data.state);
});

webview.addEventListener('dom-ready', () => {
  apiReady = false;
  // Show only the video: hide YouTube's page and player chrome; Premium draws its own.
  webview.insertCSS(`
    html, body { overflow: hidden !important; background: #000 !important; }
    #movie_player, #movie_player.ytp-fullscreen, .html5-video-player {
      position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
      z-index: 2147483646 !important; background: #000 !important; margin: 0 !important;
    }
    #movie_player .html5-video-container, #movie_player video { width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; object-fit: contain !important; }
    #masthead-container, #secondary, #below, #chat, #related, ytd-popup-container, tp-yt-iron-overlay-backdrop,
    ytd-consent-bump-v2-lightbox, ytd-mealbar-promo-renderer, ytd-enforcement-message-view-model, #panels,
    .ytp-chrome-bottom, .ytp-chrome-top, .ytp-gradient-top, .ytp-gradient-bottom, .ytp-pause-overlay, .ytp-ce-element,
    .ytp-endscreen-content, .ytp-autonav-endscreen, .ytp-autonav-endscreen-countdown-overlay, .ytp-paid-content-overlay,
    .ytp-spinner, .ytp-cued-thumbnail-overlay, .ytp-large-play-button, .ytp-iv-player-content, .annotation, .iv-branding,
    .ytp-watermark, .ytp-show-cards-title, .ytp-suggested-action, .ytp-doubletap-ui-legacy, .ytp-bezel, .ytp-bezel-text-wrapper,
    .ytp-tooltip, .ytp-contextmenu, .ytp-popup, .ytp-settings-menu, .ytp-ad-overlay-container, .ytp-featured-product,
    .ytp-overlays-container, .ytp-info-panel-preview, .ytp-ad-module, .ytp-ad-player-overlay, .ytp-endscreen-previous,
    .ytp-endscreen-next, .videowall-endscreen, .ytp-fullerscreen-edu-button, .ytp-player-content.ytp-timely-actions-content,
    .ytp-error-content-wrap-reason ~ *, .ytp-storyboard-framepreview, .ytp-chapter-hover-container
    { display: none !important; }
    .ytp-caption-window-container { display: block !important; }
    .caption-window { margin-bottom: 0 !important; }
  `).catch(() => {});
  webview.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
});

webview.addEventListener('did-navigate', () => { apiReady = false; });
webview.addEventListener('render-process-gone', () => { loaded = false; apiReady = false; if (wantId) load(wantId, { start: s.t }); });
webview.addEventListener('did-fail-load', (e) => {
  if (e.isMainFrame && e.errorCode !== -3) media.dispatchEvent(new CustomEvent('error', { detail: `Couldn't reach YouTube (${e.errorDescription || e.errorCode}).` }));
});
