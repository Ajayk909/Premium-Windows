// Development only (PREMIUM_MOCK=1): fake YouTube data so the UI can be checked without a network.
const titles = [
  'The most beautiful places on Earth — 8K HDR', 'I built a tiny house in 30 days', 'Why this bridge sings in the wind',
  'Ranking every keyboard switch I own', 'Street food tour: Mumbai at midnight', 'The physics of a perfect free kick',
  'Lo-fi beats to code to (3 hour mix)', 'Restoring a 1970s camera back to life', 'We tested the cheapest 4K TV',
  'How airlines actually make money', 'A day in the life of a lighthouse keeper', 'Making Neapolitan pizza at home',
  'Inside the world’s quietest room', 'Speedrunning the hardest level ever made', 'Explaining black holes with a bowling ball',
  'My minimalist desk setup for 2026', 'The secret language of trains', 'Cooking with only a candle', 'Building a Roku app from scratch',
  'Northern lights timelapse over Iceland'
];
const channels = ['Pearl Studio', 'Atlas Travel', 'Tiny Builds', 'Signal & Noise', 'Night Market', 'Kickoff Lab', 'Calm Frequencies', 'Shutter Club'];
const palettes = [['#9B8CFF', '#6FD3FF'], ['#FF7EB3', '#FFC07A'], ['#7EE8C1', '#6FD3FF'], ['#FFC07A', '#FF7EB3'], ['#2E2A5E', '#6FD3FF'], ['#164E5A', '#7EE8C1'], ['#E52222', '#FFC07A'], ['#1C1D24', '#9B8CFF']];

function art(i, w = 640, h = 360, label = '') {
  const [a, b] = palettes[i % palettes.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><radialGradient id="r" cx=".75" cy=".25" r=".6"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#r)"/><circle cx="${w * 0.28}" cy="${h * 0.7}" r="${h * 0.42}" fill="#fff" opacity=".12"/><text x="24" y="${h - 28}" font-family="Segoe UI, sans-serif" font-size="${h / 9}" font-weight="700" fill="#fff" opacity=".9">${label}</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function video(i, extra = {}) {
  const c = i % channels.length;
  return {
    id: 'mock' + String(i).padStart(7, '0'),
    title: titles[i % titles.length],
    channel: channels[c], channelId: 'UCmock' + String(c).padStart(18, '0'), channelAvatar: art(c + 3, 88, 88),
    thumbnail: art(i, 640, 360, ''), duration: `${3 + (i * 7) % 40}:${String((i * 13) % 60).padStart(2, '0')}`,
    views: `${(i * 37) % 900 + 12}K views`, published: `${(i % 11) + 1} days ago`, isLive: i === 5, isShort: false,
    description: 'A calm look at how things work, filmed over a year. Chapters below.', ...extra
  };
}

export const mock = {
  search: (q, filter) => ({ items: Array.from({ length: 20 }, (_, i) => video(i + (q?.length || 0), filter === 'shorts' ? { isShort: true, thumbnail: art(i, 360, 640) } : {})), channels: q && q !== '#shorts' ? [{ id: 'UCmock000000000000000001', name: channels[1], avatar: art(4, 88, 88), subscribers: '1.2M subscribers', handle: '@atlastravel' }] : [], continuation: null }),
  suggestions: (q) => [q + ' explained', q + ' 2026', q + ' review', q + ' tutorial'],
  details: (id) => {
    const i = parseInt(id.replace(/\D/g, '') || '0', 10);
    const v = video(i);
    return {
      video: { ...v, id }, description: 'Filmed across twelve countries over a full year.\n\n00:00 Intro\n02:15 The coast\n07:40 Mountains\n12:05 Cities at night\n\nMusic: Calm Frequencies — https://example.com',
      views: '1,284,551 views', date: '3 weeks ago', fullDate: 'Nov 2, 2026', likes: '48K',
      channel: { id: v.channelId, name: v.channel, avatar: v.channelAvatar, subscribers: '2.4M subscribers' },
      chapters: [{ title: 'Intro', start: 0, thumbnail: art(1, 320, 180) }, { title: 'The coast', start: 135, thumbnail: art(2, 320, 180) }, { title: 'Mountains', start: 460, thumbnail: art(3, 320, 180) }, { title: 'Cities at night', start: 725, thumbnail: art(4, 320, 180) }],
      related: Array.from({ length: 16 }, (_, k) => video(k + 3)), commentsToken: 'mock', commentCount: '2,113'
    };
  },
  comments: () => ({ items: Array.from({ length: 8 }, (_, i) => ({ id: 'c' + i, author: '@' + channels[i % 8].toLowerCase().replace(/\s/g, ''), avatar: art(i + 2, 80, 80), text: ['This is the most relaxing thing I have watched all year.', 'The shot at 7:52 is unreal 😮', 'Watching this in 4K on a big screen is a different experience.', 'Came back to this for the third time today.'][i % 4], likes: String(120 + i * 31), published: `${i + 1} days ago`, replies: i % 3 ? String(i * 2) : '' })), next: null }),
  channel: (id) => ({ channel: { id, name: channels[1], avatar: art(4, 160, 160), subscribers: '2.4M subscribers' }, banner: art(6, 2120, 350, ''), handle: '@atlastravel', videoCount: '412 videos', description: 'Slow travel films from places that are hard to get to.', videos: { items: Array.from({ length: 16 }, (_, i) => video(i + 1)), continuation: null } }),
  latestMany: (subs) => Array.from({ length: 18 }, (_, i) => ({ ...video(i + 2), publishedAt: Date.now() - i * 3600e3 * 5, isShort: i % 6 === 5 })),
  streams: () => { throw new Error('Mock mode: no streams'); },
  art, video
};
