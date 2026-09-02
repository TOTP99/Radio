/*
 * 模拟收音机 · 可折叠预设 + 筛选 + 旋钮吸附 + The Daily
 * 结构总览（自上而下）：
 *   1. 数据 — 电台预设 / 播客源 / 常量
 *   2. 音效合成 — 点击声、调台静电声（纯 Web Audio，无音频文件）
 *   3. DOM 引用
 *   4. 状态变量
 *   5. 表盘工具函数 — 频率 ↔ 百分比换算、指针/频率显示、信号格数
 *   6. 通用工具 — 时间格式化、localStorage 读写
 *   7. 播放核心 — 启停、direct/HLS 播放、选台（含"调谐延迟"模拟）
 *   8. 预设列表渲染 + 分类筛选
 *   9. 折叠面板（电台 / 播客）
 *   10. 旋钮拖拽交互（鼠标 + 触屏）
 *   11. 播客 RSS 拉取与解析（带 CORS 代理兜底）
 *   12. <audio> 原生事件绑定
 *   13. 预设步进（⏮️⏭️）与波段切换（🔄 FM/AM）
 *   14. 控制按钮 + 键盘快捷键绑定
 *   15. 时钟
 *   16. 初始化（恢复上次状态）
 *
 * 状态持久化说明：localStorage 只记住"上次在听什么/面板是否展开"，
 * 刷新后仅恢复显示文字和表盘位置，不会自动开始播放（需用户手动点按钮），
 * 避免自动播放被浏览器拦截，也避免在网络差时突然出声。
 */

/* ========== 1. 数据 ========== */
const STATIONS = [
  { id:'classical', name:'Classical 96.3', meta:'多伦多古典音乐', freq:96.3, band:'FM', tags:['music'],
    url:'https://live.amperwave.net/direct/mzmedia-cfmzfmmp3-ibc2', type:'direct' },
  { id:'boom', name:'Boom 97.3', meta:'经典流行 70s–90s', freq:97.3, band:'FM', tags:['music'],
    url:'https://newcap.leanstream.co/CHBMFM', type:'direct' },
  { id:'chfi', name:'98.1 CHFI', meta:'成人流行', freq:98.1, band:'FM', tags:['music'],
    url:'https://rogers-hls.leanstream.co/rogers/tor981.stream/playlist.m3u8', type:'hls' },
  { id:'cbc', name:'CBC Radio One', meta:'新闻谈话', freq:99.1, band:'FM', tags:['news'],
    url:'https://cbcradiolive.akamaized.net/hls/live/2041036/ES_R1ETR/master.m3u8', type:'hls' },
  { id:'virgin', name:'Virgin Radio 99.9', meta:'流行热歌', freq:99.9, band:'FM', tags:['music'],
    url:'https://playerservices.streamtheworld.com/api/livestream-redirect/CKFMFMAAC.aac', type:'direct' },
  { id:'cmr', name:'CMR 101.3', meta:'多元文化', freq:101.3, band:'FM', tags:['zh'],
    url:'https://live.cmr24.net/CMR/CMR-HQ/icecast.audio', type:'direct' },
  { id:'fairchild', name:'中文电台 粤语', meta:'Fairchild 88.9', freq:88.9, band:'FM', tags:['zh'],
    url:'https://5b2959fe11444.streamlock.net/radio/am1430.stream/playlist.m3u8', type:'hls' },
  { id:'am640', name:'640 Toronto', meta:'谈话', freq:640, band:'AM', tags:['news'],
    url:'https://corus.leanstream.co/CFIQAM-MP3', type:'direct' },
  { id:'am680', name:'680 NewsRadio', meta:'全新闻', freq:680, band:'AM', tags:['news'],
    url:'https://rogers-hls.leanstream.co/rogers/tor680.stream/playlist.m3u8', type:'hls' },
  { id:'zoomer', name:'Zoomer Radio', meta:'怀旧金曲 AM740', freq:740, band:'AM', tags:['music'],
    url:'https://live.amperwave.net/direct/mzmedia-cfzmammp3-ibc2', type:'direct' },
  { id:'am820', name:'Big AM 820', meta:'旁遮普语音乐', freq:820, band:'AM', tags:['zh','music'],
    url:'https://ice25.securenetsystems.net/CHAM', type:'direct' }
];
// 注：STATIONS 的数组顺序 = "全部"筛选下网格的显示顺序（未按频率排序）。
// 拨号旋钮的上一台/下一台走的是 sortedPresets()，会在当前波段内按频率单独排序。

const DAILY = { name:'The Daily', feed:'https://feeds.simplecast.com/54nAGcIl' };
const STORAGE_KEY = 'radio_state_v5'; // 存档结构变化时应递增版本号，避免读到旧格式出错
const FM_MIN=88, FM_MAX=108, AM_MIN=530, AM_MAX=1700; // 表盘量程（MHz / kHz）
const SNAP_FM=0.35, SNAP_AM=12; // 拖动旋钮松手时，频率落在预设 ±此范围内即自动吸附锁台

/* ========== 2. 音效合成（纯 Web Audio，不依赖任何音频文件） ========== */
let audioCtx=null;
const ensureAudioCtx=()=>{
  if(!audioCtx) audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended') audioCtx.resume(); // 移动端首次需要用户手势才能启动
  return audioCtx;
};
// 按钮"咔哒"声：一个从 880Hz 快速下滑到 420Hz 的正弦短音
const playClickSound=()=>{try{
  const c=ensureAudioCtx(),o=c.createOscillator(),g=c.createGain();
  o.type='sine';o.frequency.setValueAtTime(880,c.currentTime);
  o.frequency.exponentialRampToValueAtTime(420,c.currentTime+0.06);
  g.gain.setValueAtTime(0.18,c.currentTime);g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+0.08);
  o.connect(g);g.connect(c.destination);o.start();o.stop(c.currentTime+0.09);
}catch{}};
// 选台时的一小段"沙沙"静电声：带通滤波的白噪声，中心频率随时间上扫
const playTuneStatic=(d=0.4)=>{try{
  const c=ensureAudioCtx(),n=Math.floor(c.sampleRate*d),b=c.createBuffer(1,n,c.sampleRate),a=b.getChannelData(0);
  for(let i=0;i<n;i++) a[i]=(Math.random()*2-1)*Math.sin(i/n*Math.PI)*0.2;
  const s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();
  s.buffer=b;f.type='bandpass';f.frequency.setValueAtTime(900,c.currentTime);
  f.frequency.exponentialRampToValueAtTime(2400,c.currentTime+d*0.5);f.Q.value=0.7;
  g.gain.setValueAtTime(0.32,c.currentTime);g.gain.exponentialRampToValueAtTime(0.01,c.currentTime+d);
  s.connect(f);f.connect(g);g.connect(c.destination);s.start();
}catch{}};

/* ========== 3. DOM 引用 ========== */
const audio=document.getElementById('audio');
const playBtn=document.getElementById('playBtn');
const prevBtn=document.getElementById('prevBtn');
const nextBtn=document.getElementById('nextBtn');
const bandBtn=document.getElementById('bandBtn');
const nowTitle=document.getElementById('nowTitle');
const nowSub=document.getElementById('nowSub');
const liveBadge=document.getElementById('liveBadge');
const progressWrap=document.getElementById('progressWrap');
const progressBar=document.getElementById('progressBar');
const progressFilled=document.getElementById('progressFilled');
const curTime=document.getElementById('curTime');
const durTime=document.getElementById('durTime');
const stationGrid=document.getElementById('stationGrid');
const episodeList=document.getElementById('episodeList');
const clockEl=document.getElementById('clock');
const podToggle=document.getElementById('podToggle');
const podBody=document.getElementById('podBody');
const stToggle=document.getElementById('stToggle');
const stBody=document.getElementById('stBody');
const stToggleName=document.getElementById('stToggleName');
const filterRow=document.getElementById('filterRow');
const freqDisplay=document.getElementById('freqDisplay');
const bandLabel=document.getElementById('bandLabel');
const dialNeedle=document.getElementById('dialNeedle');
const dialMarks=document.getElementById('dialMarks');
const dialTrack=document.getElementById('dialTrack');
const dialLabels=document.getElementById('dialLabels');
const signalBars=document.getElementById('signalBars');

/* ========== 4. 状态变量 ========== */
let hls=null;              // 当前 Hls.js 实例（direct 流或原生 HLS 支持时为 null）
let mode=null;              // 'live' | 'podcast' | null —— 当前播放类型
let activeId=null;          // 当前电台 id 或播客集 url
let podLoaded=false;        // The Daily 节目单是否已成功拉取过（避免重复请求）
let podOpen=false, stOpen=false; // 两个折叠面板的展开状态；实际初始值由 init() 中的存档覆盖
let tuneTimer=null;         // "调谐延迟"的 setTimeout 句柄，用于中途取消
let dialBand='FM';          // 当前表盘波段
let currentFreq=98;         // 表盘当前指向的频率
let dragging=false;         // 是否正在拖动旋钮
let staticLoop=null;        // 拖动旋钮时循环播放的静电声源
let filter='all';           // 当前预设筛选 tab

// 表盘刻度线（41 根），纯装饰，与频率数值无绑定关系
(()=>{const f=document.createDocumentFragment();for(let i=0;i<41;i++)f.appendChild(document.createElement('span'));dialMarks.appendChild(f);})();

/* ========== 5. 表盘工具函数 ========== */
const freqToPercent=(freq,band)=>band==='AM'
  ? Math.max(0,Math.min(100,((freq-AM_MIN)/(AM_MAX-AM_MIN))*100))
  : Math.max(0,Math.min(100,((freq-FM_MIN)/(FM_MAX-FM_MIN))*100));
const percentToFreq=(pct,band)=>band==='AM'
  ? AM_MIN+(pct/100)*(AM_MAX-AM_MIN) : FM_MIN+(pct/100)*(FM_MAX-FM_MIN);

// 更新频率数字 + 指针位置。animate:false 用于"瞬移"（拖动中/初始化），跳过 CSS transition
const setDialUI=(freq,band,{animate=true,tuning=false}={})=>{
  dialBand=band||dialBand; bandLabel.textContent=dialBand;
  if(freq==null){freqDisplay.textContent='--.-';freqDisplay.classList.remove('tuning');setSignal('off');return;}
  currentFreq=freq;
  freqDisplay.textContent=dialBand==='AM'?String(Math.round(freq)):Number(freq).toFixed(1);
  freqDisplay.classList.toggle('tuning',tuning);
  if(!animate) dialNeedle.classList.add('dragging'); // 借用 .dragging 关掉 transition
  dialNeedle.style.left=freqToPercent(freq,dialBand)+'%';
  if(!animate){
    void dialNeedle.offsetWidth; // 强制重排，确保 left 变化在无 transition 状态下立即生效
    if(!dragging) dialNeedle.classList.remove('dragging');
  }
};
const setDialScale=band=>{
  dialBand=band;
  dialLabels.innerHTML=band==='AM'
    ? '<span>530</span><span>770</span><span>1010</span><span>1250</span><span>1490</span><span>1700</span>'
    : '<span>88</span><span>92</span><span>96</span><span>100</span><span>104</span><span>108</span>';
};
const setSignal=s=>{signalBars.classList.remove('on','weak');if(s==='on')signalBars.classList.add('on');else if(s==='weak')signalBars.classList.add('weak');};

/* ========== 6. 通用工具 ========== */
const fmt=sec=>{if(!isFinite(sec)||sec<0)return'0:00';const m=Math.floor(sec/60),s=Math.floor(sec%60);return m+':'+String(s).padStart(2,'0');};
const loadState=()=>{try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');}catch{return{};}};
const saveState=p=>{try{localStorage.setItem(STORAGE_KEY,JSON.stringify({...loadState(),...p}));}catch{}};

/* ========== 7. 播放核心 ========== */
const destroyHls=()=>{if(hls){try{hls.destroy();}catch{}hls=null;}};
const stopStaticLoop=()=>{if(staticLoop){try{staticLoop.stop();}catch{}staticLoop=null;}};
const startStaticLoop=()=>{stopStaticLoop();try{
  const c=ensureAudioCtx(),n=c.sampleRate,b=c.createBuffer(1,n,c.sampleRate),a=b.getChannelData(0);
  for(let i=0;i<n;i++)a[i]=(Math.random()*2-1)*0.08;
  const s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();
  s.buffer=b;s.loop=true;f.type='bandpass';f.frequency.value=1400;f.Q.value=0.6;g.gain.value=0.25;
  s.connect(f);f.connect(g);g.connect(c.destination);s.start();staticLoop=s;
}catch{}};

// 停止一切播放并把 UI 复位到"未选台"状态。所有切台/切集/拖旋钮的入口都先调用它，
// 保证同一时刻最多只有一个音频源在播（旧的 hls 实例、旧的 <audio>.src 都会被清掉）。
const stopAll=()=>{
  if(tuneTimer){clearTimeout(tuneTimer);tuneTimer=null;}
  stopStaticLoop();destroyHls();audio.pause();audio.removeAttribute('src');try{audio.load();}catch{};
  playBtn.textContent='▶';liveBadge.hidden=true;progressWrap.hidden=true;progressFilled.style.width='0';
  document.querySelectorAll('.station,.episode').forEach(el=>el.classList.remove('active'));
  mode=null;activeId=null;setSignal('off');
};
const playDirect=async url=>{destroyHls();audio.src=url;await audio.play().catch(()=>{});};
const playHls=async url=>{
  destroyHls();
  // iOS Safari 原生支持 HLS，优先直接赋值 src；其余浏览器走 hls.js（MSE）
  if(audio.canPlayType('application/vnd.apple.mpegurl')){audio.src=url;await audio.play().catch(()=>{});return;}
  if(window.Hls&&Hls.isSupported()){
    hls=new Hls({enableWorker:true,maxBufferLength:30});
    hls.loadSource(url);hls.attachMedia(audio);
    hls.on(Hls.Events.MANIFEST_PARSED,()=>audio.play().catch(()=>{}));
    hls.on(Hls.Events.ERROR,(_,d)=>{if(d.fatal){nowSub.textContent='信号中断，请重试';playBtn.textContent='▶';setSignal('weak');}});
    // 致命错误后不主动 destroy：用户重新点选该台会走 stopAll()->destroyHls() 统一清理
  } else nowSub.textContent='当前浏览器不支持此流';
};

// 选台：先给"调谐中…"的过渡反馈（模拟真实收音机对频延迟），tuneTimer 到时才真正切换音频源。
// fromDial=true 表示由拖动旋钮松手触发，用更短的延迟 + 不叠加静电音效（拖动中已经在放静电声）。
const playStation=async(st,{fromDial=false}={})=>{
  stopAll();mode='live';activeId=st.id;
  setDialScale(st.band);setDialUI(st.freq,st.band,{tuning:true,animate:!fromDial});setSignal('weak');
  if(!fromDial) playTuneStatic(0.45);
  nowTitle.textContent=fromDial?'锁台中…':'调谐中…';
  nowSub.textContent=st.band+' '+(st.band==='AM'?Math.round(st.freq):st.freq.toFixed(1));
  liveBadge.hidden=true;progressWrap.hidden=true;
  document.querySelectorAll('.station').forEach(el=>el.classList.toggle('active',el.dataset.id===st.id));
  tuneTimer=setTimeout(async()=>{
    tuneTimer=null;freqDisplay.classList.remove('tuning');setSignal('on');
    nowTitle.textContent=st.name;nowSub.textContent=st.meta;liveBadge.hidden=false;
    if(st.type==='hls') await playHls(st.url); else await playDirect(st.url);
    saveState({type:'live',id:st.id});
  }, fromDial?280:450);
};

// 在给定波段内找离 freq 最近的预设电台；超出吸附阈值（SNAP_FM/SNAP_AM）则返回 null
const findSnapStation=(freq,band)=>{
  let best=null,bestD=Infinity,th=band==='AM'?SNAP_AM:SNAP_FM;
  for(const s of STATIONS.filter(x=>x.band===band)){
    const d=Math.abs(s.freq-freq); if(d<bestD){bestD=d;best=s;}
  }
  return (best&&bestD<=th)?best:null;
};

const playEpisode=async ep=>{
  stopAll();mode='podcast';activeId=ep.url;
  nowTitle.textContent=ep.title;nowSub.textContent=DAILY.name;
  liveBadge.hidden=true;progressWrap.hidden=false;
  bandLabel.textContent='POD';freqDisplay.textContent='—';freqDisplay.classList.remove('tuning');setSignal('on');
  document.querySelectorAll('.episode').forEach(el=>el.classList.toggle('active',el.dataset.url===ep.url));
  await playDirect(ep.url);saveState({type:'podcast',url:ep.url,title:ep.title});
};

// 播放/暂停合一按钮的核心逻辑：没有任何音频源时不做任何事（避免暂停一个空 <audio>）
const togglePlay=()=>{
  if(!audio.src&&!hls)return;
  if(audio.paused){
    audio.play().catch(err=>{
      console.warn('播放失败:',err);
      setSignal('off');
    });
  }else{
    audio.pause();
  }
};

/* ========== 8. 预设列表渲染 + 分类筛选 ========== */
const renderStations=()=>{
  stationGrid.innerHTML='';
  const last=loadState();
  STATIONS.forEach(st=>{
    const btn=document.createElement('button');
    btn.type='button';btn.className='station';btn.dataset.id=st.id;
    btn.dataset.band=st.band;btn.dataset.tags=(st.tags||[]).join(' ');
    const fs=st.band==='AM'?String(st.freq):st.freq.toFixed(1);
    btn.innerHTML=`<span class="name">${st.name}</span><span class="meta">${st.meta}</span><span class="freq-tag">${st.band} ${fs}</span>`;
    if(last.type==='live'&&last.id===st.id) btn.classList.add('active'); // 恢复上次收听台的高亮
    btn.addEventListener('click',()=>playStation(st));
    stationGrid.appendChild(btn);
  });
  applyFilter(filter);
};
const applyFilter=f=>{
  filter=f;
  filterRow.querySelectorAll('.chip').forEach(c=>c.classList.toggle('active',c.dataset.filter===f));
  let n=0;
  stationGrid.querySelectorAll('.station').forEach(el=>{
    let show=true;
    if(f==='FM'||f==='AM') show=el.dataset.band===f;
    else if(f==='news'||f==='music'||f==='zh') show=(el.dataset.tags||'').split(' ').includes(f);
    el.classList.toggle('hidden',!show);
    if(show) n++;
  });
  const labels={all:'全部',FM:'FM',AM:'AM',news:'新闻',music:'音乐',zh:'中文/多元'};
  stToggleName.textContent=`预设 · ${labels[f]||f}（${n}）`;
};
filterRow.addEventListener('click',e=>{
  const chip=e.target.closest('.chip'); if(!chip) return;
  applyFilter(chip.dataset.filter);
});
renderStations();

/* ========== 9. 折叠面板（电台 / 播客） ========== */
const setStOpen=open=>{
  stOpen=open;stBody.hidden=!open;
  stToggle.setAttribute('aria-expanded',open?'true':'false');
  saveState({stOpen:open});
};
stToggle.addEventListener('click',()=>setStOpen(!stOpen));

const setPodOpen=open=>{
  podOpen=open;podBody.hidden=!open;
  podToggle.setAttribute('aria-expanded',open?'true':'false');
  saveState({podOpen:open});
  if(open)loadDaily(false); // 首次展开才拉取节目单，避免一进页面就发请求
};
podToggle.addEventListener('click',()=>setPodOpen(!podOpen));

/* ========== 10. 旋钮拖拽交互（鼠标 + 触屏） ========== */
const pointerToFreq=x=>{
  const r=dialTrack.getBoundingClientRect();
  return percentToFreq(Math.max(0,Math.min(1,(x-r.left)/r.width))*100, dialBand);
};
const onDialDown=e=>{
  e.preventDefault();dragging=true;dialNeedle.classList.add('dragging');
  stopAll();startStaticLoop();setSignal('weak');freqDisplay.classList.add('tuning');
  nowTitle.textContent='调谐中…';nowSub.textContent='松开以锁台';liveBadge.hidden=true;progressWrap.hidden=true;
  setDialUI(pointerToFreq(e.touches?e.touches[0].clientX:e.clientX),dialBand,{animate:false,tuning:true});
};
const onDialMove=e=>{
  if(!dragging)return;
  const f=pointerToFreq(e.touches?e.touches[0].clientX:e.clientX);
  setDialUI(f,dialBand,{animate:false,tuning:true});
  const near=findSnapStation(f,dialBand);
  nowSub.textContent=near?('接近 '+near.name):'静电 · 无预设';
  setSignal(near?'weak':'off');
};
const onDialUp=()=>{
  if(!dragging)return;dragging=false;dialNeedle.classList.remove('dragging');stopStaticLoop();freqDisplay.classList.remove('tuning');
  const snap=findSnapStation(currentFreq,dialBand);
  if(snap) playStation(snap,{fromDial:true});
  else{nowTitle.textContent='未锁台';nowSub.textContent='靠近预设再松手，或点下方列表';setSignal('off');setDialUI(currentFreq,dialBand,{animate:true});}
};
dialTrack.addEventListener('mousedown',onDialDown);
dialTrack.addEventListener('touchstart',onDialDown,{passive:false}); // 需要 preventDefault，故不能 passive
window.addEventListener('mousemove',onDialMove);
// touchmove 可以 passive：滚动/手势已被 .dial-track { touch-action:none } 和 touchstart 的
// preventDefault 一起挡住，这里不需要再调用 preventDefault
window.addEventListener('touchmove',onDialMove,{passive:true});
window.addEventListener('mouseup',onDialUp);
window.addEventListener('touchend',onDialUp);

/* ========== 11. 播客 RSS 拉取与解析 ========== */
const parseRss=xml=>{
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  if(doc.querySelector('parsererror'))return[];
  return[...doc.querySelectorAll('item')].slice(0,12).map(item=>{
    const title=item.querySelector('title')?.textContent?.trim()||'无标题';
    // 音频地址优先级：<enclosure> → <media:content>/<content> → <link> 里像音频文件的 URL
    let url=item.querySelector('enclosure')?.getAttribute('url')||'';
    if(!url){const m=item.querySelector('media\\:content, content');url=m?.getAttribute('url')||'';}
    if(!url){const l=item.querySelector('link');const h=l?.textContent?.trim()||l?.getAttribute('href')||'';if(/\.(mp3|m4a|aac)(\?|$)/i.test(h))url=h;}
    const dur=item.querySelector('itunes\\:duration, duration')?.textContent||'';
    const pub=item.querySelector('pubDate')?.textContent||'';
    let date='';try{date=new Date(pub).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});}catch{}
    return{title,url,dur,date};
  }).filter(x=>x.url); // 丢弃解析不出音频地址的条目
};
// RSS 源大多不带 CORS 头，依次尝试：直连 → allorigins → corsproxy，任一成功即用
const fetchFeedText=async feedUrl=>{
  const cands=[feedUrl,'https://api.allorigins.win/raw?url='+encodeURIComponent(feedUrl),'https://corsproxy.io/?'+encodeURIComponent(feedUrl)];
  let last=null;
  for(const src of cands){try{
    const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),12000);
    const res=await fetch(src,{signal:ctrl.signal,mode:'cors',credentials:'omit',cache:'no-cache'});
    clearTimeout(t);if(!res.ok)throw new Error('HTTP '+res.status);
    const text=await res.text();
    if(!text||text.length<40)throw new Error('empty');
    if(!text.includes('<item')&&!text.includes('<rss'))throw new Error('not rss'); // 代理有时返回错误页而非 XML
    return text;
  }catch(e){last=e;}}
  throw last||new Error('feed failed');
};
const renderEpisodes=eps=>{
  episodeList.innerHTML='';const last=loadState();
  eps.forEach(ep=>{
    const btn=document.createElement('button');btn.type='button';btn.className='episode';btn.dataset.url=ep.url;
    if(last.type==='podcast'&&last.url===ep.url)btn.classList.add('active');
    btn.innerHTML=`<div class="ep-title">${ep.title}</div><div class="ep-meta">${ep.date}${ep.dur?' · '+ep.dur:''}</div>`;
    btn.addEventListener('click',()=>playEpisode(ep));episodeList.appendChild(btn);
  });podLoaded=true;
};
const loadDaily=async force=>{
  if(podLoaded&&!force)return;
  episodeList.innerHTML='<div class="loading">加载节目单…</div>';
  try{
    const eps=parseRss(await fetchFeedText(DAILY.feed));
    if(!eps.length){episodeList.innerHTML='<div class="error">暂无节目</div>';return;}
    renderEpisodes(eps);
  }catch(e){
    console.warn(e);podLoaded=false;
    episodeList.innerHTML='<div class="error">节目单加载失败，请点此重试</div>';
    const err=episodeList.querySelector('.error');
    if(err){err.style.cursor='pointer';err.addEventListener('click',()=>loadDaily(true));}
  }
};

/* ========== 12. <audio> 原生事件绑定 ========== */
audio.addEventListener('play',()=>{playBtn.textContent='⏸';});
audio.addEventListener('pause',()=>{playBtn.textContent='▶';});
audio.addEventListener('timeupdate',()=>{
  if(mode!=='podcast'||!audio.duration)return; // 直播没有进度条，只有播客更新
  progressFilled.style.width=((audio.currentTime/audio.duration)*100)+'%';
  curTime.textContent=fmt(audio.currentTime);durTime.textContent=fmt(audio.duration);
});
audio.addEventListener('loadedmetadata',()=>{if(mode==='podcast')durTime.textContent=fmt(audio.duration);});
audio.addEventListener('error',()=>{if(mode){nowSub.textContent='播放出错，请换台重试';setSignal('weak');}playBtn.textContent='▶';});
progressBar.addEventListener('click',e=>{
  if(mode!=='podcast'||!audio.duration)return;
  const r=progressBar.getBoundingClientRect();
  audio.currentTime=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width))*audio.duration;
});

/* ========== 13. 预设步进（⏮️⏭️）与波段切换（🔄） ========== */
// 当前波段内按频率排序的预设列表，供 ⏮️/⏭️ 顺序步进使用（与 STATIONS 原始数组顺序无关）
const sortedPresets = (band) =>
  STATIONS.filter((s) => s.band === band).sort((a, b) => a.freq - b.freq);

const stepPreset = (dir) => {
  playClickSound();
  const list = sortedPresets(dialBand);
  if (!list.length) return;
  let idx = list.findIndex((s) => s.id === activeId);
  if (idx < 0) {
    // 当前没有选中预设（比如刚拖旋钮停在空白频率）：按当前指针频率找最近的一个作为起点
    let best = 0, bestD = Infinity;
    list.forEach((s, i) => {
      const d = Math.abs(s.freq - currentFreq);
      if (d < bestD) { bestD = d; best = i; }
    });
    idx = best;
  }
  const next = list[(idx + dir + list.length) % list.length]; // 首尾循环
  playStation(next);
};

// 切换 FM/AM：像真实收音机一样，先停掉正在播的内容，再把指针移到新波段的第一个预设
// （不自动播放，只是把表盘定位过去，避免切完波段音频和文字对不上）
const toggleBand = () => {
  playClickSound();
  stopAll();
  const next = dialBand === 'FM' ? 'AM' : 'FM';
  setDialScale(next);
  const list = sortedPresets(next);
  nowTitle.textContent = '未选台';
  if (list.length) {
    setDialUI(list[0].freq, next, { animate: true });
    nowSub.textContent = next + ' 刻度 · 共 ' + list.length + ' 个预设 · 点 ⏭️ 或列表收听';
  } else {
    setDialUI(next === 'FM' ? 98 : 1000, next, { animate: true });
    nowSub.textContent = '已切换到 ' + next + ' 刻度';
  }
  setSignal('off');
};

prevBtn.addEventListener('click', () => stepPreset(-1));
nextBtn.addEventListener('click', () => stepPreset(1));
bandBtn.addEventListener('click', toggleBand);

/* ========== 14. 控制按钮 + 键盘快捷键 ========== */
playBtn.addEventListener('click',()=>{playClickSound();togglePlay();});
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')return;
  if(e.key===' '||e.key==='k'||e.key==='K'){e.preventDefault();playClickSound();togglePlay();}
});

/* ========== 15. 时钟 ========== */
const pad=n=>String(n).padStart(2,'0');
const tick=()=>{const d=new Date();clockEl.textContent=`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;};
tick();setInterval(tick,1000);

/* ========== 16. 初始化：恢复上次的展开状态 / 表盘位置 / 显示文字（不自动播放） ========== */
(()=>{
  const last=loadState();
  setStOpen(last.stOpen===true);   // 默认收起，只有上次手动展开过才恢复展开
  setPodOpen(!!last.podOpen);

  if(last.type==='live'&&last.id){
    const st=STATIONS.find(s=>s.id===last.id);
    if(st){
      // 对应的 .station 按钮已在 renderStations() 里根据同一份存档标记过 active，这里无需重复操作
      nowTitle.textContent=st.name;nowSub.textContent='点击播放继续收听';
      setDialScale(st.band);setDialUI(st.freq,st.band,{animate:false});setSignal('weak');
      return; // 表盘已定位到目标电台，不再需要下面的默认 FM/98 复位
    }
  }

  // 默认表盘位置：既是"无历史记录"时的起点，也是"上次在听播客"时表盘的底层状态
  // （播客模式下波段/频率显示会被下面的 POD/— 覆盖，但 dialBand 内部仍保持 FM，供后续切 FM/AM 使用）
  setDialScale('FM');setDialUI(98,'FM',{animate:false});

  if(last.type==='podcast'&&last.title){
    nowTitle.textContent=last.title;nowSub.textContent=DAILY.name+' · 展开后可继续收听';
    bandLabel.textContent='POD';freqDisplay.textContent='—';
  }
})();
