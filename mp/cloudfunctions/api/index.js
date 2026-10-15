/**
 * 小程序云函数 api：读写百度云 MySQL 里的 dota_state（与网页 server/ 同一张表、同一份数据）
 *
 * 小程序调用（wx.cloud.callFunction，event.userInfo.openId 由微信注入，不可伪造）：
 *   { action: 'meta' }                      → { ok, version, updatedAt }
 *   { action: 'data', part }                → { ok, version, updatedAt, parts, part, players?(仅 part 0), matches: 第 part 页 }
 *   { action: 'match', id }                 → { ok, match }：单场完整记录（含完整录像解析）
 *   { action: 'ladder', pid, force }        → OpenDota 天梯资料（10 分钟缓存）
 *   { action: 'me' }                        → { ok, openid, admin, writable }
 *   { action: 'bind', token }               → 编辑口令正确就把当前微信加入管理员（之后写入不用再输口令）
 *   { action: 'preview', ids, autoNew, overwrite } → 查询不写库：每场阵容、能对上名单的 / 会新建的选手
 *   { action: 'import', ids, autoNew, overwrite } → 按比赛 ID 导入（≤10 场/次）：完美世界 → OpenDota，顺带拉录像解析
 *
 * 网页调用（云开发 HTTP 访问服务，event.httpMethod 存在时）：与 Cloudflare Worker 的 /data 接口完全一致
 *   GET /data · GET /data/meta · GET /data?strip=1 · PUT /data（X-Edit-Token + X-Base-Version 乐观锁）
 *
 * 环境变量：MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE，EDIT_TOKEN（编辑口令），
 *   MP_WRITE=1 才允许写（网页切到数据库之前保持关闭，免得网页写 KV、小程序写 MySQL 两边分叉）
 */
const mysql = require('mysql2/promise');
const https = require('https');
const C = require('./core.js');

const PAGE = 200;
// 表名可改，只为本机测试时指向副本表，线上不设
const T = process.env.DOTA_TABLE || 'dota_state', TA = process.env.DOTA_ADMIN_TABLE || 'dota_mp_admins';
const EDIT_TOKEN = process.env.EDIT_TOKEN || '';
const WRITABLE = process.env.MP_WRITE === '1';
let pool = null;
const getPool = () => pool || (pool = mysql.createPool({
  host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
  connectionLimit: 2, connectTimeout: 10000, charset: 'utf8mb4',
}));

// ---------- 读 ----------
async function readMeta() {
  const [[r]] = await getPool().query(`SELECT version, updated_at FROM ${T} WHERE id = 'state'`);
  return r ? { version: r.version, updatedAt: r.updated_at } : { version: 0, updatedAt: null };
}
const slimReplay = rp => rp && rp.heroes ? { leagueId: rp.leagueId || 0, heroes: rp.heroes, lanes: rp.lanes, kills: rp.kills, gold: rp.gold } : undefined;
const slimSide = arr => (arr || []).map(s => ({ pid: s.pid, pos: s.pos || 0, hero: s.hero || '', kda: s.kda }));
function slim(data) {
  return {
    players: (data.players || []).map(p => ({ id: p.id, name: p.name, rank: p.rank, stars: p.stars, positions: p.positions || [], heroes: p.heroes || [], accountId: p.accountId || null })),
    matches: (data.matches || []).map(m => ({
      id: m.id, date: m.date, winner: m.winner, duration: m.duration, createdAt: m.createdAt, note: m.note || '',
      score: m.score, leagueId: m.leagueId, radiant: slimSide(m.radiant), dire: slimSide(m.dire), replay: slimReplay(m.replay),
    })),
  };
}
let cache = null, raw = null;   // 热实例内复用；raw = 完整数据
async function readAll() {
  const meta = await readMeta();
  if (cache && cache.version === meta.version) return cache;
  const [[r]] = await getPool().query(`SELECT version, updated_at, data FROM ${T} WHERE id = 'state'`);
  raw = r && r.data ? JSON.parse(r.data) : { players: [], matches: [], tournaments: [] };
  cache = { version: r ? r.version : 0, updatedAt: r ? r.updated_at : null, ...slim(raw) };
  return cache;
}

// ---------- 写（乐观锁：UPDATE … WHERE version = 读到的版本；被别人抢先就重读重做，最多 3 次） ----------
async function writeState(base, data) {
  const updatedAt = new Date().toISOString(), text = JSON.stringify({ players: data.players, matches: data.matches, tournaments: data.tournaments || [] });
  const [r] = base === 0
    ? await getPool().query(`INSERT IGNORE INTO ${T} (id, version, updated_at, data) VALUES ('state', 1, ?, ?)`, [updatedAt, text])
    : await getPool().query(`UPDATE ${T} SET version = version + 1, updated_at = ?, data = ? WHERE id = 'state' AND version = ?`, [updatedAt, text, base]);
  cache = null; raw = null;
  return r.affectedRows === 1 ? { version: base + 1, updatedAt } : null;
}
async function mutate(fn) {
  for (let i = 0; i < 3; i++) {
    await readAll();
    const base = cache.version, state = JSON.parse(JSON.stringify(raw));
    const result = await fn(state);
    if (result && result.noop) return { ...result, version: base };
    const next = await writeState(base, state);
    if (next) return { ...result, ...next };
  }
  throw new Error('数据一直在被别人修改，稍后再试');
}

// ---------- 管理员（微信 openid 白名单，存在 MySQL） ----------
let adminTable = false;
async function ensureAdminTable() {
  if (adminTable) return;
  await getPool().query(`CREATE TABLE IF NOT EXISTS ${TA} (openid VARCHAR(64) PRIMARY KEY, created_at VARCHAR(32)) DEFAULT CHARSET = utf8mb4`);
  adminTable = true;
}
async function isAdmin(openid) {
  if (!openid) return false;
  await ensureAdminTable();
  const [[r]] = await getPool().query(`SELECT openid FROM ${TA} WHERE openid = ?`, [openid]);
  return !!r;
}

// ---------- 外部接口 ----------
function getText(url, ms) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'dota-games-mp' } }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('请求太频繁，稍等一分钟再试'));
        if (res.statusCode === 404) return reject(Object.assign(new Error('没有找到'), { notFound: true }));
        if (res.statusCode !== 200) return reject(new Error('返回 ' + res.statusCode));
        resolve(body);
      });
    });
    req.setTimeout(ms, () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}
const getJson = async (url, ms) => JSON.parse(await getText(url, ms));
const PWE = 'https://gwapi.pwesports.cn/appdatacenter/api/v1/dota2';
const OPENDOTA = 'https://api.opendota.com/api';

// 单场：完美世界（国服、中文昵称）→ OpenDota 兜底（与网页 fetchMatchRaw 同顺序，少了 Worker 中转那一档）
async function fetchMatch(id) {
  const errs = [];
  try { return { m: C.pwesportsMatch(await getJson(`${PWE}/matches?matchId=${id}&platform=admin`, 12000)), source: '完美世界电竞' }; }
  catch (e) { errs.push('完美世界：' + e.message); }
  try {
    const m = await getJson(`${OPENDOTA}/matches/${id}`, 15000);
    if (!Array.isArray(m.players) || m.players.length < 2) throw new Error('比赛数据不完整，可能还没同步');
    return { m, source: 'OpenDota' };
  } catch (e) { errs.push('OpenDota：' + (e.notFound ? '没有这场比赛' : e.message)); }
  throw new Error(errs.join('；'));
}
async function fetchReplay(id) {
  try {
    const body = C.parseReplayJson(await getText(`${PWE}/match/replay?matchId=${id}`, 12000));
    return body.code === 0 ? C.compactReplay(body.result || {}) : null;
  } catch (e) { return null; }
}
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// 拉外部数据（慢）：查询和确认导入共用，热实例里缓存 10 分钟，确认时不用再拉一遍
const fetchCache = new Map();
async function fetchOne(id) {
  const hit = fetchCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  const { m, source } = await fetchMatch(id);
  const f = { id, at: Date.now(), parsed: C.parseOpenDotaMatch(m), source, rp: await fetchReplay(id) };
  fetchCache.set(id, f);
  return f;
}
async function fetchAllIds(ids, overwrite) {
  await readAll();
  const exists = new Set(raw.matches.map(m => m.id));
  const out = [];
  for (const id of ids) {
    if (exists.has(id) && !overwrite) { out.push({ id, skip: '已存在（勾选「覆盖已存在」才会重新导入）' }); continue; }
    try { out.push(await fetchOne(id)); } catch (e) { out.push({ id, error: e.message }); }
  }
  return out;
}

// 查询（不写库）：每场两队阵容、哪些人能对上名单、哪些会新建
async function previewMatches(ids, { autoNew, overwrite }) {
  const fetched = await fetchAllIds(ids, overwrite);
  const known = new Set(raw.players.map(p => p.id));
  return fetched.map(f => {
    if (!f.parsed) return { id: f.id, ok: false, error: f.error || f.skip, skipped: !!f.skip };
    const st = { players: raw.players.map(p => ({ ...p })), matches: [] };
    try {
      const r = C.importParsed(st, f.parsed, { autoNew, source: '预览', uid });
      const P = new Map(st.players.map(p => [p.id, p]));
      const side = arr => arr.map(s => ({ name: P.get(s.pid).name, hero: s.hero, pos: s.pos, kda: s.kda ? s.kda.join('/') : '', isNew: !known.has(s.pid) }));
      return { id: f.id, ok: true, source: f.source, date: f.parsed.date, winner: f.parsed.winner, score: f.parsed.score.join(':'), league: f.parsed.leagueId || 0, replay: !!f.rp,
        existed: raw.matches.some(m => m.id === f.id), created: r.created, dropped: f.parsed.radiant.length + f.parsed.dire.length - r.match.radiant.length - r.match.dire.length,
        radiant: side(r.match.radiant), dire: side(r.match.dire) };
    } catch (e) { return { id: f.id, ok: false, error: e.message }; }
  });
}

async function importMatches(ids, { autoNew, overwrite }) {
  // 先在锁外把外部数据都拉好（慢），再一次性写库（快），减少和别人冲突的窗口
  const fetched = await fetchAllIds(ids, overwrite);
  const todo = fetched.filter(f => f.parsed);
  if (!todo.length) return { results: fetched.map(f => ({ id: f.id, ok: false, error: f.error || f.skip, skipped: !!f.skip })), written: false };
  const out = await mutate(state => {
    const results = [];
    for (const f of fetched) {
      if (!f.parsed) { results.push({ id: f.id, ok: false, error: f.error || f.skip, skipped: !!f.skip }); continue; }
      try {
        const existed = state.matches.some(m => m.id === f.id);
        const r = C.importParsed(state, f.parsed, { autoNew, source: `${f.source} 导入（小程序）`, uid });
        // importParsed 覆盖已有比赛时会保留旧录像；拉到了新录像就换成新的
        if (f.rp) state.matches.find(m => m.id === f.id).replay = f.rp;
        results.push({ id: f.id, ok: true, created: r.created, existed, replay: !!f.rp, date: r.match.date, league: r.match.leagueId || 0,
          names: [...r.match.radiant, ...r.match.dire].length, unmatched: 10 - [...r.match.radiant, ...r.match.dire].length });
      } catch (e) { results.push({ id: f.id, ok: false, error: e.message }); }
    }
    if (!results.some(r => r.ok)) return { noop: true, results };
    return { results };
  });
  return { ...out, written: !out.noop };
}

// ---------- 网页 HTTP 接口（与 Worker /data 一致） ----------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token, X-Base-Version', 'Access-Control-Max-Age': '86400' };
const http = (statusCode, obj) => ({ statusCode, isBase64Encoded: false, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }, body: JSON.stringify(obj) });
function stripSnapshot(data, meta) {
  const players = (data.players || []).map(p => ({ id: p.id, name: p.name, rank: p.rank, stars: p.stars, positions: p.positions, heroes: p.heroes }));
  const matches = (data.matches || []).map(m => ({
    id: m.id, date: m.date, winner: m.winner, duration: m.duration, createdAt: m.createdAt, leagueId: (m.leagueId != null ? Number(m.leagueId) : Number(m.replay && m.replay.leagueId)) || undefined,
    radiant: (m.radiant || []).map(x => ({ pid: x.pid, hero: x.hero, pos: x.pos, kda: x.kda })),
    dire: (m.dire || []).map(x => ({ pid: x.pid, hero: x.hero, pos: x.pos, kda: x.kda })),
  }));
  return { meta: { publishedAt: meta.updatedAt, version: meta.version, players: players.length, matches: matches.length }, players, matches };
}
async function handleHttp(ev) {
  const method = (ev.httpMethod || 'GET').toUpperCase();
  const path = String(ev.path || '/').replace(/\/+$/, '');
  const q = ev.queryStringParameters || {};
  const hdr = Object.fromEntries(Object.entries(ev.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const isMeta = /\/data\/meta$/.test(path), isData = /\/data$/.test(path);
  if (!isMeta && !isData) return http(200, { ok: true, backend: 'mysql · 云开发', usage: ['/data', '/data/meta', '/data?strip=1'], editable: !!EDIT_TOKEN && WRITABLE });
  if (method === 'GET') {
    if (isMeta) return http(200, { ok: true, ...await readMeta() });
    await readAll();
    const meta = { version: cache.version, updatedAt: cache.updatedAt };
    if (q.strip != null) return http(200, cache.version ? stripSnapshot(raw, meta) : { meta: { publishedAt: null, version: 0, players: 0, matches: 0 }, players: [], matches: [] });
    return http(200, { ok: true, ...meta, data: cache.version ? raw : null });
  }
  if (method === 'PUT' && isData) {
    if (!EDIT_TOKEN || !WRITABLE) return http(503, { error: '数据库写入还没开放（MP_WRITE 未开启）' });
    if ((hdr['x-edit-token'] || '') !== EDIT_TOKEN) return http(401, { error: '编辑口令不正确' });
    let text = ev.body || '';
    if (ev.isBase64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
    let data; try { data = JSON.parse(text); } catch { return http(400, { error: '请求体不是合法 JSON' }); }
    if (!data || !Array.isArray(data.players) || !Array.isArray(data.matches)) return http(400, { error: '格式不对：需要 players / matches 数组' });
    const base = Number(hdr['x-base-version']);
    const next = Number.isInteger(base) && base >= 0 ? await writeState(base, data) : null;
    if (!next) return http(409, { error: '云端已被其他设备修改，请先拉取最新数据', conflict: true, ...await readMeta(), base: Number.isInteger(base) ? base : null });
    return http(200, { ok: true, ...next, players: data.players.length, matches: data.matches.length, tournaments: (data.tournaments || []).length });
  }
  return http(405, { error: '/data 只支持 GET / PUT，/data/meta 只支持 GET' });
}

// ---------- 入口 ----------
exports.main = async (event) => {
  try {
    if (event && event.httpMethod) return await handleHttp(event);
    const openid = event.userInfo && event.userInfo.openId;
    switch (event.action) {
      case 'meta': return { ok: true, ...await readMeta() };
      case 'data': {
        const d = await readAll();
        const parts = Math.max(1, Math.ceil(d.matches.length / PAGE));
        const part = Math.min(Math.max(0, Number(event.part) || 0), parts - 1);
        return { ok: true, version: d.version, updatedAt: d.updatedAt, parts, part, players: part === 0 ? d.players : undefined, matches: d.matches.slice(part * PAGE, (part + 1) * PAGE) };
      }
      case 'match': {
        await readAll();
        const m = (raw.matches || []).find(x => x.id === String(event.id));
        return m ? { ok: true, match: m } : { error: '找不到这场比赛' };
      }
      case 'ladder': return { ok: true, ...await ladder(String(event.pid || ''), !!event.force) };
      case 'me': return { ok: true, openid: openid || '', admin: await isAdmin(openid), writable: WRITABLE && !!EDIT_TOKEN };
      case 'bind': {
        if (!openid) return { error: '拿不到微信身份' };
        if (!EDIT_TOKEN) return { error: '服务端没有设置编辑口令' };
        if (String(event.token || '').trim() !== EDIT_TOKEN) return { error: '编辑口令不正确' };
        await ensureAdminTable();
        await getPool().query(`INSERT IGNORE INTO ${TA} (openid, created_at) VALUES (?, ?)`, [openid, new Date().toISOString()]);
        return { ok: true, admin: true };
      }
      case 'preview': {
        const ids = [...new Set((event.ids || []).map(x => String(x).match(/\d{6,}/)).filter(Boolean).map(x => x[0]))].slice(0, 10);
        if (!ids.length) return { error: '没有有效的比赛 ID（6 位以上数字）' };
        return { ok: true, results: await previewMatches(ids, { autoNew: event.autoNew !== false, overwrite: !!event.overwrite }) };
      }
      case 'import': {
        if (!WRITABLE) return { error: '数据库写入还没开放：网页切到数据库之后才能在小程序里导入，免得两边数据分叉' };
        if (!await isAdmin(openid)) return { error: '没有写权限：先在导入页输入编辑口令绑定' };
        const ids = [...new Set((event.ids || []).map(x => String(x).match(/\d{6,}/)).filter(Boolean).map(x => x[0]))].slice(0, 10);
        if (!ids.length) return { error: '没有有效的比赛 ID（6 位以上数字）' };
        return { ok: true, ...await importMatches(ids, { autoNew: event.autoNew !== false, overwrite: !!event.overwrite }) };
      }
      default: return { error: '未知操作：' + event.action };
    }
  } catch (e) {
    if (event && event.httpMethod) return http(500, { error: e.message || String(e) });
    return { error: e.message || String(e) };
  }
};

// ---------- OpenDota 天梯资料（与网页 fetchLadder 同四个接口） ----------
const pickKeys = (o, keys) => o ? Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]])) : o;
const ladderCache = new Map();
const LADDER_TTL = 10 * 60 * 1000;
async function ladder(pid, force) {
  await readAll();
  const p = (raw.players || []).find(x => x.id === pid);
  if (!p) throw new Error('找不到这名选手');
  const acc = p.accountId;
  if (!acc) return { noAccount: true };
  const hit = ladderCache.get(acc);
  if (hit && !force && Date.now() - hit.at < LADDER_TTL) return hit;
  const get = path => getJson(`${OPENDOTA}/players/${acc}${path ? '/' + path : ''}`, 16000);
  const [pf, h, r, c] = await Promise.allSettled([get(''), get('heroes'), get('recentMatches'), get('counts')]);
  const errs = [];
  const take = (s, label) => { if (s.status === 'fulfilled') return s.value; errs.push(`${label}：${s.reason && s.reason.message || s.reason}`); return null; };
  const prof = take(pf, '基础资料'), heroes = take(h, '擅长英雄'), recent = take(r, '近期比赛'), counts = take(c, '统计');
  const d = {
    at: Date.now(), accountId: acc, errs,
    profile: prof ? { profile: pickKeys(prof.profile, ['personaname', 'avatarmedium', 'plus', 'profileurl']), rank_tier: prof.rank_tier, leaderboard_rank: prof.leaderboard_rank } : null,
    heroes: Array.isArray(heroes) ? heroes.filter(x => x.games > 0).map(x => pickKeys(x, ['hero_id', 'games', 'win', 'last_played', 'with_games', 'with_win', 'against_games', 'against_win'])) : null,
    recent: Array.isArray(recent) ? recent.map(x => pickKeys(x, ['match_id', 'hero_id', 'player_slot', 'radiant_win', 'kills', 'deaths', 'assists', 'gold_per_min', 'xp_per_min', 'last_hits', 'duration', 'game_mode', 'lobby_type', 'party_size', 'average_rank', 'start_time'])) : null,
    counts: counts ? pickKeys(counts, ['lobby_type', 'game_mode', 'lane_role', 'region', 'patch', 'leaver_status', 'is_radiant']) : null,
  };
  if (d.profile || d.heroes || d.recent || d.counts) ladderCache.set(acc, d);
  return d;
}
