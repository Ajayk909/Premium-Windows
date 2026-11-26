// The one video player. It lives on the Watch page and moves into the floating mini player
// when you browse elsewhere — the same <video> element, so playback never restarts.
import { h, ic, api, toast, formatTime, menu, closeMenu, nav, thumb } from './ui.js';
import { settings, set, lib, library } from './state.js';

const shaka = window.shaka;

// shaka only knows http(s)/data/blob, so teach it our ytv:// proxy scheme (main.js) via fetch.
if (window.shaka && !window.__ytvScheme) {
  window.__ytvScheme = true;
  window.shaka.net.NetworkingEngine.registerScheme('ytv', window.shaka.net.HttpFetchPlugin.parse,
    window.shaka.net.NetworkingEngine.PluginPriority.PREFERRED);
}

const listeners = new Map();
function emit(evt, payload) { for (const fn of listeners.get(evt) || []) { try { fn(payload); } catch (e) { console.error(e); } } }

export const P = {
  current: null,      // the video being played
  details: null,      // watch-page details (title, channel, chapters, related…)
  info: null,         // stream info from the main process
  queue: [],          // explicit queue (playlists, "play next")
  queueIndex: -1,
  segments: [],       // SponsorBlock
  chapters: [],
  captionTracks: [],
  captionTrack: null,
  cues: [],
  theater: false,
  audioOnly: false,
  loading: false,
  error: null,
  mode: 'none',       // 'page' | 'mini' | 'none'
  sleepAt: null,
  sleepEndOfVideo: false,
  token: 0,

  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt).delete(fn);
  }
};

// ---------- DOM ----------

const video = h('video', { playsInline: true, preload: 'auto', crossOrigin: 'anonymous', disablePictureInPicture: false });
const poster = h('img.player-poster', { alt: '' });
const captionBox = h('div.captions');
const spinner = h('div.player-spinner', h('div.spinner.light'));
const flash = h('div.player-flash');
const skipToast = h('div.player-skip');
const errorBox = h('div.player-error');
const upNext = h('div.player-upnext');
const statsBox = h('div.player-stats');

const seekTrack = h('div.seek-track');
const seekSponsor = h('div.seek-sponsor');
const seekHover = h('div.seek-hover');
const seekKnob = h('div.seek-knob');
const seekTip = h('div.seek-tip', h('div.seek-tip-chapter'), h('div.seek-tip-time'));
const seek = h('div.seek', { role: 'slider', 'aria-label': 'Seek' }, seekTrack, seekSponsor, seekHover, seekKnob, seekTip);

const btnPlay = h('button.pbtn.play', { title: 'Play (k)' }, ic('play', 26));
const btnPrev = h('button.pbtn', { title: 'Previous (Shift+P)' }, ic('prev', 22));
const btnNext = h('button.pbtn', { title: 'Next (Shift+N)' }, ic('next', 22));
const btnVol = h('button.pbtn', { title: 'Mute (m)' }, ic('volume', 24));
const volSlider = h('input.vol-slider', { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': 'Volume' });
const timeLabel = h('div.ptime', h('span.ptime-cur', '0:00'), h('span.ptime-sep', ' / '), h('span.ptime-dur', '0:00'));
const chapterLabel = h('button.pchapter');
const btnAuto = h('button.pauto', { title: 'Autoplay' }, h('span.pauto-track', h('span.pauto-knob', ic('play', 10))));
const btnCC = h('button.pbtn', { title: 'Captions (c)' }, ic('cc', 23));
const btnSettings = h('button.pbtn', { title: 'Settings' }, ic('settings', 23));
const btnMini = h('button.pbtn', { title: 'Mini player (i)' }, ic('mini', 23));
const btnTheater = h('button.pbtn', { title: 'Theater mode (t)' }, ic('theater', 23));
const btnFull = h('button.pbtn', { title: 'Full screen (f)' }, ic('fullscreen', 23));
const qualityBadge = h('span.pquality');

const controls = h('div.player-controls',
  seek,
  h('div.prow',
    h('div.prow-left', btnPrev, btnPlay, btnNext, h('div.vol', btnVol, volSlider), timeLabel, chapterLabel),
    h('div.prow-right', btnAuto, btnCC, h('div.pbtn-wrap', btnSettings, qualityBadge), btnMini, btnTheater, btnFull)
  )
);

export const el = h('div.player', { tabIndex: -1 },
  h('div.player-stage', poster, video),
  captionBox, flash, spinner, skipToast, upNext, errorBox, statsBox,
  h('div.player-shade'),
  controls
);

/** Ambient glow: a tiny canvas the watch page puts behind the player and blurs. */
export const ambient = h('canvas.ambient', { width: 48, height: 27 });
const actx = ambient.getContext('2d', { willReadFrequently: false });

// ---------- shaka ----------

let sp = null;
async function ensureShaka() {
  if (sp) return sp;
  shaka.polyfill.installAll();
  sp = new shaka.Player();
  await sp.attach(video);
  sp.getNetworkingEngine().registerRequestFilter((_type, req) => {
    // Video segments go through our ytv:// proxy (see main.js).
    req.uris = req.uris.map((u) => u.replace(/^https:\/\/([a-z0-9.-]+\.(?:googlevideo|youtube)\.com)\//i, (m, host) => /googlevideo/.test(host) ? `ytv://${host}/` : m));
  });
  sp.configure({
    streaming: {
      bufferingGoal: 40,
      rebufferingGoal: 1.2,
      bufferBehind: 30,
      retryParameters: { maxAttempts: 4, baseDelay: 400, backoffFactor: 2, timeout: 20000 },
      stallEnabled: true
    },
    manifest: { dash: { ignoreMinBufferTime: true }, retryParameters: { maxAttempts: 2 } },
    abr: { enabled: true, restrictToElementSize: true, defaultBandwidthEstimate: 8_000_000, switchInterval: 4 },
    preferredAudioLanguage: 'en'
  });
  sp.addEventListener('error', (e) => onShakaError(e.detail));
  sp.addEventListener('variantchanged', updateQualityBadge);
  sp.addEventListener('adaptation', updateQualityBadge);
  sp.addEventListener('buffering', (e) => setBuffering(e.buffering));
  return sp;
}

// ---------- Loading ----------

export async function play(v, opts = {}) {
  if (!v?.id) return;
  const sameVideo = P.current?.id === v.id;
  if (sameVideo && !opts.force) {
    if (opts.queue) setQueue(opts.queue, v.id);
    emit('change');
    return;
  }
  const token = ++P.token;
  saveProgress();
  P.current = { ...v };
  P.details = null;
  P.info = null;
  P.segments = [];
  P.chapters = [];
  P.captionTracks = [];
  P.captionTrack = null;
  P.cues = [];
  P.error = null;
  P.failures = [];
  P.retriedSame = false;
  P.loading = true;
  P.ended = false;
  hideUpNext();
  if (opts.queue) setQueue(opts.queue, v.id);
  else if (!P.queue.some((x) => x.id === v.id)) { P.queue = []; P.queueIndex = -1; }
  else P.queueIndex = P.queue.findIndex((x) => x.id === v.id);

  poster.src = thumb(v, true);
  poster.onerror = () => { poster.onerror = null; poster.src = thumb(v); };
  el.classList.add('has-poster');
  errorBox.innerHTML = '';
  el.classList.remove('errored', 'ended');
  setBuffering(true);
  renderCaptions();
  renderSeekDecor();
  updateMediaSession();
  emit('change');

  lib.addHistory(v);

  // Details for the watch page (title, chapters, related, comments).
  api.call('yt:details', v.id).then((d) => {
    if (token !== P.token) return;
    P.details = d;
    P.chapters = d.chapters || [];
    const merged = { ...P.current, ...pickDefined(d.video), thumbnail: P.current.thumbnail || null, duration: P.current.duration || null };
    if (!merged.channelAvatar && d.channel?.avatar) merged.channelAvatar = d.channel.avatar;
    P.current = merged;
    lib.updateVideo(merged);
    if (d.channel) lib.updateChannel(d.channel);
    renderSeekDecor();
    updateMediaSession();
    emit('details', d);
  }).catch((e) => { if (token === P.token) emit('details-error', e); });

  api.call('yt:sponsor', v.id, settings.sponsorCategories).then((s) => {
    if (token !== P.token) return;
    P.segments = s;
    renderSeekDecor();
  }).catch(() => {});

  await loadStreams(token, 0, opts.startAt);
}

function pickDefined(o) {
  const out = {};
  for (const [k, val] of Object.entries(o || {})) if (val != null && val !== '') out[k] = val;
  return out;
}

async function loadStreams(token, from, startAt) {
  const v = P.current;
  try {
    await ensureShaka();
    let info;
    try {
      info = await api.call('streams:get', v.id, from);
    } catch (err) {
      // The main process already tried every remaining client.
      if (token === P.token) showError(new Error([...(P.failures || []), String(err?.message || err)].join(' · ')));
      return;
    }
    if (token !== P.token) return;
    P.info = info;
    if (!P.current.duration && info.duration) P.current.duration = formatTime(info.duration);
    P.captionTracks = info.captions || [];

    let uri, mime;
    if (info.kind === 'dash') {
      uri = 'data:application/dash+xml;base64,' + b64(info.manifest);
      mime = 'application/dash+xml';
    } else if (info.kind === 'hls') {
      uri = info.url; mime = 'application/x-mpegurl';
    } else {
      uri = info.url; mime = 'application/dash+xml';
    }
    applyQualityRestrictions();
    let start = startAt;
    if (start == null && !info.live) {
      const saved = lib.progress(v.id);
      const total = info.duration || 0;
      if (saved > 5 && (!total || saved < total - 20)) start = saved;
    }
    await sp.unload();
    if (token !== P.token) return;
    await sp.load(uri, start ?? null, mime);
    if (token !== P.token) return;
    P.loading = false;
    applyQualityPreference();
    video.playbackRate = settings.speed || 1;
    video.volume = settings.volume ?? 1;
    video.muted = !!settings.muted;
    syncVolumeUI();
    startCaptionsIfWanted();
    const playing = video.play();
    playing?.catch(() => {});
    armStartWatchdog(token, from);
    emit('change');
  } catch (err) {
    if (token !== P.token) return;
    console.warn('[player] load failed', from, err);
    if (P.info) P.failures.push(`${P.info.client}: ${err?.code ? 'shaka ' + err.code : String(err?.message || err)}`);
    const nextFrom = (P.info?.index ?? from) + 1;
    if (nextFrom < 7) return loadStreams(token, nextFrom, startAt ?? (video.currentTime > 1 ? video.currentTime : null));
    showError(new Error(P.failures.join(' · ') || String(err?.message || err)));
  }
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

let watchdog;
function armStartWatchdog(token, from) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    // Nothing decoded after 14 s: this client's links aren't working, try the next one.
    if (token === P.token && video.readyState < 3) {
      fallback('stalled');
    }
  }, 14000);
  video.addEventListener('playing', () => clearTimeout(watchdog), { once: true });
}

let lastFallbackToken = -1, fallbackCount = 0;
function fallback(reason) {
  if (!P.current || !P.info) return;
  if (lastFallbackToken !== P.token) { lastFallbackToken = P.token; fallbackCount = 0; }
  P.failures.push(`${P.info.client}: ${reason}`);
  if (++fallbackCount > 8) return showError(new Error(P.failures.join(' · ')));
  const at = video.currentTime > 1 ? video.currentTime : null;
  // If this source played fine for a while, its links probably just went stale: fetch fresh
  // ones from the same source once before moving on to the next.
  const refreshSame = video.currentTime > 20 && !P.retriedSame;
  if (refreshSame) P.retriedSame = true;
  const from = refreshSame ? P.info.index : P.info.index + 1;
  console.warn('[player] falling back from', P.info.client, 'because', reason, refreshSame ? '(refreshing same source)' : '');
  setBuffering(true);
  loadStreams(P.token, from, at);
}

function onShakaError(err) {
  if (!err) return;
  console.warn('[shaka]', err.code, err);
  // 1001/1002: HTTP failures (403 = link refused), 3016: decode error, 4000s: manifest problems.
  if (err.severity === 2 || [1001, 1002, 1003, 3014, 3015, 3016].includes(err.code)) {
    const why = err.code === 1001 ? `HTTP ${err.data?.[1] ?? '?'}` : err.code === 1003 ? 'timed out' : `shaka ${err.code}`;
    fallback(why);
  }
}

function showError(err) {
  P.loading = false;
  P.error = err;
  setBuffering(false);
  el.classList.add('errored');
  errorBox.innerHTML = '';
  errorBox.append(
    h('div.player-error-icon', ic('sparkle', 28)),
    h('h3', 'This video can\'t play right now'),
    h('p', friendly(err)),
    String(err?.message || '').includes(':') ? h('p.player-error-details', String(err.message)) : null,
    h('div.player-error-actions',
      h('button.btn.light', { onclick: () => play(P.current, { force: true }) }, ic('refresh', 18), 'Try again'),
      h('button.btn.ghost-light', { onclick: () => api.call('app:open', `https://www.youtube.com/watch?v=${P.current.id}`) }, ic('external', 18), 'Open on YouTube'))
  );
  emit('change');
}

function friendly(err) {
  const m = String(err?.message || err || '');
  if (m.includes(' · ') || /^[A-Z_]+: /.test(m)) {
    if (/age|sign in to confirm/i.test(m)) return 'YouTube asks for an age check on this one.';
    if (/private/i.test(m)) return 'This video is private.';
    return 'YouTube refused all the ways we tried to play it. The details below tell me what went wrong.';
  }
  if (/sign in to confirm your age|age/i.test(m)) return 'YouTube asks for an age check on this one.';
  if (/private/i.test(m)) return 'This video is private.';
  if (/unavailable|removed|terminated/i.test(m)) return 'YouTube says this video isn\'t available.';
  if (/network|fetch|ENOTFOUND|ECONN|timed? ?out/i.test(m)) return 'Check your internet connection.';
  if (/^shaka \d+/.test(m)) return `YouTube's video servers refused every way we tried (error ${m.slice(6)}). Try again, or open it on YouTube.`;
  return m.length < 140 ? m : 'YouTube refused all the ways we tried to play it.';
}

// ---------- Queue ----------

function setQueue(list, currentId) {
  P.queue = list.filter((x) => !x.isShort).map((x) => ({ ...x }));
  P.queueIndex = P.queue.findIndex((x) => x.id === currentId);
}

export function queueNext(v) {
  if (!P.current) return play(v);
  if (!P.queue.length) { P.queue = [P.current]; P.queueIndex = 0; }
  P.queue = P.queue.filter((x) => x.id !== v.id);
  P.queueIndex = P.queue.findIndex((x) => x.id === P.current.id);
  P.queue.splice(P.queueIndex + 1, 0, { ...v });
  toast('Plays next');
  emit('change');
}

export function nextVideo() {
  if (P.queue.length && P.queueIndex >= 0 && P.queueIndex < P.queue.length - 1) return P.queue[P.queueIndex + 1];
  const related = (P.details?.related || []).filter((r) => !r.isShort && !r.isLive);
  const recent = new Set(lib_recentIds());
  return related.find((r) => !recent.has(r.id)) || related[0] || null;
}

function lib_recentIds() {
  return library.history.slice(1, 30).map((v) => v.id);
}

export function next() {
  const n = nextVideo();
  if (n) play(n);
}

export function prev() {
  if (video.currentTime > 4) { video.currentTime = 0; return; }
  if (P.queue.length && P.queueIndex > 0) return play(P.queue[P.queueIndex - 1]);
  const hist = library.history;
  const before = hist.find((x) => x.id !== P.current?.id);
  if (before) play(before);
}

// ---------- Controls ----------

export function toggle() {
  if (!P.current) return;
  if (video.paused || video.ended) {
    if (video.ended) video.currentTime = 0;
    video.play().catch(() => {});
    showFlash('play');
  } else {
    video.pause();
    showFlash('pause');
  }
}
export function pause() { video.pause(); }
export function resume() { video.play().catch(() => {}); }
export function isPlaying() { return !video.paused && !video.ended; }
export function time() { return video.currentTime || 0; }
export function duration() { return isFinite(video.duration) ? video.duration : (P.info?.duration || 0); }

export function seekTo(t, show = true) {
  if (!P.current) return;
  const d = duration();
  video.currentTime = Math.max(0, d ? Math.min(t, d - 0.25) : t);
  if (show) tick(true);
}
export function seekBy(dt) {
  seekTo(video.currentTime + dt);
  showFlash(dt > 0 ? 'fwd' : 'back', `${Math.abs(dt)}s`);
}

export function setVolume(v) {
  video.volume = Math.max(0, Math.min(1, v));
  if (video.volume > 0 && video.muted) video.muted = false;
  set('volume', video.volume);
  set('muted', video.muted);
  syncVolumeUI();
}
export function volumeBy(d) {
  setVolume(video.volume + d);
  showFlash(video.volume === 0 ? 'mute' : 'volume', Math.round(video.volume * 100) + '%');
}
export function toggleMute() {
  video.muted = !video.muted;
  set('muted', video.muted);
  syncVolumeUI();
  showFlash(video.muted ? 'mute' : 'volume');
}

export function setSpeed(s) {
  video.playbackRate = s;
  set('speed', s);
  showFlash('speed', s + '×');
}
export function speedBy(d) {
  const steps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const i = steps.findIndex((x) => x >= video.playbackRate - 0.01);
  const ni = Math.max(0, Math.min(steps.length - 1, i + (d > 0 ? 1 : -1)));
  setSpeed(steps[ni]);
}

export async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  else await el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

export function toggleTheater() {
  P.theater = !P.theater;
  emit('theater', P.theater);
}

export async function togglePiP() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch { toast('Picture in picture isn\'t available'); }
}

export function stop() {
  saveProgress();
  P.token++;
  P.current = null;
  P.details = null;
  P.info = null;
  P.queue = [];
  P.queueIndex = -1;
  video.pause();
  sp?.unload().catch(() => {});
  hideUpNext();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  emit('change');
}

export function mount(container, mode) {
  if (el.parentElement !== container) container.append(el);
  P.mode = mode;
  el.classList.toggle('mini', mode === 'mini');
  updateAmbientLoop();
}

// ---------- Quality ----------

function label(height, fps) {
  let base;
  if (height >= 4320) base = '8K';
  else if (height >= 2160) base = '4K';
  else if (height >= 1440) base = '1440p';
  else base = height + 'p';
  return base + (fps > 31 ? '60' : '');
}

function trackHeight(t) { return Math.min(t.height || 0, t.width || t.height || 0) || t.height || 0; }

function qualityTracks() {
  if (!sp) return [];
  const active = sp.getVariantTracks().find((t) => t.active);
  const byHeight = new Map();
  for (const t of sp.getVariantTracks()) {
    if (!t.height) continue;
    if (active && t.language !== active.language) continue;
    const hgt = trackHeight(t);
    const cur = byHeight.get(hgt);
    const score = (t.frameRate || 30) * 1e9 + (t.videoBandwidth || t.bandwidth);
    if (!cur || score > cur.score) byHeight.set(hgt, { track: t, score, height: hgt, fps: t.frameRate || 30 });
  }
  return [...byHeight.values()].sort((a, b) => b.height - a.height);
}

function applyQualityRestrictions() {
  if (!sp) return;
  const cap = settings.dataSaver ? 480 : Infinity;
  sp.configure({ abr: { restrictions: { maxHeight: cap } } });
}

function applyQualityPreference() {
  const pref = settings.dataSaver ? Math.min(settings.quality || 480, 480) : settings.quality;
  if (!pref) { sp.configure({ abr: { enabled: true } }); return; }
  const list = qualityTracks();
  const pick = list.find((q) => q.height <= pref) || list[list.length - 1];
  if (pick) { sp.configure({ abr: { enabled: false } }); sp.selectVariantTrack(pick.track, true); }
  updateQualityBadge();
}

export function chooseQuality(height) {
  if (!sp) return;
  if (!height) {
    sp.configure({ abr: { enabled: true } });
    toast('Quality: Auto');
  } else {
    const q = qualityTracks().find((x) => x.height === height);
    if (!q) return;
    sp.configure({ abr: { enabled: false } });
    sp.selectVariantTrack(q.track, true, 0);
    toast('Quality: ' + label(q.height, q.fps));
  }
  P.manualQuality = height || 0;
  updateQualityBadge();
}

function currentQuality() {
  const t = sp?.getVariantTracks().find((x) => x.active);
  return t ? { height: trackHeight(t), fps: t.frameRate || 30 } : null;
}

function updateQualityBadge() {
  const q = currentQuality();
  qualityBadge.textContent = q && q.height >= 720 ? (q.height >= 2160 ? (q.height >= 4320 ? '8K' : '4K') : 'HD') : '';
  qualityBadge.classList.toggle('uhd', !!q && q.height >= 2160);
}

// ---------- Captions ----------

async function selectCaptions(track) {
  P.captionTrack = track;
  P.cues = [];
  renderCaptions();
  btnCC.innerHTML = '';
  btnCC.append(ic(track ? 'ccOn' : 'cc', 23));
  if (!track) return;
  const token = P.token;
  try {
    const cues = await api.call('yt:cues', track.url);
    if (token !== P.token || P.captionTrack !== track) return;
    P.cues = cues;
  } catch {
    toast('Couldn\'t load captions');
  }
}

function bestCaptionTrack() {
  const list = P.captionTracks;
  if (!list.length) return null;
  const lang = settings.captionLanguage || (navigator.language || 'en').split('-')[0];
  return list.find((t) => t.lang.startsWith(lang) && !t.auto) || list.find((t) => t.lang.startsWith(lang)) || list.find((t) => !t.auto) || list[0];
}

function startCaptionsIfWanted() {
  if (settings.captions) selectCaptions(bestCaptionTrack());
  else selectCaptions(null);
}

export function toggleCaptions() {
  if (!P.captionTracks.length) { toast('No captions for this video'); return; }
  const on = !P.captionTrack;
  set('captions', on);
  selectCaptions(on ? bestCaptionTrack() : null);
  toast(on ? `Captions: ${P.captionTrack?.name || 'On'}` : 'Captions off');
}

let lastCue = null;
function renderCaptions() {
  if (!P.captionTrack || !P.cues.length) {
    if (lastCue !== null) { captionBox.innerHTML = ''; lastCue = null; }
    return;
  }
  const t = video.currentTime;
  const active = P.cues.filter((c) => t >= c.start && t < c.end).slice(-2);
  const key = active.map((c) => c.start).join('|');
  if (key === lastCue) return;
  lastCue = key;
  captionBox.innerHTML = '';
  for (const c of active) captionBox.append(h('span.cue', c.text));
}

// ---------- Seek bar ----------

function renderSeekDecor() {
  const d = duration() || P.info?.duration || 0;
  seekTrack.innerHTML = '';
  const chapters = P.chapters.length ? P.chapters : [{ start: 0, title: '' }];
  chapters.forEach((c, i) => {
    const end = chapters[i + 1]?.start ?? d;
    const w = d ? Math.max(0, (end - c.start) / d) : 1;
    seekTrack.append(h('div.seek-seg', { style: { flexGrow: w || (i === 0 ? 1 : 0) }, dataset: { start: c.start, end } },
      h('div.seek-buf'), h('div.seek-play')));
  });
  seekSponsor.innerHTML = '';
  if (d) {
    for (const s of P.segments) {
      seekSponsor.append(h('div.seek-sb', { title: s.category, style: { left: (s.start / d * 100) + '%', width: ((s.end - s.start) / d * 100) + '%' } }));
    }
  }
}

function paintSeek(t) {
  const d = duration();
  const segs = seekTrack.children;
  let buffered = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t + 0.5) buffered = Math.max(buffered, video.buffered.end(i));
  }
  for (const seg of segs) {
    const s = +seg.dataset.start, e = +seg.dataset.end || d;
    const span = Math.max(0.001, e - s);
    seg.children[0].style.transform = `scaleX(${Math.max(0, Math.min(1, (buffered - s) / span))})`;
    seg.children[1].style.transform = `scaleX(${Math.max(0, Math.min(1, (t - s) / span))})`;
  }
  seekKnob.style.left = (d ? (t / d) * 100 : 0) + '%';
}

let dragging = false;
function seekFromEvent(e) {
  const r = seek.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  return x * duration();
}
seek.addEventListener('pointerdown', (e) => {
  if (!P.current) return;
  dragging = true;
  seek.setPointerCapture(e.pointerId);
  el.classList.add('scrubbing');
  const t = seekFromEvent(e);
  paintSeek(t);
  video.currentTime = t;
});
seek.addEventListener('pointermove', (e) => {
  const t = seekFromEvent(e);
  const r = seek.getBoundingClientRect();
  const x = e.clientX - r.left;
  seekHover.style.width = Math.max(0, Math.min(r.width, x)) + 'px';
  const ch = [...P.chapters].reverse().find((c) => c.start <= t);
  seekTip.children[0].textContent = ch?.title || '';
  seekTip.children[1].textContent = formatTime(t);
  const tw = seekTip.offsetWidth || 60;
  seekTip.style.left = Math.max(tw / 2, Math.min(r.width - tw / 2, x)) + 'px';
  if (dragging) { paintSeek(t); video.currentTime = t; }
});
seek.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  el.classList.remove('scrubbing');
  seek.releasePointerCapture(e.pointerId);
});

// ---------- Tick ----------

let raf = 0, lastWall = 0, watchAcc = 0, lastProgressSave = 0, lastSkipKey = null;
function tick(force = false) {
  const t = video.currentTime || 0;
  const d = duration();
  if (!dragging) paintSeek(t);
  timeLabel.children[0].textContent = formatTime(t);
  timeLabel.children[2].textContent = P.info?.live ? 'LIVE' : formatTime(d);
  const ch = [...P.chapters].reverse().find((c) => c.start <= t);
  if (chapterLabel.textContent !== (ch?.title ? '•  ' + ch.title : '')) chapterLabel.textContent = ch?.title ? '•  ' + ch.title : '';
  renderCaptions();

  // SponsorBlock auto-skip.
  if (!video.paused && P.segments.length) {
    const seg = P.segments.find((s) => t >= s.start && t < s.end - 0.35);
    if (seg) {
      const key = P.current.id + seg.start;
      if (lastSkipKey !== key) {
        lastSkipKey = key;
        video.currentTime = seg.end;
        showSkip(seg);
      }
    }
  }

  const now = performance.now();
  if (!video.paused && lastWall) {
    const dt = Math.min(1, (now - lastWall) / 1000);
    watchAcc += dt;
    if (watchAcc >= 15) { lib.addWatch(watchAcc, P.current?.channel); watchAcc = 0; }
  }
  lastWall = video.paused ? 0 : now;
  if (now - lastProgressSave > 5000) { lastProgressSave = now; saveProgress(); }

  // Sleep timer.
  if (P.sleepAt && Date.now() >= P.sleepAt) {
    P.sleepAt = null;
    video.pause();
    toast('Sleep timer: paused');
  }

  if (!force) emit('time', t);
}

function loop() {
  tick();
  raf = !video.paused ? requestAnimationFrame(loop) : 0;
}

function saveProgress() {
  if (!P.current || P.info?.live) return;
  const t = video.currentTime, d = duration();
  if (!t || t < 5) return;
  lib.setProgress(P.current.id, d && t > d - 20 ? null : t);
}

// ---------- Ambient glow ----------

let ambientTimer = 0;
function updateAmbientLoop() {
  clearInterval(ambientTimer);
  const on = settings.ambient && P.mode === 'page' && document.documentElement.dataset.glass === '1';
  ambient.classList.toggle('on', on);
  if (!on) return;
  const draw = () => {
    if (video.readyState >= 2 && !P.audioOnly) {
      try { actx.drawImage(video, 0, 0, ambient.width, ambient.height); } catch {}
    }
  };
  draw();
  ambientTimer = setInterval(draw, 280);
}
export function refreshAmbient() { updateAmbientLoop(); }

// ---------- Overlays ----------

let flashTimer;
function showFlash(kind, text) {
  const iconName = { play: 'play', pause: 'pause', fwd: 'forward', back: 'back', volume: 'volume', mute: 'mute', speed: 'speed' }[kind] || 'play';
  flash.innerHTML = '';
  flash.append(h('div.flash-bubble', ic(iconName, 30), text ? h('span', text) : null));
  flash.classList.remove('show');
  void flash.offsetWidth;
  flash.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => flash.classList.remove('show'), 650);
}

let skipTimer;
function showSkip(seg) {
  const names = { sponsor: 'sponsor', selfpromo: 'self-promo', interaction: 'subscribe reminder', intro: 'intro', outro: 'outro', music_offtopic: 'non-music part', preview: 'preview', filler: 'filler' };
  skipToast.innerHTML = '';
  skipToast.append(ic('shield', 16), h('span', `Skipped ${names[seg.category] || 'segment'}`),
    h('button', { onclick: (e) => { e.stopPropagation(); video.currentTime = seg.start; skipToast.classList.remove('show'); } }, 'Undo'));
  skipToast.classList.add('show');
  clearTimeout(skipTimer);
  skipTimer = setTimeout(() => skipToast.classList.remove('show'), 3500);
}

function setBuffering(on) {
  el.classList.toggle('buffering', !!on);
}

let upNextTimer = 0;
function showUpNext(n) {
  hideUpNext();
  let left = 6;
  const ring = h('div.upnext-ring', h('span', String(left)));
  upNext.append(
    h('div.upnext-card',
      h('div.upnext-label', 'Up next'),
      h('div.upnext-body',
        h('img', { src: thumb(n), alt: '' }),
        h('div', h('div.upnext-title', n.title), h('div.upnext-meta', n.channel))),
      h('div.upnext-actions',
        h('button.btn.ghost-light', { onclick: (e) => { e.stopPropagation(); hideUpNext(); } }, 'Cancel'),
        h('button.btn.light', { onclick: (e) => { e.stopPropagation(); hideUpNext(); play(n); } }, ic('play', 16), 'Play now'),
        ring))
  );
  upNext.classList.add('show');
  upNextTimer = setInterval(() => {
    left--;
    ring.firstChild.textContent = String(left);
    ring.style.setProperty('--p', String((6 - left) / 6));
    if (left <= 0) { hideUpNext(); play(n); }
  }, 1000);
}
function hideUpNext() {
  clearInterval(upNextTimer);
  upNext.classList.remove('show');
  upNext.innerHTML = '';
}

// ---------- Settings menu ----------

function openSettings(anchor) {
  const q = currentQuality();
  const auto = sp?.getConfiguration().abr.enabled;
  const speedLabel = (video.playbackRate === 1 ? 'Normal' : video.playbackRate + '×');
  const ccLabel = P.captionTrack ? P.captionTrack.name : 'Off';
  const sleepLabel = P.sleepAt ? `${Math.ceil((P.sleepAt - Date.now()) / 60000)} min` : P.sleepEndOfVideo ? 'End of video' : 'Off';
  menu([
    { icon: 'quality', label: 'Quality', hint: (auto ? 'Auto' : '') + (q ? (auto ? ' · ' : '') + label(q.height, q.fps) : ''), keepOpen: true, action: () => qualityMenu(anchor) },
    { icon: 'speed', label: 'Playback speed', hint: speedLabel, keepOpen: true, action: () => speedMenu(anchor) },
    { icon: 'cc', label: 'Captions', hint: ccLabel, keepOpen: true, action: () => captionsMenu(anchor) },
    audioTracks().length > 1 ? { icon: 'headphones', label: 'Audio track', hint: sp.getVariantTracks().find((t) => t.active)?.language || '', keepOpen: true, action: () => audioMenu(anchor) } : null,
    { icon: 'moon', label: 'Sleep timer', hint: sleepLabel, keepOpen: true, action: () => sleepMenu(anchor) },
    { icon: 'headphones', label: 'Audio only', checked: P.audioOnly, action: () => toggleAudioOnly() },
    '-',
    { icon: 'pip', label: 'Pop out (picture in picture)', action: togglePiP },
    { icon: 'chart', label: 'Stats for nerds', checked: statsBox.classList.contains('show'), action: toggleStats }
  ], anchor, { above: true, cls: 'player-menu' });
}

function qualityMenu(anchor) {
  const list = qualityTracks();
  const auto = sp?.getConfiguration().abr.enabled;
  const q = currentQuality();
  menu([
    { header: 'Quality' },
    { label: 'Auto' + (auto && q ? ` (${label(q.height, q.fps)})` : ''), checked: auto, action: () => chooseQuality(0) },
    ...list.map((x) => ({ label: label(x.height, x.fps), hint: x.height >= 2160 ? (x.height >= 4320 ? '8K' : '4K') : x.height >= 720 ? 'HD' : '', checked: !auto && q?.height === x.height, action: () => chooseQuality(x.height) }))
  ], anchor, { above: true, cls: 'player-menu' });
}

function speedMenu(anchor) {
  menu([{ header: 'Playback speed' }, ...[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((s) => ({ label: s === 1 ? 'Normal' : s + '×', checked: Math.abs(video.playbackRate - s) < 0.01, action: () => setSpeed(s) }))], anchor, { above: true, cls: 'player-menu' });
}

function captionsMenu(anchor) {
  menu([
    { header: 'Captions' },
    { label: 'Off', checked: !P.captionTrack, action: () => { set('captions', false); selectCaptions(null); } },
    ...P.captionTracks.map((t) => ({ label: t.name + (t.auto ? ' (auto)' : ''), checked: P.captionTrack?.url === t.url, action: () => { set('captions', true); set('captionLanguage', t.lang.split('-')[0]); selectCaptions(t); } })),
    '-',
    { label: 'Text size', hint: Math.round(settings.captionSize * 100) + '%', keepOpen: true, action: () => menu([{ header: 'Caption size' }, ...[0.75, 1, 1.25, 1.5, 2].map((s) => ({ label: Math.round(s * 100) + '%', checked: settings.captionSize === s, action: () => { set('captionSize', s); el.style.setProperty('--cc-scale', s); } }))], anchor, { above: true, cls: 'player-menu' }) }
  ], anchor, { above: true, cls: 'player-menu' });
}

function audioTracks() {
  if (!sp) return [];
  return [...new Set(sp.getVariantTracks().map((t) => t.language))];
}
function audioMenu(anchor) {
  const cur = sp.getVariantTracks().find((t) => t.active)?.language;
  menu([{ header: 'Audio track' }, ...audioTracks().map((l) => ({ label: l, checked: l === cur, action: () => sp.selectAudioLanguage(l) }))], anchor, { above: true, cls: 'player-menu' });
}

function sleepMenu(anchor) {
  const setSleep = (min) => {
    P.sleepEndOfVideo = false;
    P.sleepAt = min ? Date.now() + min * 60000 : null;
    toast(min ? `Sleep timer: ${min} minutes` : 'Sleep timer off');
  };
  menu([
    { header: 'Sleep timer' },
    { label: 'Off', checked: !P.sleepAt && !P.sleepEndOfVideo, action: () => setSleep(0) },
    ...[10, 15, 30, 45, 60, 90].map((m) => ({ label: `${m} minutes`, action: () => setSleep(m) })),
    { label: 'End of video', checked: P.sleepEndOfVideo, action: () => { P.sleepAt = null; P.sleepEndOfVideo = true; toast('Pauses when this video ends'); } }
  ], anchor, { above: true, cls: 'player-menu' });
}

function toggleAudioOnly() {
  P.audioOnly = !P.audioOnly;
  el.classList.toggle('audio-only', P.audioOnly);
  if (!sp) return;
  if (P.audioOnly) {
    const lowest = qualityTracks().pop();
    if (lowest) { sp.configure({ abr: { enabled: false } }); sp.selectVariantTrack(lowest.track, true); }
    toast('Audio only — saving data');
  } else {
    applyQualityPreference();
    toast('Video back on');
  }
}

let statsTimer = 0;
function toggleStats() {
  const on = !statsBox.classList.contains('show');
  statsBox.classList.toggle('show', on);
  clearInterval(statsTimer);
  if (!on) return;
  const render = () => {
    const s = sp?.getStats();
    const t = sp?.getVariantTracks().find((x) => x.active);
    statsBox.innerHTML = '';
    const rows = [
      ['Video', P.current?.id],
      ['Source', P.info ? `${P.info.client} · ${P.info.kind.toUpperCase()}` : '—'],
      ['Resolution', t ? `${t.width}×${t.height}@${Math.round(t.frameRate || 30)}` : '—'],
      ['Codecs', t ? `${t.videoCodec || '?'} / ${t.audioCodec || '?'}` : '—'],
      ['Bitrate', t ? `${Math.round((t.bandwidth || 0) / 1000)} kbps` : '—'],
      ['Connection', s ? `${Math.round(s.estimatedBandwidth / 1e6 * 10) / 10} Mbps` : '—'],
      ['Buffer', video.buffered.length ? `${Math.round(video.buffered.end(video.buffered.length - 1) - video.currentTime)} s` : '0 s'],
      ['Dropped frames', s ? `${s.droppedFrames} / ${s.decodedFrames}` : '—']
    ];
    for (const [k, v] of rows) statsBox.append(h('div', h('b', k), h('span', v || '—')));
  };
  render();
  statsTimer = setInterval(render, 1000);
}

// ---------- Media Session (Windows media keys + volume flyout) ----------

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !P.current) return;
  const v = P.current;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: v.title || '',
    artist: v.channel || '',
    album: 'Premium',
    artwork: [{ src: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' }]
  });
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => resume());
  ms.setActionHandler('pause', () => pause());
  ms.setActionHandler('nexttrack', () => next());
  ms.setActionHandler('previoustrack', () => prev());
  ms.setActionHandler('seekbackward', () => seekBy(-10));
  ms.setActionHandler('seekforward', () => seekBy(10));
  try { ms.setActionHandler('seekto', (d) => seekTo(d.seekTime)); } catch {}
}

// ---------- Wiring ----------

function syncPlayButton() {
  const playing = !video.paused && !video.ended;
  btnPlay.innerHTML = '';
  btnPlay.append(ic(playing ? 'pause' : 'play', 26));
  btnPlay.title = playing ? 'Pause (k)' : 'Play (k)';
  el.classList.toggle('paused', !playing);
}

function syncVolumeUI() {
  const v = video.muted ? 0 : video.volume;
  volSlider.value = String(v);
  volSlider.style.setProperty('--v', String(v));
  btnVol.innerHTML = '';
  btnVol.append(ic(v === 0 ? 'mute' : v < 0.5 ? 'volumeLow' : 'volume', 24));
}

function syncAutoplay() {
  btnAuto.classList.toggle('on', !!settings.autoplay);
  btnAuto.title = settings.autoplay ? 'Autoplay is on' : 'Autoplay is off';
}

video.addEventListener('play', () => { syncPlayButton(); if (!raf) loop(); emit('state'); });
video.addEventListener('pause', () => { syncPlayButton(); saveProgress(); emit('state'); });
video.addEventListener('playing', () => { setBuffering(false); el.classList.remove('has-poster'); });
video.addEventListener('waiting', () => setBuffering(true));
video.addEventListener('canplay', () => setBuffering(false));
video.addEventListener('loadedmetadata', () => { renderSeekDecor(); tick(true); updateQualityBadge(); });
video.addEventListener('durationchange', () => renderSeekDecor());
video.addEventListener('seeked', () => tick(true));
video.addEventListener('volumechange', syncVolumeUI);
video.addEventListener('ended', () => {
  syncPlayButton();
  if (P.current) lib.setProgress(P.current.id, null);
  if (P.sleepEndOfVideo) { P.sleepEndOfVideo = false; toast('Sleep timer: stopped'); return; }
  const n = nextVideo();
  const inQueue = P.queue.length && P.queueIndex < P.queue.length - 1;
  if (n && (settings.autoplay || inQueue)) {
    if (P.mode === 'mini' || document.hidden) play(n);
    else showUpNext(n);
  }
  emit('ended');
});

btnPlay.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
btnPrev.addEventListener('click', (e) => { e.stopPropagation(); prev(); });
btnNext.addEventListener('click', (e) => { e.stopPropagation(); next(); });
btnVol.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });
volSlider.addEventListener('input', (e) => { e.stopPropagation(); setVolume(+volSlider.value); });
volSlider.addEventListener('click', (e) => e.stopPropagation());
btnCC.addEventListener('click', (e) => { e.stopPropagation(); toggleCaptions(); });
btnSettings.addEventListener('click', (e) => { e.stopPropagation(); openSettings(btnSettings); });
btnMini.addEventListener('click', (e) => { e.stopPropagation(); nav.toMini?.(); });
btnTheater.addEventListener('click', (e) => { e.stopPropagation(); toggleTheater(); });
btnFull.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });
btnAuto.addEventListener('click', (e) => {
  e.stopPropagation();
  set('autoplay', !settings.autoplay);
  syncAutoplay();
  toast(settings.autoplay ? 'Autoplay is on' : 'Autoplay is off');
});
chapterLabel.addEventListener('click', (e) => { e.stopPropagation(); nav.showChapters?.(); });
controls.addEventListener('click', (e) => e.stopPropagation());
controls.addEventListener('dblclick', (e) => e.stopPropagation());

// Click toggles play, double-click toggles full screen. Wait a beat so a double-click doesn't also pause.
let clickTimer = 0;
el.addEventListener('click', (e) => {
  if (e.target.closest('.player-controls, .player-upnext, .player-error, .player-skip, .player-stats')) return;
  if (P.mode === 'mini') return;
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => toggle(), 200);
});
el.addEventListener('dblclick', (e) => {
  if (e.target.closest('.player-controls, .player-upnext, .player-error')) return;
  if (P.mode === 'mini') return;
  clearTimeout(clickTimer);
  toggleFullscreen();
});
el.addEventListener('wheel', (e) => {
  if (!document.fullscreenElement) return;
  e.preventDefault();
  volumeBy(e.deltaY < 0 ? 0.05 : -0.05);
}, { passive: false });

// Controls hide after 2.6 s without the mouse moving.
let idleTimer = 0;
function wake() {
  el.classList.add('awake');
  el.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!video.paused && !dragging && !document.querySelector('.menu.player-menu')) { el.classList.remove('awake'); el.classList.add('idle'); }
  }, 2600);
}
el.addEventListener('mousemove', wake);
el.addEventListener('mouseleave', () => { if (!video.paused) { clearTimeout(idleTimer); el.classList.remove('awake'); } });
video.addEventListener('pause', wake);

document.addEventListener('fullscreenchange', () => {
  const fs = document.fullscreenElement === el;
  el.classList.toggle('fullscreen', fs);
  btnFull.innerHTML = '';
  btnFull.append(ic(fs ? 'exitFullscreen' : 'fullscreen', 23));
  btnFull.title = fs ? 'Exit full screen (f)' : 'Full screen (f)';
  closeMenu();
  emit('fullscreen', fs);
});

document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
window.addEventListener('beforeunload', saveProgress);

el.style.setProperty('--cc-scale', settings.captionSize || 1);
syncPlayButton();
syncVolumeUI();
syncAutoplay();

export function refreshSettings() {
  syncAutoplay();
  el.style.setProperty('--cc-scale', settings.captionSize || 1);
  applyQualityRestrictions();
  updateAmbientLoop();
}

export const videoElement = video;
