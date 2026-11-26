// Hover previews: rest the mouse on a thumbnail and it flips through moments from the video
// (YouTube's own auto-generated frames), with a little progress bar — light and instant.
import { previewHooks, h } from './ui.js';

let timer = 0;
let layer = null;

function start(v, wrap) {
  stop();
  const frames = [1, 2, 3].map((n) => `https://i.ytimg.com/vi/${v.id}/hq${n}.jpg`);
  const a = h('img.preview-frame', { alt: '' });
  const b = h('img.preview-frame', { alt: '' });
  const bar = h('div.preview-bar', h('div'));
  layer = h('div.preview-layer', a, b, bar);
  wrap.append(layer);
  wrap.classList.add('previewing');
  let i = 0;
  let front = a, back = b;
  const show = () => {
    back.src = frames[i % frames.length];
    back.onload = () => {
      back.classList.add('on');
      front.classList.remove('on');
      [front, back] = [back, front];
    };
    bar.firstChild.style.transform = `scaleX(${((i % frames.length) + 1) / frames.length})`;
    i++;
  };
  show();
  timer = setInterval(show, 900);
}

function stop() {
  clearInterval(timer);
  if (layer) {
    layer.parentElement?.classList.remove('previewing');
    layer.remove();
    layer = null;
  }
}

previewHooks.start = start;
previewHooks.stop = stop;
