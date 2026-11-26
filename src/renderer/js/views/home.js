// Home: greeting, chips, and a mixed feed from your subscriptions and what you watch.
import { h, ic, api, videoCard, shortTile, chips, loadingGrid, emptyState, infinite } from '../ui.js';
import { library, settings, allowed } from '../state.js';

const CHIPS = ['All', 'Music', 'Gaming', 'Podcasts', 'Live', 'News', 'Tech', 'Cooking', 'Sports', 'Comedy', 'Science', 'Recently uploaded'];
const STARTER = ['trending today', 'new music video', 'tech review', 'gaming highlights', 'podcast clips', 'travel vlog', 'cooking recipe', 'science explained', 'comedy sketch', 'documentary'];

function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function homeView() {
  let chip = 'All';
  let items = [];
  let continuation = null;
  let seeds = [];
  let shelfShown = false;
  let loadToken = 0;

  const greet = h('div.greeting');
  const grid = h('div.grid');
  const status = h('div.feed-status');
  const tail = h('div.feed-tail');
  const el = h('div.page.home', greet, chips(CHIPS, chip, (c) => { chip = c; refresh(); }), status, grid, tail);

  function renderGreeting() {
    const hr = new Date().getHours();
    const line1 = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    const line2 = hr >= 18 ? 'What\'s on tonight?' : 'What are we watching?';
    greet.innerHTML = '';
    greet.append(h('h1', h('span', line1 + (settings.name ? `, ${settings.name}` : '')), h('span.faded', line2)));
    const cont = library.history.find((v) => library.progress[v.id] > 30 && !v.isShort);
    if (cont) greet.append(continueCard(cont));
  }

  function keep(list) {
    const have = new Set(items.map((v) => v.id));
    return list.filter((v) => !have.has(v.id) && allowed(v) && !v.isShort && v.title);
  }

  function add(list) {
    const fresh = keep(list);
    for (const v of fresh) {
      items.push(v);
      grid.append(videoCard(v));
      if (!shelfShown && items.length === 8 && chip === 'All' && !settings.hideShortsOnHome) {
        shelfShown = true;
        grid.append(shortsShelf());
      }
    }
    return fresh.length;
  }

  async function refresh() {
    const my = ++loadToken;
    items = [];
    continuation = null;
    shelfShown = false;
    grid.innerHTML = '';
    tail.innerHTML = '';
    status.innerHTML = '';
    status.append(loadingGrid(12));
    renderGreeting();
    try {
      if (chip === 'All') await loadMixed(my);
      else {
        const q = chip === 'Live' ? 'live now' : chip === 'Recently uploaded' ? 'new today' : chip.toLowerCase();
        const page = await api.call('yt:search', q, chip === 'Live' ? 'live' : chip === 'Recently uploaded' ? 'today' : 'none');
        if (my !== loadToken) return;
        status.innerHTML = '';
        add(page.items);
        continuation = page.continuation;
      }
      if (!items.length) throw new Error('empty');
      tail.append(sentinel());
    } catch (e) {
      if (my !== loadToken) return;
      status.innerHTML = '';
      status.append(emptyState('refresh', 'Couldn\'t load your feed', 'Check your connection and try again.', { label: 'Try again', fn: refresh }));
    }
  }

  async function loadMixed(my) {
    const subs = shuffle(library.subscriptions).slice(0, 10);
    const pool = new Set();
    library.history.slice(0, 30).forEach((v) => v.channel && pool.add(v.channel));
    subs.forEach((c) => pool.add(c.name));
    let s = shuffle([...pool]);
    if (s.length < 4) s = s.concat(shuffle(STARTER));
    seeds = s;

    const fromSubsP = subs.length ? api.call('yt:latestMany', subs, 3).catch(() => []) : Promise.resolve([]);
    const first = seeds.shift();
    const pageA = await api.call('yt:search', first);
    const fromSubs = await fromSubsP;
    if (my !== loadToken) return;
    continuation = pageA.continuation;
    const mixed = shuffle(fromSubs.filter((v) => !v.isShort));
    const search = pageA.items.filter((v) => !v.isShort);
    const merged = [];
    while (mixed.length || search.length) {
      if (mixed.length) merged.push(mixed.shift());
      if (search.length) merged.push(search.shift());
      if (search.length) merged.push(search.shift());
    }
    status.innerHTML = '';
    add(merged);
  }

  async function loadMore() {
    const my = loadToken;
    try {
      let page;
      if (continuation) page = await api.call('yt:search', '', 'none', continuation);
      else if (chip === 'All' && seeds.length) page = await api.call('yt:search', seeds.shift());
      else return false;
      if (my !== loadToken) return;
      continuation = page.continuation;
      add(chip === 'All' && !continuation ? shuffle(page.items) : page.items);
      return true;
    } catch {
      return true;
    }
  }

  function sentinel() { return infinite(loadMore); }

  let shortsCache = null;
  function shortsShelf() {
    const row = h('div.shelf-row');
    const shelf = h('section.shelf.shorts-shelf',
      h('div.shelf-head', h('span.shelf-icon', ic('shortsOn', 20)), h('h2', 'Shorts')),
      row);
    const fill = (list) => {
      row.innerHTML = '';
      for (const v of list.slice(0, 12)) row.append(shortTile(v, list));
      if (!list.length) shelf.remove();
    };
    if (shortsCache) fill(shortsCache);
    else api.call('yt:search', '#shorts', 'shorts').then((p) => { shortsCache = p.items.filter(allowed); fill(shortsCache); }).catch(() => shelf.remove());
    return shelf;
  }

  refresh();

  return {
    el,
    refresh,
    onShow() { renderGreeting(); }
  };
}

function continueCard(v) {
  const p = library.progress[v.id] || 0;
  const total = v.duration ? v.duration.split(':').map(Number).reduce((a, b) => a * 60 + b, 0) : 0;
  const card = h('button.continue-card.glass',
    h('div.continue-thumb', h('img', { src: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, alt: '' }),
      total ? h('div.thumb-progress', h('div', { style: { width: Math.min(100, p / total * 100) + '%' } })) : null),
    h('div.continue-text',
      h('span.card-label', 'Continue watching'),
      h('span.continue-title', v.title),
      h('span.continue-meta', v.channel)),
    h('span.continue-play', ic('play', 18)));
  card.addEventListener('click', () => import('../ui.js').then(({ nav }) => nav.play(v)));
  return card;
}
