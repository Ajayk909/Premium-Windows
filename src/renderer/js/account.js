// Google account in the app: sign in, import from YouTube, stay in sync, sign out.
// The OAuth work happens in the main process (src/main/google.js); this keeps the UI in step.
import { api, toast } from './ui.js';
import { lib, settings, set, emit, on } from './state.js';

export const account = { signedIn: false, profile: null, busy: false, status: null };

function changed() { emit('account'); }
export const onAccount = (fn) => on('account', fn);

window.premium.on('google:progress', (text) => {
  account.status = text;
  changed();
});

export async function load() {
  try {
    const s = await api.call('google:status');
    account.signedIn = !!s.signedIn;
    account.profile = s.profile || null;
  } catch {}
  changed();
}

export async function signIn() {
  if (account.busy) return;
  account.busy = true;
  account.status = 'Opening Google in your browser…';
  changed();
  try {
    account.profile = await api.call('google:signIn');
    account.signedIn = true;
    toast(`Signed in as ${account.profile?.name || 'you'}`);
    account.busy = false;
    await importAll();
  } catch (e) {
    account.status = String(e.message || e);
  } finally {
    account.busy = false;
    changed();
  }
}

export function cancel() {
  api.call('google:cancel').catch(() => {});
}

export async function signOut() {
  await api.call('google:signOut').catch(() => {});
  account.signedIn = false;
  account.profile = null;
  account.status = null;
  changed();
  toast('Signed out of Google');
}

/** Brings subscriptions, playlists and liked videos over from YouTube (merges, never deletes). */
export async function importAll(quiet = false) {
  if (!account.signedIn || account.busy) return;
  account.busy = true;
  changed();
  try {
    const data = await api.call('google:import');
    const newSubs = lib.addSubscriptions(data.channels);
    let videoCount = 0;
    for (const p of data.playlists) { lib.upsertPlaylist(p.name, p.sourceID, p.videos); videoCount += p.videos.length; }
    const newLiked = lib.mergeLiked(data.liked);
    set('lastSync', Date.now());
    const summary = `Imported ${data.channels.length} subscriptions (${newSubs} new), ${data.playlists.length} playlists (${videoCount} videos) and ${newLiked} new liked videos.`;
    account.status = quiet ? null : summary;
    if (!quiet) toast('Imported from YouTube');
    else if (newSubs > 0) toast(`${newSubs} new subscriptions from YouTube`);
  } catch (e) {
    account.status = `Import stopped: ${e.message || e}`;
    if (/sign in again/i.test(account.status)) { account.signedIn = false; account.profile = null; }
  } finally {
    account.busy = false;
    changed();
  }
}

/** At launch: keep the profile fresh and, once a day, pick up new subscriptions. */
export async function refreshOnLaunch() {
  await load();
  if (!account.signedIn) return;
  api.call('google:profile').then((p) => { if (p) { account.profile = p; changed(); } }).catch(() => {});
  if (!settings.syncOnLaunch) return;
  if (settings.lastSync && Date.now() - settings.lastSync < 20 * 3600 * 1000) return;
  importAll(true);
}
