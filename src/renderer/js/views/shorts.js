// Shorts: a full-height vertical feed you scroll (or arrow) through. The active short plays in
// Premium's player (YouTube's own engine underneath) and loops, like the app.
import { h, ic, api, nav, toast, avatar, chips, emptyState, spinner, saveDialog } from '../ui.js';
import { library, lib, settings, set, allowed } from '../state.js';

import * as player from '../player.js';

const SEEDS = ['#shorts', 'funny #shorts', 'satisfying #shorts', 'gaming #shorts', 'music #shorts', 'tech #shorts', 'food #shorts', 'sports #shorts', 'science #shorts', 'travel #shorts'];

export function shortsView(params) {
  let mode = 'foryou';
  let items = [];
  let seeds = [...SEEDS].sort(() => Math.random() - 0.5);
  let continuation = null;
  let active = -1;
  let token = 0;
  let loadingMore = false;

  const feed = h('div.shorts-feed');
  const tabs = chips([{ value: 'foryou', label: 'For you' }, { value: 'subs', label: 'Subscriptions' }], mode, (m) => { mode = m; reset(); });
  const navUp = h('button.shorts-nav.glass', { title: 'Previous (↑)', onclick: () => step(-1) }, ic('up', 24));
  const navDown = h('button.shorts-nav.glass', { title: 'Next (↓)', onclick: () => step(1) }, ic('down', 24));
  const el = h('div.page.shorts-page', h('div.shorts-tabs', tabs), feed, h('div.shorts-navs', navUp, navDown));

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio > 0.6) activate(+e.target.dataset.index);
    }
  }, { root: feed, threshold: [0.6] });

  function slide(v, i) {
    const liked = lib.isLiked(v.id);
    const s = h('section.short-slide', { dataset: { index: i } },
      h('div.short-card',
        h('img.short-poster', { src: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/oar2.jpg`, alt: '', onerror: (e) => { e.target.src = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`; } }),
        h('div.short-slot'),
        h('div.short-overlay',
          h('div.short-meta',
            v.channel ? h('button.short-channel', { onclick: (e) => { e.stopPropagation(); if (v.channelId) nav.go('channel', { id: v.channelId, name: v.channel }); } }, avatar(v.channelAvatar, v.channel, 30), h('span', v.channel)) : null,
            h('div.short-caption', v.title),
            v.views ? h('div.short-views-line', v.views) : null)),
        h('div.short-progress', h('div')),
        h('div.short-paused', ic('play', 44))),
      h('div.short-actions',
        action(liked ? 'likeOn' : 'like', 'Like', (b) => { lib.toggleLike(v); b.innerHTML = ''; b.append(ic(lib.isLiked(v.id) ? 'likeOn' : 'like', 24)); }),
        action(lib.isDisliked(v.id) ? 'dislikeOn' : 'dislike', 'Dislike', (b) => { lib.toggleDislike(v); b.innerHTML = ''; b.append(ic(lib.isDisliked(v.id) ? 'dislikeOn' : 'dislike', 24)); }),
        action('share', 'Share', () => { api.call('app:copy', `https://youtube.com/shorts/${v.id}`); toast('Link copied'); }),
        action('save', 'Save', () => saveDialog(v)),
        action('external', 'Watch', () => nav.play({ ...v, isShort: false }))));
    s.querySelector('.short-card').addEventListener('click', () => toggle());
    return s;
  }

  function action(iconName, label, fn) {
    const b = h('button.short-action-btn.glass', { title: label }, ic(iconName, 24));
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
    return h('div.short-action', b, h('span', label));
  }

  function append(list) {
    const have = new Set(items.map((x) => x.id));
    for (const v of list) {
      if (have.has(v.id) || !allowed(v)) continue;
      have.add(v.id);
      const i = items.length;
      items.push(v);
      const s = slide(v, i);
      feed.append(s);
      io.observe(s);
    }
  }

  async function more() {
    if (loadingMore) return;
    loadingMore = true;
    const my = token;
    try {
      if (mode === 'subs') {
        if (items.length) return;
        const subs = library.subscriptions.slice(0, 40);
        if (!subs.length) { feed.append(emptyState('subs', 'No subscriptions yet', 'Subscribe to channels to see their Shorts here.')); return; }
        const list = await api.call('yt:latestMany', subs, 8);
        if (my !== token) return;
        const shorts = list.filter((v) => v.isShort);
        if (!shorts.length) feed.append(emptyState('shorts', 'No new Shorts', 'Your channels haven\'t posted Shorts lately.'));
        append(shorts);
        return;
      }
      let page;
      if (continuation) page = await api.call('yt:search', '', 'shorts', continuation);
      else page = await api.call('yt:search', seeds.shift() || '#shorts', 'shorts');
      if (my !== token) return;
      continuation = seeds.length && Math.random() < 0.5 ? null : page.continuation;
      append(page.items.map((v) => ({ ...v, isShort: true })));
    } catch (e) {
      if (!items.length) feed.append(emptyState('refresh', 'Couldn\'t load Shorts', 'Check your connection and try again.', { label: 'Try again', fn: reset }));
    } finally {
      loadingMore = false;
    }
  }

  function activate(i) {
    if (i === active || !items[i]) return;
    active = i;
    const v = items[i];
    const sEl = feed.children[i];
    feed.querySelectorAll('.short-slide.active').forEach((x) => x.classList.remove('active'));
    sEl.classList.add('active');
    sEl.classList.remove('paused');
    if (i >= items.length - 3) more();
    player.play({ ...v, isShort: true }, { short: true });
    player.mount(sEl.querySelector('.short-slot'), 'short');
    lend(sEl);
  }

  // The player floats above the page, so the active short's caption, progress bar and pause
  // icon ride along inside it; they go back to their card when another short takes over.
  let lent = null;
  function lend(sEl) {
    giveBack();
    const nodes = [...sEl.querySelectorAll('.short-overlay, .short-progress, .short-paused')];
    player.setOverlay(nodes);
    lent = { sEl, nodes, bar: sEl.querySelector('.short-progress div') };
  }
  function giveBack() {
    if (!lent) return;
    const card = lent.sEl.querySelector('.short-card');
    lent.nodes.forEach((n) => card.append(n));
    player.setOverlay(null);
    lent = null;
  }

  function step(d) {
    const n = Math.max(0, Math.min(items.length - 1, active + d));
    feed.children[n]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function toggle() {
    player.toggle();
    syncPaused();
  }

  function syncPaused() {
    feed.children[active]?.classList.toggle('paused', !player.isPlaying());
  }

  function reset() {
    token++;
    active = -1;
    items = [];
    continuation = null;
    seeds = [...SEEDS].sort(() => Math.random() - 0.5);
    giveBack();
    if (player.P.short) player.stop();
    feed.innerHTML = '';
    feed.append(spinner());
    more().then(() => feed.querySelector('.spinner-wrap')?.remove());
  }

  const offTime = player.P.on('time', (t) => {
    const d = player.duration();
    if (lent && d && player.P.short) lent.bar.style.transform = `scaleX(${t / d})`;
  });
  const offState = player.P.on('state', syncPaused);

  // Start with the shorts we were opened with, then keep going.
  if (params.list?.length) {
    const start = params.list.findIndex((v) => v.id === params.id);
    const ordered = start > 0 ? [...params.list.slice(start), ...params.list.slice(0, start)] : params.list;
    append(ordered.map((v) => ({ ...v, isShort: true })));
  } else {
    feed.append(spinner());
    more().then(() => feed.querySelector('.spinner-wrap')?.remove());
  }

  return {
    el,
    onShow() {
      if (active >= 0 && items[active]) {
        const a = active;
        active = -1;
        activate(a);
      } else requestAnimationFrame(() => { activate(Math.round(feed.scrollTop / (feed.clientHeight || 1))); });
    },
    onHide() {
      token++;
      giveBack();
      if (player.P.short) player.stop();
    },
    refresh: reset,
    key(e) {
      const k = e.key.toLowerCase();
      if (k === 'arrowdown' || k === 'j') { e.preventDefault(); step(1); }
      else if (k === 'arrowup') { e.preventDefault(); step(-1); }
      else if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
      else if (k === 'm') { e.preventDefault(); player.toggleMute(); }
      else if (k === 'arrowright' || k === 'l') { e.preventDefault(); player.seekBy(5); }
      else if (k === 'arrowleft') { e.preventDefault(); player.seekBy(-5); }
    },
    destroy() { giveBack(); io.disconnect(); offTime(); offState(); }
  };
}
