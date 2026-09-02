/*
 * 模拟收音机 · 6 预设 + 旋钮吸附 + The Daily 播客
 */
const STATIONS = [
  {
    id: 'fairchild',
    name: '加拿大中文电台 粤语',
    meta: 'Fairchild · 粤语为主',
    freq: 88.9,
    band: 'FM',
    url: 'https://5b2959fe11444.streamlock.net/radio/am1430.stream/playlist.m3u8',
    type: 'hls'
  },
  {
    id: 'cbc',
    name: 'CBC Radio One',
    meta: 'Toronto · 新闻谈话',
    freq: 99.1,
    band: 'FM',
    url: 'https://cbcradiolive.akamaized.net/hls/live/2041036/ES_R1ETR/master.m3u8',
    type: 'hls'
  },
  {
    id: 'virgin',
    name: 'Virgin Radio 99.9',
    meta: 'Toronto · 流行热歌',
    freq: 99.9,
    band: 'FM',
    url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/CKFMFMAAC.aac',
    type: 'direct'
  },
  {
    id: 'am680',
    name: '680 NewsRadio',
    meta: 'Toronto · 全新闻',
    freq: 680,
    band: 'AM',
    url: 'https://rogers-hls.leanstream.co/rogers/tor680.stream/playlist.m3u8',
    type: 'hls'
  },
  {
    id: 'am640',
    name: '640 Toronto',
    meta: '谈话 · Global News',
    freq: 640,
    band: 'AM',
    url: 'https://corus.leanstream.co/CFIQAM-MP3',
    type: 'direct'
  },
  {
    id: 'am820',
    name: 'Big AM 820',
    meta: '旁遮普语音乐 · GTA',
    freq: 820,
    band: 'AM',
    url: 'https://ice25.securenetsystems.net/CHAM',
    type: 'direct'
  }
];

const DAILY = {
  name: 'The Daily',
  feed: 'https://feeds.simplecast.com/54nAGcIl'
};

const STORAGE_KEY = 'radio_state_v4';

/* 刻度：FM 88–108 映射；AM 用独立映射 530–1700 */
const FM_MIN = 88;
const FM_MAX = 108;
const AM_MIN = 530;
const AM_MAX = 1700;
const SNAP_FM = 0.35;   // MHz
const SNAP_AM = 12;     // kHz

let audioCtx = null;
const ensureAudioCtx = () => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
};

const playClickSound = () => {
  try {
    const ctx = ensureAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(420, ctx.currentTime + 0.06);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.09);
  } catch {}
};

const playTuneStatic = (duration = 0.4) => {
  try {
    const ctx = ensureAudioCtx();
    const len = Math.floor(ctx.sampleRate * duration);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.sin((i / len) * Math.PI) * 0.2;
    }
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = buf;
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(900, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(2400, ctx.currentTime + duration * 0.5);
    filter.Q.value = 0.7;
    gain.gain.setValueAtTime(0.32, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  } catch {}
};

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
const freqDisplay = document.getElementById('freqDisplay');
const bandLabel = document.getElementById('bandLabel');
const dialNeedle = document.getElementById('dialNeedle');
const dialMarks = document.getElementById('dialMarks');
const dialTrack = document.getElementById('dialTrack');
const dialLabels = document.getElementById('dialLabels');
const signalBars = document.getElementById('signalBars');

let hls = null;
let mode = null;
let activeId = null;
let podLoaded = false;
let podOpen = false;
let tuneTimer = null;
let dialBand = 'FM'; // 当前刻度显示的波段
let currentFreq = 98;
let dragging = false;
let staticLoop = null;

/* 刻度线 */
(() => {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 41; i++) frag.appendChild(document.createElement('span'));
  dialMarks.appendChild(frag);
})();

const freqToPercent = (freq, band) => {
  if (band === 'AM') {
    return Math.max(0, Math.min(100, ((freq - AM_MIN) / (AM_MAX - AM_MIN)) * 100));
  }
  return Math.max(0, Math.min(100, ((freq - FM_MIN) / (FM_MAX - FM_MIN)) * 100));
};

const percentToFreq = (pct, band) => {
  if (band === 'AM') {
    return AM_MIN + (pct / 100) * (AM_MAX - AM_MIN);
  }
  return FM_MIN + (pct / 100) * (FM_MAX - FM_MIN);
};

const setDialUI = (freq, band, { animate = true, tuning = false } = {}) => {
  dialBand = band || dialBand;
  bandLabel.textContent = dialBand;
  if (freq == null) {
    freqDisplay.textContent = '--.-';
    freqDisplay.classList.remove('tuning');
    setSignal('off');
    return;
  }
  currentFreq = freq;
  if (dialBand === 'AM') {
    freqDisplay.textContent = String(Math.round(freq));
  } else {
    freqDisplay.textContent = Number(freq).toFixed(1);
  }
  freqDisplay.classList.toggle('tuning', tuning);
  if (!animate) dialNeedle.classList.add('dragging');
  dialNeedle.style.left = freqToPercent(freq, dialBand) + '%';
  if (!animate) {
    void dialNeedle.offsetWidth;
    if (!dragging) dialNeedle.classList.remove('dragging');
  }
};

const setDialScale = (band) => {
  dialBand = band;
  if (band === 'AM') {
    dialLabels.innerHTML = '<span>530</span><span>770</span><span>1010</span><span>1250</span><span>1490</span><span>1700</span>';
  } else {
    dialLabels.innerHTML = '<span>88</span><span>92</span><span>96</span><span>100</span><span>104</span><span>108</span>';
  }
};

const setSignal = (state) => {
  signalBars.classList.remove('on', 'weak');
  if (state === 'on') signalBars.classList.add('on');
  else if (state === 'weak') signalBars.classList.add('weak');
};

const fmt = (sec) => {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
};

const loadState = () => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
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

const stopStaticLoop = () => {
  if (staticLoop) {
    try { staticLoop.stop(); } catch {}
    staticLoop = null;
  }
};

const startStaticLoop = () => {
  stopStaticLoop();
  try {
    const ctx = ensureAudioCtx();
    const len = ctx.sampleRate * 1;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.08;
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = buf;
    src.loop = true;
    filter.type = 'bandpass';
    filter.frequency.value = 1400;
    filter.Q.value = 0.6;
    gain.gain.value = 0.25;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start();
    staticLoop = src;
  } catch {}
};

const stopAll = () => {
  if (tuneTimer) { clearTimeout(tuneTimer); tuneTimer = null; }
  stopStaticLoop();
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
  setSignal('off');
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
    hls.on(Hls.Events.MANIFEST_PARSED, () => { audio.play().catch(() => {}); });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        nowSub.textContent = '信号中断，请重试';
        playBtn.textContent = '▶';
        setSignal('weak');
      }
    });
  } else {
    nowSub.textContent = '当前浏览器不支持此流';
  }
};

const playStation = async (st, { fromDial = false } = {}) => {
  stopAll();
  mode = 'live';
  activeId = st.id;

  setDialScale(st.band);
  setDialUI(st.freq, st.band, { tuning: true, animate: !fromDial });
  setSignal('weak');
  if (!fromDial) playTuneStatic(0.45);

  nowTitle.textContent = fromDial ? '锁台中…' : '调谐中…';
  nowSub.textContent = st.band + ' ' + (st.band === 'AM' ? Math.round(st.freq) : st.freq.toFixed(1));
  liveBadge.hidden = true;
  progressWrap.hidden = true;

  document.querySelectorAll('.station').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === st.id);
  });

  const delay = fromDial ? 280 : 450;
  tuneTimer = setTimeout(async () => {
    tuneTimer = null;
    freqDisplay.classList.remove('tuning');
    setSignal('on');
    nowTitle.textContent = st.name;
    nowSub.textContent = st.meta;
    liveBadge.hidden = false;
    if (st.type === 'hls') await playHls(st.url);
    else await playDirect(st.url);
    saveState({ type: 'live', id: st.id });
  }, delay);
};

const findSnapStation = (freq, band) => {
  const list = STATIONS.filter((s) => s.band === band);
  let best = null;
  let bestDist = Infinity;
  const thresh = band === 'AM' ? SNAP_AM : SNAP_FM;
  for (const s of list) {
    const d = Math.abs(s.freq - freq);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  if (best && bestDist <= thresh) return best;
  return null;
};

const playEpisode = async (ep) => {
  stopAll();
  mode = 'podcast';
  activeId = ep.url;
  nowTitle.textContent = ep.title;
  nowSub.textContent = DAILY.name;
  liveBadge.hidden = true;
  progressWrap.hidden = false;
  bandLabel.textContent = 'POD';
  freqDisplay.textContent = '—';
  freqDisplay.classList.remove('tuning');
  setSignal('on');
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

/* 预设网格 */
STATIONS.forEach((st) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'station';
  btn.dataset.id = st.id;
  const freqStr = st.band === 'AM' ? String(st.freq) : st.freq.toFixed(1);
  btn.innerHTML =
    `<span class="name">${st.name}</span>` +
    `<span class="meta">${st.meta}</span>` +
    `<span class="freq-tag">${st.band} ${freqStr}</span>`;
  btn.addEventListener('click', () => playStation(st));
  stationGrid.appendChild(btn);
});

/* 旋钮拖动 */
const pointerToFreq = (clientX) => {
  const rect = dialTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * 100;
  return percentToFreq(pct, dialBand);
};

const onDialDown = (e) => {
  e.preventDefault();
  dragging = true;
  dialNeedle.classList.add('dragging');
  stopAll();
  startStaticLoop();
  setSignal('weak');
  freqDisplay.classList.add('tuning');
  nowTitle.textContent = '调谐中…';
  nowSub.textContent = '松开以锁台';
  liveBadge.hidden = true;
  progressWrap.hidden = true;
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  const f = pointerToFreq(x);
  setDialUI(f, dialBand, { animate: false, tuning: true });
};

const onDialMove = (e) => {
  if (!dragging) return;
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  const f = pointerToFreq(x);
  setDialUI(f, dialBand, { animate: false, tuning: true });
  const near = findSnapStation(f, dialBand);
  if (near) {
    nowSub.textContent = '接近 ' + near.name;
    setSignal('weak');
  } else {
    nowSub.textContent = '静电 · 无预设';
    setSignal('off');
  }
};

const onDialUp = () => {
  if (!dragging) return;
  dragging = false;
  dialNeedle.classList.remove('dragging');
  stopStaticLoop();
  freqDisplay.classList.remove('tuning');
  const snap = findSnapStation(currentFreq, dialBand);
  if (snap) {
    playStation(snap, { fromDial: true });
  } else {
    nowTitle.textContent = '未锁台';
    nowSub.textContent = '靠近预设频率再松手，或点下方预设';
    setSignal('off');
    setDialUI(currentFreq, dialBand, { animate: true });
  }
};

dialTrack.addEventListener('mousedown', onDialDown);
dialTrack.addEventListener('touchstart', onDialDown, { passive: false });
window.addEventListener('mousemove', onDialMove);
window.addEventListener('touchmove', onDialMove, { passive: true });
window.addEventListener('mouseup', onDialUp);
window.addEventListener('touchend', onDialUp);

/* 双击刻度切换 FM/AM 刻度 */
dialTrack.addEventListener('dblclick', () => {
  const next = dialBand === 'FM' ? 'AM' : 'FM';
  setDialScale(next);
  const mid = next === 'FM' ? 98 : 1000;
  setDialUI(mid, next, { animate: false });
  nowSub.textContent = '已切换到 ' + next + ' 刻度';
});

/* RSS */
const parseRss = (xmlText) => {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return [];
  return [...doc.querySelectorAll('item')].slice(0, 12).map((item) => {
    const title = item.querySelector('title')?.textContent?.trim() || '无标题';
    const enclosure = item.querySelector('enclosure');
    let url = enclosure?.getAttribute('url') || '';
    if (!url) {
      const media = item.querySelector('media\\:content, content');
      url = media?.getAttribute('url') || '';
    }
    if (!url) {
      const link = item.querySelector('link');
      const href = link?.textContent?.trim() || link?.getAttribute('href') || '';
      if (/\.(mp3|m4a|aac)(\?|$)/i.test(href)) url = href;
    }
    const dur = item.querySelector('itunes\\:duration, duration')?.textContent || '';
    const pub = item.querySelector('pubDate')?.textContent || '';
    let date = '';
    try {
      date = new Date(pub).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    } catch {}
    return { title, url, dur, date };
  }).filter((x) => x.url);
};

const fetchFeedText = async (feedUrl) => {
  const candidates = [
    feedUrl,
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(feedUrl),
    'https://corsproxy.io/?' + encodeURIComponent(feedUrl)
  ];
  let lastErr = null;
  for (const src of candidates) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(src, {
        signal: ctrl.signal, mode: 'cors', credentials: 'omit', cache: 'no-cache'
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (!text || text.length < 40) throw new Error('empty');
      if (!text.includes('<item') && !text.includes('<rss')) throw new Error('not rss');
      return text;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('feed failed');
};

const renderEpisodes = (eps) => {
  episodeList.innerHTML = '';
  const last = loadState();
  eps.forEach((ep) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'episode';
    btn.dataset.url = ep.url;
    if (last.type === 'podcast' && last.url === ep.url) btn.classList.add('active');
    btn.innerHTML =
      `<div class="ep-title">${ep.title}</div>` +
      `<div class="ep-meta">${ep.date}${ep.dur ? ' · ' + ep.dur : ''}</div>`;
    btn.addEventListener('click', () => playEpisode(ep));
    episodeList.appendChild(btn);
  });
  podLoaded = true;
};

const loadDaily = async (force) => {
  if (podLoaded && !force) return;
  episodeList.innerHTML = '<div class="loading">加载节目单…</div>';
  try {
    const text = await fetchFeedText(DAILY.feed);
    const eps = parseRss(text);
    if (!eps.length) {
      episodeList.innerHTML = '<div class="error">暂无节目</div>';
      return;
    }
    renderEpisodes(eps);
  } catch (e) {
    console.warn('Daily feed error', e);
    podLoaded = false;
    episodeList.innerHTML = '<div class="error">节目单加载失败，请点此重试</div>';
    const errEl = episodeList.querySelector('.error');
    if (errEl) {
      errEl.style.cursor = 'pointer';
      errEl.addEventListener('click', () => loadDaily(true));
    }
  }
};

const setPodOpen = (open) => {
  podOpen = open;
  podBody.hidden = !open;
  podToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  saveState({ podOpen: open });
  if (open) loadDaily(false);
};

podToggle.addEventListener('click', () => setPodOpen(!podOpen));

audio.addEventListener('play', () => { playBtn.textContent = '⏸'; });
audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });
audio.addEventListener('timeupdate', () => {
  if (mode !== 'podcast' || !audio.duration) return;
  progressFilled.style.width = ((audio.currentTime / audio.duration) * 100) + '%';
  curTime.textContent = fmt(audio.currentTime);
  durTime.textContent = fmt(audio.duration);
});
audio.addEventListener('loadedmetadata', () => {
  if (mode === 'podcast') durTime.textContent = fmt(audio.duration);
});
audio.addEventListener('error', () => {
  if (mode) {
    nowSub.textContent = '播放出错，请换台重试';
    setSignal('weak');
  }
  playBtn.textContent = '▶';
});

progressBar.addEventListener('click', (e) => {
  if (mode !== 'podcast' || !audio.duration) return;
  const rect = progressBar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  audio.currentTime = ratio * audio.duration;
});

playBtn.addEventListener('click', () => { playClickSound(); togglePlay(); });
stopBtn.addEventListener('click', () => {
  playClickSound();
  stopAll();
  nowTitle.textContent = '已停止';
  nowSub.textContent = '选择电台或播客';
  saveState({ type: null });
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
    e.preventDefault();
    playClickSound();
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
  setDialScale('FM');
  setDialUI(98, 'FM', { animate: false });

  if (last.type === 'live' && last.id) {
    const st = STATIONS.find((s) => s.id === last.id);
    if (st) {
      document.querySelector(`.station[data-id="${st.id}"]`)?.classList.add('active');
      nowTitle.textContent = st.name;
      nowSub.textContent = '点击播放继续收听';
      setDialScale(st.band);
      setDialUI(st.freq, st.band, { animate: false });
      setSignal('weak');
    }
  } else if (last.type === 'podcast' && last.title) {
    nowTitle.textContent = last.title;
    nowSub.textContent = DAILY.name + ' · 展开后可继续收听';
    bandLabel.textContent = 'POD';
    freqDisplay.textContent = '—';
  }
})();
