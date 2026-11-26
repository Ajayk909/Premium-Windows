// Channel page: banner, avatar, subscribe, and Videos / Shorts / Live / About tabs.
import { h, ic, api, nav, toast, avatar, videoCard, shortTile, chips, loadingGrid, emptyState, infinite, linkify, menu } from '../ui.js';
import { lib, allowed, blockChannel } from '../state.js';

export function channelView(params) {
  let tab = 'videos';
  let data = null;
  let continuation = null;
  let token = 0;
  let items = [];

  const header = h('div.channel-header');
  const tabsSlot = h('div.channel-tabs');
  const grid = h('div.grid');
  const tail = h('div.feed-tail');
  const el = h('div.page.channel-page', header, tabsSlot, grid, tail);

  tabsSlot.append(chips([
    { value: 'videos', label: 'Videos' }, { value: 'shorts', label: 'Shorts' }, { value: 'live', label: 'Live' }, { value: 'about', label: 'About' }
  ], tab, (t) => { tab = t; load(); }));

  function renderHeader() {
    header.innerHTML = '';
    const c = data?.channel || { id: params.id, name: params.name || '' };
    const subscribed = lib.isSubscribed(c.id);
    const sub = h('button.subscribe.big' + (subscribed ? '.on' : ''), subscribed ? [ic('bell', 18), 'Subscribed'] : 'Subscribe');
    sub.addEventListener('click', () => {
      const now = lib.toggleSubscribe({ ...c, avatar: c.avatar });
      toast(now ? `Subscribed to ${c.name}` : `Unsubscribed from ${c.name}`);
      renderHeader();
    });
    header.append(
      data?.banner ? h('div.channel-banner', h('img', { src: data.banner.replace(/=w\d+.*$/, '=w2120-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj'), alt: '', onerror: (e) => { e.target.src = data.banner; } })) : null,
      h('div.channel-id',
        avatar(c.avatar, c.name, 120, 'channel-avatar'),
        h('div.channel-id-text',
          h('h1', c.name || ' '),
          h('div.faded', [data?.handle, c.subscribers, data?.videoCount].filter(Boolean).join(' · ')),
          data?.description ? h('button.channel-desc', { onclick: () => { tab = 'about'; tabsSlot.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x.textContent === 'About')); load(); } }, data.description.split('\n')[0].slice(0, 140), h('span', ' ›')) : null,
          h('div.channel-actions', sub,
            h('button.pill-btn.round', { title: 'More', onclick: (e) => menu([
              { icon: 'link', label: 'Copy channel link', action: () => { api.call('app:copy', `https://www.youtube.com/channel/${c.id}`); toast('Link copied'); } },
              { icon: 'external', label: 'Open on YouTube', action: () => api.call('app:open', `https://www.youtube.com/channel/${c.id}`) },
              { icon: 'block', label: 'Block this channel', danger: true, action: () => { blockChannel({ id: c.id, name: c.name }); toast(`You won't see ${c.name} anymore`); } }
            ], e.currentTarget) }, ic('moreH', 20))))));
  }

  function addItems(list) {
    const have = new Set(items.map((v) => v.id));
    const fresh = list.filter((v) => !have.has(v.id) && allowed(v));
    items.push(...fresh);
    for (const v of fresh) grid.append(tab === 'shorts' ? shortTile(v, items) : videoCard(v, { hideAvatar: true, hideChannel: true }));
  }

  async function load() {
    const my = ++token;
    items = [];
    grid.innerHTML = '';
    tail.innerHTML = '';
    grid.classList.toggle('shorts-grid', tab === 'shorts');
    if (tab === 'about') {
      if (!data) await fetchTab('videos', my);
      renderAbout();
      return;
    }
    tail.append(loadingGrid(8));
    await fetchTab(tab, my);
  }

  async function fetchTab(t, my) {
    try {
      const r = await api.call('yt:channel', params.id, t === 'about' ? 'videos' : t);
      if (my !== token) return;
      const first = !data;
      data = { ...r, channel: { ...r.channel, name: r.channel.name || params.name } };
      if (data.channel.id && data.channel.id !== params.id) params.id = data.channel.id;
      if (first || !header.children.length) renderHeader();
      lib.updateChannel(data.channel);
      tail.innerHTML = '';
      if (tab === 'about') return;
      continuation = r.videos.continuation;
      addItems(r.videos.items);
      if (!items.length) grid.append(h('div.span-all', emptyState(t === 'shorts' ? 'shorts' : t === 'live' ? 'live' : 'subs', 'Nothing here', 'This channel has no ' + (t === 'videos' ? 'videos' : t) + ' yet.')));
      else if (continuation) tail.append(infinite(more));
    } catch (e) {
      if (my !== token) return;
      tail.innerHTML = '';
      if (!data) renderHeader();
      grid.append(h('div.span-all', emptyState('refresh', 'Couldn\'t load this channel', String(e.message || e), { label: 'Try again', fn: load })));
    }
  }

  async function more() {
    if (!continuation) return false;
    const my = token;
    try {
      const r = await api.call('yt:channel', params.id, tab, continuation);
      if (my !== token) return false;
      continuation = r.videos.continuation;
      addItems(r.videos.items);
      return !!continuation;
    } catch {
      return true;
    }
  }

  function renderAbout() {
    grid.innerHTML = '';
    grid.append(h('div.span-all', h('div.about-card.glass',
      h('h2', 'About'),
      h('div.desc-text.open', linkify(data?.description || 'No description.')),
      h('div.about-stats', [data?.handle, data?.channel?.subscribers, data?.videoCount].filter(Boolean).map((s) => h('span.desc-tag', s))))));
  }

  renderHeader();
  load();
  return { el, refresh: load };
}
