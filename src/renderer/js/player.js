// The one video player. Premium's controls on top, YouTube's own player underneath (engine.js).
// The player floats in a layer above the page and follows whichever spot it's shown in —
// the Watch page, the mini player or a Short — so playback never restarts when you move around.
import { h, ic, api, toast, formatTime, menu, closeMenu, nav, thumb } from './ui.js';
import { settings, set, lib, library } from './state.js';
import * as engine from './engine.js';

const listeners = new Map();
function emit(evt, payload) { for (const fn of listeners.get(evt) || []) { try { fn(payload); } catch (e) { console.error(e); } } }

export const P = {
  current: null,      // the video being played
  details: null,      // watch-page details (title, channel, chapters, related…)
  short: false,       // playing a Short (loops, no watch-page extras)
  queue: [],          // explicit queue (playlists, "play next")
  queueIndex: -1,
  segments: [],       // SponsorBlock
  chapters: [],
  captionTracks: [],
  captionTrack: null,
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

const video = engine.media;
const poster = h('img.player-poster', { alt: '' });
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

const extra = h('div.player-extra');

export const el = h('div.player', { tabIndex: -1 },
  h('div.player-stage', engine.webview, poster),
  extra,
  flash, spinner, skipToast, upNext, errorBox, statsBox,
  h('div.player-shade'),
  controls
);

/** Ambient glow: a tiny canvas the watch page puts behind the player and blurs. */
export const ambient = h('canvas.ambient', { width: 48, height: 27 });
const actx = ambient.getContext('2d');

// ---------- Loading ----------

export async function play(v, opts = {}) {
  if (!v?.id) return;
  const sameVideo = P.current?.id === v.id;
  if (sameVideo && !opts.force) {
    if (opts.queue) setQueue(opts.queue, v.id);
    if (opts.short !== undefined) P.short = !!opts.short;
    emit('change');
    return;
  }
  const token = ++P.token;
  saveProgress();
  P.current = { ...v };
  P.short = !!opts.short;
  P.details = null;
  P.segments = [];
  P.chapters = [];
  P.captionTracks = [];
  P.captionTrack = null;
  P.error = null;
  P.loading = true;
  P.ended = false;
  hideUpNext();
  if (P.short) { P.queue = []; P.queueIndex = -1; }
  else if (opts.queue) setQueue(opts.queue, v.id);
  else if (!P.queue.some((x) => x.id === v.id)) { P.queue = []; P.queueIndex = -1; }
  else P.queueIndex = P.queue.findIndex((x) => x.id === v.id);

  poster.src = thumb(v, true);
  poster.onerror = () => { poster.onerror = null; poster.src = thumb(v); };
  el.classList.add('has-poster');
  el.classList.toggle('short', P.short);
  errorBox.innerHTML = '';
  el.classList.remove('errored', 'ended');
  setBuffering(true);
  drawAmbient();
  renderSeekDecor();
  updateMediaSession();
  emit('change');

  lib.addHistory(P.short ? { ...v, isShort: true } : v);

  // Start position: what you asked for, or where you left off.
  let start = opts.startAt;
  if (start == null && !P.short) {
    const saved = lib.progress(v.id);
    const total = durationOf(v);
    if (saved > 5 && (!total || saved < total - 20)) start = saved;
  }
  engine.load(v.id, { start: start || 0, loop: P.short });
  applyPlaybackPrefs();

  if (P.short) return;

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
}

function durationOf(v) {
  if (!v?.duration) return 0;
  return String(v.duration).split(':').map(Number).reduce((a, b) => a * 60 + b, 0) || 0;
}

function pickDefined(o) {
  const out = {};
  for (const [k, val] of Object.entries(o || {})) if (val != null && val !== '') out[k] = val;
  return out;
}

/** Speed, volume, quality and captions follow your settings on every video. */
function applyPlaybackPrefs() {
  video.playbackRate = P.short ? 1 : (settings.speed || 1);
  video.volume = settings.volume ?? 1;
  video.muted = !!settings.muted;
  syncVolumeUI();
  const pref = settings.dataSaver ? Math.min(settings.quality || 480, 480) : settings.quality;
  P.manualQuality = 0;
  engine.setQuality(pref ? nearestLevel(pref) : 0);
}

function showError(message) {
  P.loading = false;
  P.error = message;
  setBuffering(false);
  el.classList.add('errored');
  errorBox.innerHTML = '';
  errorBox.append(
    h('div.player-error-icon', ic('sparkle', 28)),
    h('h3', 'This video can\'t play right now'),
    h('p', friendly(message)),
    h('div.player-error-actions',
      h('button.btn.light', { onclick: () => play(P.current, { force: true }) }, ic('refresh', 18), 'Try again'),
      h('button.btn.ghost-light', { onclick: () => api.call('app:open', `https://www.youtube.com/watch?v=${P.current.id}`) }, ic('external', 18), 'Open on YouTube'))
  );
  emit('change');
}

function friendly(m) {
  m = String(m || '');
  if (/sign in to confirm your age|age-restricted|inappropriate/i.test(m)) return 'YouTube asks you to sign in to confirm your age for this one.';
  if (/not a bot/i.test(m)) return 'YouTube wants to check you\'re not a bot. Open it on YouTube once, then try again.';
  if (/private/i.test(m)) return 'This video is private.';
  if (/unavailable|removed|terminated|deleted/i.test(m)) return 'YouTube says this video isn\'t available.';
  if (/couldn't reach|internet|network/i.test(m)) return 'Check your internet connection.';
  return m.length < 160 ? m : m.slice(0, 157) + '…';
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
export function duration() { return isFinite(video.duration) ? video.duration : durationOf(P.current); }

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
  engine.pip();
}

export function stop() {
  saveProgress();
  P.token++;
  P.current = null;
  P.details = null;
  P.short = false;
  P.queue = [];
  P.queueIndex = -1;
  engine.stop();
  hideUpNext();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  unmount();
  emit('change');
}

/** Extra layers drawn on top of the video (Shorts use this for their caption and progress bar). */
export function setOverlay(nodes) {
  extra.replaceChildren(...(nodes || []));
}

// ---------- Placement ----------
// The player is a floating layer. mount() tells it which element to sit on top of; it then
// follows that element as the page scrolls or resizes.

let slot = null;
let placeRaf = 0;
el.classList.add('floating');
document.body.append(el);

export function mount(container, mode) {
  slot = container;
  P.mode = mode;
  el.classList.toggle('mini', mode === 'mini');
  el.classList.toggle('in-short', mode === 'short');
  el.classList.add('placed');
  place();
  if (!placeRaf) placeRaf = requestAnimationFrame(follow);
  updateAmbientLoop();
}

export function unmount(container) {
  if (container && container !== slot) return;
  slot = null;
  P.mode = 'none';
  el.classList.remove('placed', 'mini', 'in-short');
  park();
}

function park() {
  // Keep the page alive (and the sound playing) but out of sight.
  Object.assign(el.style, { left: '-10000px', top: '0px', width: '320px', height: '180px' });
}

let lastRect = '';
function place() {
  if (document.fullscreenElement === el) return;
  if (!slot || !slot.isConnected) { park(); lastRect = ''; return; }
  const r = slot.getBoundingClientRect();
  if (!r.width || !r.height) { park(); lastRect = ''; return; }
  const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
  if (key === lastRect) return;
  lastRect = key;
  Object.assign(el.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
}

function follow() {
  place();
  placeRaf = slot ? requestAnimationFrame(follow) : 0;
}
park();

// ---------- Quality ----------

function label(height) {
  if (height >= 4320) return '8K';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  return height + 'p';
}

function qualityLevels() {
  return [...new Set((engine.state().levels || []).map(engine.qualityHeight).filter(Boolean))].sort((a, b) => b - a);
}

function nearestLevel(pref) {
  const list = qualityLevels();
  if (!list.length) return pref;
  return list.find((x) => x <= pref) || list[list.length - 1];
}

export function chooseQuality(height) {
  P.manualQuality = height || 0;
  engine.setQuality(height || 0);
  toast(height ? 'Quality: ' + label(height) : 'Quality: Auto');
  setTimeout(updateQualityBadge, 800);
}

function currentQuality() {
  const st = engine.state();
  const hgt = Math.min(st.w || 0, st.h || 0) || engine.qualityHeight(st.q);
  return hgt ? { height: hgt } : null;
}

function updateQualityBadge() {
  const q = currentQuality();
  qualityBadge.textContent = q && q.height >= 720 ? (q.height >= 2160 ? (q.height >= 4320 ? '8K' : '4K') : 'HD') : '';
  qualityBadge.classList.toggle('uhd', !!q && q.height >= 2160);
}

// ---------- Captions ----------
// YouTube's player draws the captions itself (same styling and timing as YouTube).

function selectCaptions(track) {
  P.captionTrack = track;
  btnCC.innerHTML = '';
  btnCC.append(ic(track ? 'ccOn' : 'cc', 23));
  engine.setCaptions(track, captionFontSize());
}

function captionFontSize() {
  const s = settings.captionSize || 1;
  return s <= 0.75 ? -1 : s <= 1 ? 0 : s <= 1.25 ? 1 : s <= 1.5 ? 2 : 3;
}

function bestCaptionTrack() {
  const list = P.captionTracks;
  if (!list.length) return null;
  const lang = settings.captionLanguage || (navigator.language || 'en').split('-')[0];
  return list.find((t) => t.lang.startsWith(lang) && !t.auto) || list.find((t) => t.lang.startsWith(lang)) || list.find((t) => !t.auto) || list[0];
}

export function toggleCaptions() {
  if (!P.captionTracks.length) { toast('No captions for this video'); return; }
  const on = !P.captionTrack;
  set('captions', on);
  selectCaptions(on ? bestCaptionTrack() : null);
  toast(on ? `Captions: ${P.captionTrack?.name || 'On'}` : 'Captions off');
}


video.addEventListener('tracks', () => {
  P.captionTracks = engine.state().tracks || [];
  if (settings.captions && !P.captionTrack && P.captionTracks.length && !P.short) selectCaptions(bestCaptionTrack());
  else if (!P.captionTracks.length && P.captionTrack) { P.captionTrack = null; btnCC.innerHTML = ''; btnCC.append(ic('cc', 23)); }
});
video.addEventListener('quality', () => {
  updateQualityBadge();
  // Re-apply your quality choice once YouTube knows which qualities this video has.
  const pref = P.manualQuality || (settings.dataSaver ? Math.min(settings.quality || 480, 480) : settings.quality);
  if (pref && qualityLevels().length) engine.setQuality(nearestLevel(pref));
});
video.addEventListener('error', (e) => { if (P.current) showError(e.detail); });
video.addEventListener('ad', (e) => { el.classList.toggle('ad-skipping', !!e.detail); });

// ---------- Seek bar ----------

function renderSeekDecor() {
  const d = duration() || 0;
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
  timeLabel.children[2].textContent = engine.state().live ? 'LIVE' : formatTime(d);
  const ch = [...P.chapters].reverse().find((c) => c.start <= t);
  if (chapterLabel.textContent !== (ch?.title ? '•  ' + ch.title : '')) chapterLabel.textContent = ch?.title ? '•  ' + ch.title : '';

  // SponsorBlock auto-skip.
  if (!video.paused && P.segments.length && !P.short) {
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
  if (!P.current || P.short || engine.state().live) return;
  const t = video.currentTime, d = duration();
  if (!t || t < 5) return;
  lib.setProgress(P.current.id, d && t > d - 20 ? null : t);
}

// ---------- Ambient glow ----------

// The player runs in its own process, so its frames can't be read; the glow is drawn from the
// video's thumbnail instead (blurred heavily, it reads the same).
const ambientImg = new Image();
ambientImg.crossOrigin = 'anonymous';
ambientImg.onload = () => { try { actx.clearRect(0, 0, ambient.width, ambient.height); actx.drawImage(ambientImg, 0, 0, ambient.width, ambient.height); } catch {} };
function drawAmbient() {
  if (P.current) ambientImg.src = `https://i.ytimg.com/vi/${P.current.id}/mqdefault.jpg`;
}
function updateAmbientLoop() {
  const on = settings.ambient && P.mode === 'page' && document.documentElement.dataset.glass === '1';
  ambient.classList.toggle('on', on);
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
  const auto = !P.manualQuality;
  const speedLabel = (video.playbackRate === 1 ? 'Normal' : video.playbackRate + '×');
  const ccLabel = P.captionTrack ? P.captionTrack.name : 'Off';
  const sleepLabel = P.sleepAt ? `${Math.ceil((P.sleepAt - Date.now()) / 60000)} min` : P.sleepEndOfVideo ? 'End of video' : 'Off';
  menu([
    { icon: 'quality', label: 'Quality', hint: (auto ? 'Auto' : '') + (q ? (auto ? ' · ' : '') + label(q.height) : ''), keepOpen: true, action: () => qualityMenu(anchor) },
    { icon: 'speed', label: 'Playback speed', hint: speedLabel, keepOpen: true, action: () => speedMenu(anchor) },
    { icon: 'cc', label: 'Captions', hint: ccLabel, keepOpen: true, action: () => captionsMenu(anchor) },
    { icon: 'moon', label: 'Sleep timer', hint: sleepLabel, keepOpen: true, action: () => sleepMenu(anchor) },
    { icon: 'headphones', label: 'Audio only', checked: P.audioOnly, action: () => toggleAudioOnly() },
    '-',
    { icon: 'pip', label: 'Pop out (picture in picture)', action: togglePiP },
    { icon: 'chart', label: 'Stats for nerds', checked: statsBox.classList.contains('show'), action: toggleStats }
  ], anchor, { above: true, cls: 'player-menu' });
}

function qualityMenu(anchor) {
  const list = qualityLevels();
  const auto = !P.manualQuality;
  const q = currentQuality();
  menu([
    { header: 'Quality' },
    { label: 'Auto' + (auto && q ? ` (${label(q.height)})` : ''), checked: auto, action: () => chooseQuality(0) },
    ...list.map((x) => ({ label: label(x), hint: x >= 2160 ? (x >= 4320 ? '8K' : '4K') : x >= 720 ? 'HD' : '', checked: !auto && P.manualQuality === x, action: () => chooseQuality(x) }))
  ], anchor, { above: true, cls: 'player-menu' });
}

function speedMenu(anchor) {
  menu([{ header: 'Playback speed' }, ...[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((s) => ({ label: s === 1 ? 'Normal' : s + '×', checked: Math.abs(video.playbackRate - s) < 0.01, action: () => setSpeed(s) }))], anchor, { above: true, cls: 'player-menu' });
}

function captionsMenu(anchor) {
  menu([
    { header: 'Captions' },
    { label: 'Off', checked: !P.captionTrack, action: () => { set('captions', false); selectCaptions(null); } },
    ...P.captionTracks.map((t) => ({ label: t.name + (t.auto ? ' (auto)' : ''), checked: P.captionTrack?.lang === t.lang && P.captionTrack?.auto === t.auto, action: () => { set('captions', true); set('captionLanguage', t.lang.split('-')[0]); selectCaptions(t); } })),
    '-',
    { label: 'Text size', hint: Math.round(settings.captionSize * 100) + '%', keepOpen: true, action: () => menu([{ header: 'Caption size' }, ...[0.75, 1, 1.25, 1.5, 2].map((s) => ({ label: Math.round(s * 100) + '%', checked: settings.captionSize === s, action: () => { set('captionSize', s); if (P.captionTrack) selectCaptions(P.captionTrack); } }))], anchor, { above: true, cls: 'player-menu' }) }
  ], anchor, { above: true, cls: 'player-menu' });
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
  engine.setVisible(!P.audioOnly);
  if (P.audioOnly) { engine.setQuality(144); toast('Audio only — saving data'); }
  else { engine.setQuality(P.manualQuality || nearestLevel(settings.quality || 0) || 0); toast('Video back on'); }
}

let statsTimer = 0;
function toggleStats() {
  const on = !statsBox.classList.contains('show');
  statsBox.classList.toggle('show', on);
  clearInterval(statsTimer);
  if (!on) return;
  const render = () => {
    const st = engine.state();
    statsBox.innerHTML = '';
    const rows = [
      ['Video', P.current?.id],
      ['Source', 'YouTube player'],
      ['Resolution', st.w ? `${st.w}×${st.h}` : '—'],
      ['Quality', st.q ? `${st.q}${P.manualQuality ? '' : ' (auto)'}` : '—'],
      ['Available', qualityLevels().map(label).join(' · ') || '—'],
      ['Buffer', video.buffered.length ? `${Math.max(0, Math.round(video.buffered.end(video.buffered.length - 1) - video.currentTime))} s` : '0 s'],
      ['Dropped frames', `${st.dropped || 0} / ${st.frames || 0}`],
      ['Ads', st.ad ? 'skipping one now' : 'none']
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
  if (P.short) return;
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
  if (P.mode === 'mini') { nav.openWatch?.(); return; }
  if (P.mode === 'short') { toggle(); emit('state'); return; }
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => toggle(), 200);
});
el.addEventListener('dblclick', (e) => {
  if (e.target.closest('.player-controls, .player-upnext, .player-error')) return;
  if (P.mode === 'mini' || P.mode === 'short') return;
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
  lastRect = '';
  requestAnimationFrame(place);
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
  if (P.current && !P.manualQuality) {
    const pref = settings.dataSaver ? Math.min(settings.quality || 480, 480) : settings.quality;
    engine.setQuality(pref ? nearestLevel(pref) : 0);
  }
  updateAmbientLoop();
}

