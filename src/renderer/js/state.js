// Everything the app keeps on this PC: subscriptions, history, saved lists, watch time, settings.
// Same shape as the iPhone app's library, so a backup from one can be restored on the other.
const api = window.premium;

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, payload) {
  for (const fn of listeners.get(evt) || []) {
    try { fn(payload); } catch (e) { console.error(e); }
  }
}

const libraryDefaults = () => ({
  subscriptions: [],
  history: [],
  watchLater: [],
  liked: [],
  disliked: [],
  playlists: [],
  progress: {},
  watchSeconds: {},
  channelSeconds: {},
  recentSearches: []
});

const settingsDefaults = () => ({
  theme: 'pearl',
  eveningMode: true,
  ambient: true,
  ambientStrength: 0.65,
  hideShortsOnHome: false,
  blockedWords: [],
  blockedChannels: [],
  sponsorCategories: ['sponsor', 'selfpromo', 'interaction'],
  autoplay: true,
  dataSaver: false,
  quality: 0, // 0 = Auto
  speed: 1,
  volume: 1,
  muted: false,
  captions: false,
  captionLanguage: null,
  captionSize: 1,
  hoverPreviews: true,
  maxLengthMinutes: 0,
  rokuIP: null,
  rokuName: null,
  sidebarCollapsed: false,
  showDislikes: true,
  name: ''
});

export const library = libraryDefaults();
export const settings = settingsDefaults();

export async function load() {
  try {
    const data = await api.call('store:load');
    if (data?.library) Object.assign(library, libraryDefaults(), data.library);
    if (data?.settings) Object.assign(settings, settingsDefaults(), data.settings);
  } catch (e) {
    console.error('[state] load failed', e);
  }
}

let libTimer, setTimer;
function saveLibrary() {
  clearTimeout(libTimer);
  libTimer = setTimeout(() => api.call('store:save', 'library', library).catch(() => {}), 1200);
  emit('library');
}
function saveSettings() {
  clearTimeout(setTimer);
  setTimer = setTimeout(() => api.call('store:save', 'settings', settings).catch(() => {}), 300);
}

export function set(key, value) {
  settings[key] = value;
  saveSettings();
  emit('settings', key);
}

// ---------- Theme ----------

export function themeName(date = new Date()) {
  const h = date.getHours();
  if (settings.theme === 'pearl' && settings.eveningMode && (h >= 20 || h < 6)) return 'pearl-evening';
  return settings.theme;
}

// ---------- Filters ----------

export function durationSeconds(v) {
  if (!v?.duration) return null;
  const parts = String(v.duration).split(':').map(Number);
  if (parts.some(isNaN)) return null;
  return parts.reduce((a, b) => a * 60 + b, 0);
}

export function allowed(v) {
  if (!v) return false;
  if (settings.blockedChannels.some((c) => c.id === v.channelId || (v.channel && c.name === v.channel))) return false;
  if (settings.maxLengthMinutes > 0) {
    const s = durationSeconds(v);
    if (s && s > settings.maxLengthMinutes * 60) return false;
  }
  const words = settings.blockedWords.map((w) => w.toLowerCase()).filter(Boolean);
  if (!words.length) return true;
  const hay = (v.title || '').toLowerCase();
  return !words.some((w) => hay.includes(w));
}

export function blockChannel(c) {
  if (settings.blockedChannels.some((x) => x.id === c.id)) return;
  set('blockedChannels', [...settings.blockedChannels, c]);
}

// ---------- Library ----------

const slim = (v) => ({
  id: v.id, title: v.title, channel: v.channel || '', channelId: v.channelId || null, channelAvatar: v.channelAvatar || null,
  thumbnail: v.thumbnail || null, duration: v.duration || null, views: v.views || null, published: v.published || null,
  isLive: !!v.isLive, isShort: !!v.isShort
});

export const lib = {
  isSubscribed: (id) => !!id && library.subscriptions.some((c) => c.id === id),
  toggleSubscribe(c) {
    const i = library.subscriptions.findIndex((x) => x.id === c.id);
    if (i >= 0) library.subscriptions.splice(i, 1);
    else library.subscriptions.unshift({ id: c.id, name: c.name, avatar: c.avatar || null, subscribers: c.subscribers || null });
    saveLibrary();
    return i < 0;
  },
  addSubscriptions(list) {
    let added = 0;
    for (const c of list) {
      if (!c.id || library.subscriptions.some((x) => x.id === c.id)) continue;
      library.subscriptions.push({ id: c.id, name: c.name, avatar: c.avatar || null, subscribers: null });
      added++;
    }
    if (added) saveLibrary();
    return added;
  },
  updateChannel(c) {
    const s = library.subscriptions.find((x) => x.id === c.id);
    if (!s) return;
    let changed = false;
    if (c.name && s.name !== c.name) { s.name = c.name; changed = true; }
    if (c.avatar && s.avatar !== c.avatar) { s.avatar = c.avatar; changed = true; }
    if (c.subscribers && s.subscribers !== c.subscribers) { s.subscribers = c.subscribers; changed = true; }
    if (changed) saveLibrary();
  },
  addHistory(v) {
    library.history = library.history.filter((x) => x.id !== v.id);
    library.history.unshift(slim(v));
    if (library.history.length > 500) library.history.length = 500;
    saveLibrary();
  },
  updateVideo(v) {
    const i = library.history.findIndex((x) => x.id === v.id);
    if (i >= 0) { library.history[i] = { ...library.history[i], ...slim(v) }; saveLibrary(); }
  },
  removeHistory(id) { library.history = library.history.filter((x) => x.id !== id); saveLibrary(); },
  clearHistory() { library.history = []; library.progress = {}; saveLibrary(); },
  progress: (id) => library.progress[id] || 0,
  setProgress(id, s) {
    if (s == null) delete library.progress[id]; else library.progress[id] = Math.round(s);
    saveLibrary();
  },
  progressFraction(v) {
    const p = library.progress[v.id];
    const total = durationSeconds(v);
    if (!p || p < 5 || !total) return null;
    return Math.min(1, p / total);
  },
  addWatch(seconds, channel) {
    const key = dayKey(new Date());
    library.watchSeconds[key] = (library.watchSeconds[key] || 0) + seconds;
    if (channel) library.channelSeconds[channel] = (library.channelSeconds[channel] || 0) + seconds;
    saveLibrary();
  },
  lastSevenDays() {
    const out = [];
    for (let back = 6; back >= 0; back--) {
      const d = new Date();
      d.setDate(d.getDate() - back);
      out.push({ label: d.toLocaleDateString(undefined, { weekday: 'narrow' }), full: d.toLocaleDateString(undefined, { weekday: 'long' }), seconds: library.watchSeconds[dayKey(d)] || 0, today: back === 0 });
    }
    return out;
  },
  topChannels(n = 5) {
    return Object.entries(library.channelSeconds).sort((a, b) => b[1] - a[1]).slice(0, n);
  },
  isLiked: (id) => library.liked.some((v) => v.id === id),
  isDisliked: (id) => library.disliked.includes(id),
  toggleLike(v) {
    const i = library.liked.findIndex((x) => x.id === v.id);
    if (i >= 0) library.liked.splice(i, 1);
    else { library.liked.unshift(slim(v)); library.disliked = library.disliked.filter((x) => x !== v.id); }
    saveLibrary();
  },
  toggleDislike(v) {
    const i = library.disliked.indexOf(v.id);
    if (i >= 0) library.disliked.splice(i, 1);
    else { library.disliked.push(v.id); library.liked = library.liked.filter((x) => x.id !== v.id); }
    saveLibrary();
  },
  inWatchLater: (id) => library.watchLater.some((v) => v.id === id),
  toggleWatchLater(v) {
    const i = library.watchLater.findIndex((x) => x.id === v.id);
    if (i >= 0) library.watchLater.splice(i, 1); else library.watchLater.unshift(slim(v));
    saveLibrary();
    return i < 0;
  },
  removeWatchLater(id) { library.watchLater = library.watchLater.filter((v) => v.id !== id); saveLibrary(); },
  removeLiked(id) { library.liked = library.liked.filter((v) => v.id !== id); saveLibrary(); },
  createPlaylist(name, v) {
    const p = { id: crypto.randomUUID(), name, videos: v ? [slim(v)] : [] };
    library.playlists.unshift(p);
    saveLibrary();
    return p;
  },
  inPlaylist: (pid, vid) => !!library.playlists.find((p) => p.id === pid)?.videos.some((v) => v.id === vid),
  togglePlaylist(pid, v) {
    const p = library.playlists.find((x) => x.id === pid);
    if (!p) return;
    const i = p.videos.findIndex((x) => x.id === v.id);
    if (i >= 0) p.videos.splice(i, 1); else p.videos.push(slim(v));
    saveLibrary();
  },
  renamePlaylist(pid, name) {
    const p = library.playlists.find((x) => x.id === pid);
    if (p) { p.name = name; saveLibrary(); }
  },
  deletePlaylist(pid) { library.playlists = library.playlists.filter((p) => p.id !== pid); saveLibrary(); },
  removeFromPlaylist(pid, vid) {
    const p = library.playlists.find((x) => x.id === pid);
    if (p) { p.videos = p.videos.filter((v) => v.id !== vid); saveLibrary(); }
  },
  addSearch(q) {
    q = q.trim();
    if (!q) return;
    library.recentSearches = library.recentSearches.filter((x) => x.toLowerCase() !== q.toLowerCase());
    library.recentSearches.unshift(q);
    if (library.recentSearches.length > 20) library.recentSearches.length = 20;
    saveLibrary();
  },
  removeSearch(q) { library.recentSearches = library.recentSearches.filter((x) => x !== q); saveLibrary(); },
  exportData: () => ({ app: 'Premium', version: 1, library: { ...library }, settings: { ...settings } }),
  importData(data) {
    const src = data?.library || data;
    if (!src || typeof src !== 'object' || !Array.isArray(src.history || [])) return false;
    Object.assign(library, libraryDefaults(), src);
    saveLibrary();
    if (data.settings) { Object.assign(settings, settingsDefaults(), data.settings); saveSettings(); emit('settings', 'theme'); }
    return true;
  }
};

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
