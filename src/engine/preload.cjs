// Preload for the hidden YouTube player (the <webview> inside Premium's player).
// It injects a small script into YouTube's own page world, before YouTube's scripts run, that:
//   1. strips ad slots out of YouTube's player responses (the same trick uBlock Origin uses),
//   2. skips any ad that still gets through and closes "Are you still watching?",
//   3. exposes window.__prm so Premium can drive the player (load, play, seek, quality…),
//   4. reports the player state back to Premium through console messages.
// Nothing here gives the YouTube page access to Premium or Node.
const { webFrame } = require('electron');

function inject() {
  if (window.__prm) return;
  const PREFIX = '__PRM__';
  const post = (msg) => { try { console.info(PREFIX + JSON.stringify(msg)); } catch (e) {} };

  // ---------- 1. Ad pruning ----------
  const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams', 'adBreakParams'];
  const pruneOne = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of AD_KEYS) if (k in o) { try { delete o[k]; } catch (e) {} }
  };
  const prune = (o) => {
    try {
      if (o && typeof o === 'object') {
        pruneOne(o);
        if (o.playerResponse) pruneOne(o.playerResponse);
        if (Array.isArray(o)) for (const x of o) if (x && x.playerResponse) pruneOne(x.playerResponse);
      }
    } catch (e) {}
    return o;
  };
  const nativeParse = JSON.parse;
  JSON.parse = function (text, reviver) { return prune(nativeParse.call(this, text, reviver)); };
  const nativeJson = Response.prototype.json;
  Response.prototype.json = function () { return nativeJson.call(this).then(prune); };
  let initial;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get() { return initial; },
      set(v) { initial = prune(v); }
    });
  } catch (e) {}

  // ---------- 3. Control API ----------
  const P = () => document.getElementById('movie_player');
  const V = () => (P() && P().querySelector('video')) || document.querySelector('video.html5-main-video') || document.querySelector('video');
  let wantId = null;
  let loopOn = false;
  let muteForAd = false;
  let captionLang = null;
  let captionSize = 0;

  const call = (name, ...args) => { const p = P(); try { return p && typeof p[name] === 'function' ? p[name](...args) : undefined; } catch (e) { return undefined; } };

  function applyCaptions() {
    const p = P();
    if (!p) return;
    try {
      if (!captionLang) {
        call('setOption', 'captions', 'track', {});
        call('unloadModule', 'captions');
        return;
      }
      call('loadModule', 'captions');
      const list = call('getOption', 'captions', 'tracklist', { includeAsr: true }) || [];
      const want = captionLang.split(':');
      const pick = list.find((t) => t.languageCode === want[0] && (!!(t.kind === 'asr') === (want[1] === 'asr')))
        || list.find((t) => t.languageCode === want[0]) || list[0];
      if (pick) call('setOption', 'captions', 'track', pick);
      call('setOption', 'captions', 'fontSize', captionSize);
    } catch (e) {}
  }

  window.__prm = {
    load(id, start, opts) {
      wantId = id;
      loopOn = !!(opts && opts.loop);
      const p = P();
      if (p && typeof p.loadVideoById === 'function') {
        p.loadVideoById({ videoId: id, startSeconds: start || 0 });
      } else {
        location.href = '/watch?v=' + encodeURIComponent(id) + (start ? '&t=' + Math.floor(start) + 's' : '');
      }
    },
    adopt(id, opts) { wantId = id; loopOn = !!(opts && opts.loop); },
    play() { const v = V(); if (call('playVideo') === undefined && v) v.play().catch(() => {}); },
    pause() { const v = V(); if (call('pauseVideo') === undefined && v) v.pause(); },
    seek(t) { const v = V(); if (call('seekTo', t, true) === undefined && v) v.currentTime = t; },
    rate(r) { call('setPlaybackRate', r); const v = V(); if (v) v.playbackRate = r; },
    volume(x) { call('setVolume', Math.round(x * 100)); },
    mute(m) { if (m) call('mute'); else call('unMute'); const v = V(); if (v && !muteForAd) v.muted = !!m; },
    quality(q) {
      if (!q || q === 'auto') call('setPlaybackQualityRange', 'auto', 'auto');
      else { call('setPlaybackQualityRange', q, q); call('setPlaybackQuality', q); }
    },
    captions(lang, size) { captionLang = lang || null; captionSize = size || 0; applyCaptions(); },
    loop(on) { loopOn = !!on; },
    stop() { call('stopVideo'); wantId = null; },
    pip() { const v = V(); if (!v) return; if (document.pictureInPictureElement) document.exitPictureInPicture(); else v.requestPictureInPicture(); }
  };

  // ---------- 2 + 4. Watch loop ----------
  let boundVideo = null;
  const onEvent = (e) => post({ type: 'event', name: e.type, state: snapshot() });
  function bind() {
    const v = V();
    if (v === boundVideo || !v) return;
    if (boundVideo) for (const n of EVENTS) boundVideo.removeEventListener(n, onEvent);
    boundVideo = v;
    for (const n of EVENTS) v.addEventListener(n, onEvent);
  }
  const EVENTS = ['play', 'pause', 'playing', 'waiting', 'seeked', 'ended', 'loadedmetadata', 'durationchange', 'volumechange', 'ratechange', 'canplay'];

  function handleAds(p, v) {
    const ad = !!(p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
    if (ad && v) {
      if (!v.muted) { v.muted = true; muteForAd = true; }
      try { if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration; } catch (e) {}
      try { v.playbackRate = 16; } catch (e) {}
      document.querySelectorAll('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-container button').forEach((b) => { try { b.click(); } catch (e) {} });
    } else if (!ad && muteForAd && v) {
      muteForAd = false;
      v.muted = !!call('isMuted');
    }
    return ad;
  }

  function snapshot() {
    const p = P();
    const v = V();
    const ad = handleAds(p, v);
    const vd = call('getVideoData') || {};
    const buf = [];
    try { if (v) for (let i = 0; i < v.buffered.length; i++) buf.push([v.buffered.start(i), v.buffered.end(i)]); } catch (e) {}
    let errText = null;
    const errEl = document.querySelector('#movie_player .ytp-error');
    if (errEl && errEl.offsetParent !== null) errText = (errEl.innerText || '').trim().slice(0, 300) || 'Video unavailable';
    const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    let tracks = [];
    try {
      const pr = call('getPlayerResponse');
      tracks = ((pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [])
        .map((t) => ({ lang: t.languageCode, auto: t.kind === 'asr', name: (t.name && (t.name.simpleText || (t.name.runs || []).map((r) => r.text).join(''))) || t.languageCode }));
    } catch (e) {}
    const state = call('getPlayerState');
    return {
      id: vd.video_id || null,
      want: wantId,
      t: v ? v.currentTime : (call('getCurrentTime') || 0),
      d: (v && isFinite(v.duration) && v.duration > 0) ? v.duration : (call('getDuration') || 0),
      paused: v ? v.paused : true,
      ended: !!(v && v.ended) || state === 0,
      rs: v ? v.readyState : 0,
      buf,
      rate: v ? v.playbackRate : 1,
      vol: (call('getVolume') ?? 100) / 100,
      muted: !!call('isMuted'),
      q: call('getPlaybackQuality') || null,
      levels: call('getAvailableQualityLevels') || [],
      w: v ? v.videoWidth : 0,
      h: v ? v.videoHeight : 0,
      fps: 0,
      dropped: q ? q.droppedVideoFrames : 0,
      frames: q ? q.totalVideoFrames : 0,
      live: !!vd.isLive,
      ad,
      err: errText,
      tracks,
      ready: !!(p && typeof p.loadVideoById === 'function')
    };
  }

  setInterval(() => {
    bind();
    const v = V();
    if (v && loopOn && v.ended) { try { v.currentTime = 0; v.play(); } catch (e) {} }
    // "Video paused. Continue watching?" — keep going.
    document.querySelectorAll('yt-confirm-dialog-renderer #confirm-button, ytd-popup-container #confirm-button').forEach((b) => { try { b.click(); } catch (e) {} });
    post({ type: 'state', state: snapshot() });
  }, 250);

  post({ type: 'hello' });
}

webFrame.executeJavaScript('(' + inject.toString() + ')();').catch(() => {});
