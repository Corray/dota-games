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

// ============ 统计筛选（统计页、选手详情共用；与网页「统计」页的 从 / 到 / 联赛 / 最少场次 同口径） ============
const filter = { from: '', to: '', league: '', minG: 1 };
const setFilter = f => { Object.assign(filter, f); };
const filterKey = f => [f.from, f.to, f.league].join('|');
const ALL = { from: '', to: '', league: '' };

// ============ 评分权重：存在本机（和网页一样各设备各自一份），默认值同网页 ============
const SO_KEY = 'dota-score-weights';
let soCache = null;
function scoreOpt() {
  if (soCache) return soCache;
  try { soCache = { ...core.SCORE_DEF, ...(wx.getStorageSync(SO_KEY) || {}) }; } catch (e) { soCache = { ...core.SCORE_DEF }; }
  return soCache;
}
function saveScoreOpt(o) {
  soCache = { ...core.SCORE_DEF, ...o };
  try { wx.setStorageSync(SO_KEY, soCache); } catch (e) { }
  views.clear();
}
const resetScoreOpt = () => { try { wx.removeStorageSync(SO_KEY); } catch (e) { } soCache = null; views.clear(); };

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

/** 某个范围（日期 + 联赛）下的全部统计，同版本数据 + 同权重内缓存。f 省略 = 全部比赛（选手名单页用） */
function view(f = ALL) {
  if (!mem) return null;
  const so = scoreOpt();
  const key = filterKey(f) + '|' + JSON.stringify(so);
  if (views.has(key)) return views.get(key);
  const ms = mem.matches.filter(m => (!f.from || m.date >= f.from) && (!f.to || m.date <= f.to) && leagueMatch(m, f.league));
  const st = core.computeStats(ms, so);
  const badges = core.computeBadges(st, ms, mem.P);
  const rs = core.replayStats(ms, mem.P);
  const scores = {};
  for (const p of mem.players) scores[p.id] = core.playerScore(st.players[p.id], p, so);
  const v = { f: { ...f }, ms, st, badges, rs, scores, so };
  views.set(key, v);
  return v;
}

/** 当前统计筛选下的排行行（与网页统计表同字段） */
function statRows(v, minG) {
  const P = mem.P;
  const rows = Object.values(v.st.players).filter(s => s.g >= minG && P.has(s.pid));
  return { rows, data: core.statsRows(rows, P, v.so) };
}

/** 战报标题：与网页一致（从 ~ 到 · 联赛） */
function scopeTitle(v) {
  const dates = v.ms.map(m => m.date).sort();
  const range = v.f.from || v.f.to ? `${v.f.from || dates[0] || '?'} ~ ${v.f.to || dates[dates.length - 1] || '?'}` : (dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : '无');
  const lg = v.f.league ? (v.f.league === 'none' ? '无联赛 ID' : `联赛 ${v.f.league}`) : '';
  return range + (lg ? ' · ' + lg : '');
}
function report(v, minG) {
  const { rows, data } = statRows(v, minG);
  return core.buildReport({ title: scopeTitle(v), st: v.st, ms: v.ms, rows, P: mem.P, data });
}
function rankTable(v, minG, sorted) {
  const pct = core.pct;
  const head = ['选手', '段位', '评分', '场次', '胜', '负', '胜率', '天辉', '夜魇', 'KDA', '常用位置', '常用英雄', '连胜/负'];
  const P = mem.P;
  const lines = sorted.map(r => [r.name, `${P.get(r.pid).rank}${P.get(r.pid).stars || ''}`, r.score.toFixed(1), r.g, r.w, r.l, pct(r.w, r.g), r.rg ? `${pct(r.rw, r.rg)}(${r.rg})` : '-', r.dg ? `${pct(r.dw, r.dg)}(${r.dg})` : '-', r.kda >= 0 ? `${r.kda.toFixed(2)} (${r.kdaStr})` : '-', r.pos || '-', r.hero || '-', r.streak > 0 ? `${r.streak}连胜` : r.streak < 0 ? `${-r.streak}连败` : '-']);
  return ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|', ...lines.map(r => '| ' + r.join(' | ') + ' |')].join('\n');
}

const matchById = id => mem && mem.matches.find(m => m.id === id);
// 单场完整记录（含完整录像解析），同版本内缓存
const fullMatch = new Map();
async function match(id) {
  const k = (mem ? mem.version : 0) + '|' + id;
  if (fullMatch.has(k)) return fullMatch.get(k);
  const r = await call('match', { id });
  fullMatch.set(k, r.match);
  return r.match;
}
// 天梯资料（云函数代查 OpenDota，云函数里缓存 10 分钟）
const ladder = (pid, force = false) => call('ladder', { pid, force });
// 写权限 / 导入（云函数按微信身份鉴权）
const me = () => call('me');
const bind = token => call('bind', { token });
const previewIds = (ids, opts) => call('preview', { ids, ...opts });
const importIds = (ids, opts) => call('import', { ids, ...opts });
// 从粘贴的文字里抽比赛 ID（支持链接、逗号 / 空格 / 换行分隔），去重
const extractIds = text => [...new Set((String(text).match(/\d{6,}/g) || []))];
const fmtTime = s => { if (!s) return ''; const d = new Date(s); const z = n => String(n).padStart(2, '0'); return `${d.getMonth() + 1}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
const pname = pid => (mem && mem.P.get(pid) || {}).name || '(已删除)';

module.exports = { load, view, leagues, leagueOf, get data() { return mem; }, core, fmtTime, filter, setFilter, ALL,
  scoreOpt, saveScoreOpt, resetScoreOpt, statRows, report, rankTable, scopeTitle, matchById, pname, match, ladder, me, bind, previewIds, importIds, extractIds };
