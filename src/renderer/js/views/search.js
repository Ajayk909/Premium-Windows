// Search: the pill in the title bar (suggestions + recent searches) and the results page.
import { h, ic, api, searchRow, chips, emptyState, infinite, avatar, spinner, handleLink, nav, toast } from '../ui.js';
import { library, lib, allowed } from '../state.js';

const FILTERS = [
  { value: 'none', label: 'All' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'short', label: 'Under 4 min' },
  { value: 'long', label: 'Over 20 min' },
  { value: 'live', label: 'Live' },
  { value: 'shorts', label: 'Shorts' }
];

let searchInput = null;

export function attachSearchBox(slot, ctx) {
  const input = h('input.search-input', { type: 'search', placeholder: 'Search Premium', spellcheck: false, autocomplete: 'off' });
  searchInput = input;
  const clear = h('button.icon-btn.small.search-clear', { title: 'Clear', onclick: () => { input.value = ''; input.focus(); renderList(); clear.classList.remove('show'); } }, ic('close', 16));
  const go = h('button.search-go', { title: 'Search' }, ic('search', 20));
  const list = h('div.suggest.glass-strong');
  const box = h('div.search-box', h('span.search-icon', ic('search', 18)), input, clear, go, list);
  slot.append(box);

  let items = [];
  let sel = -1;
  let timer;
  let reqId = 0;

  function submit(q) {
    q = (q ?? input.value).trim();
    if (!q) return;
    input.blur();
    close();
    if (/youtu\.?be|youtube\.com/.test(q)) { handleLink(q); return; }
    lib.addSearch(q);
    ctx.go('search', { q });
  }

  function open() { box.classList.add('open'); }
  function close() { box.classList.remove('open'); sel = -1; }

  function renderList(suggestions) {
    list.innerHTML = '';
    const q = input.value.trim();
    const recent = library.recentSearches.filter((r) => !q || r.toLowerCase().startsWith(q.toLowerCase())).slice(0, q ? 3 : 8);
    items = [
      ...recent.map((t) => ({ t, recent: true })),
      ...(suggestions || []).filter((s) => !recent.some((r) => r.toLowerCase() === s.toLowerCase())).map((t) => ({ t }))
    ].slice(0, 12);
    items.forEach((it, i) => {
      const row = h('div.suggest-row' + (i === sel ? '.sel' : ''),
        ic(it.recent ? 'history' : 'search', 17),
        h('span.suggest-text', highlight(it.t, q)),
        it.recent ? h('button.suggest-remove', { title: 'Remove', onmousedown: (e) => { e.preventDefault(); e.stopPropagation(); lib.removeSearch(it.t); renderList(suggestions); } }, 'Remove') : null);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); input.value = it.t; submit(it.t); });
      list.append(row);
    });
    box.classList.toggle('has-items', items.length > 0);
  }

  function highlight(text, q) {
    if (!q || !text.toLowerCase().startsWith(q.toLowerCase())) return text;
    const span = h('span');
    span.append(h('span.faded-q', text.slice(0, q.length)), h('b', text.slice(q.length)));
    return span;
  }

  input.addEventListener('focus', () => { open(); renderList(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('input', () => {
    clear.classList.toggle('show', !!input.value);
    sel = -1;
    open();
    renderList();
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return;
    const my = ++reqId;
    timer = setTimeout(async () => {
      const s = await api.call('yt:suggest', q).catch(() => []);
      if (my === reqId && document.activeElement === input) renderList(s);
    }, 140);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(sel >= 0 ? items[sel]?.t : undefined); }
    else if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); sel = (sel + 1) % items.length; input.value = items[sel].t; markSel(); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); sel = sel <= 0 ? items.length - 1 : sel - 1; input.value = items[sel].t; markSel(); }
    else if (e.key === 'Escape') { input.blur(); }
  });
  function markSel() { [...list.children].forEach((r, i) => r.classList.toggle('sel', i === sel)); }
  go.addEventListener('click', () => submit());
}

export function setSearchText(q) {
  if (searchInput && document.activeElement !== searchInput) {
    searchInput.value = q || '';
    searchInput.parentElement.querySelector('.search-clear')?.classList.toggle('show', !!q);
  }
}

export function searchView(params) {
  const q = params.q || '';
  let filter = params.filter || 'none';
  let continuation = null;
  let token = 0;
  const seen = new Set();

  const results = h('div.results');
  const tail = h('div.feed-tail');
  const el = h('div.page.search-page',
    chips(FILTERS, filter, (f) => { filter = f; load(); }),
    results, tail);

  async function load() {
    const my = ++token;
    seen.clear();
    results.innerHTML = '';
    tail.innerHTML = '';
    results.append(spinner());
    try {
      const page = await api.call('yt:search', q, filter);
      if (my !== token) return;
      results.innerHTML = '';
      for (const c of page.channels || []) results.append(channelResult(c));
      addItems(page.items);
      continuation = page.continuation;
      if (!results.children.length) results.append(emptyState('search', 'No results', `Nothing found for “${q}”. Try different words or another filter.`));
      else if (continuation) tail.append(infinite(more));
    } catch (e) {
      if (my !== token) return;
      results.innerHTML = '';
      results.append(emptyState('refresh', 'Search didn\'t work', String(e.message || e), { label: 'Try again', fn: load }));
    }
  }

  function addItems(items) {
    const shorts = [];
    for (const v of items) {
      if (seen.has(v.id) || !allowed(v)) continue;
      seen.add(v.id);
      if (v.isShort && filter !== 'shorts') { shorts.push(v); continue; }
      results.append(searchRow(filter === 'shorts' ? { ...v, isShort: true } : v));
    }
    if (shorts.length >= 2) {
      const row = h('div.shelf-row');
      shorts.forEach((v) => row.append(shortTileMini(v, shorts)));
      results.append(h('section.shelf.shorts-shelf.inline', h('div.shelf-head', h('span.shelf-icon', ic('shortsOn', 20)), h('h2', 'Shorts')), row));
    }
  }

  async function more() {
    if (!continuation) return false;
    const my = token;
    try {
      const page = await api.call('yt:search', q, filter, continuation);
      if (my !== token) return false;
      continuation = page.continuation;
      addItems(page.items);
      return !!continuation;
    } catch {
      return true;
    }
  }

  load();
  return {
    el,
    onShow() { setSearchText(q); },
    onHide() { setSearchText(''); },
    refresh: load
  };
}

function shortTileMini(v, list) {
  const t = h('article.short-tile', { tabIndex: 0 },
    h('div.short-thumb', h('img', { src: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/oar2.jpg`, alt: '', loading: 'lazy' }), h('div.short-shade')),
    h('div.short-title', v.title), v.views ? h('div.short-views', v.views) : null);
  t.addEventListener('click', () => nav.openShorts(list.map((x) => ({ ...x, isShort: true })), v.id));
  return t;
}

function channelResult(c) {
  const subscribed = lib.isSubscribed(c.id);
  const btn = h('button.subscribe' + (subscribed ? '.on' : ''), subscribed ? 'Subscribed' : 'Subscribe');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const now = lib.toggleSubscribe(c);
    btn.classList.toggle('on', now);
    btn.textContent = now ? 'Subscribed' : 'Subscribe';
    toast(now ? `Subscribed to ${c.name}` : `Unsubscribed from ${c.name}`);
  });
  const row = h('article.channel-result',
    h('div.channel-result-avatar', avatar(c.avatar, c.name, 120)),
    h('div.channel-result-text', h('h3', c.name), h('div.vcard-meta', [c.handle, c.subscribers].filter(Boolean).join(' · '))),
    btn);
  row.addEventListener('click', () => nav.go('channel', { id: c.id, name: c.name }));
  return row;
}
