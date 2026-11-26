// You: watch time, history, Watch later, liked videos, playlists, stats.
import { h, ic, api, nav, toast, avatar, videoCard, videoRow, emptyState, prompt, menu, formatDuration, thumb, spinner, infinite } from '../ui.js';
import { library, lib, settings } from '../state.js';
import { account, signIn } from '../account.js';

const LISTS = {
  history: { title: 'History', icon: 'history', get: () => library.history, remove: (id) => lib.removeHistory(id), empty: 'Videos you watch will show up here.' },
  watchLater: { title: 'Watch later', icon: 'clock', get: () => library.watchLater, remove: (id) => lib.removeWatchLater(id), empty: 'Save videos to watch later from any video\'s menu.' },
  liked: { title: 'Liked videos', icon: 'like', get: () => library.liked, remove: (id) => lib.removeLiked(id), empty: 'Videos you like will show up here.' }
};

export function youView() {
  const el = h('div.page.you-page');

  function render() {
    el.innerHTML = '';
    const p = account.signedIn ? account.profile : null;
    const name = settings.name || p?.name || 'You';
    el.append(
      h('div.you-header',
        avatar(p?.avatar || null, name, 88, 'you-avatar'),
        h('div',
          h('h1', name),
          h('div.faded', `${library.subscriptions.length} subscriptions · ${library.history.length} watched · ${library.playlists.length} playlists`),
          h('div.you-buttons',
            h('button.btn.ghost.small', { onclick: async () => { const n = await prompt('Your name', settings.name, 'Shown on Home and here'); if (n != null) { (await import('../state.js')).set('name', n); render(); } } }, 'Edit name'),
            !account.signedIn ? h('button.btn.ghost.small', { onclick: () => { signIn(); nav.go('settings'); } }, ic('you', 16), 'Sign in with Google') : null,
            h('button.btn.ghost.small', { onclick: () => nav.go('settings') }, ic('settings', 16), 'Settings')))),
      h('div.you-grid',
        weekCard(),
        h('div.you-tiles',
          tile('history', 'History', `${library.history.length} videos`, () => nav.go('list', { kind: 'history' })),
          tile('clock', 'Watch later', `${library.watchLater.length} videos`, () => nav.go('list', { kind: 'watchLater' })),
          tile('like', 'Liked videos', `${library.liked.length} videos`, () => nav.go('list', { kind: 'liked' })),
          tile('playlist', 'Playlists', `${library.playlists.length} playlists`, () => nav.go('playlists'))))
    );
    shelf('History', library.history.filter((v) => !v.isShort), () => nav.go('list', { kind: 'history' }));
    shelf('Watch later', library.watchLater, () => nav.go('list', { kind: 'watchLater' }));
    shelf('Liked videos', library.liked, () => nav.go('list', { kind: 'liked' }));
    if (library.playlists.length) {
      const row = h('div.shelf-row.wide');
      for (const p of library.playlists) row.append(playlistCard(p));
      el.append(h('section.shelf', h('div.shelf-head', h('h2', 'Playlists'), h('button.btn.ghost.small', { onclick: () => nav.go('playlists') }, 'View all')), row));
    }
  }

  function shelf(title, list, onAll) {
    if (!list.length) return;
    const row = h('div.shelf-row.wide');
    for (const v of list.slice(0, 12)) row.append(videoCard(v, { hideAvatar: true }));
    el.append(h('section.shelf', h('div.shelf-head', h('h2', title), h('button.btn.ghost.small', { onclick: onAll }, 'View all')), row));
  }

  render();
  return { el, onShow: render, refresh: render };
}

function tile(iconName, title, sub, fn) {
  return h('button.you-tile.glass', { onclick: fn }, h('span.you-tile-icon', ic(iconName, 22)), h('span.you-tile-title', title), h('span.you-tile-sub', sub));
}

export function weekCard(big = false) {
  const days = lib.lastSevenDays();
  const total = days.reduce((a, d) => a + d.seconds, 0);
  const active = days.filter((d) => d.seconds > 0).length || 1;
  const max = Math.max(...days.map((d) => d.seconds), 1);
  const card = h('div.week-card.glass' + (big ? '.big' : ''),
    h('div.week-head',
      h('div', h('span.card-label', 'Watch time this week'), h('div.week-total', formatDuration(total))),
      h('div.faded', `Daily avg ${formatDuration(total / active)}`)),
    h('div.week-bars', days.map((d) => h('div.week-bar' + (d.today ? '.today' : ''), { title: `${d.full}: ${formatDuration(d.seconds)}` },
      h('div.week-fill', { style: { height: Math.max(4, (d.seconds / max) * 100) + '%' } }),
      h('span', d.label)))));
  if (!big) card.addEventListener('click', () => nav.go('stats'));
  return card;
}

function playlistCard(p) {
  const first = p.videos[0];
  const c = h('article.playlist-card',
    h('div.playlist-thumb', first ? h('img', { src: thumb(first), alt: '' }) : h('div.playlist-empty', ic('playlist', 28)),
      h('div.playlist-count', ic('playlist', 16), String(p.videos.length))),
    h('div.vcard-text', h('h3.vcard-title', p.name), h('div.vcard-meta', `${p.videos.length} videos`)));
  c.addEventListener('click', () => nav.go('playlist', { id: p.id }));
  return c;
}

export function listView(params) {
  const def = LISTS[params.kind] || LISTS.history;
  const el = h('div.page.list-page');
  let filterText = '';

  function render() {
    el.innerHTML = '';
    const all = def.get();
    const list = filterText ? all.filter((v) => (v.title + ' ' + v.channel).toLowerCase().includes(filterText)) : all;
    const search = h('input.text-field.list-search', { type: 'search', placeholder: `Search ${def.title.toLowerCase()}`, value: filterText });
    search.addEventListener('input', () => { filterText = search.value.toLowerCase(); renderList(); });
    const body = h('div.list-body');
    el.append(h('div.list-layout',
      h('aside.list-hero.glass',
        all[0] ? h('div.list-hero-thumb', h('img', { src: thumb(all[0], true), alt: '', onerror: (e) => { e.target.src = thumb(all[0]); } })) : h('div.list-hero-thumb.empty', ic(def.icon, 40)),
        h('h1', def.title),
        h('div.faded', `${all.length} videos`),
        h('div.list-hero-actions',
          all.length ? h('button.btn.primary', { onclick: () => nav.play(all[0], { queue: all }) }, ic('play', 18), 'Play all') : null,
          all.length > 1 ? h('button.btn.ghost', { onclick: () => { const s = [...all].sort(() => Math.random() - 0.5); nav.play(s[0], { queue: s }); } }, ic('refresh', 18), 'Shuffle') : null,
          params.kind === 'history' && all.length ? h('button.btn.ghost', { onclick: () => { if (confirm('Clear all watch history?')) { lib.clearHistory(); render(); } } }, ic('trash', 18), 'Clear') : null)),
      h('div.list-main', all.length > 6 ? search : null, body)));
    function renderList() {
      body.innerHTML = '';
      const items = filterText ? all.filter((v) => (v.title + ' ' + v.channel).toLowerCase().includes(filterText)) : all;
      items.forEach((v, i) => body.append(videoRow(v, { index: i, queue: all, onRemove: (x, row) => { def.remove(x.id); row?.remove(); toast('Removed'); } })));
      if (!items.length) body.append(emptyState(def.icon, filterText ? 'No matches' : 'Nothing here yet', filterText ? '' : def.empty));
    }
    renderList();
    void list;
  }

  render();
  return { el, onShow: render };
}

export function playlistsView() {
  const el = h('div.page.playlists-page');
  function render() {
    el.innerHTML = '';
    const grid = h('div.grid');
    el.append(h('div.page-head', h('h1', 'Playlists'),
      h('button.btn.primary', { onclick: async () => { const n = await prompt('New playlist', '', 'Playlist name'); if (n) { lib.createPlaylist(n); render(); } } }, ic('save', 18), 'New playlist')), grid);
    for (const p of library.playlists) grid.append(playlistCard(p));
    if (!library.playlists.length) grid.append(h('div.span-all', emptyState('playlist', 'No playlists yet', 'Create one here, or use Save on any video.')));
  }
  render();
  return { el, onShow: render };
}

export function playlistView(params) {
  const el = h('div.page.list-page');
  function render() {
    el.innerHTML = '';
    const p = library.playlists.find((x) => x.id === params.id);
    if (!p) { el.append(emptyState('playlist', 'Playlist not found', 'It may have been deleted.')); return; }
    const body = h('div.list-body');
    p.videos.forEach((v, i) => body.append(videoRow(v, { index: i, queue: p.videos, onRemove: (x, row) => { lib.removeFromPlaylist(p.id, x.id); row?.remove(); } })));
    if (!p.videos.length) body.append(emptyState('playlist', 'This playlist is empty', 'Use Save on any video to add it here.'));
    el.append(h('div.list-layout',
      h('aside.list-hero.glass',
        p.videos[0] ? h('div.list-hero-thumb', h('img', { src: thumb(p.videos[0], true), alt: '', onerror: (e) => { e.target.src = thumb(p.videos[0]); } })) : h('div.list-hero-thumb.empty', ic('playlist', 40)),
        h('h1', p.name),
        h('div.faded', `${p.videos.length} videos`),
        h('div.list-hero-actions',
          p.videos.length ? h('button.btn.primary', { onclick: () => { nav.play(p.videos[0], { queue: p.videos }); } }, ic('play', 18), 'Play all') : null,
          p.videos.length > 1 ? h('button.btn.ghost', { onclick: () => { const s = [...p.videos].sort(() => Math.random() - 0.5); nav.play(s[0], { queue: s }); } }, ic('refresh', 18), 'Shuffle') : null,
          h('button.btn.ghost.round', { title: 'More', onclick: (e) => menu([
            { icon: 'settings', label: 'Rename', action: async () => { const n = await prompt('Rename playlist', p.name); if (n) { lib.renamePlaylist(p.id, n); render(); } } },
            { icon: 'trash', label: 'Delete playlist', danger: true, action: () => { if (confirm(`Delete “${p.name}”?`)) { lib.deletePlaylist(p.id); nav.go('playlists', {}, { replace: true }); } } }
          ], e.currentTarget) }, ic('moreH', 18)))),
      h('div.list-main', body)));
  }
  render();
  return { el, onShow: render };
}

/** A public YouTube playlist opened from a link. */
export function ytPlaylistView(params) {
  const el = h('div.page.list-page');
  const body = h('div.list-body');
  let items = [];
  let cont = null;
  el.append(spinner());
  api.call('yt:playlist', params.id).then((r) => {
    items = r.items;
    cont = r.continuation;
    el.innerHTML = '';
    el.append(h('div.list-layout',
      h('aside.list-hero.glass',
        items[0] ? h('div.list-hero-thumb', h('img', { src: thumb(items[0], true), alt: '', onerror: (e) => { e.target.src = thumb(items[0]); } })) : null,
        h('h1', r.title), h('div.faded', `${items.length}${cont ? '+' : ''} videos`),
        h('div.list-hero-actions',
          items.length ? h('button.btn.primary', { onclick: () => nav.play(items[0], { queue: items }) }, ic('play', 18), 'Play all') : null,
          h('button.btn.ghost', { onclick: () => { const p = lib.createPlaylist(r.title); items.forEach((v) => lib.togglePlaylist(p.id, v)); toast(`Saved “${r.title}” to your playlists`); } }, ic('save', 18), 'Save'))),
      h('div.list-main', body)));
    items.forEach((v, i) => body.append(videoRow(v, { index: i, queue: items })));
    if (cont) body.append(infinite(async () => {
      const m = await api.call('yt:playlist', params.id, cont).catch(() => null);
      if (!m) return false;
      cont = m.continuation;
      const s = body.querySelector('.sentinel');
      m.items.forEach((v) => { items.push(v); body.insertBefore(videoRow(v, { index: items.length - 1, queue: items }), s); });
      return !!cont;
    }));
  }).catch((e) => { el.innerHTML = ''; el.append(emptyState('playlist', 'Couldn\'t open playlist', String(e.message || e))); });
  return { el };
}

export function statsView() {
  const el = h('div.page.stats-page');
  function render() {
    el.innerHTML = '';
    const top = lib.topChannels(8);
    const max = top[0]?.[1] || 1;
    el.append(h('h1.page-title', 'Watch time'), weekCard(true));
    el.append(h('section.glass.top-channels',
      h('h2', 'Most watched channels'),
      top.length ? top.map(([name, secs], i) => h('div.top-row',
        h('span.top-rank', String(i + 1)),
        h('div.top-main', h('div.top-name', name), h('div.top-bar', h('div', { style: { width: (secs / max * 100) + '%' } }))),
        h('span.faded', formatDuration(secs)))) : h('p.faded', 'Watch a few videos and your top channels show up here.')));
  }
  render();
  return { el, onShow: render };
}
