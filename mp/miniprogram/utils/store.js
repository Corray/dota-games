/**
 * 数据层：云函数 api 读百度云 MySQL（与网页版同一份数据），本机缓存 + 版本号判断是否要重新拉
 * 统计全部用 core.js（与网页共用的计算核心）在手机上算，口径和网页一致；评分权重用默认值。
 */
const core = require('./core.js');

const K = { meta: 'dota-meta', players: 'dota-players', part: i => 'dota-matches-' + i };
let mem = null;            // { version, updatedAt, players, matches, P }
const views = new Map();   // 联赛筛选 → 统计结果（同一版本数据内复用）

function call(action, data = {}) {
  return wx.cloud.callFunction({ name: 'api', data: { action, ...data } }).then(r => {
    const res = r.result || {};
    if (res.error) throw new Error(res.error);
    return res;
  });
}

function readCache() {
  try {
    const meta = wx.getStorageSync(K.meta);
    if (!meta || !meta.version) return null;
    const players = wx.getStorageSync(K.players) || [];
    let matches = [];
    for (let i = 0; i < meta.parts; i++) matches = matches.concat(wx.getStorageSync(K.part(i)) || []);
    return { version: meta.version, updatedAt: meta.updatedAt, players, matches };
  } catch (e) { return null; }
}
function writeCache(d, pages) {
  try {
    const old = wx.getStorageSync(K.meta);
    wx.setStorageSync(K.players, d.players);
    pages.forEach((p, i) => wx.setStorageSync(K.part(i), p));
    if (old && old.parts > pages.length) for (let i = pages.length; i < old.parts; i++) wx.removeStorageSync(K.part(i));
    wx.setStorageSync(K.meta, { version: d.version, updatedAt: d.updatedAt, parts: pages.length });
  } catch (e) { console.warn('写缓存失败', e); }
}

function adopt(d) {
  mem = { ...d, P: new Map(d.players.map(p => [p.id, p])) };
  views.clear();
  return mem;
}

async function fetchAll() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await call('data', { part: 0 });
    const pages = [first.matches];
    let ok = true;
    for (let i = 1; i < first.parts; i++) {
      const r = await call('data', { part: i });
      if (r.version !== first.version) { ok = false; break; }   // 拉取途中有人改了数据，从头再拉
      pages.push(r.matches);
    }
    if (!ok) continue;
    const d = { version: first.version, updatedAt: first.updatedAt, players: first.players || [], matches: [].concat(...pages) };
    writeCache(d, pages);
    return d;
  }
  throw new Error('数据一直在变，稍后再试');
}

/** 加载数据：有缓存且云端版本没变就直接用缓存；连不上云端时退回缓存（offline: true） */
async function load({ force = false } = {}) {
  if (!mem) { const c = readCache(); if (c) adopt(c); }
  let meta;
  try { meta = await call('meta'); }
  catch (e) { if (mem) return { ...mem, offline: true, error: e.message }; throw e; }
  if (!force && mem && mem.version === meta.version) return mem;
  return adopt(await fetchAll());
}

const leagueOf = core.leagueOf;
const leagueMatch = (m, sel) => !sel || (sel === 'none' ? !leagueOf(m) : String(leagueOf(m)) === sel);

/** 联赛下拉选项：按场次多到少，另加「无联赛 ID」 */
function leagues() {
  if (!mem) return [{ value: '', label: '全部联赛' }];
  const cnt = new Map(); let none = 0;
  for (const m of mem.matches) { const l = leagueOf(m); if (l) cnt.set(l, (cnt.get(l) || 0) + 1); else none++; }
  const ids = [...cnt.keys()].sort((a, b) => cnt.get(b) - cnt.get(a) || b - a);
  return [{ value: '', label: `全部联赛 · ${mem.matches.length} 场` }]
    .concat(ids.map(id => ({ value: String(id), label: `联赛 ${id} · ${cnt.get(id)} 场` })))
    .concat(none && ids.length ? [{ value: 'none', label: `无联赛 ID · ${none} 场` }] : []);
}

/** 某个联赛筛选下的全部统计（同版本数据内缓存） */
function view(league = '') {
  if (!mem) return null;
  if (views.has(league)) return views.get(league);
  const ms = mem.matches.filter(m => leagueMatch(m, league));
  const st = core.computeStats(ms, core.SCORE_DEF);
  const badges = core.computeBadges(st, ms, mem.P);
  const rs = core.replayStats(ms, mem.P);
  const scores = {};
  for (const p of mem.players) scores[p.id] = core.playerScore(st.players[p.id], p, core.SCORE_DEF);
  const v = { league, ms, st, badges, rs, scores };
  views.set(league, v);
  return v;
}

const fmtTime = s => { if (!s) return ''; const d = new Date(s); const z = n => String(n).padStart(2, '0'); return `${d.getMonth() + 1}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };

module.exports = { load, view, leagues, leagueOf, get data() { return mem; }, core, fmtTime };
