// Сервер «Рыбалка с Бибинто»: раздаёт игру, регистрация/вход, облачные сохранения,
// ежедневные награды (по серверному времени), учёт времени в игре, топ игроков и кланов.
// Без внешних зависимостей: нужен только Node.js 18+.  Запуск: node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const SAVES = path.join(DATA, 'saves');
const DB_FILE = path.join(DATA, 'db.json');
const TZ_OFFSET_H = +process.env.TZ_OFFSET_H || 3;      // «день» считается по Москве
const TOKEN_TTL = 30 * 864e5;                            // вход живёт 30 дней
const MAX_BODY = 4 * 1024 * 1024;                        // сохранение до 4 МБ
const TRUST_PROXY = process.env.TRUST_PROXY === '1';     // за nginx: брать IP из X-Forwarded-For

fs.mkdirSync(SAVES, { recursive: true });

/* ---------------- база (JSON-файл, атомарная запись) ---------------- */
let db = { users: {}, tokens: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') { console.error('db.json повреждён:', e.message); process.exit(1); } }
db.users = db.users || {}; db.tokens = db.tokens || {};
let dbDirty = false, dbTimer = null;
function dbSave(now) {
  dbDirty = true;
  if (now) return flush();
  if (!dbTimer) dbTimer = setTimeout(flush, 1500);
}
function flush() {
  clearTimeout(dbTimer); dbTimer = null;
  if (!dbDirty) return; dbDirty = false;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
const userById = id => Object.values(db.users).find(u => u.id === id);
const saveFile = id => path.join(SAVES, id.replace(/[^a-z0-9]/gi, '') + '.json');

/* ---------------- утилиты ---------------- */
const dayKey = (t = Date.now()) => new Date(t + TZ_OFFSET_H * 36e5).toISOString().slice(0, 10);
const prevDay = k => dayKey(Date.parse(k + 'T12:00:00Z') - 864e5 - TZ_OFFSET_H * 36e5);
const NAME_RE = /^[A-Za-zА-Яа-яЁё0-9_]{3,16}$/;
function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 64).toString('hex'); }
function checkPass(pass, u) {
  const a = Buffer.from(hashPass(pass, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newToken(u) {
  const t = crypto.randomBytes(32).toString('hex');
  db.tokens[t] = { u: u.id, exp: Date.now() + TOKEN_TTL };
  dbSave(); return t;
}
function cleanTokens() { const n = Date.now(); for (const t in db.tokens) if (db.tokens[t].exp < n) delete db.tokens[t]; }
setInterval(() => { cleanTokens(); dbSave(); }, 36e5).unref();

// ограничение частоты запросов по IP
const RL = new Map();
function limited(ip, key, max, winMs) {
  const k = key + '|' + ip, n = Date.now();
  let r = RL.get(k); if (!r || r.t < n) { r = { c: 0, t: n + winMs }; RL.set(k, r); }
  return ++r.c > max;
}
setInterval(() => { const n = Date.now(); for (const [k, r] of RL) if (r.t < n) RL.delete(k); }, 6e5).unref();

/* ---------------- статистика для топов ---------------- */
const num = (v, max = 1e15) => { v = +v; return Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0; };
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
function summarize(u, s) {
  const c = s.clan && typeof s.clan === 'object' && s.clan.id ? s.clan : null;
  const girls = Array.isArray(s.list) ? s.list.filter(g => g && g.kind === 'girl') : [];
  u.sum = {
    cups: num(s.cups, 1e7), elo: num(s.elo, 1e5), total: num(s.total, 1e9), coll: girls.length,
    wallet: num(s.wallet), maxWallet: num(s.rec && s.rec.maxWallet), bossWins: num(s.bossWins, 1e6),
    best: num(s.rec && s.rec.bestPrice), locs: s.unlocked && typeof s.unlocked === 'object' ? Object.keys(s.unlocked).length : 1,
    tw: num(s.tw, 1e6), skin: str(s.equip && s.equip.skin, 20),
    clan: c ? {
      id: str(c.id, 12), tag: str(c.tag, 5), n: str(c.n, 24), c: /^#[0-9a-f]{3,8}$/i.test(c.c) ? c.c : '#22d3ee',
      wins: num(c.wins, 1e6), tier: num(c.boss && c.boss.tier, 1e4) || 1,
      dep: c.dep && typeof c.dep === 'object' ? c.dep : {}, spent: c.spent && typeof c.spent === 'object' ? c.spent : {},
      terr: c.terr && typeof c.terr === 'object' ? c.terr : {}, perk: c.perk && typeof c.perk === 'object' ? c.perk : {}
    } : null,
    t: Date.now()
  };
}
let topCache = null, topAt = 0;
function buildTop() {
  if (topCache && Date.now() - topAt < 30000) return topCache;
  const us = Object.values(db.users).filter(u => u.sum);
  const P = us.map(u => ({ name: u.name, ...u.sum, clan: u.sum.clan ? { id: u.sum.clan.id, tag: u.sum.clan.tag, c: u.sum.clan.c } : null }));
  const by = k => P.slice().sort((a, b) => b[k] - a[k]).slice(0, 50).map(p => ({ name: p.name, v: p[k], cups: p.cups, elo: p.elo, total: p.total, clan: p.clan }));
  // кланы: сливаем данные всех участников (как в игре: максимум по каждому ключу)
  const M = {}, now = Date.now();
  for (const u of us) {
    const c = u.sum.clan; if (!c || !c.id) continue;
    const m = M[c.id] || (M[c.id] = { id: c.id, tag: c.tag, n: c.n, c: c.c, wins: 0, tier: 1, dep: {}, spent: {}, terr: {}, perk: {}, members: [], cups: 0, t: 0 });
    if (u.sum.t > m.t) { m.tag = c.tag; m.n = c.n; m.c = c.c; m.t = u.sum.t; }
    m.wins = Math.max(m.wins, c.wins); m.tier = Math.max(m.tier, c.tier);
    for (const k in c.dep) m.dep[k] = Math.max(m.dep[k] || 0, num(c.dep[k]));
    for (const k in c.spent) m.spent[k] = Math.max(m.spent[k] || 0, num(c.spent[k]));
    for (const k in c.terr) if (num(c.terr[k]) > now) m.terr[k] = 1;
    for (const k in c.perk) m.perk[k] = Math.max(m.perk[k] || 0, num(c.perk[k], 10));
    m.members.push(u.name); m.cups += u.sum.cups;
  }
  const sumv = o => Object.values(o).reduce((a, b) => a + b, 0);
  const C = Object.values(M).map(m => {
    const bank = Math.max(0, sumv(m.dep) - sumv(m.spent)), terr = Object.keys(m.terr).length, perks = sumv(m.perk);
    const score = Math.round(m.wins * 10 + (m.tier - 1) * 25 + m.members.length * 5 + terr * 15 + perks * 4 + Math.floor(bank / 100000) + m.cups / 5);
    return { id: m.id, tag: m.tag, n: m.n, c: m.c, wins: m.wins, tier: m.tier, bank, terr, perks, members: m.members.length, names: m.members.slice(0, 12), cups: m.cups, score };
  }).sort((a, b) => b.score - a.score).slice(0, 50);
  topCache = { players: { cups: by('cups'), elo: by('elo'), total: by('total'), maxWallet: by('maxWallet'), bossWins: by('bossWins') }, clans: C, count: us.length, at: Date.now() };
  topAt = Date.now();
  return topCache;
}

/* ---------------- чат: общий, клановый, личные сообщения ---------------- */
const CHAT_FILE = path.join(DATA, 'chat.json');
const CHAT_KEEP = 5000, ADMINS = new Set(String(process.env.ADMINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
let chat = { seq: 0, msgs: [], mutes: {} };
try { chat = { ...chat, ...JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')) }; } catch (e) { }
let chatTimer = null;
function chatSave() { if (chatTimer) return; chatTimer = setTimeout(chatFlush, 2000); }
function chatFlush() { clearTimeout(chatTimer); chatTimer = null; const tmp = CHAT_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(chat)); fs.renameSync(tmp, CHAT_FILE); }
const clanOf = u => (u.sum && u.sum.clan && u.sum.clan.id) || null;
function visible(u, m) {
  if (m.ch === 'g') return true;
  if (m.ch === 'd') return m.from === u.id || m.to === u.id;
  if (m.ch.startsWith('c:')) return m.ch === 'c:' + clanOf(u);
  return false;
}
const pubMsg = m => { const o = { ...m }; delete o.to; return o; };
const waiters = new Set();
function chatPush(m) {
  m.id = ++chat.seq; m.t = Date.now(); chat.msgs.push(m);
  if (chat.msgs.length > CHAT_KEEP) chat.msgs.splice(0, chat.msgs.length - CHAT_KEEP);
  chatSave();
  for (const w of [...waiters]) if (visible(w.u, m)) { waiters.delete(w); clearTimeout(w.timer); w.done(); }
  return m;
}
function chatSince(u, since) {
  if (since > 0) return chat.msgs.filter(m => m.id > since && visible(u, m)).map(pubMsg);
  // первая загрузка: история
  const out = [], cnt = { g: 0, c: 0, d: 0 };
  for (let i = chat.msgs.length - 1; i >= 0 && out.length < 600; i--) {
    const m = chat.msgs[i]; if (m.sys || !visible(u, m)) continue;
    const k = m.ch === 'g' ? 'g' : m.ch === 'd' ? 'd' : 'c', lim = k === 'd' ? 300 : 120;
    if (cnt[k] < lim) { cnt[k]++; out.push(pubMsg(m)); }
  }
  return out.reverse().filter(m => !m.del);
}
const cleanText = s => String(s || '').replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
function adminCmd(u, text) {
  const [cmd, a, b] = text.split(' ');
  const sys = t => chatPush({ ch: 'g', sys: 'info', from: '', fn: '🛡️ Модератор', text: t });
  if (cmd === '/mute' && a) { const t = db.users[a.toLowerCase()]; if (!t) return 'Нет такого игрока'; const min = Math.max(1, Math.min(43200, +b || 60)); chat.mutes[t.id] = Date.now() + min * 6e4; chatSave(); sys(`${t.name} не может писать ${min} мин.`); return null; }
  if (cmd === '/unmute' && a) { const t = db.users[a.toLowerCase()]; if (t) delete chat.mutes[t.id]; chatSave(); return null; }
  if (cmd === '/del' && a) { const m = chat.msgs.find(x => x.id === +a); if (m) { m.del = true; chatPush({ ch: m.ch, to: m.to, from: m.from, sys: 'del', ref: m.id, text: '' }); } return null; }
  if (cmd === '/clear') { chat.msgs.forEach(m => { if (m.ch === 'g') m.del = true; }); chatPush({ ch: 'g', sys: 'clear', from: '', text: '' }); return null; }
  return 'Команды: /mute ник минут, /unmute ник, /del id, /clear';
}

/* ---------------- HTTP ---------------- */
function send(res, code, obj, req) {
  const body = Buffer.from(JSON.stringify(obj));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(code, h); res.end(zlib.gzipSync(body)); return; }
  res.writeHead(code, h); res.end(body);
}
function readBody(req) {
  return new Promise((ok, bad) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { bad(Object.assign(new Error('Слишком большое сохранение'), { code: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => { if (!size) return ok({}); try { ok(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { bad(Object.assign(new Error('Плохой JSON'), { code: 400 })); } });
    req.on('error', bad);
  });
}
function authUser(req) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '');
  if (!m) return null; const t = db.tokens[m[1]];
  if (!t || t.exp < Date.now()) return null;
  return userById(t.u) || null;
}
function dailyState(u) {
  const today = dayKey(), d = u.daily || { last: '', days: 0, streak: 0 };
  const p = u.play && u.play.day === today ? u.play : { day: today, sec: 0, claimed: false };
  return { today, claimed: d.last === today, days: d.days, streak: d.last === today || d.last === prevDay(today) ? d.streak : 0, playSec: Math.floor(p.sec), hourClaimed: !!p.claimed };
}
const pubUser = u => ({ id: u.id, name: u.name, created: u.created });

const API = {
  'GET /api/ping': () => ({ ok: true, time: Date.now(), today: dayKey(), players: Object.keys(db.users).length }),

  async 'POST /api/register'(req, ip) {
    if (limited(ip, 'regtry', 60, 36e5)) throw Object.assign(new Error('Слишком много попыток. Попробуй через час'), { code: 429 });
    const b = await readBody(req), name = String(b.name || '').trim(), pass = String(b.pass || '');
    if (!NAME_RE.test(name)) throw Object.assign(new Error('Ник: 3–16 символов, буквы, цифры и _'), { code: 400 });
    if (pass.length < 6 || pass.length > 100) throw Object.assign(new Error('Пароль: от 6 символов'), { code: 400 });
    const key = name.toLowerCase();
    if (db.users[key]) throw Object.assign(new Error('Такой ник уже занят'), { code: 409 });
    if (limited(ip, 'reg', 5, 36e5)) throw Object.assign(new Error('С твоего IP уже создано много аккаунтов. Попробуй через час'), { code: 429 });
    const salt = crypto.randomBytes(16).toString('hex');
    const u = db.users[key] = { id: crypto.randomBytes(8).toString('hex'), name, salt, hash: hashPass(pass, salt), created: Date.now(), rev: 0, daily: { last: '', days: 0, streak: 0 }, play: null };
    const token = newToken(u); dbSave(true);
    console.log('регистрация:', name);
    return { token, user: pubUser(u) };
  },

  async 'POST /api/login'(req, ip) {
    if (limited(ip, 'login', 20, 6e5)) throw Object.assign(new Error('Слишком много попыток входа. Подожди 10 минут'), { code: 429 });
    const b = await readBody(req), u = db.users[String(b.name || '').trim().toLowerCase()];
    if (!u || !checkPass(String(b.pass || ''), u)) throw Object.assign(new Error('Неверный ник или пароль'), { code: 401 });
    return { token: newToken(u), user: pubUser(u) };
  },

  'POST /api/logout'(req) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || ''); if (m) { delete db.tokens[m[1]]; dbSave(); }
    return { ok: true };
  },

  'GET /api/me'(req, ip, u) { return { user: pubUser(u), daily: dailyState(u) }; },

  'GET /api/save'(req, ip, u) {
    let save = null; try { save = JSON.parse(fs.readFileSync(saveFile(u.id), 'utf8')); } catch (e) { }
    return { save, rev: u.rev || 0 };
  },

  async 'PUT /api/save'(req, ip, u) {
    const b = await readBody(req), s = b.save;
    if (!s || typeof s !== 'object' || !Array.isArray(s.list)) throw Object.assign(new Error('Плохое сохранение'), { code: 400 });
    if ((+b.rev || 0) !== (u.rev || 0) && !b.force) return { __code: 409, error: 'Аккаунт сохранён с другого устройства', rev: u.rev || 0 };
    s.name = u.name;
    const f = saveFile(u.id), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, f);
    u.rev = (u.rev || 0) + 1; u.lastSave = Date.now(); summarize(u, s); dbSave();
    return { rev: u.rev };
  },

  // ежедневный вход: «день» считает сервер, перевод часов не поможет
  async 'POST /api/daily'(req, ip, u) {
    const st = dailyState(u);
    if (st.claimed) return { granted: false, daily: st };
    const d = u.daily || (u.daily = { last: '', days: 0, streak: 0 });
    d.streak = d.last === prevDay(st.today) ? d.streak + 1 : 1;
    d.days = (d.days || 0) + 1; d.last = st.today; dbSave();
    return { granted: true, day: d.days, streak: d.streak, daily: dailyState(u) };
  },

  // пульс раз в минуту, пока вкладка с игрой открыта и видна
  'POST /api/beat'(req, ip, u) {
    const today = dayKey(), n = Date.now();
    if (!u.play || u.play.day !== today) u.play = { day: today, sec: 0, claimed: false };
    const gap = u.lastBeat ? (n - u.lastBeat) / 1000 : 0;
    if (gap > 0) u.play.sec += Math.min(gap, 75);           // засчитываем не больше 75 с на пульс
    u.lastBeat = n; dbSave();
    return { daily: dailyState(u) };
  },

  'POST /api/hour'(req, ip, u) {
    const st = dailyState(u);
    if (st.hourClaimed) return { granted: false, daily: st };
    if (st.playSec < 3600) return { granted: false, need: 3600 - st.playSec, daily: st };
    u.play.claimed = true; dbSave();
    return { granted: true, daily: dailyState(u) };
  },

  'GET /api/top'() { return buildTop(); },

  // сообщения: since=0 — история, иначе новые; wait=1 — ждать новых до 25 с (long-poll)
  'GET /api/chat'(req, ip, u, url) {
    const since = Math.max(0, +url.searchParams.get('since') || 0);
    const now = () => ({ msgs: chatSince(u, since), seq: chat.seq, admin: ADMINS.has(u.name.toLowerCase()), muted: Math.max(0, (chat.mutes[u.id] || 0) - Date.now()) });
    if (since > chat.seq) return { msgs: [], seq: chat.seq, reset: true };
    const first = now(); if (first.msgs.length || !url.searchParams.get('wait')) return first;
    return new Promise(ok => {
      const w = { u, done: () => ok(now()) };
      w.timer = setTimeout(() => { waiters.delete(w); ok(now()); }, 25000);
      waiters.add(w); req.on('close', () => { if (waiters.delete(w)) clearTimeout(w.timer); });
    });
  },

  async 'POST /api/chat'(req, ip, u) {
    const b = await readBody(req), text = cleanText(b.text);
    if (!text) throw Object.assign(new Error('Пустое сообщение'), { code: 400 });
    if (text.startsWith('/') && ADMINS.has(u.name.toLowerCase())) { const err = adminCmd(u, text); if (err) throw Object.assign(new Error(err), { code: 400 }); return { ok: true }; }
    const mu = chat.mutes[u.id] || 0; if (mu > Date.now()) throw Object.assign(new Error(`Ты в муте ещё ${Math.ceil((mu - Date.now()) / 6e4)} мин.`), { code: 403 });
    if (limited(u.id, 'chat1', 1, 1200)) throw Object.assign(new Error('Не так быстро'), { code: 429 });
    if (limited(u.id, 'chatm', 15, 6e4)) throw Object.assign(new Error('Слишком много сообщений. Подожди минуту'), { code: 429 });
    const last = chat.msgs.length ? chat.msgs.findLast(m => m.from === u.id && !m.sys) : null;
    if (last && last.text === text && Date.now() - last.t < 30000) throw Object.assign(new Error('Не повторяйся'), { code: 429 });
    const c = u.sum && u.sum.clan, m = { from: u.id, fn: u.name, tag: c ? c.tag : '', tc: c ? c.c : '', text };
    if (b.to) {
      const t = db.users[String(b.to).trim().toLowerCase()];
      if (!t) throw Object.assign(new Error('Нет такого игрока'), { code: 404 });
      if (t.id === u.id) throw Object.assign(new Error('Самому себе нельзя'), { code: 400 });
      Object.assign(m, { ch: 'd', to: t.id, tn: t.name });
    } else if (b.ch === 'c') {
      if (!clanOf(u)) throw Object.assign(new Error('Ты не в клане (или игра ещё не сохранилась)'), { code: 400 });
      m.ch = 'c:' + clanOf(u);
    } else m.ch = 'g';
    return { msg: pubMsg(chatPush(m)) };
  }
};
const NEED_AUTH = new Set(['GET /api/me', 'GET /api/save', 'PUT /api/save', 'POST /api/daily', 'POST /api/beat', 'POST /api/hour', 'GET /api/chat', 'POST /api/chat']);

/* ---------------- статика ---------------- */
const STATIC = { '/': 'ribalka3d.html', '/index.html': 'ribalka3d.html', '/ribalka3d.html': 'ribalka3d.html', '/models.js': 'models.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary' };
const gzCache = new Map();
function serveStatic(req, res, p) {
  const rel = STATIC[p] || (p.startsWith('/public/') ? p.slice(1) : null);
  if (!rel || rel.includes('..')) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Не найдено'); return; }
  const f = path.join(ROOT, rel);
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end(); return; }
    const type = TYPES[path.extname(f)] || 'application/octet-stream', etag = '"' + st.size.toString(36) + '-' + st.mtimeMs.toString(36) + '"';
    const h = { 'Content-Type': type, 'ETag': etag, 'Cache-Control': rel.endsWith('.html') ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); res.end(); return; }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /html|javascript/.test(type);
    if (gz) {
      let c = gzCache.get(f);
      if (!c || c.etag !== etag) { c = { etag, buf: zlib.gzipSync(fs.readFileSync(f)) }; gzCache.set(f, c); }
      h['Content-Encoding'] = 'gzip'; h['Vary'] = 'Accept-Encoding'; res.writeHead(200, h); res.end(req.method === 'HEAD' ? undefined : c.buf); return;
    }
    res.writeHead(200, h); if (req.method === 'HEAD') res.end(); else fs.createReadStream(f).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname.replace(/\/+$/, '') || '/';
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  if (!p.startsWith('/api/')) { if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p); res.writeHead(405); return res.end(); }
  const key = req.method + ' ' + p, fn = API[key];
  if (!fn) return send(res, 404, { error: 'Нет такого метода' }, req);
  if (limited(ip, 'api', 600, 6e4)) return send(res, 429, { error: 'Слишком часто' }, req);
  try {
    let u = null;
    if (NEED_AUTH.has(key)) { u = authUser(req); if (!u) return send(res, 401, { error: 'Нужно войти заново' }, req); }
    const out = await fn(req, ip, u, url);
    if (out && out.__code) { const c = out.__code; delete out.__code; return send(res, c, out, req); }
    send(res, 200, out, req);
  } catch (e) {
    if (!e.code || typeof e.code !== 'number') console.error(key, e);
    send(res, typeof e.code === 'number' ? e.code : 500, { error: e.code ? e.message : 'Ошибка сервера' }, req);
  }
});
server.listen(PORT, HOST, () => console.log(`🎣 Рыбалка с Бибинто: http://localhost:${PORT}  (данные: ${DATA})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { flush(); chatFlush(); } catch (e) { console.error(e); } process.exit(0); });
