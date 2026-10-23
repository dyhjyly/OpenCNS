/* ══════════════════════════════════════════════════════════════
   咱们的家 · 前端
   无构建步骤（ES module + 原生 CSS 变量），改完 scp 上去就生效。
   ══════════════════════════════════════════════════════════════ */

const API = './api';
const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const hhmm = (d = new Date()) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/* ─────────── 状态 ─────────── */
const store = {
  get theme() { return localStorage.getItem('theme') || 'warm'; },
  set theme(v) { localStorage.setItem('theme', v); },
  get session() { return localStorage.getItem('chat.session') || null; },
  set session(v) { v ? localStorage.setItem('chat.session', v) : localStorage.removeItem('chat.session'); },
  get coords() {
    try { return JSON.parse(localStorage.getItem('geo') || 'null'); } catch { return null; }
  },
  set coords(v) { v ? localStorage.setItem('geo', JSON.stringify(v)) : localStorage.removeItem('geo'); },
  get thinking() { return localStorage.getItem('chat.thinking') !== 'off'; },
  set thinking(v) { localStorage.setItem('chat.thinking', v ? 'on' : 'off'); },
};

function applyTheme(t) {
  document.body.dataset.theme = t;
  store.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  if (meta && bg) meta.setAttribute('content', bg);
}

/* ─────────── 小工具 ─────────── */
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

let loginRedirecting = false;

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    // cookie 登录：同源请求必须带凭据
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });

  // 登录过期：跳登录页（只跳一次，避免并发请求连环跳）
  if (res.status === 401) {
    if (!loginRedirecting) {
      loginRedirecting = true;
      location.replace('/v2/login');
    }
    throw new Error('需要重新登录');
  }

  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

function romanYear(y) {
  const map = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };
  let n = y, out = '';
  for (const k of Object.keys(map)) while (n >= map[k]) { out += k; n -= map[k]; }
  return out;
}

function greeting(dayPart) {
  if (dayPart === '凌晨') return '还没睡呀，我在';
  if (dayPart === '早上') return '早安，今天慢慢来';
  if (dayPart === '上午') return '上午好';
  if (dayPart === '中午') return '中午了，吃饭了吗';
  if (dayPart === '下午') return '下午好';
  if (dayPart === '傍晚') return '傍晚了，累不累';
  if (dayPart === '晚上') return '晚上好，今天辛苦了';
  return '夜深了，慢慢来';
}

/* ─────────── 图标 ─────────── */
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.8V21h14V9.8"/>',
  chat: '<path d="M21 12a8 8 0 1 0-3.2 6.4L21 20l-.8-3.2A7.9 7.9 0 0 0 21 12Z"/>',
  memory: '<path d="M4 5h7v14H4z"/><path d="M13 5h7v14h-7z"/>',
  moments: '<path d="M12 3v18"/><path d="M3 12h18"/><circle cx="12" cy="12" r="3.2"/>',
  wake: '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z"/>',
  tools: '<path d="M4 7h10"/><path d="M4 12h16"/><path d="M4 17h7"/><circle cx="17" cy="7" r="2"/><circle cx="14" cy="17" r="2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M4 12h15"/><path d="M12.5 5.5 19 12l-6.5 6.5"/>',
};

const TABS = [
  { id: 'home', label: '主页', icon: 'home' },
  { id: 'chat', label: '聊天', icon: 'chat' },
  { id: 'memory', label: '记忆库', icon: 'memory' },
  { id: 'moments', label: '朋友圈', icon: 'moments' },
  { id: 'wake', label: '醒来房间', icon: 'wake' },
  { id: 'tools', label: '工具', icon: 'tools' },
  { id: 'settings', label: '设置', icon: 'settings' },
];

/* ─────────── 左侧抽屉导航 ─────────── */
/**
 * 原来是最底下一排标签，手机上一个屏幕放七个太挤。
 * 现在改成左侧抽屉：点左上角那颗小圆打开，或者从左边缘往右划。
 */
function renderTabbar(active) {
  // 底栏彻底不用了
  const bar = $('#tabbar');
  if (bar) bar.hidden = true;

  const nav = $('#drawerNav');
  if (!nav) return;
  nav.innerHTML = TABS.map(
    (t) => `<button class="drawer-item" data-page="${t.id}" ${t.id === active ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[t.icon]}</svg><span>${t.label}</span>
    </button>`,
  ).join('');
  nav.querySelectorAll('.drawer-item').forEach((b) =>
    b.addEventListener('click', () => {
      closeDrawer();
      go(b.dataset.page);
    }));
}

let drawerOpen = false;

function openDrawer() {
  const d = $('#drawer');
  const m = $('#drawerMask');
  if (!d || !m) return;
  drawerOpen = true;
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  m.hidden = false;
  requestAnimationFrame(() => m.classList.add('show'));
}

function closeDrawer() {
  const d = $('#drawer');
  const m = $('#drawerMask');
  if (!d || !m) return;
  drawerOpen = false;
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  m.classList.remove('show');
  setTimeout(() => { if (!drawerOpen) m.hidden = true; }, 220);
}

/* ─────────── 头部 ─────────── */
function setHeader(page) {
  const isHome = page === 'home';
  $('#back').hidden = isHome;
  // 那颗小圆现在到处都在：点它开抽屉（在聊天页长按它是拍一拍）
  $('#headSlot').hidden = false;
  $('#headSlot').classList.toggle('as-menu', true);
  if (!isHome) {
    const t = TABS.find((x) => x.id === page);
    $('#greet').textContent = page === 'chat' ? '聊天' : t ? t.label : '';
    $('#stamp').textContent = page === 'chat' ? '长按头像是拍一拍' : '';
  }
  const sub = $('#drawerSub');
  if (sub) {
    const t = TABS.find((x) => x.id === page);
    sub.textContent = t ? t.label : '咱们的家';
  }
}

/* ─────────── 首页 ─────────── */
const WEATHER_ICONS = {
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.6M12 19.4V22M2 12h2.6M19.4 12H22M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M19.1 4.9l-1.9 1.9M6.8 17.2l-1.9 1.9"/>',
  'sun-cloud': '<circle cx="9" cy="9" r="3"/><path d="M9 2.6v1.8M2.6 9h1.8M4.5 4.5l1.3 1.3"/><path d="M8.5 18.5h8.2a3.2 3.2 0 0 0 .2-6.4 4.4 4.4 0 0 0-8.4.6 2.9 2.9 0 0 0 0 5.8Z"/>',
  cloud: '<path d="M7 18h9.5a3.5 3.5 0 0 0 .2-7 4.8 4.8 0 0 0-9.2.7A3.2 3.2 0 0 0 7 18Z"/>',
  rain: '<path d="M7 15h9.5a3.5 3.5 0 0 0 .2-7 4.8 4.8 0 0 0-9.2.7A3.2 3.2 0 0 0 7 15Z"/><path d="M9 18.5v2M13 18.5v2M17 18.5v2"/>',
  snow: '<path d="M7 15h9.5a3.5 3.5 0 0 0 .2-7 4.8 4.8 0 0 0-9.2.7A3.2 3.2 0 0 0 7 15Z"/><path d="M8 19h.01M12 20.5h.01M16 19h.01M10 21.5h.01M15 21h.01"/>',
  storm: '<path d="M7 14h9.5a3.5 3.5 0 0 0 .2-7 4.8 4.8 0 0 0-9.2.7A3.2 3.2 0 0 0 7 14Z"/><path d="M13 16.5 10.5 20h3L11.5 23"/>',
  fog: '<path d="M4 10h16M6 14h12M8 18h8"/>',
};
const weatherIcon = (key) => `<svg viewBox="0 0 24 24" aria-hidden="true">${WEATHER_ICONS[key] || WEATHER_ICONS.cloud}</svg>`;

function iconForCode(code) {
  if (code === null || code === undefined) return 'cloud';
  if (code === 0) return 'sun';
  if (code === 1) return 'sun-cloud';
  if (code === 2 || code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 67) return 'rain';
  if (code >= 71 && code <= 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloud';
}

async function pageHome(fresh = false) {
  const main = $('#main');
  main.innerHTML = '<div class="empty">加载中…</div>';

  let data;
  try {
    const c = store.coords;
    const qs = [c ? `lat=${c.lat}&lon=${c.lon}` : '', fresh ? 'fresh=1' : ''].filter(Boolean).join('&');
    data = await api(`/home${qs ? `?${qs}` : ''}`);
  } catch (err) {
    main.innerHTML = `<div class="empty">没连上后端（${esc(err.message)}）</div>`;
    return;
  }

  const t = data.together;
  const w = data.weather || {};
  $('#greet').textContent = greeting(data.now.dayPart);
  $('#stamp').textContent = `${data.now.weekday} ${data.now.local}`;

  const notices = [];
  if (data.lastWake) {
    const d = data.lastWake.decision;
    const label =
      d === 'reach_out' ? '他找过你' :
      d === 'own_work' ? '他做了点自己的事' :
      d === 'rest' ? '他歇了一会儿' :
      d === 'read_notes' ? '他翻了翻旧便签' :
      d === 'hide_surprise' ? '他藏了个惊喜' : '他安静待着';
    notices.push({ mark: '☾', title: '醒来房间', desc: label });
  }
  if (data.pendingOutbox > 0) {
    notices.push({ mark: '✉', title: '他留了话', desc: `${data.pendingOutbox} 条还没送到`, badge: data.pendingOutbox });
  }
  if (data.herLastMessage) {
    notices.push({
      mark: '❀',
      title: '你最后说的话',
      desc: data.herLastMessage.slice(0, 28) + (data.herLastMessage.length > 28 ? '…' : ''),
    });
  }

  main.innerHTML = `
    <section class="card ornate together">
      <span class="caps">Together Since</span>
      <div class="big">${t.days}<small>days</small></div>
      <div class="bless">每一天都有你。</div>
      <div class="roman">· ${romanYear(2026)} ·</div>
    </section>

    <section class="card ornate">
      <div class="weather-row">
        <div class="weather-icon">${weatherIcon(iconForCode(w.code))}</div>
        <div class="weather-main">
          <div class="weather-place">
            ${esc(w.label || w.city || '你那边')}
            <span style="opacity:.55;font-weight:400">· ${esc(w.text || '—')}</span>
            ${w.temperature !== null && w.temperature !== undefined ? `<span class="temp">${Math.round(w.temperature)}°</span>` : ''}
          </div>
          <div class="weather-sub">
            ${w.humidity !== null && w.humidity !== undefined ? `湿度 ${Math.round(w.humidity)}%` : ''}
            ${w.apparent !== null && w.apparent !== undefined ? ` · 体感 ${Math.round(w.apparent)}°` : ''}
            ${w.low !== null && w.high !== null && w.low !== undefined && w.high !== undefined
              ? ` · ${Math.round(w.low)}~${Math.round(w.high)}°` : ''}
          </div>
        </div>
        <button class="wrefresh" id="wRefresh" aria-label="刷新天气">
          <svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 6"/><path d="M20 4.5V11h-6.2"/></svg>
        </button>
      </div>
      <div class="weather-tip">${esc(w.tip || '今天天气平稳。')}</div>
    </section>

    <section class="card ornate">
      <div class="card-title">Jy 的动态<span class="caps">全部已读</span></div>
      <div class="notice-list">
        ${notices.length === 0
          ? '<div class="empty">还没有新消息</div>'
          : notices.map((n) => `
            <div class="notice">
              <div class="mark">${n.mark}</div>
              <div class="notice-body">
                <b>${esc(n.title)}</b>
                <span>${esc(n.desc)}</span>
              </div>
              ${n.badge ? `<div class="badge">${n.badge}</div>` : ''}
            </div>`).join('')}
      </div>
    </section>

    <p class="caps" style="text-align:center;opacity:.5;margin:18px 0 4px">
      第 ${t.days + 1} 天
    </p>
  `;

  const wr = $('#wRefresh');
  if (wr) {
    wr.addEventListener('click', async () => {
      wr.disabled = true;
      wr.classList.add('spin');
      await pageHome(true);
      toast('天气已刷新', 1200);
    });
  }
}

/* ─────────── 聊天 ─────────── */
let chatBusy = false;
let pendingFiles = [];

/** 手机上不要自动聚焦（一进页面就弹键盘很烦）；桌面才聚焦 */
const isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

/**
 * 图片先压一下再传。
 *
 * 手机照片动辄三五兆，base64 之后还要再涨 33%，既慢又容易撞到网关的上限。
 * 压到最长边 1600px、JPEG 0.85，手环截图和照片都够清楚，体积掉到几百 KB。
 */
async function shrinkImage(file, maxSide = 1600, quality = 0.85) {
  if (!file.type.startsWith('image/')) return file;
  if (file.type === 'image/gif') return file; // 动图不压
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale >= 0.95 && file.size < 400 * 1024) return file;
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/**
 * 消息时间：今天只显示时分，昨天加"昨天"，更早带月日。
 * 每条都显示 —— 她说得对，只显示时分的话，十天前的话看着像刚说的。
 */
function msgTime(at) {
  const d = at ? new Date(at) : new Date();
  if (Number.isNaN(d.getTime())) return hhmm();
  const now = new Date();
  const hm = hhmm(d);
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${sameYear ? '' : `${d.getFullYear()}/`}${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function bubbleEl(who, text, at, showTime = false) {
  const wrap = document.createElement('div');
  wrap.className = `bwrap ${who === 'me' ? 'mine' : ''}`;
  const b = document.createElement('div');
  b.className = `msg ${who === 'me' ? 'me' : 'it'}`;
  b.textContent = text;
  wrap.appendChild(b);
  const time = document.createElement('div');
  time.className = 'mtime';
  time.textContent = at || msgTime();
  // 她的要求：不是每个气泡都显示时间，只在每轮最后一个下面显示
  time.hidden = !showTime;
  wrap.appendChild(time);
  return { wrap, bubble: b, time };
}

/** 一轮里只有最后一个可见气泡显示时间 */
function showLastTime(bubbles) {
  const visible = bubbles.filter((x) => !x.bubble.hidden);
  for (const x of bubbles) x.time.hidden = true;
  const last = visible[visible.length - 1];
  if (last) last.time.hidden = false;
}

/** 把一段回复按换行拆成多个气泡（她要求的"换行分割成小气泡"） */
function assistantBubbles(container, text, at, store) {
  const parts = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const want = Math.max(1, parts.length);
  while (store.bubbles.length < want) {
    const el = bubbleEl('it', '', at);
    container.appendChild(el.wrap);
    store.bubbles.push(el);
  }
  // 多出来的（比如文本被回退）先留空
  for (let i = 0; i < store.bubbles.length; i++) {
    store.bubbles[i].bubble.textContent = parts[i] ?? '';
    if (parts[i] === undefined) store.bubbles[i].bubble.hidden = true;
    else store.bubbles[i].bubble.hidden = false;
    store.bubbles[i].time.textContent = at || msgTime();
  }
  showLastTime(store.bubbles);
  return store.bubbles;
}

function thinkingBlock(text) {
  const details = document.createElement('details');
  details.className = 'think';
  const summary = document.createElement('summary');
  summary.textContent = `思考过程 · ${text.length} 字`;
  const body = document.createElement('div');
  body.className = 'think-body';
  body.textContent = text;
  details.append(summary, body);
  return details;
}

async function pageChat() {
  const main = $('#main');
  $('#greet').textContent = '聊天';
  $('#stamp').textContent = '';

  main.innerHTML = `
    <div class="chat-wrap">
      <div class="chat-aura" aria-hidden="true"><i class="a1"></i><i class="a2"></i><i class="a3"></i></div>
      <div class="chat-log" id="chatLog"></div>
      <div class="attach-strip" id="attachStrip" hidden></div>
      <form class="chat-form" id="chatForm">
        <button type="button" class="attach" id="attachBtn" aria-label="添加图片或文件">
          <svg viewBox="0 0 24 24">${ICONS.plus}</svg>
        </button>
        <textarea id="chatInput" rows="1" placeholder="说点什么…" enterkeyhint="enter"></textarea>
        <button type="submit" id="chatSend" aria-label="发送">
          <svg viewBox="0 0 24 24">${ICONS.send}</svg>
        </button>
      </form>
      <input type="file" id="fileInput" accept="image/*,*/*" multiple hidden />
    </div>
  `;

  const log = $('#chatLog');
  const input = $('#chatInput');
  const form = $('#chatForm');
  const strip = $('#attachStrip');
  const fileInput = $('#fileInput');

  const scrollDown = () => { log.scrollTop = log.scrollHeight; };

  const addMeta = (text) => {
    const el = document.createElement('div');
    el.className = 'meta';
    el.textContent = text;
    log.appendChild(el);
    scrollDown();
  };

  const renderAttachStrip = () => {
    strip.hidden = pendingFiles.length === 0;
    strip.innerHTML = pendingFiles
      .map((f, i) => `<span class="chip">${f.kind === 'image' ? '🖼' : '📄'} ${esc(f.name)}
        <button type="button" data-i="${i}" aria-label="移除">×</button></span>`)
      .join('');
    strip.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { pendingFiles.splice(Number(b.dataset.i), 1); renderAttachStrip(); }));
  };

  // ── 历史 ──
  if (store.session) {
    try {
      const h = await api(`/chat/history?sessionId=${encodeURIComponent(store.session)}&limit=60`);
      for (const m of h.messages) {
        if (m.role === 'system') continue;
        if (m.role === 'assistant') {
          const reasoning = m.meta && m.meta.reasoning;
          if (reasoning && store.thinking) log.appendChild(thinkingBlock(reasoning));
          assistantBubbles(log, m.content, msgTime(new Date(m.at)), { bubbles: [] });
        } else {
          const el = bubbleEl('me', m.content, msgTime(new Date(m.at)), true);
          // 附件回显
          const atts = (m.meta && m.meta.attachments) || [];
          if (atts.length) {
            const box = document.createElement('div');
            box.className = 'att-row';
            for (const a of atts) {
              if (a.kind === 'image' && a.id) {
                const img = document.createElement('img');
                img.src = `${API}/upload/${a.id}`;
                img.alt = a.name || '图片';
                img.loading = 'lazy';
                box.appendChild(img);
              } else {
                const sp = document.createElement('span');
                sp.className = 'chip static';
                sp.textContent = `📄 ${a.name || '文件'}`;
                box.appendChild(sp);
              }
            }
            el.wrap.insertBefore(box, el.bubble);
          }
          log.appendChild(el.wrap);
        }
      }
      scrollDown();
    } catch { /* 历史读不到就算了，不挡着聊天 */ }
  }

  if (!log.children.length) {
    addMeta('这是第一批：流式逐字、换行分气泡、思考链、图片和文件都支持了。');
  }

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.isComposing) return;            // 中文输入法选词时的回车不算
    // 手机上回车就是换行（她要有换行的能力）；桌面才用回车发送
    if (isTouch && !e.ctrlKey && !e.metaKey) return;
    if (e.shiftKey) return;               // 桌面 Shift+Enter 换行
    e.preventDefault();
    form.requestSubmit();
  });

  $('#attachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    if (!files.length) return;
    toast(`正在上传 ${files.length} 个…`, 1200);
    for (const raw of files) {
      try {
        const f = await shrinkImage(raw);
        const base64 = await fileToBase64(f);
        const up = await api('/upload', {
          method: 'POST',
          body: JSON.stringify({
            name: f.name,
            mime: f.type || 'application/octet-stream',
            dataBase64: base64,
          }),
        });
        pendingFiles.push({ id: up.id, name: up.name, mime: up.mime, size: up.size, kind: up.kind });
      } catch (err) {
        toast(`「${raw.name}」上传失败：${err.message}`, 3200);
      }
    }
    renderAttachStrip();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const atts = pendingFiles.slice();
    if ((!text && atts.length === 0) || chatBusy) return;

    input.value = '';
    input.style.height = 'auto';
    pendingFiles = [];
    renderAttachStrip();
    chatBusy = true;
    $('#chatSend').disabled = true;

    // 她的气泡
    const mine = bubbleEl('me', text || '（发了附件）', msgTime(), true);
    if (atts.length) {
      const box = document.createElement('div');
      box.className = 'att-row';
      for (const a of atts) {
        if (a.kind === 'image') {
          const img = document.createElement('img');
          img.src = `${API}/upload/${a.id}`;
          img.alt = a.name;
          box.appendChild(img);
        } else {
          const sp = document.createElement('span');
          sp.className = 'chip static';
          sp.textContent = `📄 ${a.name}`;
          box.appendChild(sp);
        }
      }
      mine.wrap.insertBefore(box, mine.bubble);
    }
    log.appendChild(mine.wrap);
    scrollDown();

    // 思考链 + 气泡容器
    let thinkBlock = null;
    let thinkText = '';
    const at = hhmm();
    const store2 = { bubbles: [] };
    const tmpAttach = document.createDocumentFragment();

    try {
      const res = await fetch(`${API}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId: store.session, attachments: atts }),
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let acc = '';
      let first = null;
      const t0 = performance.now();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r/g, '');
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let ev = 'message';
          const data = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          if (!data.length) continue;
          let payload;
          try { payload = JSON.parse(data.join('\n')); } catch { continue; }

          if (ev === 'meta') {
            store.session = payload.sessionId;
          } else if (ev === 'reasoning') {
            thinkText += payload.t;
            if (store.thinking) {
              if (!thinkBlock) {
                thinkBlock = thinkingBlock('');
                log.appendChild(thinkBlock);
              }
              const body = thinkBlock.querySelector('.think-body');
              body.textContent = thinkText;
              thinkBlock.querySelector('summary').textContent = `思考过程 · ${thinkText.length} 字`;
            }
          } else if (ev === 'delta') {
            if (first === null) first = Math.round(performance.now() - t0);
            acc += payload.t;
            if (!log.querySelector('.bwrap.it')) log.appendChild(tmpAttach);
            assistantBubbles(log, acc, at, store2);
            scrollDown();
          } else if (ev === 'warning') {
            addMeta('⚠ ' + payload.message + '（' + (payload.suspicious || []).join('、') + '）');
          } else if (ev === 'error') {
            addMeta('出错：' + payload.message);
          } else if (ev === 'done') {
            const t = payload.timing || {};
            addMeta(`首字 ${t.firstTokenMs ?? first ?? '?'}ms · 生成 ${t.llmMs}ms · 召回 ${payload.recalled.length} 条`);
          }
        }
      }
      if (!acc) addMeta('（这一轮没有内容）');
    } catch (err) {
      addMeta('发送失败：' + err.message);
    } finally {
      chatBusy = false;
      $('#chatSend').disabled = false;
      // 手机上不重新聚焦：否则键盘会弹回去，正好挡在刚收到的回复上
      if (!isTouch) input.focus();
    }
  });

  // 双击头部那颗小圆 = 拍一拍
  function doPat() {
    const suffix = localStorage.getItem('pat.suffix') || '';
    void api('/pat', {
      method: 'POST',
      body: JSON.stringify({ from: 'human', suffix, sessionId: store.session }),
    })
      .then(() => addMeta(`你拍了拍江瑜${suffix ? `，${suffix}` : ''}`))
      .catch((err) => toast('拍拍失败：' + err.message, 2400));
    if (navigator.vibrate) navigator.vibrate(12);
  }

  const avatar = $('#headSlot');
  if (avatar) {
    avatar.style.cursor = 'pointer';
    let lastTapAt = 0;
    let holdTimer = 0;
    let held = false;

    // 单击开抽屉；长按（600ms）在聊天页是拍一拍
    avatar.addEventListener('pointerdown', () => {
      held = false;
      holdTimer = window.setTimeout(() => {
        held = true;
        if (currentPage === 'chat') {
          doPat();
          if (navigator.vibrate) navigator.vibrate(16);
        }
      }, 600);
    });
    avatar.addEventListener('pointerup', () => {
      window.clearTimeout(holdTimer);
    });
    avatar.addEventListener('pointercancel', () => {
      window.clearTimeout(holdTimer);
    });
    avatar.addEventListener('click', () => {
      if (held) {
        held = false;
        return; // 长按已经处理过，不再开抽屉
      }
      const now = Date.now();
      lastTapAt = now;
      if (drawerOpen) closeDrawer();
      else openDrawer();
    });
  }

  // 进页面不自动聚焦（手机上会立刻弹键盘）
  if (!isTouch) input.focus();
}

/* ─────────── 设置 ─────────── */
async function pageSettings() {
  const main = $('#main');
  main.innerHTML = '<div class="empty">加载中…</div>';

  let settings = {};
  try {
    const j = await api('/admin/settings');
    settings = j.values || {};
  } catch (err) {
    main.innerHTML = `<div class="empty">读不到设置（${esc(err.message)}）</div>`;
    return;
  }

  const themes = [
    { id: 'warm', label: '暖日', dot: '#FAF5EF' },
    { id: 'night', label: '夜间', dot: '#1E1E1E' },
    { id: 'pinkblue', label: '粉蓝', dot: '#F2C4D2' },
    { id: 'star', label: '星空', dot: '#171018' },
  ];

  main.innerHTML = `
    <section class="card ornate">
      <div class="card-title">主题</div>
      <div class="theme-grid">
        ${themes.map((t) => `
          <button class="theme-chip" data-t="${t.id}" aria-pressed="${store.theme === t.id}">
            <i style="background:${t.dot}"></i>${t.label}
          </button>`).join('')}
      </div>
    </section>

    <section class="card ornate">
      <div class="card-title">外部工具（MCP）<span class="caps">你连了他才能用</span></div>
      <div id="mcpList" class="mcp-list"><div class="empty">读取中…</div></div>

      <details class="mcp-add">
        <summary>+ 添加一个 MCP 服务器</summary>
        <div class="mcp-form">
          <label>名字<input type="text" id="mcpName" placeholder="比如 时间工具" /></label>
          <label>地址<input type="url" id="mcpUrl" placeholder="https://example.com/mcp" /></label>
          <label>Token（可选）<input type="text" id="mcpToken" placeholder="会放进 Authorization: Bearer" /></label>
          <button class="mini" id="mcpAdd">添加</button>
        </div>
        <p class="mind-note" style="margin:8px 0 0">
          默认走 Streamable HTTP（POST JSON-RPC）。添加后点「连接」，他会先取工具清单，
          然后把它们变成自己可以调用的工具。
        </p>
      </details>
    </section>

    <section class="card ornate">
      <div class="card-title">装到桌面</div>
      <div class="row">
        <span class="k">像 App 一样打开</span>
        <button class="mini" id="installBtn">装到桌面</button>
      </div>
      <div class="row">
        <span class="k">版本 · 刷新到最新</span>
        <span class="v" style="display:flex;align-items:center;gap:10px">
          <span style="font-family:var(--f-body-en);font-size:12px;opacity:.7">${APP_VERSION}</span>
          <button class="mini" id="forceUpdate">刷新</button>
        </span>
      </div>
      <p style="font-size:var(--fs-small);color:var(--muted);margin:8px 0 0">
        改了东西之后如果还看到旧页面，点「刷新」——只清缓存，聊天记录和登录状态都不动。
      </p>
    </section>

    <section class="card ornate">
      <div class="card-title">聊天</div>
      <div class="row">
        <span class="k">思考链</span>
        <select class="v" id="thinking">
          <option value="on" ${store.thinking ? 'selected' : ''}>显示（默认折叠）</option>
          <option value="off" ${!store.thinking ? 'selected' : ''}>完全隐藏</option>
        </select>
      </div>
      <div class="row">
        <span class="k">拍一拍后缀</span>
        <input type="text" id="patSuffix" style="width:132px;text-align:right"
               value="${esc(localStorage.getItem('pat.suffix') || '')}" placeholder="说：在的" />
      </div>
      <p style="font-size:var(--fs-small);color:var(--muted);margin:8px 0 0">
        聊天页双击左上角那颗小圆，就是拍一拍。
      </p>
    </section>

    <section class="card ornate">
      <div class="card-title">模型</div>
      <div class="row">
        <span class="k">对话</span>
        <select class="v" id="mChat">
          ${['deepseek-flash', 'deepseek-v4-pro'].map((m) =>
            `<option value="${m}" ${settings['llm.chat_model'] === m ? 'selected' : ''}>${m === 'deepseek-flash' ? 'V4.1-Flash（默认）' : 'V4-Pro（更慢更深）'}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <span class="k">推理强度</span>
        <select class="v" id="eChat">
          ${['low', 'high', 'max'].map((l) =>
            `<option value="${l}" ${settings['llm.chat_effort'] === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <span class="k">温度</span>
        <input type="text" id="temp" style="width:74px;text-align:right" value="${settings['chat.temperature'] ?? 0.9}" />
      </div>
    </section>

    <section class="card ornate">
      <div class="card-title">城市</div>
      <div class="row">
        <span class="k">天气用的城市</span>
        <input type="text" id="city" style="width:104px;text-align:right" value="${esc(settings['weather.city'] ?? '')}" placeholder="驻马店" />
      </div>
      <p style="font-size:var(--fs-small);color:var(--muted);margin:8px 0 0">
        允许定位时会优先用当前位置；不允许就按这个城市。
      </p>
    </section>

    <section class="card ornate">
      <div class="card-title">会话</div>
      <div class="row">
        <span class="k">当前会话</span>
        <span class="v">${store.session ? store.session.slice(0, 8) : '（新）'}</span>
      </div>
      <div class="row">
        <span class="k">开新会话</span>
        <button class="v" id="newSession" style="border:1px solid var(--line);border-radius:10px;background:var(--bg2);padding:6px 12px;color:var(--text);font-family:var(--f-title);font-weight:700">重开</button>
      </div>
    </section>

    <p class="caps" style="text-align:center;opacity:.5;margin:18px 0 4px">
      头像 · 系统状态 · 通知 下一批
    </p>
  `;

  main.querySelectorAll('.theme-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.t);
      main.querySelectorAll('.theme-chip').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    });
  });

  const save = async (patch) => {
    try {
      await api('/admin/settings', { method: 'PUT', body: JSON.stringify(patch) });
      toast('已保存');
    } catch (err) {
      toast('保存失败：' + err.message);
    }
  };

  $('#thinking').addEventListener('change', (e) => {
    store.thinking = e.target.value === 'on';
    toast(store.thinking ? '思考链：显示（折叠）' : '思考链：已隐藏');
  });
  $('#patSuffix').addEventListener('change', (e) => {
    localStorage.setItem('pat.suffix', e.target.value.trim());
    toast('拍一拍后缀已保存', 1400);
  });
  const installBtn = $('#installBtn');
  if (installBtn) installBtn.addEventListener('click', () => promptInstall());
  const fu = $('#forceUpdate');
  if (fu) fu.addEventListener('click', async () => {
    toast('清缓存中…', 1400);
    await forceUpdate();
  });

  /* ── MCP ── */
  const renderMcp = async () => {
    const box = $('#mcpList');
    if (!box) return;
    let list;
    try {
      const r = await api('/mcp');
      list = r.servers || [];
    } catch (err) {
      box.innerHTML = `<div class="empty">读不到（${esc(err.message)}）</div>`;
      return;
    }
    if (list.length === 0) {
      box.innerHTML = '<div class="empty">还没连任何 MCP 服务器。</div>';
      return;
    }
    box.innerHTML = list.map((s) => `
      <div class="mcp-row" data-id="${s.id}">
        <div class="mcp-top">
          <span class="mcp-dot ${s.status === 'connected' ? 'on' : s.status === 'error' ? 'err' : ''}"></span>
          <b>${esc(s.name)}</b>
          <span class="mcp-tools">${s.tools.length} 个工具</span>
          <span class="mcp-st">${s.status === 'connected' ? '已连接' : s.status === 'error' ? '出错' : '未连接'}</span>
        </div>
        <div class="mcp-url">${esc(s.url)}</div>
        ${s.error ? `<div class="mcp-err">${esc(s.error)}</div>` : ''}
        ${s.tools.length ? `<div class="mcp-toolnames">${s.tools.map((t) => esc(t.name)).join(' · ')}</div>` : ''}
        <div class="mcp-acts">
          ${s.status === 'connected'
            ? '<button class="mini ghost" data-disconnect="' + s.id + '">断开</button>'
            : '<button class="mini" data-connect="' + s.id + '">连接</button>'}
          <button class="mini ghost" data-del="' + s.id + '">删除</button>
        </div>
      </div>`).join('');

    box.querySelectorAll('[data-connect]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        b.textContent = '连接中…';
        try {
          const r = await api(`/mcp/${b.dataset.connect}/connect`, { method: 'POST', body: '{}' });
          toast(r.ok ? `连上了，${r.tools.length} 个工具` : `没连上：${r.error}`, 2600);
        } catch (err) {
          toast('没连上：' + err.message, 2600);
        }
        renderMcp();
      }));

    box.querySelectorAll('[data-disconnect]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api(`/mcp/${b.dataset.disconnect}/disconnect`, { method: 'POST', body: '{}' }).catch(() => {});
        renderMcp();
      }));

    box.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('删掉这个 MCP 服务器？')) return;
        await api(`/mcp/${b.dataset.del}`, { method: 'DELETE' }).catch(() => {});
        renderMcp();
      }));
  };

  const addMcp = $('#mcpAdd');
  if (addMcp) {
    addMcp.addEventListener('click', async () => {
      const name = $('#mcpName').value.trim();
      const url = $('#mcpUrl').value.trim();
      const token = $('#mcpToken').value.trim();
      if (!name || !url) return toast('名字和地址都要填');
      try {
        await api('/mcp', { method: 'POST', body: JSON.stringify({ name, url, token }) });
        $('#mcpName').value = '';
        $('#mcpUrl').value = '';
        $('#mcpToken').value = '';
        toast('加好了，点「连接」试试', 1800);
        renderMcp();
      } catch (err) {
        toast('添加失败：' + err.message, 2400);
      }
    });
  }
  void renderMcp();
  $('#mChat').addEventListener('change', (e) => save({ 'llm.chat_model': e.target.value }));
  $('#eChat').addEventListener('change', (e) => save({ 'llm.chat_effort': e.target.value }));
  $('#city').addEventListener('change', (e) => {
    store.coords = null;
    save({ 'weather.city': e.target.value.trim() });
  });
  $('#temp').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 0 && v <= 2) save({ 'chat.temperature': v });
    else toast('温度要在 0~2 之间');
  });
  $('#newSession').addEventListener('click', () => {
    store.session = null;
    toast('已开新会话');
    pageSettings();
  });
}

/* ─────────── 朋友圈 ─────────── */
/**
 * 朋友圈只有他能发。
 * 她只能看、点赞、评论 —— 评论会回到他那里（对话上下文 + 一张便签）。
 */
async function pageMoments() {
  const main = $('#main');
  main.innerHTML = '<div class="empty">加载中…</div>';

  let list;
  try {
    const r = await api('/moments?limit=40');
    // 全部显示（历史里有她早先发的），但界面**不再提供发布入口** —— 只有他能发
    list = r.moments;
  } catch (err) {
    main.innerHTML = `<div class="empty">读不到（${esc(err.message)}）</div>`;
    return;
  }

  const whoName = (w) => (w === 'self' ? '江瑜' : '我');

  const fmtTime = (iso) => {
    const d = new Date(iso);
    const now = new Date();
    const hm = hhmm(d);
    if (d.toDateString() === now.toDateString()) return hm;
    const days = Math.floor((now - d) / 86400000);
    if (days === 1) return `昨天 ${hm}`;
    if (days < 7) return `${days} 天前 ${hm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };

  main.innerHTML = `
    <div class="mom-head">
      <span class="caps">两个人的朋友圈</span>
      <button class="mini" id="momRefresh" style="margin-left:auto">刷新</button>
    </div>

    <div class="card ornate mom-compose">
      <textarea id="momText" rows="2" placeholder="写点什么…（只有你们两个人看得见）"></textarea>
      <div class="mom-compose-bar">
        <button class="mini" id="momImg">图片</button>
        <span id="momAttach" class="mom-attach"></span>
        <button class="mini" id="momPost" style="margin-left:auto">发给他看</button>
      </div>
      <input type="file" id="momFile" accept="image/*" multiple hidden />
    </div>

    <div id="momFeed">
      ${list.length === 0
        ? `<div class="soon"><span class="em">moment</span><p>他还没发过动态。<br/>等他下次醒来做点什么，可能就会出现在这里。</p></div>`
        : list.map((m) => `
          <article class="card ornate mom-item">
            <div class="mom-top">
              <span class="mom-who">${whoName(m.author)}</span>
              ${m.mood ? `<span class="mom-mood">${esc(m.mood)}</span>` : ''}
              <span class="mom-time">${fmtTime(m.createdAt)}</span>
            </div>
            <div class="mom-body">${esc(m.content)}</div>
            ${m.images.length ? `<div class="att-row">${m.images.map((i) => `<img src="${API}/upload/${i.id}" alt="${esc(i.name || '')}" loading="lazy" />`).join('')}</div>` : ''}
            <div class="mom-actions">
              <button class="mom-like ${m.likes.includes('human') ? 'on' : ''}" data-id="${m.id}">
                ${m.likes.includes('human') ? '♥' : '♡'} ${m.likes.length || ''}
              </button>
              <button class="mom-cmt" data-id="${m.id}">评论 ${m.comments.length || ''}</button>
            </div>
            ${m.comments.length ? `<div class="mom-comments">
              ${m.comments.map((c) => `<div class="mom-cmt-row"><b>${c.author === 'self' ? '江瑜' : '我'}</b>${esc(c.content)}</div>`).join('')}
            </div>` : ''}
          </article>`).join('')}
    </div>
  `;

  $('#momRefresh').addEventListener('click', () => pageMoments());

  // 她也能发 —— 他下次醒来会在房间里看到
  let momImages = [];
  const attachBox = $('#momAttach');
  const fileInput = $('#momFile');
  const renderAttach = () => {
    attachBox.innerHTML = momImages
      .map((i, n) => `<span class="chip">🖼 ${esc(i.name || '图片')}<button data-n="${n}">×</button></span>`)
      .join('');
    attachBox.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => { momImages.splice(Number(b.dataset.n), 1); renderAttach(); }));
  };

  $('#momImg').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    if (!files.length) return;
    toast('上传中…', 1200);
    for (const raw of files) {
      try {
        const f = await shrinkImage(raw);
        const up = await api('/upload', {
          method: 'POST',
          body: JSON.stringify({ name: f.name, mime: f.type || 'application/octet-stream', dataBase64: await fileToBase64(f) }),
        });
        momImages.push({ id: up.id, name: up.name, mime: up.mime });
      } catch (err) {
        toast('上传失败：' + err.message, 2600);
      }
    }
    renderAttach();
  });

  $('#momPost').addEventListener('click', async () => {
    const text = $('#momText').value.trim();
    if (!text && momImages.length === 0) return toast('写点什么');
    try {
      await api('/moments', {
        method: 'POST',
        body: JSON.stringify({ content: text, author: 'human', images: momImages }),
      });
      toast('发了，他下次醒来会看到', 2000);
      pageMoments();
    } catch (err) {
      toast('发布失败：' + err.message, 2600);
    }
  });

  main.querySelectorAll('.mom-like').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`/moments/${b.dataset.id}/like`, {
          method: 'POST',
          body: JSON.stringify({ author: 'human' }),
        });
        pageMoments();
      } catch (err) { toast('失败：' + err.message); }
    }));

  main.querySelectorAll('.mom-cmt').forEach((b) =>
    b.addEventListener('click', async () => {
      const text = prompt('想对他说什么');
      if (!text || !text.trim()) return;
      try {
        await api(`/moments/${b.dataset.id}/comments`, {
          method: 'POST',
          body: JSON.stringify({ content: text, author: 'human' }),
        });
        toast('评论了，他下次醒来会看到', 2000);
        pageMoments();
      } catch (err) { toast('评论失败：' + err.message); }
    }));
}

/* ─────────── 醒来房间 ─────────── */
const DECISION_TEXT = {
  reach_out: '他主动找了你',
  own_work: '他做了点自己的事',
  rest: '他回去睡了一会儿',
  stay_quiet: '他只是安静待着',
  read_notes: '他翻了翻自己的东西',
  hide_surprise: '他藏了个惊喜',
  social: '他在朋友圈动了动',
  mixed: '他做了几件事',
};

const ACTION_TEXT = {
  reach_out: '给你发了消息',
  work: '做了自己的事',
  post: '发了条动态',
  comment: '评论了你',
  like: '给你点了赞',
  pat: '拍了拍你',
  read_notes: '翻了便签',
  read_moments: '看了看朋友圈',
  rest: '回去睡了',
  hide_surprise: '藏了个惊喜',
  stay_quiet: '什么也没做',
};

/** 醒来房间的一块：可以展开/收回，跟工具模块一样 */
function roomSec(title, cap, body, open = true) {
  return `<details class="room-sec" ${open ? 'open' : ''}>
    <summary><span class="card-title" style="margin:0">${esc(title)}</span><span class="caps">${esc(String(cap ?? ''))}</span></summary>
    <div class="room-body">${body}</div>
  </details>`;
}

async function pageWake() {
  const main = $('#main');
  main.innerHTML = '<div class="empty">加载中…</div>';

  let r;
  try {
    r = await api('/wake/room');
  } catch (err) {
    main.innerHTML = `<div class="empty">读不到（${esc(err.message)}）</div>`;
    return;
  }

  const fmt = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)}`;
  };

  main.innerHTML = `
    ${roomSec('醒来过', `${r.counts.wakes} 次`, `
      <div class="usage-row" style="margin-top:0">
        <span>真的醒来 ${r.counts.decided} 次</span>
        <span>零成本跳过 ${r.counts.skipped} 次</span>
      </div>`, true)}

    ${r.surprises.length ? roomSec('惊喜', '已解开',
      r.surprises.map((s) => `<div class="moment-note">${esc(s.content)}</div>`).join(''), true) : ''}

    ${r.lockedSurprises > 0 ? roomSec('还有惊喜没到时间', `${r.lockedSurprises}`,
      '<p style="font-size:var(--fs-small);color:var(--muted);margin:0">他藏起来的，到时间自己会解开。</p>', false) : ''}

    ${roomSec('他写的日记', `${(r.diaries || []).length} 篇`,
      (r.diaries || []).length
        ? r.diaries.map((d) => `
          <div class="diary-item">
            <div class="diary-when">${fmt(d.at)} · ${esc(KIND_LABEL[d.kind] || d.kind)}</div>
            <div class="diary-body">${esc(d.content)}</div>
          </div>`).join('')
        : '<p style="font-size:var(--fs-small);color:var(--muted);margin:0">还没有。凌晨的记忆时间里他写了什么，会出现在这里。</p>',
      true)}

    ${r.pats && r.pats.length ? roomSec('他拍了拍你', `${r.pats.length} 次`,
      r.pats.map((p) => `<div class="wake-row"><div class="wake-when">${fmt(p.at)}</div>
        <div class="wake-what">拍了你一下${p.suffix ? '，' + esc(p.suffix) : ''}</div></div>`).join(''), false) : ''}

    ${r.notes.length ? roomSec('他的便签', `${r.notes.length}`,
      r.notes.map((n) => `<div class="moment-note small">${esc(n.content)}</div>`).join(''), false) : ''}

    ${roomSec('最近几次醒来', `${r.entries.length} 条`,
      r.entries.length === 0
        ? '<div class="empty">还没醒过</div>'
        : r.entries.map((e) => `
          <div class="wake-row">
            <div class="wake-when">${fmt(e.at)}${e.forced ? '<span class="wake-forced">手动叫醒</span>' : ''}</div>
            <div class="wake-what">${esc(e.decision ? DECISION_TEXT[e.decision] || e.decision : e.skipped || '什么也没做')}</div>
            ${e.actions && e.actions.length ? `<div class="wake-actions">${
              e.actions.map((a) => `<span>${esc(ACTION_TEXT[a] || a)}</span>`).join('')
            }</div>` : ''}
            ${e.did ? `<div class="wake-did">${esc(e.did)}</div>` : ''}
          </div>`).join(''), true)}

    ${roomSec('手动', '叫醒', `
      <div class="row" style="border:0;padding:0">
        <span class="k">现在叫醒他一次</span>
        <button class="mini" id="wakeNow">叫醒</button>
      </div>`, false)}
  `;

  $('#wakeNow').addEventListener('click', async () => {
    toast('叫醒中…', 1600);
    try {
      await api('/admin/wake', { method: 'POST', body: JSON.stringify({ force: true }) });
      toast('叫醒了', 1400);
      setTimeout(pageWake, 900);
    } catch (err) {
      toast('失败：' + err.message, 2600);
    }
  });
}

/* ─────────── 占位页 ─────────── */
function pageSoon(title, note, em = 'soon') {
  $('#main').innerHTML = `<div class="soon"><span class="em">${em}</span><h3 class="serif" style="margin:0;font-size:17px">${title}</h3><p>${note}</p></div>`;
}

/* ─────────── 记忆库 · 星图 ─────────── */
const KIND_META = {
  episode: { label: '情景回忆', color: '#FDF9F0', r: 2.6 },
  experience: { label: '经历', color: '#A8C4E0', r: 2.0 },
  semantic: { label: '事实', color: '#C9C4D8', r: 1.5 },
  note: { label: '便签', color: '#C0A0B8', r: 1.8 },
};
const kindOf = (k) => KIND_META[k] || { label: k, color: '#B9B2C4', r: 1.5 };

/** 稳定伪随机（同一个 id 永远同一个值），用来给星星加抖动相位 */
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * 星级布局：环状星图。
 *
 * 角度来自随机投影的方向 —— 语义相近的记忆方向相近，于是会连成**弧**，
 * 看上去就是星座。半径按类型分层：奠基事件在最中心（亮核），
 * 情景回忆、经历一圈圈往外，其余事实铺成一圈很厚的环带。
 */
function layoutStars(points) {
  return points.map((p) => {
    const dx = p.x - 0.5;
    const dy = p.y - 0.5;
    const ang = Math.atan2(dy, dx);
    const j = hash01(p.id);
    let r;
    if (p.pinned) r = 0.045 + 0.05 * j;
    else if (p.kind === 'episode') r = 0.135 + 0.06 * j;
    else if (p.kind === 'experience') r = 0.25 + 0.08 * j;
    else r = 0.56 + 0.34 * j;
    return { ...p, ang, r, phase: j * Math.PI * 2, tw: 0.7 + j * 1.6 };
  });
}

let star = null; // 星图运行态

/* ─────────── 记忆审核 ─────────── */
/**
 * 他写下的记忆先落在这里，等她看过才进正式记忆库。
 *
 * 注意：整页必须套一个根容器（.mrv）。
 * 踩过的坑：直接把几块塞进 #main，那几块会被当成 flex 行项目拉成长条，
 * 标题被挤成竖排（截图里那个样子）。
 */
const MEMORY_FORMAT = {
  kind: 'episode | semantic | experience | reflection',
  content: '第一人称写的正文（必填）',
  event_time: 'YYYY-MM-DD',
  quotes: '[{ "who": "human|self", "text": "原句" }]',
  causal: '为什么重要（episode 必填）',
  importance: '0~1',
};

async function pageMemoryReview(status = 'pending') {
  const main = $('#main');
  main.innerHTML = '<div class="mrv"><div class="empty">读取中…</div></div>';

  let d;
  try {
    d = await api(`/memory/drafts?status=${status}&limit=60`);
  } catch (err) {
    main.innerHTML = `<div class="mrv"><div class="empty">读不到（${esc(err.message)}）</div></div>`;
    return;
  }

  const kindName = { episode: '一段对话', semantic: '一件事', experience: '他的经历', reflection: '他的想法' };
  const viaName = { save_memory: '对话里记的', nightly: '凌晨写的' };

  main.innerHTML = `
  <div class="mrv">
    <div class="subhead"><button class="mini" id="rvBack">← 记忆库</button><span>记忆审核</span></div>

    <details class="mrv-fmt">
      <summary>他存记忆的格式（哪里不对可以直接在下面改）</summary>
      <pre>{
  "kind": "${MEMORY_FORMAT.kind}",
  "content": "${MEMORY_FORMAT.content}",
  "event_time": "${MEMORY_FORMAT.event_time}",
  "quotes": ${MEMORY_FORMAT.quotes},
  "causal": "${MEMORY_FORMAT.causal}",
  "importance": "${MEMORY_FORMAT.importance}"
}</pre>
      <p>episode 必须同时有 quotes 和 causal，正文 ≥80 字；只想留一句话就用 semantic。
      没给日期会自动用当天。存进来的一律先落在待审，你点「通过」才进记忆库。</p>
    </details>

    <div class="mrv-tabs">
      ${[['pending', `待审 ${d.pending}`], ['approved', '已通过'], ['rejected', '已驳回'], ['all', '全部']]
        .map(([k, label]) => `<button class="mini ${status === k ? '' : 'ghost'}" data-st="${k}">${label}</button>`)
        .join('')}
    </div>

    ${d.drafts.length === 0
      ? `<div class="empty">${status === 'pending' ? '没有待审的记忆。他存的东西会出现在这里。' : '这里还没有记录。'}</div>`
      : d.drafts.map((x) => `
        <section class="card ornate mrv-item" data-draft="${x.id}">
          <div class="mrv-top">
            <span class="mrv-kind">${esc(kindName[x.kind] || x.kind)}</span>
            <span class="mrv-via">${esc(viaName[x.via] || x.via)}</span>
            <span class="mrv-st">${x.status === 'pending' ? '待审' : x.status === 'approved' ? '已通过' : '已驳回'}</span>
          </div>

          ${x.status === 'pending' ? `
            <div class="mrv-form">
              <label>类型
                <select data-f="kind">
                  ${['semantic', 'experience', 'reflection', 'episode'].map((k) =>
                    `<option value="${k}" ${x.kind === k ? 'selected' : ''}>${k === 'semantic' ? '一件事' : k === 'experience' ? '经历' : k === 'reflection' ? '想法' : '一段对话'}</option>`).join('')}
                </select>
              </label>
              <label>日期 <input type="date" data-f="date" value="${x.eventTime ? String(x.eventTime).slice(0, 10) : ''}" /></label>
              <label>重要度 <input type="number" data-f="imp" min="0.1" max="1" step="0.1" value="${x.importance}" /></label>
            </div>
            <textarea class="mrv-content" data-f="content" rows="4">${esc(x.content)}</textarea>
          ` : `
            <div class="mrv-body">${esc(x.content)}</div>
          `}

          ${x.causal ? `<div class="mrv-meta">因果：${esc(x.causal)}</div>` : ''}
          ${Array.isArray(x.quotes) && x.quotes.length
            ? `<div class="mrv-quote">${x.quotes.map((q) => `「${esc(q.text || '')}」`).join(' ')}</div>` : ''}

          ${x.status === 'pending' ? `
            <div class="mrv-acts">
              <button class="mini" data-ok="${x.id}">通过，进记忆库</button>
              <button class="mini ghost" data-no="${x.id}">不要</button>
            </div>` : ''}
        </section>`).join('')}
  </div>`;

  const back = $('#rvBack');
  if (back) back.addEventListener('click', () => go('memory'));
  main.querySelectorAll('[data-st]').forEach((b) =>
    b.addEventListener('click', () => pageMemoryReview(b.dataset.st)));

  main.querySelectorAll('[data-ok]').forEach((b) =>
    b.addEventListener('click', async () => {
      const card = b.closest('[data-draft]');
      const q = (name) => card.querySelector(`[data-f="${name}"]`);
      const body = {
        kind: q('kind')?.value,
        content: q('content')?.value,
        eventTime: q('date')?.value || undefined,
        importance: Number(q('imp')?.value || 0.5),
      };
      try {
        const r = await api(`/memory/drafts/${b.dataset.ok}/approve`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        toast(r.ok ? '通过了，进记忆库了' : `没通过：${r.error}`, 2200);
        pageMemoryReview(status);
      } catch (err) { toast('失败：' + err.message, 2400); }
    }));

  main.querySelectorAll('[data-no]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`/memory/drafts/${b.dataset.no}/reject`, { method: 'POST', body: '{}' });
        toast('驳回了', 1200);
        pageMemoryReview(status);
      } catch (err) { toast('失败：' + err.message, 2400); }
    }));
}

async function pageMemory() {
  const main = $('#main');
  main.innerHTML = `
    <div class="mem-wrap">
      <div class="mem-tools">
        <input type="search" id="memQ" placeholder="在心河里找一段记忆…" />
        <button class="mem-toggle" id="memReview">审核</button>
        <button class="mem-toggle" id="memView">列表</button>
      </div>
      <div class="mem-chips" id="memChips"></div>
      <div class="mem-stage" id="memStage">
        <canvas id="memCanvas"></canvas>
        <div class="mem-hint" id="memHint">拖动 · 双指缩放 · 点星看记忆</div>
      </div>
      <div class="mem-count" id="memCount"></div>
      <div class="mem-list" id="memList" hidden></div>
    </div>
    <div class="sheet" id="memSheet" hidden><div class="sheet-inner" id="memSheetBody"></div></div>
  `;

  let map;
  try {
    map = await api('/memory/starmap');
  } catch (err) {
    main.innerHTML = `<div class="empty">星图读不到（${esc(err.message)}）</div>`;
    return;
  }

  const canvas = $('#memCanvas');
  const stage = $('#memStage');
  const hint = $('#memHint');
  const countEl = $('#memCount');
  const chips = $('#memChips');
  const listEl = $('#memList');

  // 记忆审核入口：他写的东西先在那儿等她过一眼
  try {
    const d = await api('/memory/drafts?status=pending&limit=1');
    const btn = $('#memReview');
    if (btn) {
      btn.textContent = d.pending > 0 ? `审核 ${d.pending}` : '审核';
      if (d.pending > 0) btn.classList.add('has-dot');
      btn.addEventListener('click', () => pageMemoryReview());
    }
  } catch {
    /* 读不到就算，不影响星图 */
  }

  const pts = layoutStars(map.points);
  const byId = new Map(pts.map((p) => [p.id, p]));
  const edges = (map.edges || [])
    .map((e) => ({ a: byId.get(e.a), b: byId.get(e.b), sim: e.sim }))
    .filter((e) => e.a && e.b);

  const filter = new Set(map.kinds.map((k) => k.kind));
  const view = { scale: 1, x: 0, y: 0, rot: 0 };
  const screen = new Map(); // id -> {x,y}（每帧更新，点击命中用）

  star = { map, pts, edges, view, filter, canvas, stage, screen, raf: 0 };

  // ── 筛选 ──
  const renderChips = () => {
    chips.innerHTML = map.kinds
      .map((k) => {
        const m = kindOf(k.kind);
        return `<button class="chip-btn" data-k="${k.kind}" aria-pressed="${filter.has(k.kind)}">
          <i style="background:${m.color}"></i>${m.label} ${k.n}</button>`;
      })
      .join('');
    chips.querySelectorAll('.chip-btn').forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.k;
        if (filter.has(k) && filter.size === 1) map.kinds.forEach((x) => filter.add(x.kind));
        else if (filter.has(k)) filter.delete(k);
        else filter.add(k);
        renderChips();
        refreshList();
      }));
  };
  renderChips();

  // ── 画布 ──
  let W = 0, H = 0;
  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = stage.clientWidth;
    H = stage.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function project(p, t) {
    // 椭圆：宽扁，像参考图那样一圈星环
    const base = Math.min(W * 0.46, H * 0.5);
    const rx = base;
    const ry = base * 0.62;
    const rot = p.ang + view.rot;
    return {
      x: W / 2 + Math.cos(rot) * p.r * rx * view.scale + view.x,
      y: H / 2 + Math.sin(rot) * p.r * ry * view.scale + view.y,
    };
  }

  function frame(t) {
    const ctx = canvas.getContext('2d');
    const time = t / 1000;
    view.rot += 0.0009; // 极慢自转，让它像活的

    // 底：深空 + 中心光晕
    ctx.clearRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W / 2 + view.x, H / 2 + view.y, 0, W / 2 + view.x, H / 2 + view.y, Math.max(W, H) * 0.8);
    g.addColorStop(0, '#2a1b38');
    g.addColorStop(0.35, '#1a1020');
    g.addColorStop(0.75, '#0d0712');
    g.addColorStop(1, '#040206');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const coreGlow = ctx.createRadialGradient(W / 2 + view.x, H / 2 + view.y, 0, W / 2 + view.x, H / 2 + view.y, Math.min(W, H) * 0.20);
    coreGlow.addColorStop(0, 'rgba(224,180,140,0.18)');
    coreGlow.addColorStop(1, 'rgba(224,180,140,0)');
    ctx.fillStyle = coreGlow;
    ctx.fillRect(0, 0, W, H);

    screen.clear();

    // 星座连线（在星星下面）
    for (const e of edges) {
      if (!filter.has(e.a.kind) || !filter.has(e.b.kind)) continue;
      const pa = project(e.a, time);
      const pb = project(e.b, time);
      if (!Number.isFinite(pa.x) || !Number.isFinite(pb.x)) continue;
      const ctx2 = ctx;
      const grad = ctx2.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
      const alpha = Math.min(0.34, 0.08 + (e.sim - 0.3) * 0.5);
      grad.addColorStop(0, `rgba(243,217,184,${alpha})`);
      grad.addColorStop(1, `rgba(168,196,224,${alpha * 0.55})`);
      ctx2.strokeStyle = grad;
      ctx2.lineWidth = 0.8;
      ctx2.beginPath();
      ctx2.moveTo(pa.x, pa.y);
      ctx2.lineTo(pb.x, pb.y);
      ctx2.stroke();
    }

    // 星星
    for (const p of pts) {
      if (!filter.has(p.kind)) continue;
      const s = project(p, time);
      screen.set(p.id, s);
      if (s.x < -20 || s.y < -20 || s.x > W + 20 || s.y > H + 20) continue;

      const twinkle = 0.42 + 0.5 * (0.5 + 0.5 * Math.sin(time * p.tw + p.phase));
      const meta = kindOf(p.kind);

      if (p.pinned) {
        const rr = 9 + 1.6 * Math.sin(time * 1.6 + p.phase);
        const rg = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, rr * 2.2);
        rg.addColorStop(0, `rgba(243,217,184,${0.85 * twinkle + 0.15})`);
        rg.addColorStop(0.35, `rgba(224,180,140,${0.3 * twinkle})`);
        rg.addColorStop(1, 'rgba(224,180,140,0)');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(s.x, s.y, rr * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#FBF0DC';
        ctx.beginPath();
        ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      const rad = meta.r * Math.min(3, Math.max(1, view.scale * 0.9));
      ctx.globalAlpha = Math.min(1, twinkle * (0.55 + p.importance * 0.5));
      ctx.fillStyle = meta.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    const visible = pts.filter((p) => filter.has(p.kind)).length;
    countEl.textContent = `${visible} / ${pts.length} 颗 · ${edges.length} 条星座线`;

    star.raf = requestAnimationFrame(frame);
  }

  function start() {
    cancelAnimationFrame(star.raf);
    resize();
    star.raf = requestAnimationFrame(frame);
  }
  function stop() {
    cancelAnimationFrame(star.raf);
  }

  // ── 交互 ──
  let dragging = false;
  let last = null;
  let pinch = null;
  let moved = 0;

  const ptOf = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    dragging = true;
    moved = 0;
    last = ptOf(e);
    hint.style.display = 'none';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || pinch) return;
    const p = ptOf(e);
    view.x += p.x - last.x;
    view.y += p.y - last.y;
    moved += Math.abs(p.x - last.x) + Math.abs(p.y - last.y);
    last = p;
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    if (moved < 10) pickOnce(ptOf(e));
  });
  canvas.addEventListener('pointercancel', () => { dragging = false; });

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), scale: view.scale };
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinch) {
      e.preventDefault();
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      view.scale = Math.max(0.5, Math.min(9, pinch.scale * (d / pinch.d)));
    }
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => {
    if (pinch) { pinch = null; return; }
    // 兜底：有些浏览器在 pinch 时 preventDefault 过 touchmove 之后就不发 pointerup 了，
    // 于是"放大后点不动"。这里再补一次点击判定，用时间戳防重复触发。
    if (dragging && moved < 10 && e.changedTouches.length) {
      const t = e.changedTouches[0];
      const r = canvas.getBoundingClientRect();
      pickOnce({ x: t.clientX - r.left, y: t.clientY - r.top });
      dragging = false;
    }
    pinch = null;
  });

  let lastPickAt = 0;
  const pickOnce = (p) => {
    if (Date.now() - lastPickAt < 400) return;
    lastPickAt = Date.now();
    pickAt(p);
  };

  /**
   * 命中。两个关键点：
   *   1) 容差**随缩放变大** —— 放大之后星星彼此离得远，34px 的圈根本够不着，
   *      她说的"放大后反而点不动"就是这个。
   *   2) 真的没点到星时，退一步找**最近的**那颗（160px 以内），
   *      而不是一句"这附近没有星"把人挡回去。
   */
  function pickAt(p) {
    const tol = 40 + 18 * Math.log2(Math.max(1, view.scale));
    const hits = [];
    let nearest = null;
    let nearestD = Infinity;

    for (const s of pts) {
      if (!filter.has(s.kind)) continue;
      const pos = screen.get(s.id);
      if (!pos) continue;
      const d = Math.hypot(pos.x - p.x, pos.y - p.y);
      if (d < tol) hits.push({ s, d });
      if (d < nearestD) { nearestD = d; nearest = s; }
    }

    if (!hits.length) {
      if (nearest && nearestD < 160) return openStar(nearest.id);
      hint.textContent = '这附近没有星，换个地方点点';
      hint.style.display = '';
      return;
    }
    hits.sort((a, b) => (b.s.pinned - a.s.pinned) || (b.s.importance - a.s.importance) || (a.d - b.d));
    if (hits.length === 1) return openStar(hits[0].s.id);

    // 多颗重叠 -> 让她选
    const sheet = $('#memSheet');
    const body = $('#memSheetBody');
    sheet.hidden = false;
    body.innerHTML = `
      <div class="sheet-head"><span class="tag">这里有好几颗星</span>
        <button class="sheet-close">×</button>
      </div>
      ${hits.slice(0, 8).map((h) => `
        <button class="pick-row" data-id="${h.s.id}">
          <i style="background:${kindOf(h.s.kind).color}"></i>
          <span>${esc(h.s.head)}</span>
        </button>`).join('')}
    `;
    body.querySelector('.sheet-close').addEventListener('click', () => { sheet.hidden = true; });
    body.querySelectorAll('.pick-row').forEach((b) =>
      b.addEventListener('click', () => openStar(b.dataset.id)));
  }

  async function openStar(id) {
    const sheet = $('#memSheet');
    const body = $('#memSheetBody');
    sheet.hidden = false;
    body.innerHTML = '<div class="empty">读取中…</div>';
    try {
      const { item } = await api(`/memory/item/${id}`);
      const when = item.event_time || item.ingested_at || '';
      const m = kindOf(String(item.kind));
      body.innerHTML = `
        <div class="sheet-head">
          <span class="tag" style="color:${m.color}">${m.label}</span>
          ${item.pinned ? '<span class="tag gold">奠基</span>' : ''}
          <button class="sheet-close">×</button>
        </div>
        <div class="sheet-date">${esc(String(when).slice(0, 16).replace('T', ' '))}</div>
        <div class="sheet-text">${esc(String(item.content))}</div>
        <div class="sheet-meta">重要度 ${Number(item.importance).toFixed(2)} · 想起过 ${item.recall_count} 次 · 状态 ${esc(String(item.state))}</div>
      `;
      body.querySelector('.sheet-close').addEventListener('click', () => { sheet.hidden = true; });
    } catch (err) {
      body.innerHTML = `<div class="empty">读不到（${esc(err.message)}）</div>`;
    }
  }
  $('#memSheet').addEventListener('click', (e) => {
    if (e.target.id === 'memSheet') $('#memSheet').hidden = true;
  });

  // ── 列表（跟着筛选走） ──
  let listMode = false;
  let listRows = [];

  async function loadList(q) {
    try {
      const r = await api(`/memory/search?limit=60${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      listRows = r.rows;
      renderList();
    } catch (err) {
      listEl.innerHTML = `<div class="empty">查询失败（${esc(err.message)}）</div>`;
    }
  }

  function renderList() {
    const rows = listRows.filter((r) => filter.has(String(r.kind)));
    listEl.innerHTML = rows.length
      ? rows.map((r) => `
        <button class="mem-row" data-id="${r.id}">
          <span class="mem-row-date">${esc(String(r.event_time || r.ingested_at || '').slice(0, 10))}</span>
          <span class="mem-row-kind" style="color:${kindOf(String(r.kind)).color}">${kindOf(String(r.kind)).label}</span>
          <span class="mem-row-text">${esc(String(r.head || ''))}</span>
        </button>`).join('')
      : '<div class="empty">这个筛选下没有记忆</div>';
    listEl.querySelectorAll('.mem-row').forEach((b) =>
      b.addEventListener('click', () => openStar(b.dataset.id)));
  }

  function refreshList() {
    if (listMode) renderList();
  }

  $('#memView').addEventListener('click', () => {
    listMode = !listMode;
    $('#memView').textContent = listMode ? '星图' : '列表';
    stage.hidden = listMode;
    chips.querySelectorAll('.chip-btn').forEach((b) => { b.style.display = ''; });
    listEl.hidden = !listMode;
    if (listMode) {
      if (!listRows.length) loadList($('#memQ').value.trim());
      else renderList();
      stop();
    } else {
      start();
    }
  });

  let timer = null;
  $('#memQ').addEventListener('input', (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    timer = setTimeout(() => {
      if (!listMode) $('#memView').click();
      loadList(q);
    }, 320);
  });

  new ResizeObserver(() => { if (!listMode) { resize(); } }).observe(stage);
  start();

  // 离开这一页就停掉动画（省电）
  window.__stopStars = stop;
}

/* ─────────── 工具（入口页） ─────────── */
const TOOL_ITEMS = [
  { id: 'mind', label: '心境', desc: '他此刻的欲望与底色', em: '◈' },
  { id: 'review', label: '记忆整理', desc: '筛掉没必要的 · 补上时间', em: '✎' },
  { id: 'usage', label: '记账', desc: '余额 · 用量 · 趋势', em: '¥' },
  { id: 'status', label: '系统状态', desc: '数据库 · 向量 · 闸门 · 任务', em: '◎' },
  { id: 'sleep', label: '睡眠', desc: '手动记 · 他要用工具查', em: '☾' },
  { id: 'health', label: '身体', desc: '步数 · 消耗 · 喝水（留两周）', em: '❤' },
  { id: 'calendar', label: '日历', desc: '每日状态 · 经期', em: '▦' },
  { id: 'games', label: '游戏', desc: '还没想好', em: '✧', soon: true },
];

function pageTools() {
  $('#main').innerHTML = `
    <div class="tool-grid">
      ${TOOL_ITEMS.map((t) => `
        <button class="tool-tile" data-tool="${t.id}">
          <span class="tool-em">${t.em}</span>
          <b>${t.label}</b>
          <span>${t.desc}</span>
        </button>`).join('')}
    </div>
  `;
  $('#main').querySelectorAll('.tool-tile').forEach((b) =>
    b.addEventListener('click', () => pageTool(b.dataset.tool)));
}

function toolBackRow(label) {
  return `<div class="subhead">
    <button class="mini" id="toolBack">← 工具</button>
    <span>${esc(label)}</span>
  </div>`;
}

function bindToolBack() {
  const b = $('#toolBack');
  if (b) b.addEventListener('click', () => pageTools());
}

async function pageTool(id) {
  if (id === 'mind') return pageToolMind();
  if (id === 'review') return pageToolReview();
  if (id === 'usage') return pageToolUsage();
  if (id === 'status') return pageToolStatus();
  if (id === 'sleep') return pageToolSleep();
  if (id === 'health') return pageToolHealth();
  if (id === 'calendar') return pageToolCalendar();
  const t = TOOL_ITEMS.find((x) => x.id === id);
  $('#main').innerHTML = `${toolBackRow(t ? t.label : '')}
    <div class="soon"><span class="em">${t ? t.em : '✧'}</span><p>这个模块还没做。</p></div>`;
  bindToolBack();
}

/* ─────────── 工具 · 记忆整理 ─────────── */
const KIND_LABEL = {
  episode: '一段对话',
  semantic: '一件事',
  experience: '他的经历',
  reflection: '他的想法',
  pinned: '底座',
};

async function pageToolReview(filter = 'no_time', offset = 0) {
  const main = $('#main');
  main.innerHTML = `${toolBackRow('记忆整理')}<div class="empty">读取中…</div>`;
  bindToolBack();

  let d;
  try {
    d = await api(`/memory/review?filter=${filter}&limit=20&offset=${offset}`);
  } catch (err) {
    main.innerHTML = `${toolBackRow('记忆整理')}<div class="empty">读不到（${esc(err.message)}）</div>`;
    bindToolBack();
    return;
  }

  const st = d.stats;
  const items = d.items;

  main.innerHTML = `${toolBackRow('记忆整理')}
    <section class="card ornate">
      <div class="card-title">现状</div>
      <div class="usage-row" style="margin-top:0">
        <span>共 ${st.total} 条</span>
        <span>没日期 ${st.noTime}</span>
        <span>第三人称 ${st.thirdPerson}</span>
      </div>
      <p class="mind-note">
        没日期的记忆被召回时会混进当前对话 —— 因为它说不清"这是什么时候的事"。
        下面一条条看：没必要的删，有必要留的补上日期。
      </p>
      <div class="rv-tabs">
        ${[['no_time', '没日期的'], ['third_person', '第三人称摘要'], ['all', '全部']].map(([k, label]) =>
          `<button class="mini ${filter === k ? '' : 'ghost'}" data-filter="${k}">${label}</button>`).join('')}
      </div>
    </section>

    <section class="card ornate">
      <div class="card-title">来源分布<span class="caps">可以整批删</span></div>
      ${st.bySource.map((s) => `
        <div class="row">
          <span class="k" style="font-size:13px">${esc(s.source)}</span>
          <span class="v">${s.n} 条
            ${['compressor', 'ltm_v13'].includes(s.source)
              ? `<button class="mini ghost" data-bulk="${esc(s.source)}" style="margin-left:8px">全删</button>`
              : ''}
          </span>
        </div>`).join('')}
    </section>

    <section class="card ornate">
      <div class="card-title">一条一条看<span class="caps">${items.length} 条</span></div>
      ${items.length === 0 ? '<div class="empty">这个筛选下没有了</div>' : items.map((m) => `
        <div class="rv-item" data-id="${m.id}">
          <div class="rv-top">
            <span class="rv-when ${m.eventTime ? '' : 'bad'}">${m.eventTime ? String(m.eventTime).slice(0, 10) : '没有日期'}</span>
            <span class="rv-kind">${KIND_LABEL[m.kind] || m.kind}</span>
            <span class="rv-src">${esc(m.source)}</span>
            ${m.thirdPerson ? '<span class="rv-flag">第三人称</span>' : ''}
          </div>
          <div class="rv-body">${esc(m.content)}</div>
          <div class="rv-acts">
            <button class="mini" data-time="${m.id}">补日期</button>
            <button class="mini ghost" data-del="${m.id}">删掉</button>
          </div>
        </div>`).join('')}
      <div class="rv-more">
        ${offset > 0 ? `<button class="mini ghost" id="rvPrev">上一页</button>` : ''}
        ${items.length === 20 ? `<button class="mini" id="rvNext" style="margin-left:8px">下一页</button>` : ''}
      </div>
    </section>
  `;
  bindToolBack();

  main.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => pageToolReview(b.dataset.filter, 0)));

  const prev = $('#rvPrev');
  if (prev) prev.addEventListener('click', () => pageToolReview(filter, Math.max(0, offset - 20)));
  const next = $('#rvNext');
  if (next) next.addEventListener('click', () => pageToolReview(filter, offset + 20));

  main.querySelectorAll('[data-time]').forEach((b) =>
    b.addEventListener('click', async () => {
      const day = prompt('这条是哪一天的事？（YYYY-MM-DD）', String(new Date().toISOString().slice(0, 10)));
      if (!day) return;
      try {
        await api(`/memory/review/${b.dataset.time}/time`, {
          method: 'POST',
          body: JSON.stringify({ eventTime: day }),
        });
        toast('补上了', 1200);
        pageToolReview(filter, offset);
      } catch (err) { toast('失败：' + err.message, 2400); }
    }));

  main.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('删掉这条？删了就不再出现在回忆里。')) return;
      try {
        await api(`/memory/review/${b.dataset.del}`, { method: 'DELETE' });
        toast('删了', 1000);
        pageToolReview(filter, offset);
      } catch (err) { toast('失败：' + err.message, 2400); }
    }));

  main.querySelectorAll('[data-bulk]').forEach((b) =>
    b.addEventListener('click', async () => {
      const src = b.dataset.bulk;
      if (!confirm(`把来源「${src}」的记忆全部删掉？这个不能撤销。`)) return;
      try {
        const r = await api('/memory/review/bulk-delete', {
          method: 'POST',
          body: JSON.stringify({ source: src }),
        });
        toast(`删了 ${r.deleted} 条`, 2000);
        pageToolReview(filter, 0);
      } catch (err) { toast('失败：' + err.message, 2400); }
    }));
}

/* ─────────── 工具 · 心境 ─────────── */

/** 六轴雷达：值域 0~100 */
function radarSvg(axes, size = 300) {
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.33;
  const n = axes.length;
  const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i, r) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];
  const f = (x) => x.toFixed(1);

  const grid = [0.25, 0.5, 0.75, 1]
    .map((k) => {
      const pts = axes.map((_, i) => pt(i, R * k).map(f).join(',')).join(' ');
      return `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-opacity="${k === 1 ? 0.3 : 0.13}" stroke-width="1"/>`;
    })
    .join('');

  const spokes = axes
    .map((_, i) => {
      const [x, y] = pt(i, R);
      return `<line x1="${cx}" y1="${cy}" x2="${f(x)}" y2="${f(y)}" stroke="currentColor" stroke-opacity="0.13" stroke-width="1"/>`;
    })
    .join('');

  const shape = axes
    .map((a, i) => pt(i, R * Math.max(0.03, a.value / 100)).map(f).join(','))
    .join(' ');

  const dots = axes
    .map((a, i) => {
      const [x, y] = pt(i, R * Math.max(0.03, a.value / 100));
      return `<circle cx="${f(x)}" cy="${f(y)}" r="3.2" fill="var(--accent)"/>`;
    })
    .join('');

  const labels = axes
    .map((a, i) => {
      const [x, y] = pt(i, R * 1.28);
      const dx = Math.cos(ang(i));
      const anchor = dx > 0.35 ? 'start' : dx < -0.35 ? 'end' : 'middle';
      const dy = Math.sin(ang(i)) < -0.5 ? -6 : 6;
      const d = a.delta > 0 ? `↑${a.delta}` : a.delta < 0 ? `↓${-a.delta}` : '·';
      return `<text x="${f(x)}" y="${f(y + dy)}" text-anchor="${anchor}" class="radar-lb">
          <tspan x="${f(x)}" dy="0">${esc(a.label)}</tspan>
          <tspan x="${f(x)}" dy="15" class="radar-val">${a.value}<tspan class="radar-delta"> ${d}</tspan></tspan>
        </text>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${size} ${size}" class="radar" style="color:var(--line)">
    ${grid}${spokes}
    <polygon points="${shape}" fill="var(--accent)" fill-opacity="0.13" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round"/>
    ${dots}${labels}
  </svg>`;
}

async function pageToolMind() {
  const main = $('#main');
  main.innerHTML = `${toolBackRow('心境')}<div class="empty">读取中…</div>`;
  bindToolBack();

  let d;
  try {
    d = await api('/mind');
  } catch (err) {
    main.innerHTML = `${toolBackRow('心境')}<div class="empty">读不到（${esc(err.message)}）</div>`;
    bindToolBack();
    return;
  }

  const now = new Date(d.at);
  const sinceText =
    d.sinceLastWakeMinutes === null
      ? '还没醒过'
      : d.sinceLastWakeMinutes < 60
        ? `距上次 ${d.sinceLastWakeMinutes} 分钟`
        : `距上次 ${Math.round(d.sinceLastWakeMinutes / 60)} 小时`;

  const bar = (label, v) => `
    <div class="mood-bar">
      <span class="mb-label">${label}</span>
      <span class="mb-track"><i style="width:${v ?? 0}%"></i></span>
      <span class="mb-num">${v ?? '—'}</span>
    </div>`;

  main.innerHTML = `${toolBackRow('心境')}
    <section class="card ornate mind-card">
      <div class="mind-head">
        <div>
          <div class="mind-title">心境</div>
          <div class="mind-sub">${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${hhmm(now)}</div>
        </div>
        <div class="mind-right">
          <div class="mind-en">Animus</div>
          <div class="mind-sub">${esc(sinceText)}</div>
        </div>
      </div>

      <div class="mind-sep">当下情感</div>
      ${radarSvg(d.radar)}
      <p class="mind-note">这六个是关系层和认知层里最能说明"他此刻是谁"的。数字来自欲望状态，箭头是相对上一次的变化。</p>

      <div class="mind-sep">情绪底色</div>
      ${bar('愉悦度', d.mood.pleasure)}
      ${bar('唤醒度', d.mood.arousal)}
      ${bar('主动性', d.mood.initiative)}
      <p class="mind-note">${esc(d.mood.source)}</p>

      ${d.truth ? `
        <div class="mind-sep">真心话</div>
        <div class="mind-quote">
          <div class="mq-label">${esc(d.truth.kind)}</div>
          <div class="mq-text">${esc(d.truth.text)}</div>
        </div>` : ''}

      ${d.wishes.length ? `
        <div class="mind-sep">愿望清单</div>
        <div class="mind-wishes">
          ${d.wishes.map((w) => `
            <div class="mw-row">
              <span class="mw-No">0${w.rank}</span>
              <span class="mw-text">${esc(w.text)}</span>
              <span class="mw-from">${esc(w.from)}</span>
            </div>`).join('')}
        </div>` : ''}

      <div class="mind-sep">闸门</div>
      <div class="mind-gates">
        ${d.gates.map((g) => `
          <span class="mg ${g.blocked ? 'on' : ''}">${esc(g.label)} ${g.value}${g.blocked ? ' · 压着主动' : ''}</span>`).join('')}
      </div>
    </section>

    <section class="card ornate">
      <div class="card-title">说明</div>
      <p class="mind-note" style="margin:0">
        这些数字不是装饰：累和烦超过 60 会压住他主动找你；想你超过基线加 8 才会进对话提示。
      </p>
      <div class="row" style="border:0;padding:12px 0 0">
        <button class="mini" id="mindRefresh">重新算</button>
      </div>
    </section>
  `;
  bindToolBack();
  $('#mindRefresh').addEventListener('click', () => pageToolMind());
}

/* ─────────── 工具 · 身体（步数/消耗/喝水）─────────── */
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function pageToolHealth() {
  const main = $('#main');
  main.innerHTML = `${toolBackRow('身体')}<div class="empty">读取中…</div>`;
  bindToolBack();

  let data;
  try {
    data = await api('/body?days=14');
  } catch (err) {
    main.innerHTML = `${toolBackRow('身体')}<div class="empty">读不到（${esc(err.message)}）</div>`;
    bindToolBack();
    return;
  }

  const rows = data.days || [];
  const today = rows.find((r) => r.day === todayISO()) || null;

  main.innerHTML = `
    ${toolBackRow('身体')}
    <section class="card ornate">
      <div class="card-title">今天<span class="caps">${esc(todayISO())}</span></div>
      <div class="health-form">
        <label>步数<input type="number" id="hSteps" inputmode="numeric" value="${today?.steps ?? ''}" placeholder="8000" /></label>
        <label>消耗<input type="number" id="hCal" inputmode="numeric" value="${today?.calories ?? ''}" placeholder="千卡" /></label>
        <label>喝水<input type="number" id="hWater" inputmode="numeric" value="${today?.waterMl ?? ''}" placeholder="ml" /></label>
        <label>活动<input type="number" id="hActive" inputmode="numeric" value="${today?.activeMin ?? ''}" placeholder="分钟" /></label>
      </div>
      <div class="row" style="border:0;padding:12px 0 0">
        <button class="mini" id="hSave">存今天</button>
        <span class="v">只保留最近 ${data.keepDays} 天，更早的自动删</span>
      </div>
    </section>

    <section class="card ornate">
      <div class="card-title">近 ${data.keepDays} 天</div>
      ${rows.length === 0 ? '<div class="empty">还没有记录</div>' : rows.map((r) => `
        <div class="row">
          <span class="k" style="font-size:13px">${r.day.slice(5)}</span>
          <span class="v">${r.steps ?? '—'} 步 · ${r.calories ?? '—'} 千卡 · ${r.waterMl ?? '—'}ml${r.activeMin ? ` · 活动 ${r.activeMin} 分` : ''}</span>
        </div>`).join('')}
    </section>
  `;
  bindToolBack();

  $('#hSave').addEventListener('click', async () => {
    const val = (id) => {
      const v = $(id).value.trim();
      return v === '' ? null : Number(v);
    };
    try {
      await api('/body', {
        method: 'POST',
        body: JSON.stringify({
          day: todayISO(),
          steps: val('#hSteps'),
          calories: val('#hCal'),
          waterMl: val('#hWater'),
          activeMin: val('#hActive'),
        }),
      });
      toast('记好了', 1400);
      pageToolHealth();
    } catch (err) {
      toast('保存失败：' + err.message, 2600);
    }
  });
}

/* ─────────── 工具 · 日历（每日状态 + 经期）─────────── */
async function pageToolCalendar(ym) {
  const main = $('#main');
  const now = new Date();
  const year = ym?.year ?? now.getFullYear();
  const month = ym?.month ?? now.getMonth() + 1;
  main.innerHTML = `${toolBackRow('日历')}<div class="empty">读取中…</div>`;
  bindToolBack();

  let cal;
  let cyc;
  try {
    [cal, cyc] = await Promise.all([
      api(`/calendar?year=${year}&month=${month}`),
      api('/calendar/cycle'),
    ]);
  } catch (err) {
    main.innerHTML = `${toolBackRow('日历')}<div class="empty">读不到（${esc(err.message)}）</div>`;
    bindToolBack();
    return;
  }

  const first = new Date(year, month - 1, 1);
  const startPad = (first.getDay() + 6) % 7; // 周一为第一列
  const st = cyc.status;

  main.innerHTML = `
    ${toolBackRow('日历')}
    <section class="card ornate">
      <div class="cal-head">
        <button class="mini" id="calPrev">‹</button>
        <span class="cal-title">${year} 年 ${month} 月</span>
        <button class="mini" id="calNext">›</button>
      </div>
      <div class="cal-grid">
        ${['一', '二', '三', '四', '五', '六', '日'].map((d) => `<span class="cal-dow">${d}</span>`).join('')}
        ${Array.from({ length: startPad }, () => '<span></span>').join('')}
        ${cal.days.map((d) => `
          <button class="cal-day ${d.inPeriod ? 'period' : ''} ${d.state ? 'has' : ''} ${d.cycle ? 'mark' : ''}"
                  data-day="${d.day}" title="${d.state ? esc([d.state.mood, d.state.note].filter(Boolean).join(' / ')) : ''}">
            ${Number(d.day.slice(8))}
            ${d.cycle ? `<i class="cal-mark">${d.cycle === 'start' ? '起' : '止'}</i>` : ''}
          </button>`).join('')}
      </div>
      <p style="font-size:var(--fs-small);color:var(--muted);margin:10px 0 0">
        点一天可以记状态；粉色是经期里。
      </p>
    </section>

    <section class="card ornate">
      <div class="card-title">经期</div>
      <div class="row"><span class="k">上次开始</span><span class="v">${st.lastStart ?? '还没记过'}</span></div>
      <div class="row"><span class="k">这次</span><span class="v">${st.ongoing ? '还没点结束' : '—'}</span></div>
      <div class="row"><span class="k">平均周期</span><span class="v">${st.avgLengthDays ? `${st.avgLengthDays} 天（${st.samples} 次记录）` : '—'}</span></div>
      <div class="row"><span class="k">下次大概</span><span class="v">${st.nextEstimate ? `${st.nextEstimate}（${st.daysUntilNext > 0 ? '还有 ' + st.daysUntilNext + ' 天' : '已过 ' + (-st.daysUntilNext) + ' 天'}，估算）` : '—'}</span></div>
      <div class="row" style="border:0;padding-top:12px">
        <button class="mini" id="cycStart">今天开始</button>
        <button class="mini" id="cycEnd" style="margin-left:8px">今天结束</button>
      </div>

      <div class="cyc-backfill">
        <div class="cb-head">忘了记？补到某一天</div>
        <input type="date" id="cycDay" value="${todayISO()}" max="${todayISO()}" />
        <div class="cb-btns">
          <button class="mini" id="cycStartOn">记为开始</button>
          <button class="mini" id="cycEndOn">记为结束</button>
          <button class="mini ghost" id="cycClear">取消这天标记</button>
        </div>
      </div>

      ${(cyc.entries || []).length ? `
        <div class="cyc-list">
          ${cyc.entries.map((e) => `
            <div class="row">
              <span class="k" style="font-size:12.5px">${e.day.slice(5)} <span class="cyc-kind">${e.kind === 'start' ? '开始' : '结束'}</span></span>
              <button class="mini ghost" data-cyc-del="${e.kind}:${e.day}">删</button>
            </div>`).join('')}
        </div>` : ''}
    </section>

    <section class="card ornate">
      <div class="card-title">每日状态<span class="caps">最近</span></div>
      ${cal.days.filter((d) => d.state).length === 0
        ? '<div class="empty">这个月还没有记录</div>'
        : cal.days.filter((d) => d.state).slice().reverse().map((d) => `
          <div class="row">
            <span class="k" style="font-size:13px">${d.day.slice(5)}</span>
            <span class="v">${esc([d.state.mood, d.state.energy ? `精力 ${d.state.energy}/5` : null, d.state.note].filter(Boolean).join(' · '))}</span>
          </div>`).join('')}
    </section>
  `;
  bindToolBack();

  $('#calPrev').addEventListener('click', () => {
    const m = month - 1;
    pageToolCalendar(m < 1 ? { year: year - 1, month: 12 } : { year, month: m });
  });
  $('#calNext').addEventListener('click', () => {
    const m = month + 1;
    pageToolCalendar(m > 12 ? { year: year + 1, month: 1 } : { year, month: m });
  });

  main.querySelectorAll('.cal-day').forEach((b) =>
    b.addEventListener('click', async () => {
      const day = b.dataset.day;
      const cur = cal.days.find((d) => d.day === day)?.state;
      const mood = prompt(`${day} 心情？（开心/累/低落…留空就不改）`, cur?.mood ?? '');
      if (mood === null) return;
      const energy = prompt('精力 1~5？（留空就不改）', cur?.energy ? String(cur.energy) : '');
      if (energy === null) return;
      const note = prompt('想记一句什么？', cur?.note ?? '');
      if (note === null) return;
      try {
        await api('/calendar/day', {
          method: 'POST',
          body: JSON.stringify({
            day,
            mood: mood.trim() || null,
            energy: energy.trim() ? Number(energy) : null,
            note: note.trim() || null,
          }),
        });
        toast('记好了', 1200);
        pageToolCalendar({ year, month });
      } catch (err) {
        toast('保存失败：' + err.message, 2400);
      }
    }));

  const markCycle = async (kind, day) => {
    try {
      await api('/calendar/cycle', { method: 'POST', body: JSON.stringify({ kind, day: day || todayISO() }) });
      toast(`${day && day !== todayISO() ? day.slice(5) + ' ' : '今天'}记下了${kind === 'start' ? '开始' : '结束'}`, 1600);
      pageToolCalendar({ year, month });
    } catch (err) {
      toast('失败：' + err.message, 2400);
    }
  };
  $('#cycStart').addEventListener('click', () => markCycle('start'));
  $('#cycEnd').addEventListener('click', () => markCycle('end'));

  // 补记：忘了当天记，也可以补到过去某一天
  $('#cycStartOn').addEventListener('click', () => markCycle('start', $('#cycDay').value));
  $('#cycEndOn').addEventListener('click', () => markCycle('end', $('#cycDay').value));
  $('#cycClear').addEventListener('click', async () => {
    const day = $('#cycDay').value;
    if (!day) return toast('先选一天');
    try {
      await Promise.all([
        api(`/calendar/cycle/start/${day}`, { method: 'DELETE' }),
        api(`/calendar/cycle/end/${day}`, { method: 'DELETE' }),
      ]);
      toast(`${day.slice(5)} 的标记清掉了`, 1400);
      pageToolCalendar({ year, month });
    } catch (err) {
      toast('失败：' + err.message, 2400);
    }
  });

  main.querySelectorAll('[data-cyc-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const [kind, day] = String(b.dataset.cycDel).split(':');
      try {
        await api(`/calendar/cycle/${kind}/${day}`, { method: 'DELETE' });
        toast('删掉了', 1200);
        pageToolCalendar({ year, month });
      } catch (err) {
        toast('失败：' + err.message, 2400);
      }
    }));
}

/* ─────────── 工具 · 睡眠 ─────────── */
const hmOf = (min) => (min === null || min === undefined ? '—' : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`);

async function pageToolSleep() {
  const main = $('#main');
  main.innerHTML = `${toolBackRow('睡眠')}<div class="empty">读取中…</div>`;
  bindToolBack();

  let data;
  try {
    data = await api('/sleep?days=30');
  } catch (err) {
    main.innerHTML = `${toolBackRow('睡眠')}<div class="empty">读不到（${esc(err.message)}）</div>`;
    bindToolBack();
    return;
  }

  const st = data.stats;
  const recs = data.records;
  const maxTotal = Math.max(1, ...st.trend.map((t) => t.totalMinutes || 0));

  main.innerHTML = `
    ${toolBackRow('睡眠')}

    <section class="card ornate">
      <div class="card-title">记一晚<span class="caps">自己记</span></div>
      <div class="health-form" style="grid-template-columns:1fr 1fr">
        <label>哪一晚<input type="date" id="sNight" value="${todayISO()}" max="${todayISO()}" /></label>
        <label>总睡眠（分钟）<input type="number" id="sTotal" inputmode="numeric" placeholder="451" /></label>
        <label>入睡<input type="time" id="sBed" value="23:00" /></label>
        <label>醒来<input type="time" id="sWake" value="07:00" /></label>
        <label>深睡（分钟）<input type="number" id="sDeep" inputmode="numeric" placeholder="75" /></label>
        <label>夜里醒了几次<input type="number" id="sAwake" inputmode="numeric" placeholder="2" /></label>
      </div>
      <div class="row" style="border:0;padding:12px 0 0">
        <button class="mini" id="sSave">存下来</button>
        <span class="v">${st.count} 晚记录</span>
      </div>
      <p class="mind-note">
        这些数字只有你在问他的时候他才会去查（get_sleep 工具）。平时不往他的上下文里塞。
      </p>
    </section>

    <section class="card ornate">
      <div class="card-title">或者发手环截图<span class="caps">自动读</span></div>
      <p style="font-size:var(--fs-small);color:var(--muted);margin:0 0 12px">
        懒得手填就发截图，模型直接从图里读数字。读不准的可以点下面那条改。
      </p>
      <div class="row" style="border:0;padding:0">
        <button class="mini" id="sleepPick">选截图</button>
        <span class="v" id="sleepState">${st.count} 晚记录</span>
      </div>
      <input type="file" id="sleepFile" accept="image/*" hidden />
    </section>

    <section class="card ornate">
      <div class="card-title">最近 30 天</div>
      <div class="usage-row" style="margin-top:0">
        <span>平均睡 ${hmOf(st.avgTotalMinutes)}</span>
        <span>深睡 ${st.avgDeepPct ?? '—'}%</span>
        <span>入睡 ${st.avgBedtime ?? '—'}</span>
      </div>
      <div class="bars" style="margin-top:12px">
        ${st.trend.length === 0 ? '<div class="empty">还没有记录</div>'
          : st.trend.slice(-14).map((t) => {
              const h = Math.max(4, Math.round(((t.totalMinutes || 0) / maxTotal) * 70));
              return `<div class="bar-item" title="${t.night} ${hmOf(t.totalMinutes)} 深睡${t.deepPct ?? '—'}%">
                <div class="bar" style="height:${h}px"></div>
                <span>${t.night.slice(5)}</span>
              </div>`;
            }).join('')}
      </div>
    </section>

    <section class="card ornate">
      <div class="card-title">每一晚<span class="caps">点一条可以改</span></div>
      ${recs.length === 0 ? '<div class="empty">还没有记录</div>'
        : recs.map((r) => {
            const deepPct = r.deepMinutes && r.totalMinutes ? Math.round((r.deepMinutes / r.totalMinutes) * 100) : null;
            return `<button class="sleep-row" data-night="${r.night}">
              <span class="sleep-date">${r.night.slice(5)}</span>
              <span class="sleep-main">${hmOf(r.totalMinutes)}</span>
              <span class="sleep-sub">深睡 ${r.deepMinutes !== null ? hmOf(r.deepMinutes) : '—'}${deepPct !== null ? ` (${deepPct}%)` : ''} · 醒 ${r.awakeCount ?? '—'} 次</span>
              <span class="sleep-bed">${r.bedtime ?? '—'} → ${r.wakeTime ?? '—'}</span>
            </button>`;
          }).join('')}
    </section>
  `;
  bindToolBack();

  const fileInput = $('#sleepFile');
  $('#sleepPick').addEventListener('click', () => fileInput.click());

  // 手动记一晚
  const sSave = $('#sSave');
  if (sSave) {
    sSave.addEventListener('click', async () => {
      const val = (id) => {
        const v = $(id).value.trim();
        return v === '' ? null : v;
      };
      const total = val('#sTotal') || val('#sDeep')
        ? (() => {
            const t = Number(val('#sTotal'));
            return Number.isFinite(t) && t > 0 ? t : null;
          })()
        : null;
      try {
        await api('/sleep', {
          method: 'POST',
          body: JSON.stringify({
            night: val('#sNight') || todayISO(),
            bedtime: val('#sBed'),
            wakeTime: val('#sWake'),
            totalMinutes: total,
            deepMinutes: val('#sDeep'),
            awakeCount: val('#sAwake'),
          }),
        });
        toast('记好了', 1400);
        pageToolSleep();
      } catch (err) {
        toast('保存失败：' + err.message, 2600);
      }
    });
  }

  fileInput.addEventListener('change', async () => {
    const raw = (fileInput.files || [])[0];
    fileInput.value = '';
    if (!raw) return;
    const state = $('#sleepState');
    state.textContent = '识别中…';
    try {
      const f = await shrinkImage(raw, 1400, 0.9);
      const up = await api('/upload', {
        method: 'POST',
        body: JSON.stringify({ name: f.name, mime: f.type || 'image/png', dataBase64: await fileToBase64(f) }),
      });
      const r = await api('/sleep/analyze', { method: 'POST', body: JSON.stringify({ uploadId: up.id }) });
      if (!r.ok) {
        toast('识别失败：' + (r.error || '读不出来'), 3000);
        state.textContent = `${st.count} 晚记录`;
        return;
      }
      toast(`记好了：${r.record.night} · ${hmOf(r.record.totalMinutes)}`, 2400);
      pageToolSleep();
    } catch (err) {
      toast('失败：' + err.message, 3000);
      state.textContent = `${st.count} 晚记录`;
    }
  });

  main.querySelectorAll('.sleep-row').forEach((b) =>
    b.addEventListener('click', async () => {
      const night = b.dataset.night;
      const r = recs.find((x) => x.night === night);
      const deep = prompt(`${night} 的深睡是几分钟？（现在 ${r.deepMinutes ?? '未知'}）`, String(r.deepMinutes ?? ''));
      if (deep === null) return;
      const total = prompt(`总睡眠是几分钟？（现在 ${r.totalMinutes ?? '未知'}）`, String(r.totalMinutes ?? ''));
      if (total === null) return;
      try {
        await api(`/sleep/${night}`, {
          method: 'PATCH',
          body: JSON.stringify({
            deepMinutes: Number(deep) || null,
            totalMinutes: Number(total) || null,
          }),
        });
        toast('改好了', 1400);
        pageToolSleep();
      } catch (err) {
        toast('改失败：' + err.message, 2400);
      }
    }));
}

async function pageToolUsage() {
  const main = $('#main');
  main.innerHTML = `${toolBackRow('记账')}<div class="empty">读取中…</div>`;
  bindToolBack();

  let usage;
  try {
    usage = await api('/admin/usage');
  } catch (err) {
    main.innerHTML = `${toolBackRow('记账')}<div class="empty">读不到（${esc(err.message)}）</div>`;
    bindToolBack();
    return;
  }

  const maxDay = Math.max(1, ...usage.days.map((d) => d.prompt + d.completion));
  const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  main.innerHTML = `
    ${toolBackRow('记账')}
    <section class="card ornate">
      <div class="card-title">余额<span class="caps">CNY</span></div>
      <div class="usage-big">${usage.balance.ok && usage.balance.cny !== null ? `¥${usage.balance.cny}` : '读不到'}</div>
      <p style="font-size:var(--fs-small);color:var(--muted);margin:6px 0 0">
        今日 ${usage.today.calls} 次调用 · 输入 ${fmt(usage.today.prompt)} / 输出 ${fmt(usage.today.completion)} tokens
      </p>
    </section>

    <section class="card ornate">
      <div class="card-title">近七天<span class="caps">tokens</span></div>
      <div class="bars">
        ${usage.days.length === 0 ? '<div class="empty">还没有记录</div>'
          : usage.days.map((d) => {
              const total = d.prompt + d.completion;
              const h = Math.max(4, Math.round((total / maxDay) * 74));
              return `<div class="bar-item"><div class="bar" style="height:${h}px"></div><span>${esc(d.day)}</span></div>`;
            }).join('')}
      </div>
      <div class="usage-row">
        <span>本周 ${usage.week.calls} 次</span>
        <span>输入 ${fmt(usage.week.prompt)}</span>
        <span>输出 ${fmt(usage.week.completion)}</span>
      </div>
    </section>

    <section class="card ornate">
      <div class="card-title">花在哪了<span class="caps">近七天</span></div>
      ${usage.byLabel.length === 0 ? '<div class="empty">还没有记录</div>'
        : usage.byLabel.map((l) => `
          <div class="row"><span class="k" style="font-size:14px">${esc(l.label)}</span>
          <span class="v">${l.calls} 次 · ${fmt(l.prompt + l.completion)}</span></div>`).join('')}
    </section>

    <section class="card ornate">
      <div class="card-title">最近调用</div>
      ${usage.recent.length === 0 ? '<div class="empty">还没有记录</div>'
        : usage.recent.map((r) => `
          <div class="row"><span class="k" style="font-size:13px">${esc(r.label || '(未标注)')}</span>
          <span class="v">${esc(r.model)} · ${fmt(r.prompt + r.completion)}${r.estimated ? ' (估)' : ''}</span></div>`).join('')}
    </section>
  `;
  bindToolBack();
}

async function pageToolStatus() {
  const main = $('#main');
  main.innerHTML = `${toolBackRow('系统状态')}<div class="empty">读取中…</div>`;
  bindToolBack();

  let s;
  try {
    s = await api('/admin/status');
  } catch (err) {
    main.innerHTML = `${toolBackRow('系统状态')}<div class="empty">读不到（${esc(err.message)}）</div>`;
    bindToolBack();
    return;
  }

  main.innerHTML = `
    ${toolBackRow('系统状态')}
    <section class="card ornate">
      <div class="card-title">底子</div>
      <div class="row"><span class="k">数据库</span><span class="v">${s.db.ok ? '连通' : '异常'} · pgvector ${esc(s.db.vector || '?')}</span></div>
      <div class="row"><span class="k">向量</span><span class="v">${esc(s.embedding.provider)} · ${s.embedding.dim} 维</span></div>
      <div class="row"><span class="k">记忆</span><span class="v">${s.memories} 条</span></div>
      <div class="row"><span class="k">运行</span><span class="v">${Math.floor(s.uptimeSec / 3600)} 小时 ${Math.floor((s.uptimeSec % 3600) / 60)} 分</span></div>
    </section>

    <section class="card ornate">
      <div class="card-title">他现在能不能主动找她</div>
      <div class="row">
        <span class="k">${s.gates.allowed ? '可以' : '被拦住'}</span>
        <span class="v">${s.gates.allowed ? '' : esc(s.gates.blockedBy.join('；'))}</span>
      </div>
      <div class="row"><span class="k">今天已发</span><span class="v">${s.gates.stats.sentToday} 条</span></div>
      <div class="row"><span class="k">距上次</span><span class="v">${s.gates.stats.hoursSinceLastSent === null ? '—' : s.gates.stats.hoursSinceLastSent.toFixed(1) + ' 小时'}</span></div>
    </section>

    <section class="card ornate">
      <div class="card-title">常驻任务<span class="caps">${s.jobs.length}</span></div>
      ${s.jobs.map((j) => `
        <div class="row"><span class="k" style="font-size:13.5px">${esc(j.job_key)}</span>
        <span class="v">${esc(j.status)} · ${j.run_count} 次${j.last_error ? ' · ' + esc(j.last_error.slice(0, 16)) : ''}</span></div>`).join('')}
    </section>

    <section class="card ornate">
      <div class="card-title">手动</div>
      <div class="row"><span class="k">叫醒他一次</span><button class="mini" id="wakeNow">叫醒</button></div>
      <div class="row"><span class="k">跑一次维护</span><button class="mini" id="maintNow">维护</button></div>
    </section>
  `;
  bindToolBack();

  $('#wakeNow').addEventListener('click', async () => {
    toast('叫醒中…', 1400);
    try {
      await api('/admin/wake', { method: 'POST', body: JSON.stringify({ force: true }) });
      toast('叫醒了', 1600);
      pageToolStatus();
    } catch (err) {
      toast('失败：' + err.message, 2600);
    }
  });
  $('#maintNow').addEventListener('click', async () => {
    toast('维护中…', 1400);
    try {
      await api('/admin/maintenance', { method: 'POST', body: JSON.stringify({}) });
      toast('维护完成', 1800);
    } catch (err) {
      toast('失败：' + err.message, 2600);
    }
  });
}

/* ─────────── 路由 ─────────── */
const PAGES = {
  home: pageHome,
  chat: pageChat,
  memory: pageMemory,
  moments: pageMoments,
  wake: pageWake,
  tools: pageTools,
  settings: pageSettings,
};

let currentPage = null;

function go(page) {
  if (!PAGES[page]) page = 'home';
  // 离开星图就停掉动画（否则一直在后台吃电）
  if (currentPage === 'memory' && page !== 'memory' && window.__stopStars) window.__stopStars();
  currentPage = page;
  location.hash = `#${page}`;
  renderTabbar(page);
  setHeader(page);
  document.body.classList.toggle('chat-mode', page === 'chat');
  document.body.classList.toggle('memory-mode', page === 'memory');
  const fab = $('#fab');
  if (fab) fab.hidden = page !== 'home';
  const p = PAGES[page]();
  if (p && p.catch) p.catch(() => {});
  $('#main').scrollTop = 0;
  if (page !== 'chat') window.scrollTo({ top: 0 });
}

/* ─────────── 开屏 → 主页 ─────────── */
function tickSplashClock() {
  const d = new Date();
  $('#splashClock').textContent =
    `${hhmm(d)}  ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]}, ` +
    `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()}`;

  const since = new Date('2026-05-23T18:25:00+08:00').getTime();
  $('#splashDays').textContent = String(Math.max(0, Math.floor((Date.now() - since) / 86400000)));
}

async function enterApp() {
  const splash = $('#splash');
  if (!splash || splash.classList.contains('hide')) return;

  const body = $('#splashBody');
  const app = $('#app');
  app.hidden = false;
  $('#headSlot').innerHTML = '<span>J<i style="font-style:italic;opacity:.6">&amp;</i>L</span>';

  const from = body.getBoundingClientRect();
  const to = $('#headSlot').getBoundingClientRect();
  const scale = Math.min(0.42, to.width / Math.max(1, from.width));
  body.style.transition = 'transform .6s cubic-bezier(.22,.9,.24,1), opacity .55s ease';
  body.style.transformOrigin = 'top left';
  body.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${scale})`;
  body.style.opacity = '.2';

  await sleep(600);
  splash.classList.add('hide');
  setTimeout(() => splash.remove(), 520);
  go(location.hash.replace('#', '') || 'home');

  if (!store.coords && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => { store.coords = { lat: pos.coords.latitude, lon: pos.coords.longitude }; if (currentPage === 'home') pageHome(); },
      () => {},
      { timeout: 8000, maximumAge: 3600000 },
    );
  }
}

/* ─────────── 装到桌面 ─────────── */
/**
 * 版本号：改前端时手动+1，显示在设置里，
 * 这样"你看到的是不是最新的"不用猜。
 */
const APP_VERSION = '2026-10-18.4';

/**
 * 强制更新：注销 Service Worker + 清掉所有缓存，然后重载。
 *
 * 为什么需要：桌面 App 里的 SW 会缓存旧页面，改完之后她打开还是老样子，
 * 而她不可能去 Android 设置里翻"清除缓存"。
 *
 * 只清缓存和 SW —— **不动 cookie、不动 localStorage**，
 * 所以聊天记录（在服务器）和登录态都不受影响。
 */
async function forceUpdate() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }
  } catch {}
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k);
    }
  } catch {}
  location.replace(`/v2/?fresh=${Date.now()}`);
}
let installEvent = null;

function installPwa() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    window.__canInstall = true;
  });

  window.addEventListener('appinstalled', () => {
    installEvent = null;
    window.__canInstall = false;
    toast('装好了，桌面找「家」', 2400);
  });
}

/** 设置页那个按钮调它：能弹系统安装框就弹，不能就给手动步骤 */
async function promptInstall() {
  if (installEvent) {
    installEvent.prompt();
    const res = await installEvent.userChoice.catch(() => ({ outcome: 'dismissed' }));
    installEvent = null;
    window.__canInstall = false;
    if (res.outcome === 'accepted') toast('正在装…', 1600);
    return;
  }
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) {
    toast('Safari 里点底部分享 → 添加到主屏幕', 4200);
  } else if (/Android/i.test(ua)) {
    toast('Chrome 右上角 ⋮ → 添加到主屏幕 / 安装应用', 4200);
  } else {
    toast('地址栏右边的安装图标，或菜单里"安装"', 4200);
  }
}

/* ─────────── 启动 ─────────── */
(function boot() {
  applyTheme(store.theme);
  tickSplashClock();
  setInterval(tickSplashClock, 30000);

  // 键盘弹起时把可视高度写进 CSS 变量（老浏览器没有 interactive-widget 时兜底）
  const vv = window.visualViewport;
  if (vv) {
    const sync = () => document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
  }

  $('#splash').addEventListener('click', enterApp);
  $('#splashMore').addEventListener('click', (e) => { e.stopPropagation(); enterApp(); });
  $('#fab').addEventListener('click', () => go('chat'));
  $('#back').addEventListener('click', () => go('home'));

  /* 抽屉：点遮罩关掉；从左边缘往右划打开；在抽屉上往左划关掉 */
  const mask = $('#drawerMask');
  if (mask) mask.addEventListener('click', () => closeDrawer());

  let edgeX = null;
  let edgeY = null;
  document.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      edgeX = t.clientX;
      edgeY = t.clientY;
    },
    { passive: true },
  );
  document.addEventListener(
    'touchend',
    (e) => {
      const t = e.changedTouches[0];
      if (!t || edgeX === null) return;
      const dx = t.clientX - edgeX;
      const dy = Math.abs(t.clientY - (edgeY ?? t.clientY));
      edgeX = null;
      edgeY = null;
      if (dy > Math.abs(dx) || Math.abs(dx) < 60) return; // 以横划为主
      if (!drawerOpen && dx > 0) {
        const fromEdge = t.clientX - dx < 40; // 起点贴着左边缘
        if (fromEdge) openDrawer();
      } else if (drawerOpen && dx < -60) {
        closeDrawer();
      }
    },
    { passive: true },
  );

  window.addEventListener('hashchange', () => {
    const page = location.hash.replace('#', '') || 'home';
    if (page !== currentPage) go(page);
  });

  installPwa();

})();
