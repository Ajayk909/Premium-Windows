// Turns a video ID into something the player can play, using youtubei.js.
// We build a DASH manifest from YouTube's separate video + audio streams (all qualities up to
// 4K/8K, same as YouTube's own apps) and never use the HLS feed for normal videos, since
// that can carry stitched-in ads. Live streams use HLS because that's all YouTube offers.
import path from 'node:path';
import vm from 'node:vm';
import { Innertube, UniversalCache, Platform } from 'youtubei.js';

// youtubei.js extracts YouTube's signature/"n" functions from the player script; we run that
// small extract in an isolated VM context (no Node globals) with a time limit.
Platform.shim.eval = async (data) => {
  const context = vm.createContext({ URL, URLSearchParams, TextEncoder, TextDecoder, console: { log() {}, warn() {}, error() {} } });
  return vm.runInContext(`(function () {\n${data.output}\n})()`, context, { timeout: 3000 });
};

let ytPromise = null;
let cacheDir = null;

export function init(userData) {
  cacheDir = path.join(userData, 'yt-cache');
  return client();
}

function client() {
  if (!ytPromise) {
    ytPromise = Innertube.create({
      cache: new UniversalCache(true, cacheDir || undefined),
      retrieve_player: true,
      lang: 'en'
    }).catch((e) => {
      ytPromise = null;
      throw e;
    });
  }
  return ytPromise;
}

// Different YouTube clients work in different situations (age limits, region, made-for-kids,
// throttling). We try them in order and the player moves to the next one if playback fails.
// ANDROID_VR first: its links need no deciphering and no proof-of-origin token, so they keep
// working for the whole video. The others are fallbacks for videos it can't open.
const CLIENTS = ['ANDROID_VR', 'TV', 'IOS', 'WEB_EMBEDDED', 'TV_SIMPLY', 'WEB', 'MWEB'];

const UAS = {
  TVHTML5_SIMPLY: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)',
  TVHTML5: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)',
  ANDROID_VR: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
  ANDROID: 'com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip',
  IOS: 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)',
  MWEB: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1'
};
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

/// googlevideo expects the same browser ID as the client that asked for the stream.
export function userAgentFor(c) {
  return UAS[c] || DESKTOP_UA;
}

function playable(info) {
  const s = info?.playability_status;
  return s && s.status === 'OK';
}

function reasonOf(info) {
  const s = info?.playability_status;
  return s?.reason || s?.error_screen?.reason?.toString?.() || s?.status || 'unavailable';
}

export async function get(id, from = 0, skip = []) {
  const yt = await client();
  const reasons = [];
  for (let i = Math.max(0, from); i < CLIENTS.length; i++) {
    const name = CLIENTS[i];
    if (skip.includes(name)) continue;
    try {
      const info = await yt.getBasicInfo(id, { client: name });
      if (!playable(info)) { reasons.push(`${name}: ${reasonOf(info)}`); continue; }
      const sd = info.streaming_data;
      if (!sd) { reasons.push(`${name}: no streams`); continue; }
      const vd = info.basic_info || {};
      const captions = (info.captions?.caption_tracks || []).map((t) => ({
        name: t.name?.toString?.() || t.language_code,
        lang: t.language_code,
        url: t.base_url,
        auto: t.kind === 'asr'
      }));
      const common = {
        client: name,
        index: i,
        duration: vd.duration || 0,
        title: vd.title || '',
        channel: vd.author || '',
        channelId: vd.channel_id || null,
        captions
      };

      if (vd.is_live || (vd.is_live_content && !sd.adaptive_formats?.length)) {
        const url = sd.hls_manifest_url || sd.dash_manifest_url;
        if (!url) { reasons.push(`${name}: no live manifest`); continue; }
        return { ...common, kind: sd.hls_manifest_url ? 'hls' : 'dash-url', url, live: !!vd.is_live };
      }
      // Some clients only offer formats without direct links (YouTube's SABR streaming); skip those.
      const usable = (sd.adaptive_formats || []).filter((f) => f.url || f.signature_cipher || f.cipher);
      if (!usable.length) { reasons.push(`${name}: no direct links`); continue; }

      const manifest = await info.toDash({
        manifest_options: { include_thumbnails: false },
        format_filter: (f) => !f.url && !f.signature_cipher && !f.cipher
      });
      if (!manifest || !manifest.includes('<Representation')) { reasons.push(`${name}: empty manifest`); continue; }

      const heights = [...new Set(usable.filter((f) => f.has_video && f.height).map((f) => Math.min(f.height, f.width || f.height)))].sort((a, b) => b - a);
      return { ...common, kind: 'dash', manifest, heights };
    } catch (err) {
      const msg = String(err?.message || err);
      reasons.push(`${name}: ${msg}`);
      console.warn(`[streams] ${name} failed for ${id}:`, msg);
    }
  }
  throw new Error(reasons.length ? reasons.join(' · ') : 'Couldn\'t find a playable stream for this video.');
}

export const clientCount = CLIENTS.length;
