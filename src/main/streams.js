// Turns a video ID into something the player can play, using youtubei.js.
// We build a DASH manifest from YouTube's separate video + audio streams (all qualities up to
// 4K/8K, same as YouTube's own apps). If that's refused, we fall back to YouTube's iOS HLS
// feed, which is what the iPhone app plays. Live streams always use HLS.
import path from 'node:path';
import vm from 'node:vm';
import { net } from 'electron';
import { Innertube, UniversalCache, Platform } from 'youtubei.js';
import * as potoken from './potoken.js';

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
  return client().then((yt) => potoken.warm(visitorData(yt)));
}

// Every YouTube request goes through Chromium's network stack (same as the video segments),
// so YouTube sees one consistent connection — its stream links are tied to the requester.
async function chromiumFetch(input, init) {
  if (input instanceof Request) {
    const body = input.method === 'GET' || input.method === 'HEAD' ? undefined : Buffer.from(await input.arrayBuffer());
    return net.fetch(input.url, { method: input.method, headers: Object.fromEntries(input.headers.entries()), body, ...(init || {}) });
  }
  return net.fetch(input instanceof URL ? input.toString() : String(input), init);
}

function client() {
  if (!ytPromise) {
    ytPromise = Innertube.create({
      cache: new UniversalCache(true, cacheDir || undefined),
      retrieve_player: true,
      lang: 'en',
      fetch: chromiumFetch
    }).catch((e) => {
      ytPromise = null;
      throw e;
    });
  }
  return ytPromise;
}

function visitorData(yt) {
  return yt?.session?.context?.client?.visitorData || null;
}

// Sources in the order we try them. The player moves to the next one if playback fails.
//  - MWEB/WEB: YouTube's own web clients, with PO tokens (full quality, most reliable today)
//  - TV / ANDROID_VR: no tokens needed for many videos
//  - IOS_HLS: the iPhone feed (up to ~1080p) — the safety net
const CLIENTS = [
  { name: 'MWEB', client: 'MWEB', pot: true },
  { name: 'TV', client: 'TV' },
  { name: 'ANDROID_VR', client: 'ANDROID_VR' },
  { name: 'IOS_HLS', client: 'IOS', hls: true },
  { name: 'WEB', client: 'WEB', pot: true },
  { name: 'WEB_EMBEDDED', client: 'WEB_EMBEDDED', pot: true },
  { name: 'IOS', client: 'IOS' }
];

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

function reasonOf(info) {
  const s = info?.playability_status;
  return s?.reason || s?.error_screen?.reason?.toString?.() || s?.status || 'unavailable';
}

export async function get(id, from = 0) {
  const yt = await client();
  const reasons = [];
  for (let i = Math.max(0, from); i < CLIENTS.length; i++) {
    const src = CLIENTS[i];
    try {
      let contentPot = null, sessionPot = null;
      if (src.pot) {
        const vd = visitorData(yt);
        try {
          const t = await potoken.mint(vd ? [vd, id] : [id]);
          contentPot = t[id] || null;
          sessionPot = vd ? t[vd] : null;
        } catch (e) {
          reasons.push(`${src.name}: no PO token (${e.message})`);
          continue;
        }
      }
      const info = await yt.getBasicInfo(id, { client: src.client, ...(contentPot ? { po_token: contentPot } : {}) });
      if (info?.playability_status?.status !== 'OK') { reasons.push(`${src.name}: ${reasonOf(info)}`); continue; }
      const sd = info.streaming_data;
      if (!sd) { reasons.push(`${src.name}: no streams`); continue; }
      const vd = info.basic_info || {};
      const captions = (info.captions?.caption_tracks || []).map((t) => ({
        name: t.name?.toString?.() || t.language_code,
        lang: t.language_code,
        url: t.base_url,
        auto: t.kind === 'asr'
      }));
      const common = {
        client: src.name,
        index: i,
        duration: vd.duration || 0,
        title: vd.title || '',
        channel: vd.author || '',
        channelId: vd.channel_id || null,
        captions
      };

      if (vd.is_live || src.hls || (vd.is_live_content && !sd.adaptive_formats?.length)) {
        const url = sd.hls_manifest_url || (src.hls ? null : sd.dash_manifest_url);
        if (!url) { reasons.push(`${src.name}: no HLS feed`); continue; }
        return { ...common, kind: sd.hls_manifest_url ? 'hls' : 'dash-url', url, live: !!vd.is_live };
      }

      // Some clients only offer formats without direct links (YouTube's SABR streaming); skip those.
      const usable = (sd.adaptive_formats || []).filter((f) => f.url || f.signature_cipher || f.cipher);
      if (!usable.length) { reasons.push(`${src.name}: no direct links`); continue; }

      // Web clients' links need the session PO token; others must not carry one.
      if (yt.session.player) yt.session.player.po_token = sessionPot || undefined;
      const manifest = await info.toDash({
        manifest_options: { include_thumbnails: false },
        format_filter: (f) => !f.url && !f.signature_cipher && !f.cipher
      });
      if (!manifest || !manifest.includes('<Representation')) { reasons.push(`${src.name}: empty manifest`); continue; }

      const heights = [...new Set(usable.filter((f) => f.has_video && f.height).map((f) => Math.min(f.height, f.width || f.height)))].sort((a, b) => b - a);
      return { ...common, kind: 'dash', manifest, heights };
    } catch (err) {
      const msg = String(err?.message || err);
      reasons.push(`${src.name}: ${msg}`);
      console.warn(`[streams] ${src.name} failed for ${id}:`, msg);
    }
  }
  throw new Error(reasons.length ? reasons.join(' · ') : 'Couldn\'t find a playable stream for this video.');
}

export const clientCount = CLIENTS.length;
