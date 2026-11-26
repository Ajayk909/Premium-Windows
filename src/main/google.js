// Sign in with Google (read-only YouTube access), the same way the iPhone app does it:
// import your subscriptions, playlists and liked videos, and stay signed in.
//
// It uses the same Google Cloud client as the iPhone app. Sign-in happens in your normal
// browser (Google doesn't allow sign-in inside apps' own windows); when you approve, Google
// hands the browser back to Premium through its own link type, so the app catches the result.
// The refresh token is encrypted with Windows' own data protection (safeStorage).
import { app, shell, safeStorage, net } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CLIENT_ID = '62470698860-0bihfg57s15kr4tpcqcl2ch1eektusu3.apps.googleusercontent.com';
const SCHEME = CLIENT_ID.split('.').reverse().join('.');
const REDIRECT_URI = `${SCHEME}:/oauth2redirect`;
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const API = 'https://www.googleapis.com/youtube/v3/';

let tokenFile, profileFile;
let accessToken = null;
let tokenExpiry = 0;
let pending = null; // { state, verifier, resolve, reject, timer }
let notify = () => {};

export const scheme = SCHEME;

export function init(userData, onStatus) {
  tokenFile = path.join(userData, 'google-token.bin');
  profileFile = path.join(userData, 'google-profile.json');
  notify = onStatus || notify;
  // Let Windows open Premium for Google's redirect link.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(SCHEME);
  }
}

/** Called with any command line / URL Windows hands us; returns true if it was ours. */
export function handleUrl(url) {
  if (!url || !url.toLowerCase().startsWith(SCHEME.toLowerCase() + ':')) return false;
  if (!pending) return true;
  const u = new URL(url.replace(/^[^:]+:\/?/, 'https://callback/'));
  const p = pending;
  if (u.searchParams.get('state') !== p.state) return true;
  pending = null;
  clearTimeout(p.timer);
  const err = u.searchParams.get('error');
  const code = u.searchParams.get('code');
  if (err || !code) p.reject(new Error(err === 'access_denied' ? 'Sign-in was cancelled.' : `Google said: ${err || 'no code'}`));
  else p.resolve(code);
  return true;
}

export function findUrl(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.toLowerCase().startsWith(SCHEME.toLowerCase() + ':'));
}

// ---------- Sign in / out ----------

export async function signIn() {
  if (pending) { pending.reject(new Error('Sign-in restarted.')); pending = null; }
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [k, v] of Object.entries({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'select_account consent', state
  })) auth.searchParams.set(k, v);

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (pending?.state === state) { pending = null; reject(new Error('Sign-in timed out. Try again.')); } }, 5 * 60 * 1000);
    pending = { state, verifier, resolve, reject, timer };
    notify('Finish signing in in your browser…');
    shell.openExternal(auth.toString());
  });

  notify('Signing in…');
  const json = await tokenRequest({ code, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code', code_verifier: verifier });
  if (!json.access_token) throw new Error('Google didn\'t return a token.');
  accessToken = json.access_token;
  tokenExpiry = Date.now() + ((json.expires_in || 3600) - 120) * 1000;
  if (json.refresh_token) await saveRefresh(json.refresh_token);
  const profile = await loadProfile();
  notify(null);
  return profile;
}

export function cancel() {
  if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Sign-in was cancelled.')); pending = null; }
}

export async function signOut() {
  const t = accessToken || (await readRefresh());
  if (t) net.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => {});
  accessToken = null;
  tokenExpiry = 0;
  await fs.rm(tokenFile, { force: true }).catch(() => {});
  await fs.rm(profileFile, { force: true }).catch(() => {});
  return true;
}

export async function status() {
  const refresh = await readRefresh();
  if (!refresh) return { signedIn: false };
  const profile = await fs.readFile(profileFile, 'utf8').then(JSON.parse).catch(() => null);
  return { signedIn: true, profile };
}

export async function refreshProfile() {
  if (!(await readRefresh())) return null;
  return loadProfile();
}

async function loadProfile() {
  const json = await get('channels', { part: 'snippet', mine: 'true' });
  const sn = json.items?.[0]?.snippet || {};
  const profile = { name: sn.title || 'You', handle: sn.customUrl || null, avatar: bestThumb(sn.thumbnails) };
  await fs.writeFile(profileFile, JSON.stringify(profile));
  return profile;
}

// ---------- Import ----------

export async function importAll() {
  notify('Importing subscriptions…');
  const subs = await all('subscriptions', { part: 'snippet', mine: 'true', order: 'alphabetical' }, 20);
  const channels = subs.map((it) => {
    const sn = it.snippet || {};
    const id = sn.resourceId?.channelId;
    return id ? { id, name: (sn.title || '').replace(/ - Topic$/, ''), avatar: bestThumb(sn.thumbnails) } : null;
  }).filter(Boolean);

  notify('Importing playlists…');
  const lists = await all('playlists', { part: 'snippet,contentDetails', mine: 'true' }, 4);
  const playlists = [];
  for (const pl of lists) {
    const title = pl.snippet?.title || 'Playlist';
    notify(`Importing playlist “${title}”…`);
    const items = await all('playlistItems', { part: 'snippet,contentDetails', playlistId: pl.id }, 6);
    playlists.push({ sourceID: pl.id, name: title, videos: items.map(fromPlaylistItem).filter(Boolean) });
  }

  notify('Importing liked videos…');
  const likedRaw = await all('videos', { part: 'snippet,contentDetails', myRating: 'like' }, 4);
  const liked = likedRaw.map(fromVideo).filter(Boolean);
  notify(null);
  return { channels, playlists, liked };
}

// ---------- API plumbing ----------

async function freshToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  const refresh = await readRefresh();
  if (!refresh) throw new Error('Please sign in again.');
  const json = await tokenRequest({ client_id: CLIENT_ID, refresh_token: refresh, grant_type: 'refresh_token' });
  if (!json.access_token) throw new Error('Please sign in again.');
  accessToken = json.access_token;
  tokenExpiry = Date.now() + ((json.expires_in || 3600) - 120) * 1000;
  return accessToken;
}

async function tokenRequest(form) {
  const res = await net.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  });
  const json = await res.json().catch(() => ({}));
  if (json.error) {
    if (json.error === 'invalid_grant') await fs.rm(tokenFile, { force: true }).catch(() => {});
    throw new Error(json.error === 'invalid_grant' ? 'Your Google sign-in expired. Please sign in again.' : (json.error_description || json.error));
  }
  return json;
}

async function get(endpoint, params) {
  const token = await freshToken();
  const url = new URL(API + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await net.fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(`YouTube said: ${json.error.message || 'error'}`);
  return json;
}

async function all(endpoint, params, pages) {
  const out = [];
  let pageToken = null;
  for (let i = 0; i < pages; i++) {
    const json = await get(endpoint, { ...params, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    out.push(...(json.items || []));
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

async function saveRefresh(token) {
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from('plain:' + token);
  await fs.writeFile(tokenFile, data);
}

async function readRefresh() {
  try {
    const buf = await fs.readFile(tokenFile);
    if (buf.subarray(0, 6).toString() === 'plain:') return buf.subarray(6).toString();
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

// ---------- Parsing ----------

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bestThumb(t) {
  if (!t) return null;
  for (const k of ['high', 'medium', 'default']) if (t[k]?.url) return t[k].url;
  return null;
}

function isoDuration(s) {
  const m = s && s.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const total = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  if (!total) return null;
  const h = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = total % 60;
  return h ? `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

function fromPlaylistItem(it) {
  const sn = it.snippet || {};
  const id = sn.resourceId?.videoId;
  if (!id || !sn.title || sn.title === 'Private video' || sn.title === 'Deleted video') return null;
  return { id, title: sn.title, channel: (sn.videoOwnerChannelTitle || '').replace(/ - Topic$/, ''), channelId: sn.videoOwnerChannelId || null };
}

function fromVideo(it) {
  const sn = it.snippet || {};
  if (!it.id) return null;
  return { id: it.id, title: sn.title || '', channel: (sn.channelTitle || '').replace(/ - Topic$/, ''), channelId: sn.channelId || null, duration: isoDuration(it.contentDetails?.duration) };
}
