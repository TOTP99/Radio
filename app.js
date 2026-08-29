/*
 * 收音机 · 3 直播台 + The Daily（默认收起）
 */
const STATIONS = [
  {
    id: 'cbc',
    name: 'CBC Radio One',
    meta: 'Toronto · 99.1 FM · 新闻谈话',
    url: 'https://cbcradiolive.akamaized.net/hls/live/2041036/ES_R1ETR/master.m3u8',
    type: 'hls'
  },
  {
    id: 'virgin',
    name: 'Virgin Radio 99.9',
    meta: 'Toronto · 99.9 FM · 流行热歌',
    url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/CKFMFMAAC.aac',
    type: 'direct'
  },
  {
    id: 'fairchild',
    name: '加拿大中文电台 粤语',
    meta: 'Fairchild AM1430 / FM88.9 · 粤语为主',
    url: 'https://5b2959fe11444.streamlock.net/radio/am1430.stream/playlist.m3u8',
    type: 'hls'
  }
];

const DAILY = {
  name: 'The Daily',
  feed: 'https://feeds.simplecast.com/54nAGcIl'
};

const STORAGE_KEY = 'radio_state_v2';

const audio = document.getElementById('audio');
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');
const nowTitle = document.getElementById('nowTitle');
const nowSub = document.getElementById('nowSub');
const liveBadge = document.getElementById('liveBadge');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressFilled = document.getElementById('progressFilled');
const curTime = document.getElementById('curTime');
const durTime = document.getElementById('durTime');
const stationGrid = document.getElementById('stationGrid');
const episodeList = document.getElementById('episodeList');
const clockEl = document.getElementById('clock');
const podToggle = document.getElementById('podToggle');
const podBody = document.getElementById('podBody');

let hls = null;
let mode = null;
let activeId = null;
let seeking = false;
let podLoaded = false;
let podOpen = false;

const fmt = (sec) => {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
};

const loadState = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
};

const saveState = (patch) => {
  try {
    const cur = loadState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch {}
};

const destroyHls = () => {
  if (hls) {
    try { hls.destroy(); } catch {}
    hls = null;
  }
};

const stopAll = () => {
  destroyHls();
  audio.pause();
  audio.removeAttribute('src');
  try { audio.load(); } catch {}
  playBtn.textContent = '▶';
  liveBadge.hidden = true;
  progressWrap.hidden = true;
  progressFilled.style.width = '0';
  document.querySelectorAll('.station, .episode').forEach((el) => el.classList.remove('active'));
  mode = null;
  activeId = null;
};

const playDirect = async (url) => {
  destroyHls();
  audio.src = url;
  await audio.play().catch(() => {});
};

const playHls = async (url) => {
  destroyHls();
  if (audio.canPlayType('application/vnd.apple.mpegurl')) {
    audio.src = url;
    await audio.play().catch(() => {});
    return;
  }
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true, maxBufferLength: 30 });
    hls.loadSource(url);
    hls.attachMedia(audio);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      audio.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        nowSub.textContent = '信号中断，请重试';
        playBtn.textContent = '▶';
      }
    });
  } else {
    nowSub.textContent = '当前浏览器不支持此流';
  }
};

const playStation = async (st) => {
  stopAll();
  mode = 'live';
  activeId = st.id;
  nowTitle.textContent = st.name;
  nowSub.textContent = st.meta;
  liveBadge.hidden = false;
  progressWrap.hidden = true;
  document.querySelectorAll('.station').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === st.id);
  });
  if (st.type === 'hls') await playHls(st.url);
  else await playDirect(st.url);
  saveState({ type: 'live', id: st.id });
};

const playEpisode = async (ep) => {
  stopAll();
  mode = 'podcast';
  activeId = ep.url;
  nowTitle.textContent = ep.title;
  nowSub.textContent = DAILY.name;
  liveBadge.hidden = true;
  progressWrap.hidden = false;
  document.querySelectorAll('.episode').forEach((el) => {
    el.classList.toggle('active', el.dataset.url === ep.url);
  });
  await playDirect(ep.url);
  saveState({ type: 'podcast', url: ep.url, title: ep.title });
};

const togglePlay = () => {
  if (!audio.src && !hls) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
};

STATIONS.forEach((st) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'station';
  btn.dataset.id = st.id;
  btn.innerHTML = `<span class="name">${st.name}</span><span class="meta">${st.meta}</span>`;
  btn.addEventListener('click', () => playStation(st));
  stationGrid.appendChild(btn);
});

const parseRss = (xmlText) => {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  return [...doc.querySelectorAll('item')].slice(0, 12).map((item) => {
    const title = item.querySelector('title')?.textContent?.trim() || '无标题';
    const enclosure = item.querySelector('enclosure');
    const url = enclosure?.getAttribute('url') || '';
    const dur = item.querySelector('itunes\\:duration, duration')?.textContent || '';
    const pub = item.querySelector('pubDate')?.textContent || '';
    let date = '';
    try {
      date = new Date(pub).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    } catch {}
    return { title, url, dur, date };
  }).filter((x) => x.url);
};

const loadDaily = async () => {
  if (podLoaded) return;
  episodeList.innerHTML = '<div class="loading">加载节目单…</div>';
  try {
    const res = await fetch(DAILY.feed);
    if (!res.ok) throw new Error('feed ' + res.status);
    const eps = parseRss(await res.text());
    if (!eps.length) {
      episodeList.innerHTML = '<div class="error">暂无节目</div>';
      return;
    }
    episodeList.innerHTML = '';
    const last = loadState();
    eps.forEach((ep) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'episode';
      btn.dataset.url = ep.url;
      if (last.type === 'podcast' && last.url === ep.url) btn.classList.add('active');
      btn.innerHTML = `<div class="ep-title">${ep.title}</div><div class="ep-meta">${ep.date}${ep.dur ? ' · ' + ep.dur : ''}</div>`;
      btn.addEventListener('click', () => playEpisode(ep));
      episodeList.appendChild(btn);
    });
    podLoaded = true;
  } catch (e) {
    console.warn(e);
    episodeList.innerHTML = '<div class="error">节目单加载失败（可能跨域），请稍后重试</div>';
  }
};

const setPodOpen = (open) => {
  podOpen = open;
  podBody.hidden = !open;
  podToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  saveState({ podOpen: open });
  if (open) loadDaily();
};

podToggle.addEventListener('click', () => setPodOpen(!podOpen));

audio.addEventListener('play', () => { playBtn.textContent = '⏸'; });
audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });
audio.addEventListener('timeupdate', () => {
  if (seeking || mode !== 'podcast' || !audio.duration) return;
  progressFilled.style.width = ((audio.currentTime / audio.duration) * 100) + '%';
  curTime.textContent = fmt(audio.currentTime);
  durTime.textContent = fmt(audio.duration);
});
audio.addEventListener('loadedmetadata', () => {
  if (mode === 'podcast') durTime.textContent = fmt(audio.duration);
});
audio.addEventListener('error', () => {
  if (mode) nowSub.textContent = '播放出错，请换台重试';
  playBtn.textContent = '▶';
});

progressBar.addEventListener('click', (e) => {
  if (mode !== 'podcast' || !audio.duration) return;
  const rect = progressBar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  audio.currentTime = ratio * audio.duration;
});

playBtn.addEventListener('click', togglePlay);
stopBtn.addEventListener('click', () => {
  stopAll();
  nowTitle.textContent = '已停止';
  nowSub.textContent = '选择电台或播客';
  saveState({ type: null });
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
    e.preventDefault();
    togglePlay();
  }
});

const pad = (n) => String(n).padStart(2, '0');
const tick = () => {
  const d = new Date();
  clockEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
tick();
setInterval(tick, 1000);

(() => {
  const last = loadState();
  setPodOpen(!!last.podOpen);

  if (last.type === 'live' && last.id) {
    const st = STATIONS.find((s) => s.id === last.id);
    if (st) {
      document.querySelector(`.station[data-id="${st.id}"]`)?.classList.add('active');
      nowTitle.textContent = st.name;
      nowSub.textContent = '点击播放继续收听';
    }
  } else if (last.type === 'podcast' && last.title) {
    nowTitle.textContent = last.title;
    nowSub.textContent = DAILY.name + ' · 点击展开选择或继续';
  }
})();
