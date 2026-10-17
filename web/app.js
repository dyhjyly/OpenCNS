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

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
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

/* ─────────── 底栏（只在主页显示）─────────── */
function renderTabbar(active) {
  const bar = $('#tabbar');
  if (active !== 'home') {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.innerHTML = TABS.map(
    (t) => `<button class="tab" data-page="${t.id}" ${t.id === active ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[t.icon]}</svg>${t.label}
    </button>`,
  ).join('');
  bar.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
  const cur = bar.querySelector('[aria-current="page"]');
  if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

/* ─────────── 头部 ─────────── */
function setHeader(page) {
  const isHome = page === 'home';
  $('#back').hidden = isHome;
  $('#headSlot').hidden = !isHome;
  if (!isHome) {
    const t = TABS.find((x) => x.id === page);
    $('#greet').textContent = t ? t.label : '';
    $('#stamp').textContent = '';
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

async function pageHome() {
  const main = $('#main');
  main.innerHTML = '<div class="empty">加载中…</div>';

  let data;
  try {
    const c = store.coords;
    data = await api(`/home${c ? `?lat=${c.lat}&lon=${c.lon}` : ''}`);
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
            ${esc(w.city || '不清楚在哪')}
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

function bubbleEl(who, text, at) {
  const wrap = document.createElement('div');
  wrap.className = `bwrap ${who === 'me' ? 'mine' : ''}`;
  const b = document.createElement('div');
  b.className = `msg ${who === 'me' ? 'me' : 'it'}`;
  b.textContent = text;
  wrap.appendChild(b);
  const time = document.createElement('div');
  time.className = 'mtime';
  time.textContent = at || hhmm();
  wrap.appendChild(time);
  return { wrap, bubble: b, time };
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
  }
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
          assistantBubbles(log, m.content, hhmm(new Date(m.at)), { bubbles: [] });
        } else {
          const el = bubbleEl('me', m.content, hhmm(new Date(m.at)));
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
    const mine = bubbleEl('me', text || '（发了附件）', hhmm());
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
      <div class="card-title">聊天</div>
      <div class="row">
        <span class="k">思考链</span>
        <select class="v" id="thinking">
          <option value="on" ${store.thinking ? 'selected' : ''}>显示（默认折叠）</option>
          <option value="off" ${!store.thinking ? 'selected' : ''}>完全隐藏</option>
        </select>
      </div>
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

/* ─────────── 占位页 ─────────── */
function pageSoon(title, note, em = 'soon') {
  $('#main').innerHTML = `<div class="soon"><span class="em">${em}</span><h3 class="serif" style="margin:0;font-size:17px">${title}</h3><p>${note}</p></div>`;
}

/* ─────────── 路由 ─────────── */
const PAGES = {
  home: pageHome,
  chat: pageChat,
  memory: () => pageSoon('记忆库', '全银河 + 可筛选。还没做。', 'memory'),
  moments: () => pageSoon('朋友圈', '两个人一起看的时间流。还没做。', 'moments'),
  wake: () => pageSoon('醒来房间', '他独处时做了什么。还没做。', 'reverie'),
  tools: () => pageSoon('工具', '用量、睡眠、日历、经期。还没做。', 'tools'),
  settings: pageSettings,
};

let currentPage = null;

function go(page) {
  if (!PAGES[page]) page = 'home';
  currentPage = page;
  location.hash = `#${page}`;
  renderTabbar(page);
  setHeader(page);
  document.body.classList.toggle('chat-mode', page === 'chat');
  const fab = $('#fab');
  if (fab) fab.hidden = page === 'chat' || page !== 'home';
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

  window.addEventListener('hashchange', () => {
    const page = location.hash.replace('#', '') || 'home';
    if (page !== currentPage) go(page);
  });
})();
