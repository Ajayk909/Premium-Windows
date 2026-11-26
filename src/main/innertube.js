// Talks to YouTube's own web API (the one youtube.com uses) for search, feeds, channels,
// video pages and comments. Ported from the iPhone app's InnerTube.swift so both apps parse
// YouTube the same proven way. Stream URLs come from streams.js.
import { net } from 'electron';

const CLIENT_VERSION = '2.20251110.01.00';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const REGION = (Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] || 'CA').toUpperCase();

async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await net.fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function post(endpoint, body) {
  const payload = { ...body, context: { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: 'en', gl: REGION } } };
  const res = await fetchWithTimeout(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': CLIENT_VERSION,
      'Origin': 'https://www.youtube.com',
      'User-Agent': UA,
      'Cookie': 'SOCS=CAI'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
  const json = await res.json();
  if (!json || typeof json !== 'object') throw new Error('YouTube sent something unexpected.');
  return json;
}

// ---------- Search ----------

export const FILTERS = {
  none: null,
  today: 'EgIIAg==',
  week: 'EgIIAw==',
  month: 'EgIIBA==',
  short: 'EgIYAQ==',
  long: 'EgIYAg==',
  live: 'EgJAAQ==',
  shorts: 'EgIQCQ=='
};

export async function search(query, filter = 'none', continuation = null) {
  const body = continuation ? { continuation } : { query, ...(FILTERS[filter] ? { params: FILTERS[filter] } : {}) };
  const json = await post('search', body);
  let items = P.videos(json);
  if (filter === 'shorts') items = items.map((v) => ({ ...v, isShort: true }));
  const channels = continuation ? [] : P.channels(json).slice(0, 3);
  return { items, channels, continuation: P.lastContinuation(json) };
}

export async function suggestions(query) {
  if (!query) return [];
  try {
    const res = await fetchWithTimeout(`https://suggestqueries-clients6.youtube.com/complete/search?client=firefox&ds=yt&hl=en&q=${encodeURIComponent(query)}`, {}, 5000);
    const arr = await res.json();
    return Array.isArray(arr?.[1]) ? arr[1].slice(0, 10) : [];
  } catch {
    return [];
  }
}

// ---------- Captions ----------

export async function cues(url) {
  const u = url.replace('&fmt=srv3', '') + '&fmt=json3';
  const res = await fetchWithTimeout(u, { headers: { 'User-Agent': UA } });
  const json = await res.json();
  const out = [];
  for (const e of json.events || []) {
    if (!e.segs) continue;
    const text = e.segs.map((s) => s.utf8 || '').join('').trim();
    if (!text || /^\d{2}:\d{2}:\d{2}/.test(text)) continue;
    const start = (e.tStartMs || 0) / 1000;
    const dur = (e.dDurationMs || 2000) / 1000;
    out.push({ start, end: start + dur, text });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------- Video page ----------

export async function details(id) {
  const json = await post('next', { videoId: id });
  const primary = P.first('videoPrimaryInfoRenderer', json);
  const secondary = P.first('videoSecondaryInfoRenderer', json);
  const owner = P.dig(secondary, 'owner', 'videoOwnerRenderer');

  const title = P.text(primary?.title) || '';
  const views = P.text(P.dig(primary, 'viewCount', 'videoViewCountRenderer', 'viewCount'))
    || P.text(P.dig(primary, 'viewCount', 'videoViewCountRenderer', 'shortViewCount')) || '';
  const shortViews = P.text(P.dig(primary, 'viewCount', 'videoViewCountRenderer', 'shortViewCount')) || views;
  const date = P.text(primary?.relativeDateText) || P.text(primary?.dateText) || '';
  const fullDate = P.text(primary?.dateText) || date;
  let likes = null;
  const like = primary && P.first('likeButtonViewModel', primary);
  if (like) likes = P.firstString('title', like);

  let channel = null;
  const cid = P.dig(owner, 'navigationEndpoint', 'browseEndpoint', 'browseId');
  if (owner && cid) {
    channel = {
      id: cid,
      name: P.text(owner.title) || '',
      avatar: P.lastURL(P.dig(owner, 'thumbnail', 'thumbnails')),
      subscribers: P.text(owner.subscriberCountText) || null,
      handle: P.dig(owner, 'navigationEndpoint', 'browseEndpoint', 'canonicalBaseUrl')?.replace(/^\//, '') || null
    };
  }
  const description = P.text(secondary?.attributedDescription) || P.text(secondary?.description) || '';

  const chapters = [];
  for (const c of P.all('chapterRenderer', json)) {
    const start = Number(c.timeRangeStartMillis || 0) / 1000;
    if (chapters.some((x) => x.start === start)) continue;
    chapters.push({ title: P.text(c.title) || '', start, thumbnail: P.lastURL(P.dig(c, 'thumbnail', 'thumbnails')) });
  }
  if (!chapters.length) {
    for (const m of P.all('macroMarkersListItemRenderer', json)) {
      const start = parseTime(P.text(m.timeDescription));
      if (start == null || chapters.some((x) => x.start === start)) continue;
      chapters.push({ title: P.text(m.title) || '', start, thumbnail: P.lastURL(P.dig(m, 'thumbnail', 'thumbnails')) });
    }
  }
  chapters.sort((a, b) => a.start - b.start);

  const secondaryResults = P.first('secondaryResults', json);
  let related = P.videos(secondaryResults || {}).filter((v) => v.id !== id);
  if (!related.length) related = P.videos(json).filter((v) => v.id !== id);

  let token = null;
  const section = P.all('itemSectionRenderer', json).find((s) => s.sectionIdentifier === 'comment-item-section' || s.targetId === 'comments-section');
  if (section) token = P.firstString('token', section);
  if (!token) {
    for (const panel of P.all('engagementPanelSectionListRenderer', json)) {
      if (panel.panelIdentifier === 'engagement-panel-comments-section') token = P.firstString('token', panel);
    }
  }
  const countHeader = P.first('commentsEntryPointHeaderRenderer', json);
  const commentCount = countHeader ? P.text(countHeader.commentCount) : null;

  return {
    video: { id, title, channel: channel?.name || '', channelId: channel?.id || null, channelAvatar: channel?.avatar || null, views: shortViews, published: date },
    description, views, date, fullDate, likes, channel, chapters, related,
    commentsToken: token, commentCount
  };
}

function parseTime(s) {
  if (!s) return null;
  const parts = s.trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  return parts.reduce((a, b) => a * 60 + b, 0);
}

export async function comments(token) {
  const json = await post('next', { continuation: token });
  const items = [];
  for (const m of P.dig(json, 'frameworkUpdates', 'entityBatchUpdate', 'mutations') || []) {
    const p = P.dig(m, 'payload', 'commentEntityPayload');
    if (!p) continue;
    items.push({
      id: P.dig(p, 'properties', 'commentId') || Math.random().toString(36).slice(2),
      author: P.dig(p, 'author', 'displayName') || '',
      avatar: P.dig(p, 'author', 'avatarThumbnailUrl') || null,
      text: P.dig(p, 'properties', 'content', 'content') || '',
      likes: P.dig(p, 'toolbar', 'likeCountNotliked') || '',
      published: P.dig(p, 'properties', 'publishedTime') || '',
      replies: P.dig(p, 'toolbar', 'replyCount') || '',
      creatorHeart: !!P.dig(p, 'toolbar', 'creatorThumbnailUrl'),
      pinned: false
    });
  }
  if (!items.length) {
    for (const c of P.all('commentRenderer', json)) {
      items.push({
        id: c.commentId || Math.random().toString(36).slice(2),
        author: P.text(c.authorText) || '',
        avatar: P.lastURL(P.dig(c, 'authorThumbnail', 'thumbnails')),
        text: P.text(c.contentText) || '',
        likes: P.text(c.voteCount) || '',
        published: P.text(c.publishedTimeText) || '',
        replies: ''
      });
    }
  }
  let next = null;
  for (const e of json.onResponseReceivedEndpoints || []) {
    const list = P.dig(e, 'reloadContinuationItemsCommand', 'continuationItems') || P.dig(e, 'appendContinuationItemsAction', 'continuationItems');
    const last = list?.[list.length - 1];
    if (last?.continuationItemRenderer) next = P.firstString('token', last.continuationItemRenderer);
  }
  return { items, next };
}

// ---------- Channels ----------

const CHANNEL_TABS = {
  videos: 'EgZ2aWRlb3PyBgQKAjoA',
  shorts: 'EgZzaG9ydHPyBgUKA5oBAA==',
  live: 'EgdzdHJlYW1z8gYECgJ6AA=='
};

export async function channel(id, tab = 'videos', continuation = null) {
  if (id.startsWith('@')) id = await resolveHandle(id);
  const body = continuation ? { continuation } : { browseId: id, params: CHANNEL_TABS[tab] || CHANNEL_TABS.videos };
  const json = await post('browse', body);
  let items = P.videos(json);
  if (tab === 'shorts') items = items.map((v) => ({ ...v, isShort: true }));
  const meta = P.dig(json, 'metadata', 'channelMetadataRenderer');
  const name = meta?.title || '';
  const avatar = P.lastURL(P.dig(meta, 'avatar', 'thumbnails'));
  const header = json.header || {};
  const subs = P.firstStringContaining('subscriber', header);
  const videoCount = P.firstStringContaining('video', header);
  const handle = P.firstStringPrefix('@', header);
  let banner = null;
  const b = P.first('imageBannerViewModel', json);
  if (b) banner = P.lastURL(P.dig(b, 'image', 'sources'));
  else banner = P.lastURL(P.dig(json, 'header', 'c4TabbedHeaderRenderer', 'banner', 'thumbnails'));
  items = items.map((v) => ({ ...v, channel: v.channel || name, channelId: v.channelId || id, channelAvatar: v.channelAvatar || avatar }));
  return {
    channel: { id, name, avatar, subscribers: subs || null },
    banner, handle, videoCount: videoCount || null,
    description: meta?.description || null,
    videos: { items, continuation: P.lastContinuation(json) }
  };
}

async function resolveHandle(handle) {
  const json = await post('navigation/resolve_url', { url: `https://www.youtube.com/${handle}` });
  const id = P.dig(json, 'endpoint', 'browseEndpoint', 'browseId');
  if (!id) throw new Error('Channel not found');
  return id;
}

export async function playlist(id, continuation = null) {
  const json = await post('browse', continuation ? { continuation } : { browseId: id.startsWith('VL') ? id : 'VL' + id });
  const items = [];
  for (const r of P.all('playlistVideoRenderer', json)) {
    const v = P.video(r);
    if (v && v.title) items.push(v);
  }
  const title = P.text(P.dig(json, 'metadata', 'playlistMetadataRenderer', 'title')) || P.dig(json, 'metadata', 'playlistMetadataRenderer', 'title') || 'Playlist';
  return { title, items: items.length ? items : P.videos(json), continuation: P.lastContinuation(json) };
}

/// Turns a pasted YouTube link into something we can open.
export async function resolve(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([\w-]{11})/);
  if (m) return { type: 'video', id: m[1], short: /shorts\//.test(url) };
  const pl = url.match(/[?&]list=([\w-]+)/);
  if (pl) return { type: 'playlist', id: pl[1] };
  const ch = url.match(/youtube\.com\/(?:channel\/(UC[\w-]{22})|(@[\w.-]+))/);
  if (ch) return { type: 'channel', id: ch[1] || ch[2] };
  return null;
}

// ---------- RSS (fast latest uploads per channel) ----------

export async function latest(ch) {
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`, { headers: { 'User-Agent': UA } }, 10000);
    if (!res.ok) return [];
    return parseRSS(await res.text(), ch);
  } catch {
    return [];
  }
}

export async function latestMany(channels, perChannel = 6) {
  const out = [];
  const queue = [...channels];
  // Six at a time keeps it quick without hammering YouTube.
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const c = queue.shift();
      const list = await latest(c);
      out.push(...list.slice(0, perChannel));
    }
  }));
  return out.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
}

function decodeXML(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function parseRSS(xml, ch) {
  const items = [];
  const nameMatch = xml.match(/<author>\s*<name>([^<]*)<\/name>/);
  for (const entry of xml.split('<entry>').slice(1)) {
    const id = entry.match(/<yt:videoId>([^<]+)</)?.[1];
    if (!id) continue;
    const title = decodeXML(entry.match(/<title>([^<]*)</)?.[1] || '');
    const published = entry.match(/<published>([^<]+)</)?.[1];
    const views = entry.match(/<media:statistics views="(\d+)"/)?.[1];
    const isShort = /\/shorts\//.test(entry.match(/<link[^>]*href="([^"]+)"/)?.[1] || '');
    const at = published ? Date.parse(published) : 0;
    items.push({
      id, title,
      channel: ch.name || decodeXML(nameMatch?.[1] || ''),
      channelId: ch.id,
      channelAvatar: ch.avatar || null,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      views: views ? compactCount(+views) + ' views' : null,
      published: at ? relativeTime(at) : null,
      publishedAt: at,
      isShort
    });
  }
  return items;
}

export function compactCount(n) {
  const f = (v, s) => (v.toFixed(1).replace(/\.0$/, '')) + s;
  if (n >= 1e9) return f(n / 1e9, 'B');
  if (n >= 1e6) return f(n / 1e6, 'M');
  if (n >= 1e3) return f(n / 1e3, 'K');
  return String(n);
}

function relativeTime(ms) {
  const s = Math.max(1, (Date.now() - ms) / 1000);
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [secs, name] of units) {
    if (s >= secs) { const n = Math.floor(s / secs); return `${n} ${name}${n > 1 ? 's' : ''} ago`; }
  }
  return 'just now';
}

// ---------- SponsorBlock & dislikes ----------

export async function sponsorSegments(id, categories) {
  if (!categories?.length) return [];
  try {
    const res = await fetchWithTimeout(`https://sponsor.ajay.app/api/skipSegments?videoID=${id}&categories=${encodeURIComponent(JSON.stringify(categories))}`, {}, 6000);
    if (!res.ok) return [];
    const list = await res.json();
    return list.filter((i) => Array.isArray(i.segment)).map((i) => ({ start: i.segment[0], end: i.segment[1], category: i.category || 'sponsor' }));
  } catch {
    return [];
  }
}

export async function dislikes(id) {
  try {
    const res = await fetchWithTimeout(`https://returnyoutubedislikeapi.com/votes?videoId=${id}`, {}, 5000);
    if (!res.ok) return null;
    const j = await res.json();
    return { likes: j.likes, dislikes: j.dislikes };
  } catch {
    return null;
  }
}

// ---------- JSON helpers ----------
// YouTube's JSON changes shape often, so instead of hard-coding long paths we walk the
// whole tree and pick up any known video "renderer" wherever it appears.

const P = {
  text(any) {
    if (typeof any === 'string') return any;
    if (!any || typeof any !== 'object') return null;
    if (typeof any.simpleText === 'string') return any.simpleText;
    if (Array.isArray(any.runs)) return any.runs.map((r) => r.text || '').join('');
    if (typeof any.content === 'string') return any.content;
    return null;
  },
  dig(any, ...path) {
    let cur = any;
    for (const k of path) {
      if (cur == null) return undefined;
      cur = cur[k];
    }
    return cur;
  },
  fix(url) {
    if (!url) return null;
    return url.startsWith('//') ? 'https:' + url : url;
  },
  lastURL(list) {
    return Array.isArray(list) && list.length ? P.fix(list[list.length - 1]?.url) : null;
  },
  first(key, node) {
    if (Array.isArray(node)) {
      for (const v of node) { const f = P.first(key, v); if (f !== undefined) return f; }
    } else if (node && typeof node === 'object') {
      if (key in node) return node[key];
      for (const v of Object.values(node)) { const f = P.first(key, v); if (f !== undefined) return f; }
    }
    return undefined;
  },
  firstString(key, node) {
    if (Array.isArray(node)) {
      for (const v of node) { const f = P.firstString(key, v); if (f) return f; }
    } else if (node && typeof node === 'object') {
      if (typeof node[key] === 'string') return node[key];
      for (const v of Object.values(node)) { const f = P.firstString(key, v); if (f) return f; }
    }
    return null;
  },
  firstStringContaining(needle, node) {
    if (typeof node === 'string') return node.toLowerCase().includes(needle) && node.length < 40 ? node : null;
    const vals = Array.isArray(node) ? node : node && typeof node === 'object' ? Object.values(node) : [];
    for (const v of vals) { const f = P.firstStringContaining(needle, v); if (f) return f; }
    return null;
  },
  firstStringPrefix(prefix, node) {
    if (typeof node === 'string') return node.startsWith(prefix) && !node.includes(' ') && node.length > 1 ? node : null;
    const vals = Array.isArray(node) ? node : node && typeof node === 'object' ? Object.values(node) : [];
    for (const v of vals) { const f = P.firstStringPrefix(prefix, v); if (f) return f; }
    return null;
  },
  all(key, node) {
    const out = [];
    const walk = (n) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        for (const [k, v] of Object.entries(n)) {
          if (k === key && v && typeof v === 'object' && !Array.isArray(v)) out.push(v);
          walk(v);
        }
      }
    };
    walk(node);
    return out;
  },
  lastContinuation(json) {
    let token = null;
    const walk = (n) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        if (n.continuationCommand?.token) token = n.continuationCommand.token;
        if (n.nextContinuationData?.continuation) token = n.nextContinuationData.continuation;
        for (const [k, v] of Object.entries(n)) if (k !== 'continuationCommand') walk(v);
      }
    };
    walk(json);
    return token;
  },
  skip: new Set(['adSlotRenderer', 'promotedSparklesWebRenderer', 'searchPyvRenderer', 'playlistRenderer', 'radioRenderer', 'movieRenderer', 'compactRadioRenderer', 'compactPlaylistRenderer']),
  videos(root) {
    const out = [];
    const seen = new Set();
    const add = (v) => {
      if (!v || !v.id || !v.title || seen.has(v.id)) return;
      seen.add(v.id);
      out.push(v);
    };
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (P.skip.has(k)) continue;
        if (!v || typeof v !== 'object') continue;
        if (Array.isArray(v)) { v.forEach(walk); continue; }
        switch (k) {
          case 'videoRenderer': case 'compactVideoRenderer': case 'gridVideoRenderer': case 'videoWithContextRenderer': case 'playlistVideoRenderer':
            add(P.video(v)); break;
          case 'reelItemRenderer': add(P.reel(v)); break;
          case 'shortsLockupViewModel': add(P.shortsLockup(v)); break;
          case 'lockupViewModel': add(P.lockup(v)); break;
          default: walk(v);
        }
      }
    };
    walk(root);
    return out;
  },
  channels(root) {
    return P.all('channelRenderer', root).map((c) => ({
      id: c.channelId,
      name: P.text(c.title) || '',
      avatar: P.lastURL(P.dig(c, 'thumbnail', 'thumbnails')),
      subscribers: P.text(c.videoCountText) || P.text(c.subscriberCountText) || null,
      handle: P.text(c.subscriberCountText)?.startsWith('@') ? P.text(c.subscriberCountText) : null
    })).filter((c) => c.id && c.name);
  },
  video(d) {
    const id = d.videoId;
    if (!id) return null;
    const owner = d.ownerText || d.longBylineText || d.shortBylineText;
    const channelId = P.dig(owner, 'runs', 0, 'navigationEndpoint', 'browseEndpoint', 'browseId') || null;
    const avatar = P.lastURL(P.dig(d, 'channelThumbnailSupportedRenderers', 'channelThumbnailWithLinkRenderer', 'thumbnail', 'thumbnails'))
      || P.lastURL(P.dig(d, 'channelThumbnail', 'thumbnails'));
    let duration = P.text(d.lengthText);
    let live = false;
    for (const o of d.thumbnailOverlays || []) {
      const t = o.thumbnailOverlayTimeStatusRenderer;
      if (t) {
        if (t.style === 'LIVE') live = true;
        else if (!duration) duration = P.text(t.text);
      }
    }
    if ((d.badges || []).some((b) => P.dig(b, 'metadataBadgeRenderer', 'style') === 'BADGE_STYLE_TYPE_LIVE_NOW')) live = true;
    return {
      id,
      title: P.text(d.title) || P.text(d.headline) || '',
      channel: P.text(owner) || '',
      channelId,
      channelAvatar: avatar,
      thumbnail: P.lastURL(P.dig(d, 'thumbnail', 'thumbnails')),
      duration: live ? null : duration,
      views: P.text(d.shortViewCountText) || P.text(d.viewCountText),
      published: P.text(d.publishedTimeText),
      isLive: live,
      isShort: !!P.dig(d, 'navigationEndpoint', 'reelWatchEndpoint'),
      description: P.text(P.dig(d, 'detailedMetadataSnippets', 0, 'snippetText')) || P.text(d.descriptionSnippet) || null
    };
  },
  reel(d) {
    if (!d.videoId) return null;
    return { id: d.videoId, title: P.text(d.headline) || '', thumbnail: P.lastURL(P.dig(d, 'thumbnail', 'thumbnails')), views: P.text(d.viewCountText), isShort: true, channel: '' };
  },
  shortsLockup(d) {
    const id = P.dig(d, 'onTap', 'innertubeCommand', 'reelWatchEndpoint', 'videoId') || P.firstString('videoId', d);
    if (!id) return null;
    return {
      id,
      title: P.dig(d, 'overlayMetadata', 'primaryText', 'content') || '',
      thumbnail: P.fix(P.dig(d, 'thumbnail', 'sources', 0, 'url')),
      views: P.dig(d, 'overlayMetadata', 'secondaryText', 'content') || null,
      isShort: true,
      channel: ''
    };
  },
  lockup(d) {
    const id = d.contentId;
    if (!id || !String(d.contentType || '').includes('VIDEO')) return null;
    const meta = P.dig(d, 'metadata', 'lockupMetadataViewModel');
    const parts = [];
    for (const r of P.dig(meta, 'metadata', 'contentMetadataViewModel', 'metadataRows') || []) {
      for (const p of r.metadataParts || []) {
        const t = P.text(p.text);
        if (t) parts.push(t);
      }
    }
    let duration = null;
    let live = false;
    const badge = P.first('thumbnailBadgeViewModel', d);
    if (badge) {
      const t = badge.text || '';
      if (t.toUpperCase() === 'LIVE') live = true; else duration = t || null;
    }
    const image = P.first('thumbnailViewModel', d);
    const avatarVM = meta ? P.first('avatarViewModel', meta) : null;
    const cid = meta ? P.firstStringPrefix('UC', meta) : null;
    return {
      id,
      title: P.text(meta?.title) || '',
      channel: parts[0] || '',
      channelId: cid && cid.length === 24 ? cid : null,
      channelAvatar: P.lastURL(P.dig(avatarVM, 'image', 'sources')),
      thumbnail: P.lastURL(P.dig(image, 'image', 'sources')),
      duration,
      views: parts[1] || null,
      published: parts[2] || null,
      isLive: live,
      isShort: false
    };
  }
};
