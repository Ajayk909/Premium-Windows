// Finds Roku TVs on the local network and controls them with Roku's External Control API
// (port 8060). Casting opens the video in the TV's own YouTube app, so it plays at full quality.
import os from 'node:os';

async function req(url, method = 'GET', ms = 1500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { method, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m && m[1] ? m[1] : null;
}

export async function probe(ip) {
  ip = String(ip || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  try {
    const res = await req(`http://${ip}:8060/query/device-info`);
    const xml = await res.text();
    if (!xml.includes('<device-info')) return null;
    return { ip, name: tag(xml, 'user-device-name') || tag(xml, 'friendly-device-name') || tag(xml, 'model-name') || 'Roku TV' };
  } catch {
    return null;
  }
}

function subnets() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254')) continue;
      out.add(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...out];
}

export async function scan() {
  const bases = subnets();
  if (!bases.length) throw new Error('Connect to Wi-Fi or Ethernet to find your TV.');
  const ips = bases.flatMap((b) => Array.from({ length: 254 }, (_, i) => `${b}.${i + 1}`));
  const found = [];
  const queue = [...ips];
  await Promise.all(Array.from({ length: 64 }, async () => {
    while (queue.length) {
      const d = await probe(queue.shift());
      if (d) found.push(d);
    }
  }));
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function key(ip, k) {
  await req(`http://${ip}:8060/keypress/${encodeURIComponent(k)}`, 'POST', 3000).catch(() => {});
}

/// 837 is the YouTube channel on Roku.
export async function cast(ip, videoId, seconds = 0) {
  let path = `launch/837?contentId=${encodeURIComponent(videoId)}&mediaType=live`;
  if (seconds > 5) path += `&t=${Math.floor(seconds)}`;
  const res = await req(`http://${ip}:8060/${path}`, 'POST', 4000);
  if (!res.ok) throw new Error(`The TV answered ${res.status}`);
  return true;
}
