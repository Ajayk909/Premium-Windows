// Subscriptions: newest uploads from every channel you follow (kept on this PC).
import { h, ic, api, nav, toast, avatar, videoCard, shortTile, chips, loadingGrid, emptyState, dialog } from '../ui.js';
import { library, lib, allowed } from '../state.js';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'videos', label: 'Videos' },
  { value: 'shorts', label: 'Shorts' }
];

/** Reads a Google Takeout subscriptions.csv (Channel Id, Channel URL, Channel title). */
export function importTakeout() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: '.csv,text/csv' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return resolve(0);
      const text = await file.text();
      const found = [];
      for (const line of text.split(/\r?\n/).slice(1)) {
        const m = line.match(/^(UC[\w-]{22}),[^,]*,(.*)$/);
        if (m) found.push({ id: m[1], name: m[2].replace(/^"|"$/g, '').replace(/""/g, '"').trim() });
      }
      const added = lib.addSubscriptions(found);
      toast(added ? `Imported ${added} channels` : 'No new channels found in that file');
      resolve(added);
    });
    input.click();
  });
}

export function subsView() {
  let filter = 'all';
  let all = [];
  let token = 0;
  const strip = h('div.sub-strip');
  const grid = h('div.grid');
  const status = h('div.feed-status');
  const el = h('div.page.subs-page',
    h('div.page-head',
      h('h1', 'Subscriptions'),
      h('div.page-head-actions',
        h('button.btn.ghost', { onclick: manage }, ic('settings', 18), 'Manage'))),
    strip,
    chips(FILTERS, filter, (f) => { filter = f; render(); }),
    status, grid);

  function renderStrip() {
    strip.innerHTML = '';
    for (const c of library.subscriptions.slice(0, 60)) {
      const b = h('button.sub-bubble', { title: c.name }, avatar(c.avatar, c.name, 56), h('span', c.name));
      b.addEventListener('click', () => nav.go('channel', { id: c.id, name: c.name }));
      strip.append(b);
    }
  }

  async function load() {
    const my = ++token;
    renderStrip();
    grid.innerHTML = '';
    status.innerHTML = '';
    if (!library.subscriptions.length) {
      status.append(emptyState('subs', 'No subscriptions yet', 'Subscribe to channels from any video or channel page, or bring yours over from YouTube with a Google Takeout file (subscriptions.csv).',
        { label: 'Import from Google Takeout', fn: async () => { if (await importTakeout()) load(); } }));
      return;
    }
    status.append(loadingGrid(8));
    try {
      const list = await api.call('yt:latestMany', library.subscriptions, 8);
      if (my !== token) return;
      all = list;
      status.innerHTML = '';
      render();
    } catch {
      if (my !== token) return;
      status.innerHTML = '';
      status.append(emptyState('refresh', 'Couldn\'t load uploads', 'Check your connection and try again.', { label: 'Try again', fn: load }));
    }
  }

  function render() {
    grid.innerHTML = '';
    const now = Date.now();
    let list = all.filter(allowed);
    if (filter === 'today') list = list.filter((v) => now - v.publishedAt < 86400e3);
    if (filter === 'week') list = list.filter((v) => now - v.publishedAt < 7 * 86400e3);
    if (filter === 'videos') list = list.filter((v) => !v.isShort);
    if (filter === 'shorts') {
      const shorts = list.filter((v) => v.isShort);
      grid.classList.add('shorts-grid');
      for (const v of shorts) grid.append(shortTile(v, shorts));
    } else {
      grid.classList.remove('shorts-grid');
      for (const v of list.filter((x) => !x.isShort)) grid.append(videoCard(v));
    }
    if (!grid.children.length) grid.append(h('div.span-all', emptyState('subs', 'Nothing here', 'No uploads match this filter.')));
  }

  function manage() {
    const list = h('div.manage-list');
    const draw = () => {
      list.innerHTML = '';
      for (const c of library.subscriptions) {
        list.append(h('div.manage-row', avatar(c.avatar, c.name, 36), h('span', c.name),
          h('button.btn.ghost.small', { onclick: () => { lib.toggleSubscribe(c); draw(); } }, 'Unsubscribe')));
      }
      if (!library.subscriptions.length) list.append(h('p.faded', 'No subscriptions.'));
    };
    draw();
    dialog(`Subscriptions (${library.subscriptions.length})`, [
      h('button.btn.ghost.full', { onclick: async () => { if (await importTakeout()) draw(); } }, ic('upload', 18), 'Import from Google Takeout (subscriptions.csv)'),
      list
    ], { wide: true, onClose: load });
  }

  load();
  return { el, refresh: load };
}
