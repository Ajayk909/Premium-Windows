// Cast to Roku: finds your Roku on the network, plays the video in the TV's YouTube app,
// and gives you a full remote.
import { h, ic, api, toast, dialog, spinner } from '../ui.js';
import { settings, set } from '../state.js';
import * as player from '../player.js';

export function castDialog(video) {
  const body = h('div.cast');
  let devices = settings.rokuIP ? [{ ip: settings.rokuIP, name: settings.rokuName || 'Roku TV' }] : [];
  let scanning = false;

  const current = () => devices.find((d) => d.ip === settings.rokuIP) || null;

  function select(d) {
    set('rokuIP', d.ip);
    set('rokuName', d.name);
    render();
  }

  async function scan() {
    scanning = true;
    render();
    try {
      const found = await api.call('roku:scan');
      devices = found;
      if (found.length === 1 && !current()) select(found[0]);
      if (!found.length) toast('No Roku found. Make sure the TV is on and on the same network.');
    } catch (e) {
      toast(String(e.message || e));
    }
    scanning = false;
    render();
  }

  async function addManual(ip) {
    const d = await api.call('roku:probe', ip).catch(() => null);
    if (!d) { toast(`Couldn't reach a Roku at ${ip}`); return; }
    if (!devices.some((x) => x.ip === d.ip)) devices.push(d);
    select(d);
  }

  async function cast() {
    const tv = current();
    if (!tv || !video) return;
    try {
      const at = player.P.current?.id === video.id ? player.time() : 0;
      await api.call('roku:cast', tv.ip, video.id, at);
      if (player.P.current?.id === video.id) player.pause();
      toast(`Playing on ${tv.name}`);
    } catch (e) {
      toast(`Couldn't cast: ${e.message || e}`);
    }
  }

  const key = (k) => { const tv = current(); if (tv) api.call('roku:key', tv.ip, k); };

  function render() {
    body.innerHTML = '';
    const tv = current();
    if (video) {
      body.append(h('div.cast-now.glass',
        h('img', { src: `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`, alt: '' }),
        h('div', h('div.card-label', 'Ready to cast'), h('div.cast-title', video.title || 'This video')),
        h('button.btn.primary', { disabled: !tv, onclick: cast }, ic('cast', 18), tv ? `Play on ${tv.name}` : 'Pick a TV')));
    }
    const list = h('div.cast-devices');
    for (const d of devices) {
      list.append(h('button.check-row' + (tv?.ip === d.ip ? '.on' : ''), { onclick: () => select(d) },
        ic('cast', 20), h('span.check-row-text', h('span', d.name), h('small', d.ip)), h('span.checkbox', tv?.ip === d.ip ? ic('check', 14) : null)));
    }
    const ipField = h('input.text-field', { placeholder: 'TV IP address, e.g. 192.168.1.40' });
    ipField.addEventListener('keydown', (e) => { if (e.key === 'Enter' && ipField.value.trim()) addManual(ipField.value.trim()); });
    body.append(
      h('div.section-title', h('h2', 'TVs'), h('button.btn.ghost.small', { onclick: scan, disabled: scanning }, ic('refresh', 16), scanning ? 'Searching…' : 'Search network')),
      scanning ? spinner() : list,
      !devices.length && !scanning ? h('p.faded', 'Press Search network to find your Roku, or type its IP address (Roku Settings → Network → About).') : null,
      h('div.cast-manual', ipField, h('button.btn.ghost', { onclick: () => ipField.value.trim() && addManual(ipField.value.trim()) }, 'Add')));
    if (tv) body.append(remote());
  }

  function remote() {
    const b = (k, content, cls = '') => h('button.remote-btn' + (cls ? '.' + cls : ''), { title: k, onclick: () => key(k) }, content);
    return h('div.remote.glass',
      h('div.remote-row', b('Back', ic('back', 20)), b('Home', ic('home', 20)), b('PowerOff', ic('power', 20), 'danger')),
      h('div.dpad',
        b('Up', ic('up', 22), 'up'), b('Left', ic('left', 22), 'left'), b('Select', 'OK', 'ok'), b('Right', ic('right', 22), 'right'), b('Down', ic('down', 22), 'down')),
      h('div.remote-row', b('Rev', ic('prev', 18)), b('Play', ic('play', 18)), b('Fwd', ic('next', 18))),
      h('div.remote-row', b('VolumeDown', '−'), b('VolumeMute', ic('mute', 18)), b('VolumeUp', '+')));
  }

  render();
  dialog('Cast to TV', body, { wide: true });
}
