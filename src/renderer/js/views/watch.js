// Watch page: player, title, channel, actions, description with chapters, comments,
// and the Up next column (queue + related). Theater mode moves the player full-width.
import { h, ic, api, nav, toast, avatar, videoRow, menu, saveDialog, linkify, formatTime, spinner, infinite, emptyState, toggle } from '../ui.js';
import * as player from '../player.js';
import { lib, library, settings, set, allowed, blockChannel } from '../state.js';
import { castDialog } from './cast.js';

export function watchView(params) {
  const P = player.P;
  const frame = h('div.player-frame', player.ambient);
  const stage = h('div.watch-stage');
  const mainCol = h('div.watch-main');
  const side = h('aside.watch-side');
  const el = h('div.page.watch', stage, h('div.watch-cols', mainCol, side));

  const info = h('div.watch-info');
  const chaptersBox = h('div.chapters-box');
  const commentsBox = h('section.comments');
  mainCol.append(info, chaptersBox, commentsBox);

  let renderedFor = null;
  const unsubs = [];

  function place() {
    const theater = P.theater;
    el.classList.toggle('theater', theater);
    if (theater) { if (frame.parentElement !== stage) stage.append(frame); }
    else if (frame.parentElement !== mainCol) mainCol.prepend(frame);
    player.mount(frame, 'page');
  }

  function render() {
    const v = P.current;
    if (!v) return;
    renderedFor = v.id;
    params.id = v.id;
    renderInfo();
    renderSide();
    renderChapters();
    renderComments();
    document.title = (v.title ? v.title + ' — ' : '') + 'Premium';
  }

  // ---------- Info ----------

  function renderInfo() {
    const v = P.current;
    const d = P.details;
    info.innerHTML = '';
    info.append(h('h1.watch-title', d?.video?.title || v.title || ''));
    const ch = d?.channel || (v.channelId ? { id: v.channelId, name: v.channel, avatar: v.channelAvatar } : null);

    const subscribed = ch && lib.isSubscribed(ch.id);
    const subBtn = ch ? h('button.subscribe' + (subscribed ? '.on' : ''), subscribed ? [ic('bell', 18), 'Subscribed'] : 'Subscribe') : null;
    subBtn?.addEventListener('click', () => {
      const now = lib.toggleSubscribe(ch);
      toast(now ? `Subscribed to ${ch.name}` : `Unsubscribed from ${ch.name}`);
      renderInfo();
    });

    const liked = lib.isLiked(v.id), disliked = lib.isDisliked(v.id);
    const likeBtn = h('button.pill-btn.left' + (liked ? '.on' : ''), { title: 'I like this' }, ic(liked ? 'likeOn' : 'like', 20), h('span', d?.likes || 'Like'));
    const dislikeBtn = h('button.pill-btn.right' + (disliked ? '.on' : ''), { title: 'I dislike this' }, ic(disliked ? 'dislikeOn' : 'dislike', 20), h('span.dislike-count'));
    likeBtn.addEventListener('click', () => { lib.toggleLike(P.current); toast(lib.isLiked(v.id) ? 'Added to Liked videos' : 'Removed from Liked videos'); renderInfo(); });
    dislikeBtn.addEventListener('click', () => { lib.toggleDislike(P.current); renderInfo(); });
    if (settings.showDislikes) {
      api.call('yt:dislikes', v.id).then((r) => {
        if (r && P.current?.id === v.id) dislikeBtn.querySelector('.dislike-count').textContent = compact(r.dislikes);
      }).catch(() => {});
    }

    const wl = lib.inWatchLater(v.id);
    const actions = h('div.watch-actions',
      h('div.pill-group', likeBtn, h('span.pill-divider'), dislikeBtn),
      h('button.pill-btn', { onclick: (e) => shareMenu(e.currentTarget) }, ic('share', 20), h('span', 'Share')),
      h('button.pill-btn', { onclick: () => saveDialog(P.current) }, ic('save', 20), h('span', 'Save')),
      h('button.pill-btn' + (wl ? '.on' : ''), { title: 'Watch later', onclick: () => { toast(lib.toggleWatchLater(P.current) ? 'Saved to Watch later' : 'Removed from Watch later'); renderInfo(); } }, ic('clock', 20), h('span', wl ? 'Saved' : 'Later')),
      h('button.pill-btn', { title: 'Cast to TV', onclick: () => castDialog(P.current) }, ic('cast', 20), h('span', 'Cast')),
      h('button.pill-btn.round', { title: 'More', onclick: (e) => moreMenu(e.currentTarget) }, ic('moreH', 20))
    );

    const channelBlock = ch ? h('div.watch-channel',
      h('button.watch-channel-link', { onclick: () => nav.go('channel', { id: ch.id, name: ch.name }) },
        avatar(ch.avatar, ch.name, 42),
        h('div', h('div.watch-channel-name', ch.name), h('div.watch-channel-subs', ch.subscribers || ''))),
      subBtn) : h('div.watch-channel');

    info.append(h('div.watch-bar', channelBlock, actions));

    // Description card
    const desc = d?.description || '';
    const expanded = info.dataset.expanded === '1';
    const card = h('div.desc-card.glass' + (expanded ? '.expanded' : ''),
      h('div.desc-meta', h('b', expanded ? (d?.views || '') : (d?.video?.views || v.views || '')), h('b', expanded ? (d?.fullDate || d?.date || '') : (d?.date || v.published || '')),
        P.chapters.length ? h('span.desc-tag', ic('playlist', 14), `${P.chapters.length} chapters`) : null),
      h('div.desc-text', d ? linkify(desc || 'No description.') : h('span.faded', 'Loading…')),
      desc.length > 180 || desc.split('\n').length > 3 ? h('button.desc-toggle', expanded ? 'Show less' : '…more') : null);
    card.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      if (!expanded || e.target.closest('.desc-toggle')) {
        info.dataset.expanded = expanded ? '0' : '1';
        renderInfo();
      }
    });
    info.append(card);
  }

  function compact(n) {
    if (n == null) return '';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  function shareMenu(anchor) {
    const v = P.current;
    const t = Math.floor(player.time());
    menu([
      { icon: 'link', label: 'Copy link', action: () => { api.call('app:copy', `https://youtu.be/${v.id}`); toast('Link copied'); } },
      t > 5 ? { icon: 'clock', label: `Copy link at ${formatTime(t)}`, action: () => { api.call('app:copy', `https://youtu.be/${v.id}?t=${t}`); toast('Link copied'); } } : null,
      { icon: 'external', label: 'Open on YouTube', action: () => api.call('app:open', `https://www.youtube.com/watch?v=${v.id}${t > 5 ? '&t=' + t : ''}`) }
    ], anchor);
  }

  function moreMenu(anchor) {
    const v = P.current;
    menu([
      { icon: 'theater', label: P.theater ? 'Default view' : 'Theater mode', hint: 'T', action: () => player.toggleTheater() },
      { icon: 'pip', label: 'Picture in picture', action: () => player.togglePiP() },
      { icon: 'mini', label: 'Mini player', hint: 'I', action: () => nav.toMini() },
      '-',
      v.channel ? { icon: 'block', label: `Don't recommend ${v.channel}`, danger: true, action: () => { blockChannel({ id: v.channelId || v.channel, name: v.channel }); toast(`You won't see ${v.channel} anymore`); } } : null,
      { icon: 'trash', label: 'Remove from history', action: () => { lib.removeHistory(v.id); toast('Removed from history'); } }
    ], anchor);
  }

  // ---------- Chapters ----------

  function renderChapters() {
    chaptersBox.innerHTML = '';
    if (!P.chapters.length) return;
    const strip = h('div.chapter-strip');
    for (const c of P.chapters) {
      const b = h('button.chapter-card', { dataset: { start: c.start } },
        c.thumbnail ? h('img', { src: c.thumbnail, alt: '', loading: 'lazy' }) : h('div.chapter-noimg', ic('playlist', 20)),
        h('div.chapter-text', h('div.chapter-title', c.title), h('div.chapter-time', formatTime(c.start))));
      b.addEventListener('click', () => player.seekTo(c.start));
      strip.append(b);
    }
    chaptersBox.append(h('div.section-title', h('h2', 'Chapters')), strip);
    markChapter(player.time());
  }

  let lastChapter = -1;
  function markChapter(t) {
    if (!P.chapters.length) return;
    let idx = -1;
    P.chapters.forEach((c, i) => { if (c.start <= t) idx = i; });
    if (idx === lastChapter) return;
    lastChapter = idx;
    const cards = chaptersBox.querySelectorAll('.chapter-card');
    cards.forEach((c, i) => c.classList.toggle('on', i === idx));
    const on = cards[idx];
    if (on) on.parentElement.scrollTo({ left: on.offsetLeft - 40, behavior: 'smooth' });
  }

  nav.showChapters = () => chaptersBox.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // ---------- Side: queue + related ----------

  function renderSide() {
    side.innerHTML = '';
    const v = P.current;
    if (P.queue.length > 1) {
      const qList = h('div.queue-list');
      P.queue.forEach((q, i) => qList.append(videoRow(q, { index: i, active: q.id === v.id, onRemove: (x) => { P.queue = P.queue.filter((y) => y.id !== x.id); P.queueIndex = P.queue.findIndex((y) => y.id === P.current.id); renderSide(); } })));
      side.append(h('section.queue-panel.glass',
        h('div.queue-head', h('div', h('h3', P.queueTitle || 'Queue'), h('div.queue-sub', `${P.queueIndex + 1} / ${P.queue.length}`)),
          h('button.icon-btn.small', { title: 'Clear queue', onclick: () => { P.queue = []; P.queueIndex = -1; renderSide(); } }, ic('close', 16))),
        qList));
      requestAnimationFrame(() => qList.querySelector('.active')?.scrollIntoView({ block: 'nearest' }));
    }
    side.append(h('div.side-head', h('h3', 'Up next'), h('label.autoplay-switch', h('span', 'Autoplay'), toggle(settings.autoplay, (on) => set('autoplay', on)))));
    const d = P.details;
    if (!d) { side.append(spinner()); return; }
    const list = (d.related || []).filter(allowed);
    if (!list.length) { side.append(h('p.faded.pad', 'Nothing related found.')); return; }
    const box = h('div.related');
    for (const r of list) box.append(videoRow(r));
    side.append(box);
  }

  // ---------- Comments ----------

  let commentsToken = null;
  function renderComments() {
    commentsBox.innerHTML = '';
    const d = P.details;
    if (!d) return;
    if (!d.commentsToken) {
      commentsBox.append(h('div.section-title', h('h2', 'Comments')), h('p.faded', 'Comments are turned off or unavailable.'));
      return;
    }
    commentsToken = d.commentsToken;
    const list = h('div.comment-list');
    commentsBox.append(h('div.section-title', h('h2', `${d.commentCount ? d.commentCount + ' ' : ''}Comments`)), list);
    const forId = P.current.id;
    list.append(infinite(async () => {
      if (!commentsToken || P.current?.id !== forId) return false;
      try {
        const r = await api.call('yt:comments', commentsToken);
        if (P.current?.id !== forId) return false;
        commentsToken = r.next;
        const sentinel = list.querySelector('.sentinel');
        for (const c of r.items) list.insertBefore(comment(c), sentinel);
        if (!r.items.length && !list.querySelector('.comment')) list.insertBefore(h('p.faded', 'No comments yet.'), sentinel);
        return !!commentsToken;
      } catch {
        return false;
      }
    }));
  }

  function comment(c) {
    const text = h('div.comment-text', linkify(c.text));
    const el = h('div.comment',
      avatar(c.avatar, c.author, 38),
      h('div.comment-body',
        h('div.comment-head', h('b', c.author), h('span.faded', c.published)),
        text,
        h('div.comment-foot', ic('like', 15), h('span', c.likes || ''), c.replies ? h('span.comment-replies', ic('comment', 15), `${c.replies} ${c.replies === '1' ? 'reply' : 'replies'}`) : null)));
    requestAnimationFrame(() => {
      if (text.scrollHeight > text.clientHeight + 4) {
        const more = h('button.desc-toggle', 'Read more');
        more.addEventListener('click', () => { text.classList.toggle('open'); more.textContent = text.classList.contains('open') ? 'Show less' : 'Read more'; });
        text.after(more);
      }
    });
    return el;
  }

  // ---------- Wiring ----------

  unsubs.push(P.on('details', () => { if (P.current?.id === renderedFor) { renderInfo(); renderSide(); renderChapters(); renderComments(); } }));
  unsubs.push(P.on('change', () => { if (P.current && P.current.id !== renderedFor) render(); else if (P.current) renderSide(); }));
  unsubs.push(P.on('time', (t) => markChapter(t)));
  unsubs.push(P.on('theater', () => place()));
  unsubs.push(P.on('details-error', () => { if (!P.details) { side.innerHTML = ''; side.append(h('p.faded.pad', 'Couldn\'t load details.')); } }));

  return {
    el,
    onShow() {
      if (!P.current) player.play({ id: params.id, title: '' });
      else if (P.current.id !== params.id) params.id = P.current.id;
      place();
      if (renderedFor !== P.current?.id) render();
      else document.title = (P.current.title ? P.current.title + ' — ' : '') + 'Premium';
      player.refreshAmbient();
    },
    onHide() {
      document.title = 'Premium';
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    },
    update() { if (P.current && P.current.id !== renderedFor) render(); },
    destroy() { unsubs.forEach((u) => u()); }
  };
}
