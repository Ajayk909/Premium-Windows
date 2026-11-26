// Small building blocks shared by every screen: element builder, cards, rows, menus, toasts.
import { icon } from './icons.js';
import { lib, library, settings, blockChannel } from './state.js';

export const api = window.premium;

// Let every append() skip null/false children so conditional UI reads naturally.
const nativeAppend = Element.prototype.append;
Element.prototype.append = function (...nodes) {
  return nativeAppend.apply(this, nodes.filter((n) => n != null && n !== false));
};
const nativePrepend = Element.prototype.prepend;
Element.prototype.prepend = function (...nodes) {
  return nativePrepend.apply(this, nodes.filter((n) => n != null && n !== false));
};

/** h('div.card.big', {onclick}, child, 'text', [more]) */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function ic(name, size, cls) {
  const t = document.createElement('template');
  t.innerHTML = icon(name, size, cls);
  return t.content.firstElementChild;
}

export function iconButton(name, title, onclick, cls = '') {
  return h('button.icon-btn' + (cls ? '.' + cls : ''), { title, 'aria-label': title, onclick }, ic(name));
}

// ---------- Formatting ----------

export function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

export function formatDuration(seconds) {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export function thumb(v, big = false) {
  if (big || !v.thumbnail) return `https://i.ytimg.com/vi/${v.id}/${big ? 'maxresdefault' : 'hqdefault'}.jpg`;
  return v.thumbnail;
}

export function meta(v, withChannel = false) {
  return [withChannel ? v.channel : null, v.views, v.published].filter(Boolean).join(' · ');
}

export function initials(name) {
  return (name || '?').replace(/^@/, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

export function avatar(src, name, size = 36, cls = '') {
  const el = h('div.avatar' + (cls ? '.' + cls : ''), { style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.38) + 'px' } }, initials(name));
  if (src) {
    const img = h('img', { src, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
    img.onerror = () => img.remove();
    el.append(img);
  }
  return el;
}

/** Thumbnail <img> that falls back to the lower-res version, then to a soft placeholder. */
export function thumbImg(v, big = false) {
  const img = h('img', { src: thumb(v, big), alt: '', loading: 'lazy', decoding: 'async', draggable: false });
  img.onerror = () => {
    if (!img.dataset.fallback) { img.dataset.fallback = '1'; img.src = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`; }
    else img.style.opacity = 0;
  };
  img.onload = () => img.classList.add('loaded');
  return img;
}

// ---------- Navigation hooks (set by app.js to avoid import cycles) ----------

export const nav = {
  go: () => {},
  play: () => {},
  openShorts: () => {},
  current: () => null
};

// ---------- Video card (grid) ----------

export function videoCard(v, opts = {}) {
  const prog = lib.progressFraction(v);
  const thumbWrap = h('div.thumb',
    thumbImg(v),
    v.isLive ? h('span.badge.live', ic('live', 12), 'LIVE') : v.duration ? h('span.badge', v.duration) : null,
    prog ? h('div.thumb-progress', h('div', { style: { width: (prog * 100).toFixed(1) + '%' } })) : null
  );
  const card = h('article.vcard', { tabIndex: 0, dataset: { id: v.id } },
    thumbWrap,
    h('div.vcard-body',
      opts.hideAvatar ? null : h('button.vcard-avatar', {
        title: v.channel,
        onclick: (e) => { e.stopPropagation(); if (v.channelId) nav.go('channel', { id: v.channelId, name: v.channel }); }
      }, avatar(v.channelAvatar, v.channel, 36)),
      h('div.vcard-text',
        h('h3.vcard-title', { title: v.title }, v.title),
        opts.hideChannel ? null : h('button.vcard-channel', {
          onclick: (e) => { e.stopPropagation(); if (v.channelId) nav.go('channel', { id: v.channelId, name: v.channel }); }
        }, v.channel),
        h('div.vcard-meta', meta(v))
      ),
      h('button.vcard-more.icon-btn.small', { title: 'More', onclick: (e) => { e.stopPropagation(); videoMenu(v, e.currentTarget, opts); } }, ic('more', 18))
    )
  );
  const open = () => (v.isShort ? nav.openShorts([v], v.id) : nav.play(v, opts.queue ? { queue: opts.queue } : {}));
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); videoMenu(v, { x: e.clientX, y: e.clientY }, opts); });
  if (settings.hoverPreviews && !v.isLive && !v.isShort) attachPreview(card, thumbWrap, v);
  return card;
}

// ---------- Compact row (watch page sidebar, lists) ----------

export function videoRow(v, opts = {}) {
  const prog = lib.progressFraction(v);
  const row = h('article.vrow' + (opts.active ? '.active' : ''), { tabIndex: 0 },
    opts.index != null ? h('span.vrow-index', opts.active ? ic('play', 12) : String(opts.index + 1)) : null,
    h('div.thumb.small',
      thumbImg(v),
      v.isLive ? h('span.badge.live', 'LIVE') : v.duration ? h('span.badge', v.duration) : null,
      prog ? h('div.thumb-progress', h('div', { style: { width: (prog * 100).toFixed(1) + '%' } })) : null
    ),
    h('div.vrow-text',
      h('h4.vrow-title', { title: v.title }, v.title),
      h('div.vrow-meta', v.channel),
      h('div.vrow-meta', meta(v))
    ),
    opts.onRemove
      ? h('button.icon-btn.small.vrow-more', { title: 'Remove', onclick: (e) => { e.stopPropagation(); opts.onRemove(v, row); } }, ic('close', 16))
      : h('button.icon-btn.small.vrow-more', { title: 'More', onclick: (e) => { e.stopPropagation(); videoMenu(v, e.currentTarget, opts); } }, ic('more', 18))
  );
  const open = () => (opts.onOpen ? opts.onOpen(v) : v.isShort ? nav.openShorts([v], v.id) : nav.play(v, opts.queue ? { queue: opts.queue } : {}));
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); videoMenu(v, { x: e.clientX, y: e.clientY }, opts); });
  return row;
}

/** Wide search-result row: big thumbnail, title, meta, channel, snippet. */
export function searchRow(v) {
  const row = h('article.srow', { tabIndex: 0 },
    h('div.thumb', thumbImg(v), v.isLive ? h('span.badge.live', ic('live', 12), 'LIVE') : v.duration ? h('span.badge', v.duration) : null),
    h('div.srow-text',
      h('h3.srow-title', v.title),
      h('div.vcard-meta', meta(v)),
      h('button.srow-channel', { onclick: (e) => { e.stopPropagation(); if (v.channelId) nav.go('channel', { id: v.channelId, name: v.channel }); } },
        avatar(v.channelAvatar, v.channel, 24), h('span', v.channel)),
      v.description ? h('p.srow-desc', v.description) : null
    ),
    h('button.icon-btn.small.srow-more', { title: 'More', onclick: (e) => { e.stopPropagation(); videoMenu(v, e.currentTarget); } }, ic('more', 18))
  );
  const open = () => (v.isShort ? nav.openShorts([v], v.id) : nav.play(v));
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); videoMenu(v, { x: e.clientX, y: e.clientY }); });
  if (settings.hoverPreviews && !v.isLive && !v.isShort) attachPreview(row, row.querySelector('.thumb'), v);
  return row;
}

export function shortTile(v, list) {
  const t = h('article.short-tile', { tabIndex: 0 },
    h('div.short-thumb', thumbImg(v), h('div.short-shade')),
    h('div.short-title', v.title),
    v.views ? h('div.short-views', v.views) : null
  );
  t.addEventListener('click', () => nav.openShorts(list || [v], v.id));
  return t;
}

// ---------- Hover previews ----------

let previewTimer = null;
let previewActive = null;
export const previewHooks = { start: null, stop: null };

function attachPreview(card, wrap, v) {
  card.addEventListener('mouseenter', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (!previewHooks.start) return;
      previewActive = wrap;
      previewHooks.start(v, wrap);
    }, 900);
  });
  card.addEventListener('mouseleave', () => {
    clearTimeout(previewTimer);
    if (previewActive === wrap) { previewActive = null; previewHooks.stop?.(); }
  });
}

// ---------- Menus ----------

let openMenu = null;
export function closeMenu() {
  if (openMenu) { openMenu.classList.add('closing'); const m = openMenu; setTimeout(() => m.remove(), 140); openMenu = null; }
}

/** items: [{icon, label, action, checked, danger, sub}|'-'] ; anchor: element or {x,y} */
export function menu(items, anchor, opts = {}) {
  closeMenu();
  const m = h('div.menu.glass-strong' + (opts.cls ? '.' + opts.cls : ''), { role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('div.menu-sep')); continue; }
    if (it.header) { m.append(h('div.menu-header', it.header)); continue; }
    const b = h('button.menu-item' + (it.danger ? '.danger' : '') + (it.checked ? '.checked' : ''), { role: 'menuitem' },
      it.icon ? ic(it.icon, 18) : h('span.menu-spacer'),
      h('span.menu-label', it.label),
      it.hint ? h('span.menu-hint', it.hint) : null,
      it.checked ? ic('check', 16, 'menu-check') : null
    );
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!it.keepOpen) closeMenu();
      it.action?.(e);
    });
    m.append(b);
  }
  document.body.append(m);
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = opts.alignRight === false ? r.left : r.right - mw;
  if (!(anchor instanceof Element)) x = r.left;
  let y = opts.above ? r.top - mh - 8 : r.bottom + 6;
  x = Math.max(8, Math.min(x, innerWidth - mw - 8));
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  openMenu = m;
  setTimeout(() => {
    const off = (e) => { if (!m.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', off, true); } };
    document.addEventListener('mousedown', off, true);
  });
  return m;
}

export function videoMenu(v, anchor, opts = {}) {
  const wl = lib.inWatchLater(v.id);
  menu([
    { icon: 'playlist', label: 'Play next', action: () => nav.queueNext?.(v) },
    { icon: 'clock', label: wl ? 'Remove from Watch later' : 'Save to Watch later', action: () => toast(lib.toggleWatchLater(v) ? 'Saved to Watch later' : 'Removed from Watch later') },
    { icon: 'save', label: 'Save to playlist…', action: () => saveDialog(v) },
    { icon: 'link', label: 'Copy link', action: () => { api.call('app:copy', v.isShort ? `https://youtube.com/shorts/${v.id}` : `https://youtu.be/${v.id}`); toast('Link copied'); } },
    { icon: 'cast', label: 'Cast to TV', action: () => nav.cast?.(v) },
    '-',
    v.channelId ? { icon: 'you', label: 'Go to channel', action: () => nav.go('channel', { id: v.channelId, name: v.channel }) } : null,
    opts.onRemove ? { icon: 'trash', label: opts.removeLabel || 'Remove', action: () => opts.onRemove(v) } : null,
    v.channel ? { icon: 'block', label: `Don't recommend ${v.channel}`, danger: true, action: () => { blockChannel({ id: v.channelId || v.channel, name: v.channel }); toast(`You won't see ${v.channel} anymore`); } } : null
  ], anchor);
}

// ---------- Toast ----------

let toastTimer;
export function toast(text, opts = {}) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div'); t.id = 'toast'; document.body.append(t); }
  t.innerHTML = '';
  t.append(h('span', text));
  if (opts.action) t.append(h('button.toast-action', { onclick: () => { opts.action.fn(); t.classList.remove('show'); } }, opts.action.label));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), opts.ms || 2600);
}

// ---------- Dialog ----------

export function dialog(title, body, opts = {}) {
  const scrim = h('div.scrim');
  const box = h('div.dialog.glass-strong' + (opts.wide ? '.wide' : ''), { role: 'dialog' },
    h('div.dialog-head', h('h2', title), iconButton('close', 'Close', () => close())),
    h('div.dialog-body', body)
  );
  scrim.append(box);
  document.body.append(scrim);
  requestAnimationFrame(() => scrim.classList.add('show'));
  const keys = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', keys, true);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  function close() {
    document.removeEventListener('keydown', keys, true);
    scrim.classList.remove('show');
    setTimeout(() => scrim.remove(), 200);
    opts.onClose?.();
  }
  return { close, box };
}

export function prompt(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    const input = h('input.text-field', { value, placeholder });
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); resolve(v); };
    const d = dialog(title, [
      input,
      h('div.dialog-actions',
        h('button.btn.ghost', { onclick: () => finish(null) }, 'Cancel'),
        h('button.btn.primary', { onclick: () => finish(input.value.trim() || null) }, 'Save'))
    ], { onClose: () => { if (!done) { done = true; resolve(null); } } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim() || null); });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

export function saveDialog(v) {
  const list = h('div.save-list');
  const render = () => {
    list.innerHTML = '';
    const wl = lib.inWatchLater(v.id);
    list.append(checkRow('Watch later', wl, () => { lib.toggleWatchLater(v); render(); }, 'clock'));
    for (const p of library.playlists) {
      list.append(checkRow(p.name, lib.inPlaylist(p.id, v.id), () => { lib.togglePlaylist(p.id, v); render(); }, 'playlist', `${p.videos.length} videos`));
    }
  };
  render();
  dialog('Save to…', [
    list,
    h('button.btn.ghost.full', {
      onclick: async () => {
        const name = await prompt('New playlist', '', 'Playlist name');
        if (name) { lib.createPlaylist(name, v); toast(`Saved to ${name}`); render(); }
      }
    }, ic('save', 18), 'New playlist')
  ]);
}

function checkRow(label, on, fn, iconName, sub) {
  return h('button.check-row' + (on ? '.on' : ''), { onclick: fn },
    ic(iconName, 20),
    h('span.check-row-text', h('span', label), sub ? h('small', sub) : null),
    h('span.checkbox', on ? ic('check', 14) : null));
}

// ---------- States ----------

export function loadingGrid(n = 12) {
  return h('div.grid.skeleton', Array.from({ length: n }, () => h('div.vcard.sk', h('div.thumb.sk-block'), h('div.vcard-body', h('div.sk-circle'), h('div.vcard-text', h('div.sk-line'), h('div.sk-line.short'))))));
}

export function spinner() {
  return h('div.spinner-wrap', h('div.spinner'));
}

export function emptyState(iconName, title, message, action) {
  return h('div.empty',
    h('div.empty-icon', ic(iconName, 34)),
    h('h3', title),
    message ? h('p', message) : null,
    action ? h('button.btn.primary', { onclick: action.fn }, action.label) : null
  );
}

/** Calls load() when the sentinel scrolls near view. Returns the sentinel element. */
export function infinite(load) {
  const s = h('div.sentinel');
  let busy = false;
  const io = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting || busy) return;
    busy = true;
    try {
      const more = await load();
      if (more === false) { io.disconnect(); s.remove(); }
    } finally {
      busy = false;
    }
  }, { rootMargin: '1200px' });
  requestAnimationFrame(() => io.observe(s));
  return s;
}

export function chips(list, selected, onSelect) {
  const row = h('div.chips');
  for (const c of list) {
    const value = typeof c === 'string' ? c : c.value;
    const label = typeof c === 'string' ? c : c.label;
    const b = h('button.chip' + (value === selected ? '.on' : ''), label);
    b.addEventListener('click', () => {
      row.querySelectorAll('.chip.on').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onSelect(value);
    });
    row.append(b);
  }
  return row;
}

export function toggle(on, onChange) {
  const t = h('button.toggle' + (on ? '.on' : ''), { role: 'switch', 'aria-checked': String(!!on) }, h('span.knob'));
  t.addEventListener('click', (e) => {
    e.stopPropagation();
    const v = !t.classList.contains('on');
    t.classList.toggle('on', v);
    t.setAttribute('aria-checked', String(v));
    onChange(v);
  });
  return t;
}

export function sectionTitle(text, extra) {
  return h('div.section-title', h('h2', text), extra || null);
}

export function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /(https?:\/\/[^\s]+)|(\b\d{1,2}:\d{2}(?::\d{2})?\b)|(#[\w]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    frag.append(text.slice(last, m.index));
    if (m[1]) frag.append(h('a', { href: m[1], target: '_blank', onclick: (e) => { e.preventDefault(); handleLink(m[1]); } }, m[1].length > 60 ? m[1].slice(0, 57) + '…' : m[1]));
    else if (m[2]) {
      const secs = m[2].split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
      frag.append(h('a.ts', { href: '#', onclick: (e) => { e.preventDefault(); nav.seek?.(secs); } }, m[2]));
    } else if (m[3]) frag.append(h('a', { href: '#', onclick: (e) => { e.preventDefault(); nav.go('search', { q: m[3] }); } }, m[3]));
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

async function handleLink(url) {
  try {
    const r = await api.call('yt:resolve', url);
    if (r?.type === 'video') return r.short ? nav.openShorts([{ id: r.id, title: '', isShort: true }], r.id) : nav.play({ id: r.id, title: '' });
    if (r?.type === 'channel') return nav.go('channel', { id: r.id });
    if (r?.type === 'playlist') return nav.go('ytplaylist', { id: r.id });
  } catch {}
  api.call('app:open', url);
}
export { handleLink };
