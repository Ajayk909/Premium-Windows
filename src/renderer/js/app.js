// App shell: title bar, sidebar, router, mini player, keyboard shortcuts and theming.
import { h, ic, api, nav, toast, avatar, closeMenu, handleLink } from './ui.js';
import * as state from './state.js';
import { settings, library } from './state.js';
import * as player from './player.js';
import './preview.js';
import { homeView } from './views/home.js';
import { searchView, attachSearchBox } from './views/search.js';
import { watchView } from './views/watch.js';
import { shortsView } from './views/shorts.js';
import { subsView } from './views/subs.js';
import { youView, listView, playlistsView, playlistView, statsView, ytPlaylistView } from './views/you.js';
import { channelView } from './views/channel.js';
import { settingsView } from './views/settings.js';
import { castDialog } from './views/cast.js';
import { account, onAccount, refreshOnLaunch } from './account.js';

const VIEWS = {
  home: homeView,
  search: searchView,
  watch: watchView,
  shorts: shortsView,
  subscriptions: subsView,
  you: youView,
  list: listView,
  playlists: playlistsView,
  playlist: playlistView,
  ytplaylist: ytPlaylistView,
  stats: statsView,
  channel: channelView,
  settings: settingsView
};

const SIDEBAR_SECTION = { home: 'home', shorts: 'shorts', subscriptions: 'subscriptions', you: 'you', list: 'you', playlists: 'you', playlist: 'you', stats: 'you', settings: 'settings' };

// ---------- Shell ----------

const main = h('main');
main.id = 'main';
const content = h('div.content');
main.append(content);

const sidebar = h('nav.sidebar');
const searchSlot = h('div.search-slot');
const backBtn = h('button.icon-btn.nav-btn', { title: 'Back (Alt+←)', onclick: () => back() }, ic('back', 20));
const fwdBtn = h('button.icon-btn.nav-btn', { title: 'Forward (Alt+→)', onclick: () => forward() }, ic('forward', 20));

const titlebar = h('header.titlebar',
  h('div.tb-left',
    h('button.icon-btn', { title: 'Menu', onclick: () => toggleSidebar() }, ic('menu')),
    backBtn, fwdBtn,
    h('button.brand', { title: 'Home', onclick: () => go('home') }, h('span.brand-logo', ic('logo', 28)), h('span.brand-name', 'Premium'))
  ),
  h('div.tb-center', searchSlot),
  h('div.tb-right',
    h('button.icon-btn', { title: 'Cast to TV', onclick: () => castDialog(player.P.current) }, ic('cast')),
    h('button.icon-btn', { title: 'Switch theme', onclick: (e) => themeMenu(e.currentTarget) }, ic('palette')),
    h('button.tb-avatar', { title: 'You', onclick: () => go('you') }, avatar(null, settings.name || 'You', 32))
  ),
  h('div.tb-window-space')
);

const miniShell = h('div.mini.glass-strong');
const miniVideoSlot = h('div.mini-video');
const miniTitle = h('div.mini-title');
const miniChannel = h('div.mini-channel');
const miniPlay = h('button.icon-btn.mini-play', { title: 'Play/Pause', onclick: (e) => { e.stopPropagation(); player.toggle(); } }, ic('play', 20));
const miniProgress = h('div.mini-progress', h('div'));
miniShell.append(
  miniVideoSlot,
  h('div.mini-info', { onclick: () => openWatch() },
    h('div.mini-text', miniTitle, miniChannel),
    h('div.mini-actions',
      h('button.icon-btn', { title: 'Previous', onclick: (e) => { e.stopPropagation(); player.prev(); } }, ic('prev', 18)),
      miniPlay,
      h('button.icon-btn', { title: 'Next', onclick: (e) => { e.stopPropagation(); player.next(); } }, ic('next', 18)),
      h('button.icon-btn', { title: 'Open (i)', onclick: (e) => { e.stopPropagation(); openWatch(); } }, ic('fullscreen', 18)),
      h('button.icon-btn', { title: 'Close', onclick: (e) => { e.stopPropagation(); player.stop(); } }, ic('close', 18)))),
  miniProgress
);
miniVideoSlot.addEventListener('click', () => openWatch());

const backdrop = h('div.backdrop', h('div.blob.b1'), h('div.blob.b2'), h('div.blob.b3'), h('div.blob.b4'), h('div.leak'));

document.body.append(backdrop, titlebar, h('div.shell', sidebar, main), miniShell);

// ---------- Theming ----------

const THEMES = [
  { id: 'pearl', name: 'Pearl Glass', sub: 'Default' },
  { id: 'classic', name: 'Classic', sub: 'Clean white' },
  { id: 'daylight', name: 'Daylight', sub: 'Red & white' },
  { id: 'midnight', name: 'Midnight Glass', sub: 'Dark' }
];
export { THEMES };

export function applyTheme() {
  const name = state.themeName();
  const root = document.documentElement;
  root.dataset.theme = name;
  root.dataset.glass = name === 'classic' ? '0' : '1';
  root.classList.toggle('dark', name === 'midnight' || name === 'pearl-evening');
  requestAnimationFrame(() => {
    const cs = getComputedStyle(root);
    const ink = cs.getPropertyValue('--ink').trim() || '#1C1D24';
    api.call('win:titlebar', '#00000000', root.classList.contains('dark') ? '#FFFFFF' : ink).catch(() => {});
  });
  player.refreshAmbient();
}

function themeMenu(anchor) {
  import('./ui.js').then(({ menu }) => menu([
    { header: 'Theme' },
    ...THEMES.map((t) => ({ label: t.name, hint: t.sub, checked: settings.theme === t.id, action: () => { state.set('theme', t.id); applyTheme(); } })),
    '-',
    { icon: 'moon', label: 'Evening mode', hint: 'Pearl turns smoky after 8 pm', checked: settings.eveningMode, action: () => { state.set('eveningMode', !settings.eveningMode); applyTheme(); } }
  ], anchor));
}

setInterval(() => {
  if (document.documentElement.dataset.theme !== state.themeName()) applyTheme();
}, 60_000);

// ---------- Router ----------

const stack = [];
let index = -1;

function currentEntry() { return stack[index]; }

export function go(name, params = {}, opts = {}) {
  closeMenu();
  const cur = currentEntry();
  if (cur && cur.name === name && JSON.stringify(cur.params) === JSON.stringify(params) && !opts.force) {
    if (name !== 'watch') main.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  // Section roots (sidebar) reuse their cached page so the feed stays where you left it.
  const entry = { name, params, view: null, scroll: 0 };
  if (cur) leave(cur);
  if (opts.replace && index >= 0) {
    disposeEntry(stack[index]);
    stack[index] = entry;
  } else {
    for (const e of stack.splice(index + 1)) disposeEntry(e);
    stack.push(entry);
    index = stack.length - 1;
    // Keep the last 12 pages alive for instant Back.
    while (stack.length > 30) { disposeEntry(stack.shift()); index--; }
    stack.forEach((e, i) => { if (i < stack.length - 12 && e.view) { disposeEntry(e); e.view = null; } });
  }
  enter(entry, true);
}

function leave(entry) {
  entry.scroll = main.scrollTop;
  entry.view?.onHide?.();
  if (entry.view?.el?.parentElement) entry.view.el.remove();
}

function disposeEntry(e) {
  if (!e?.view) return;
  e.view.destroy?.();
  e.view.el?.remove();
}

function enter(entry, fresh) {
  const make = VIEWS[entry.name] || VIEWS.home;
  if (!entry.view) entry.view = make(entry.params, ctx);
  content.className = 'content page-' + entry.name;
  content.append(entry.view.el);
  entry.view.onShow?.();
  main.scrollTop = fresh ? 0 : entry.scroll;
  if (!fresh) requestAnimationFrame(() => { main.scrollTop = entry.scroll; });
  entry.view.el.classList.remove('page-enter');
  void entry.view.el.offsetWidth;
  entry.view.el.classList.add('page-enter');
  updateChrome();
}

export function back() {
  if (index <= 0) return;
  leave(stack[index]);
  index--;
  enter(stack[index], false);
}

export function forward() {
  if (index >= stack.length - 1) return;
  leave(stack[index]);
  index++;
  enter(stack[index], false);
}

function updateChrome() {
  const entry = currentEntry();
  backBtn.disabled = index <= 0;
  fwdBtn.disabled = index >= stack.length - 1;
  const section = SIDEBAR_SECTION[entry?.name];
  for (const b of sidebar.querySelectorAll('[data-route]')) {
    const r = b.dataset.route;
    const on = r === entry?.name ? (r !== 'list' || b.dataset.kind === entry.params.kind) : (b.closest('.main-nav') && r === section && !['settings'].includes(section) && entry?.name !== r && !sidebar.querySelector(`.side-group:not(.main-nav) [data-route="${entry?.name}"]`));
    b.classList.toggle('on', !!on);
  }
  document.body.classList.toggle('on-watch', entry?.name === 'watch');
  document.body.classList.toggle('on-shorts', entry?.name === 'shorts');
  syncPlayerPlacement();
}

const ctx = { go, back, applyTheme };

// ---------- Player placement ----------

function syncPlayerPlacement() {
  const onWatch = currentEntry()?.name === 'watch';
  if (!player.P.current) {
    miniShell.classList.remove('show');
    return;
  }
  if (onWatch) {
    miniShell.classList.remove('show');
  } else {
    if (player.el.parentElement !== miniVideoSlot) player.mount(miniVideoSlot, 'mini');
    miniShell.classList.add('show');
  }
  syncMini();
}

function syncMini() {
  const v = player.P.current;
  if (!v) return;
  miniTitle.textContent = v.title || '';
  miniChannel.textContent = v.channel || '';
  miniPlay.innerHTML = '';
  miniPlay.append(ic(player.isPlaying() ? 'pause' : 'play', 20));
}

function openWatch() {
  if (!player.P.current) return;
  const idx = stack.findIndex((e) => e.name === 'watch' && e.params.id === player.P.current.id);
  if (idx >= 0 && idx === index - 1) return back();
  go('watch', { id: player.P.current.id });
}

player.P.on('change', () => { syncPlayerPlacement(); });
player.P.on('details', syncMini);
player.P.on('state', syncMini);
player.P.on('time', (t) => {
  if (!miniShell.classList.contains('show')) return;
  const d = player.duration();
  miniProgress.firstChild.style.transform = `scaleX(${d ? t / d : 0})`;
});

// ---------- Navigation hooks used across the app ----------

nav.go = go;
nav.play = (v, opts = {}) => {
  player.play(v, opts);
  const cur = currentEntry();
  if (cur?.name === 'watch') {
    if (cur.params.id !== v.id) go('watch', { id: v.id }, { replace: true });
  } else go('watch', { id: v.id });
};
nav.openShorts = (list, id) => {
  if (player.isPlaying()) player.pause();
  go('shorts', { list, id });
};
nav.queueNext = (v) => player.queueNext(v);
nav.cast = (v) => castDialog(v);
nav.seek = (t) => { player.seekTo(t); };
nav.toMini = () => { if (currentEntry()?.name === 'watch') { if (index > 0) back(); else go('home'); } };
nav.current = () => player.P.current;

// When the player switches video by itself (autoplay, next), keep the watch page in step.
player.P.on('change', () => {
  const cur = currentEntry();
  const v = player.P.current;
  if (v && cur?.name === 'watch' && cur.params.id !== v.id) {
    cur.params = { id: v.id };
    cur.view?.update?.();
  }
});

// ---------- Sidebar ----------

function sideItem(route, label, iconName, params = {}) {
  const b = h('button.side-item', { title: label, dataset: { route, ...(params.kind ? { kind: params.kind } : {}) } },
    h('span.side-icon', ic(iconName, 22, 'off'), ic(iconName + 'On', 22, 'on-icon')),
    h('span.side-label', label));
  b.addEventListener('click', () => {
    const cur = currentEntry();
    if (cur?.name === route && route !== 'list') {
      cur.view?.refresh?.();
      main.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    go(route, params);
  });
  return b;
}

function libItem(route, label, iconName, params = {}) {
  const b = h('button.side-item.small', { title: label, dataset: { route, ...(params.kind ? { kind: params.kind } : {}) } }, h('span.side-icon', ic(iconName, 20)), h('span.side-label', label));
  b.addEventListener('click', () => go(route, params));
  return b;
}

function renderSidebar() {
  sidebar.innerHTML = '';
  const subs = library.subscriptions.slice(0, 40);
  sidebar.append(
    h('div.side-group.main-nav',
      sideItem('home', 'Home', 'home'),
      sideItem('shorts', 'Shorts', 'shorts'),
      sideItem('subscriptions', 'Subscriptions', 'subs'),
      sideItem('you', 'You', 'you')),
    h('div.side-sep'),
    h('div.side-group',
      h('div.side-heading', 'Library'),
      libItem('list', 'History', 'history', { kind: 'history' }),
      libItem('list', 'Watch later', 'clock', { kind: 'watchLater' }),
      libItem('list', 'Liked videos', 'like', { kind: 'liked' }),
      libItem('playlists', 'Playlists', 'playlist'),
      libItem('stats', 'Watch time', 'chart')),
    subs.length ? h('div.side-sep') : null,
    subs.length ? h('div.side-group.side-subs',
      h('div.side-heading', 'Subscriptions'),
      subs.map((c) => {
        const b = h('button.side-item.small.side-channel', { title: c.name }, avatar(c.avatar, c.name, 24), h('span.side-label', c.name));
        b.addEventListener('click', () => go('channel', { id: c.id, name: c.name }));
        return b;
      })) : null,
    h('div.side-sep'),
    h('div.side-group', libItem('settings', 'Settings', 'settings')),
    h('div.side-foot', 'Premium for Windows', h('br'), 'Open source · no ads')
  );
  updateChrome();
}

function toggleSidebar() {
  state.set('sidebarCollapsed', !settings.sidebarCollapsed);
  document.body.classList.toggle('side-collapsed', settings.sidebarCollapsed);
}

state.on('library', debounce(renderSidebar, 400));
state.on('settings', (key) => {
  if (['autoplay', 'captionSize', 'dataSaver', 'ambient'].includes(key)) player.refreshSettings();
  if (key === 'theme' || key === 'eveningMode') applyTheme();
});

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- Keyboard & mouse ----------

document.addEventListener('keydown', (e) => {
  const tag = e.target?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable;
  if (e.key === 'Escape') {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    closeMenu();
    if (typing) e.target.blur();
    return;
  }
  if (typing) return;
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); back(); return; }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); forward(); return; }
  if (e.key === '/' || (e.ctrlKey && e.key.toLowerCase() === 'k') || (e.ctrlKey && e.key.toLowerCase() === 'l')) {
    e.preventDefault();
    searchSlot.querySelector('input')?.focus();
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'v') return;

  const onShorts = currentEntry()?.name === 'shorts';
  if (onShorts) { currentEntry().view?.key?.(e); return; }

  if (!player.P.current) return;
  const onWatch = currentEntry()?.name === 'watch' || document.fullscreenElement;
  const k = e.key;
  const handled = () => e.preventDefault();
  switch (k.toLowerCase()) {
    case 'k': handled(); player.toggle(); break;
    case ' ':
      if (e.target?.tagName === 'BUTTON') return;
      handled(); player.toggle(); break;
    case 'j': handled(); player.seekBy(-10); break;
    case 'l': handled(); player.seekBy(10); break;
    case 'arrowleft': if (onWatch) { handled(); player.seekBy(-5); } break;
    case 'arrowright': if (onWatch) { handled(); player.seekBy(5); } break;
    case 'arrowup': if (onWatch) { handled(); player.volumeBy(0.05); } break;
    case 'arrowdown': if (onWatch) { handled(); player.volumeBy(-0.05); } break;
    case 'f': handled(); if (currentEntry()?.name !== 'watch' && !document.fullscreenElement) openWatch(); player.toggleFullscreen(); break;
    case 't': if (onWatch) { handled(); player.toggleTheater(); } break;
    case 'm': handled(); player.toggleMute(); break;
    case 'c': handled(); player.toggleCaptions(); break;
    case 'i': handled(); if (currentEntry()?.name === 'watch') nav.toMini(); else openWatch(); break;
    case 'n': if (e.shiftKey) { handled(); player.next(); } break;
    case 'p': if (e.shiftKey) { handled(); player.prev(); } break;
    case '<': case ',': if (e.shiftKey || k === '<') { handled(); player.speedBy(-1); } break;
    case '>': case '.': if (e.shiftKey || k === '>') { handled(); player.speedBy(1); } break;
    case 'home': if (onWatch) { handled(); player.seekTo(0); } break;
    case 'end': if (onWatch) { handled(); player.seekTo(player.duration() - 1); } break;
    default:
      if (/^[0-9]$/.test(k) && onWatch) { handled(); player.seekTo(player.duration() * (+k / 10)); }
  }
});

// Mouse back/forward buttons.
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); back(); }
  if (e.button === 4) { e.preventDefault(); forward(); }
});

// Paste a YouTube link anywhere to open it.
document.addEventListener('paste', (e) => {
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const text = e.clipboardData?.getData('text') || '';
  if (/youtu\.?be/.test(text)) { e.preventDefault(); handleLink(text.trim()); toast('Opening link…'); }
});

// Drag the window by the title bar's empty space; double-click to maximise is handled by Windows.
window.premium.on('window:fullscreen', (fs) => document.body.classList.toggle('win-fullscreen', fs));

// ---------- Account avatar ----------

function renderAvatar() {
  const b = titlebar.querySelector('.tb-avatar');
  b.innerHTML = '';
  const p = account.signedIn ? account.profile : null;
  b.append(avatar(p?.avatar || null, settings.name || p?.name || 'You', 32));
  b.title = p ? `${p.name} — You` : 'You';
}
onAccount(renderAvatar);
state.on('settings', (k) => { if (k === 'name') renderAvatar(); });

// ---------- Boot ----------

async function boot() {
  await state.load();
  document.body.classList.toggle('side-collapsed', !!settings.sidebarCollapsed);
  applyTheme();
  attachSearchBox(searchSlot, ctx);
  renderSidebar();
  go('home');
  document.body.classList.add('ready');
  refreshOnLaunch();
}

boot();

// Handy for debugging from DevTools (F12 in development).
window.__premium = { go, back, nav, player, state, account };
