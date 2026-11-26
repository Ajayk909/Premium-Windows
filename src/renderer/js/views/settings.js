// Settings: themes, playback, feed rules, SponsorBlock, library backup, keyboard shortcuts.
import { h, ic, api, toast, toggle, avatar, dialog } from '../ui.js';
import { settings, set, library, lib } from '../state.js';
import { importTakeout } from './subs.js';
import { castDialog } from './cast.js';
import { account, onAccount, signIn, signOut, importAll, cancel } from '../account.js';

const THEMES = [
  { id: 'pearl', name: 'Pearl Glass', sub: 'Default' },
  { id: 'classic', name: 'Classic', sub: 'Clean white' },
  { id: 'daylight', name: 'Daylight', sub: 'Red & white' },
  { id: 'midnight', name: 'Midnight Glass', sub: 'Dark' }
];

const SPONSOR = [
  ['sponsor', 'Sponsors'], ['selfpromo', 'Self-promotion'], ['interaction', 'Like & subscribe reminders'],
  ['intro', 'Intros'], ['outro', 'Outros / end cards'], ['preview', 'Previews & recaps'], ['filler', 'Tangents & filler'], ['music_offtopic', 'Non-music parts in music videos']
];

const QUALITIES = [[0, 'Auto'], [4320, '8K'], [2160, '4K'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p'], [360, '360p']];

export function settingsView(_params, ctx) {
  const el = h('div.page.settings-page');

  function row(title, sub, control) {
    return h('div.set-row', h('div.set-text', h('div.set-title', title), sub ? h('div.set-sub', sub) : null), control);
  }
  function sw(key, after) {
    return toggle(settings[key], (v) => { set(key, v); after?.(v); });
  }
  function select(key, options, after) {
    const s = h('select.select');
    for (const [v, label] of options) s.append(h('option', { value: String(v), selected: String(settings[key]) === String(v) }, label));
    s.addEventListener('change', () => { const raw = s.value; const v = isNaN(+raw) ? raw : +raw; set(key, v); after?.(v); });
    return s;
  }
  function group(title, iconName, ...rows) {
    return h('section.set-group.glass', h('h2.set-group-title', ic(iconName, 20), title), ...rows);
  }

  function render() {
    el.innerHTML = '';
    const themes = h('div.theme-grid');
    for (const t of THEMES) {
      const b = h('button.theme-card' + (settings.theme === t.id ? '.on' : ''), { dataset: { preview: t.id } },
        h('div.theme-preview', h('div.tp-bar'), h('div.tp-side'), h('div.tp-cards', h('i'), h('i'), h('i'), h('i')), h('div.tp-pill')),
        h('div.theme-name', t.name), h('div.theme-sub', t.sub));
      b.addEventListener('click', () => { set('theme', t.id); ctx.applyTheme(); render(); });
      themes.append(b);
    }

    const words = h('div.word-chips');
    const drawWords = () => {
      words.innerHTML = '';
      for (const w of settings.blockedWords) words.append(h('span.word-chip', w, h('button', { title: 'Remove', onclick: () => { set('blockedWords', settings.blockedWords.filter((x) => x !== w)); drawWords(); } }, ic('close', 12))));
    };
    drawWords();
    const wordInput = h('input.text-field.small', { placeholder: 'Add a word and press Enter' });
    wordInput.addEventListener('keydown', (e) => {
      const v = wordInput.value.trim();
      if (e.key === 'Enter' && v) { if (!settings.blockedWords.includes(v)) set('blockedWords', [...settings.blockedWords, v]); wordInput.value = ''; drawWords(); }
    });

    const blocked = h('div.blocked-list');
    for (const c of settings.blockedChannels) {
      blocked.append(h('div.manage-row', avatar(null, c.name, 30), h('span', c.name),
        h('button.btn.ghost.small', { onclick: () => { set('blockedChannels', settings.blockedChannels.filter((x) => x.id !== c.id)); render(); } }, 'Unblock')));
    }

    el.append(
      h('div.page-head', h('h1', 'Settings')),
      h('div.set-cols',
        h('div.set-col',
          accountCard(),
          group('Appearance', 'palette',
            themes,
            row('Evening mode', 'Pearl Glass turns smoky after 8 pm', sw('eveningMode', () => ctx.applyTheme())),
            row('Ambient mode', 'A soft glow from the video behind the player', sw('ambient')),
            row('Hover previews', 'Rest the mouse on a thumbnail to preview it', sw('hoverPreviews')),
            row('Show dislike counts', 'From Return YouTube Dislike', sw('showDislikes'))),
          group('Playback', 'play',
            row('Default quality', 'Auto picks the best for your connection and window size', select('quality', QUALITIES)),
            row('Data saver', 'Keeps videos at 480p or lower', sw('dataSaver')),
            row('Default speed', null, select('speed', [[0.75, '0.75×'], [1, 'Normal'], [1.25, '1.25×'], [1.5, '1.5×'], [1.75, '1.75×'], [2, '2×']])),
            row('Autoplay next video', null, sw('autoplay')),
            row('Captions on by default', null, sw('captions'))),
          group('SponsorBlock', 'shield',
            h('p.set-note', 'Skips these parts automatically, using the community SponsorBlock database.'),
            ...SPONSOR.map(([id, label]) => row(label, null, toggle(settings.sponsorCategories.includes(id), (on) => {
              set('sponsorCategories', on ? [...new Set([...settings.sponsorCategories, id])] : settings.sponsorCategories.filter((x) => x !== id));
            }))))),
        h('div.set-col',
          group('Feed', 'filter',
            row('Hide Shorts on Home', null, sw('hideShortsOnHome')),
            row('Hide long videos', 'Hide videos longer than this', select('maxLengthMinutes', [[0, 'Off'], [10, '10 min'], [20, '20 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours']])),
            h('div.set-block', h('div.set-title', 'Muted keywords'), h('div.set-sub', 'Videos with these words in the title are hidden.'), words, wordInput),
            h('div.set-block', h('div.set-title', 'Blocked channels'), settings.blockedChannels.length ? blocked : h('div.set-sub', 'Use “Don’t recommend channel” on any video to block it.'))),
          group('Library', 'history',
            row('Back up library', 'Save history, playlists, subscriptions and settings to a file', h('button.btn.ghost.small', { onclick: async () => { if (await api.call('store:export', lib.exportData())) toast('Backup saved'); } }, ic('download', 16), 'Back up')),
            row('Restore from backup', 'Works with backups from the iPhone and Android apps too', h('button.btn.ghost.small', { onclick: async () => {
              const data = await api.call('store:import').catch(() => null);
              if (!data) return;
              if (lib.importData(data)) { toast('Library restored'); ctx.applyTheme(); render(); } else toast('That file isn\'t a Premium backup');
            } }, ic('upload', 16), 'Restore')),
            row('Import YouTube subscriptions', 'From Google Takeout → YouTube → subscriptions.csv', h('button.btn.ghost.small', { onclick: () => importTakeout() }, ic('upload', 16), 'Import')),
            row('Clear watch history', `${library.history.length} videos`, h('button.btn.ghost.small.danger', { onclick: () => { if (confirm('Clear all watch history?')) { lib.clearHistory(); toast('History cleared'); render(); } } }, ic('trash', 16), 'Clear'))),
          group('Cast', 'cast',
            row('Roku TV', settings.rokuIP ? `${settings.rokuName || 'Roku'} · ${settings.rokuIP}` : 'Not set up', h('button.btn.ghost.small', { onclick: () => castDialog(null) }, 'Set up'))),
          group('Keyboard shortcuts', 'keyboard',
            h('div.shortcuts', [
              ['K / Space', 'Play / pause'], ['J / L', 'Back / forward 10 s'], ['← / →', 'Back / forward 5 s'], ['↑ / ↓', 'Volume'],
              ['F', 'Full screen'], ['T', 'Theater mode'], ['I', 'Mini player'], ['M', 'Mute'], ['C', 'Captions'],
              ['Shift + N / P', 'Next / previous'], ['< / >', 'Speed'], ['0–9', 'Jump to 0–90%'], ['/ or Ctrl + K', 'Search'], ['Alt + ← / →', 'Back / forward'], ['Ctrl + V', 'Open a pasted YouTube link']
            ].map(([k, d]) => h('div.shortcut', h('kbd', k), h('span', d))))),
          h('div.about', h('div.brand-mark', ic('logo', 26)), h('div', h('b', 'Premium for Windows'), h('div.faded.version', ''), h('div.faded', 'Open source · no ads · everything stays on this PC.'))))));
    api.call('app:version').then((v) => { const n = el.querySelector('.version'); if (n) n.textContent = 'Version ' + v; }).catch(() => {});
  }

  function accountCard() {
    const g = h('section.set-group.glass.account-card');
    const draw = () => {
      g.innerHTML = '';
      g.append(h('h2.set-group-title', ic('you', 20), 'Google account'));
      if (account.signedIn) {
        const p = account.profile || {};
        g.append(
          h('div.account-row',
            avatar(p.avatar, p.name || 'You', 52, 'account-avatar'),
            h('div.account-text', h('div.account-name', p.name || 'Signed in'), h('div.set-sub', p.handle || 'Signed in with Google')),
            h('button.btn.ghost.small', { onclick: () => { if (confirm('Sign out of Google? Your imported subscriptions and playlists stay on this PC.')) signOut(); } }, 'Sign out')),
          row('Import from YouTube', 'Subscriptions, playlists and liked videos (adds new ones, never deletes)',
            h('button.btn.primary.small', { disabled: account.busy, onclick: () => importAll() }, ic('refresh', 16), account.busy ? 'Importing…' : 'Import now')),
          row('Stay in sync', 'Picks up new subscriptions once a day', toggle(settings.syncOnLaunch, (v) => set('syncOnLaunch', v))));
      } else {
        g.append(
          h('div.account-signin',
            h('div.account-g', googleMark()),
            h('div.account-text',
              h('div.account-name', 'Sign in to bring your subscriptions and playlists'),
              h('div.set-sub', 'Read-only access. Premium only reads your YouTube subscriptions, playlists and likes — it can\'t post or change anything.')),
            account.busy
              ? h('button.btn.ghost.small', { onclick: () => cancel() }, 'Cancel')
              : h('button.btn.google', { onclick: () => signIn() }, googleMark(18), 'Sign in with Google')));
      }
      if (account.status) g.append(h('div.account-status' + (account.busy ? '.busy' : ''), account.busy ? h('span.spinner.tiny') : null, account.status));
    };
    draw();
    const off = onAccount(() => { if (g.isConnected) draw(); else off(); });
    return g;
  }

  render();
  return { el, onShow: render };
}

function googleMark(size = 26) {
  const t = document.createElement('template');
  t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
  return t.content.firstElementChild;
}
export { googleMark };
