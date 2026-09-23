/**
 * Dota 2 比赛详情中转（Cloudflare Worker）
 *   GET /match/{比赛ID}        → 统一格式的比赛详情（OpenDota 优先，失败走 Valve 官方 Steam Web API，可选 STRATZ 补位置/昵称）
 *   GET /league/{联赛ID}       → 该联赛全部比赛列表（Steam GetMatchHistory 服务端翻页，需 STEAM_API_KEY）
 *   GET /                       → 健康检查 + 已配置的数据源
 *   ?nocache=1                  → 跳过 10 分钟缓存
 *
 * 云端数据库（Cloudflare KV，绑定名 DB；页面所有设备共用一份数据）：
 *   GET /data                   → { ok, version, updatedAt, data: { players, matches, tournaments } | null }
 *   GET /data?strip=1           → 脱敏快照（去 accountId / note / 赛事），字段与页面「发布统计快照」生成的 stats.json 相同
 *   GET /data/meta              → { ok, version, updatedAt }，只读元信息，用于低成本探测云端有没有更新
 *   PUT /data                   → 整份覆盖写入。请求头 X-Edit-Token = 编辑口令（wrangler secret EDIT_TOKEN），
 *                                 X-Base-Version = 客户端读到的版本号；版本不一致返回 409（乐观锁，防止两台设备互相静默覆盖）
 */
const OPENDOTA = 'https://api.opendota.com/api/matches/';
const STEAM_MATCH = 'https://api.steampowered.com/IDOTA2Match_570/GetMatchDetails/v1/';
const STEAM_SUMMARY = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const STEAM_HISTORY = 'https://api.steampowered.com/IDOTA2Match_570/GetMatchHistory/v1/';
const STRATZ = 'https://api.stratz.com/graphql';
const ANON = 4294967295;             // Steam 对匿名玩家返回的占位 account_id
const STEAM64_BASE = 76561197960265728n;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token, X-Base-Version',
  'Access-Control-Expose-Headers': 'X-Cache',
  'Access-Control-Max-Age': '86400',
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra } });

async function fetchTimeout(url, opts = {}, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? `超时 ${ms}ms` : e.message); }
  finally { clearTimeout(t); }
}
const notFound = msg => Object.assign(new Error(msg), { notFound: true });

// ---------- 数据源 1：OpenDota ----------
async function fromOpenDota(id) {
  const r = await fetchTimeout(OPENDOTA + id, {}, 9000);
  if (r.status === 404) throw notFound('OpenDota 未找到');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  if (!Array.isArray(d.players) || d.players.length < 2) throw new Error('数据不完整');
  if (d.players.every(p => !p.hero_id)) throw new Error('英雄数据为空（尚未同步）');
  d.source = 'opendota';
  return d;
}

// ---------- 数据源 2：Valve 官方 Steam Web API ----------
async function fromSteam(id, key) {
  const r = await fetchTimeout(`${STEAM_MATCH}?key=${encodeURIComponent(key)}&match_id=${id}`, {}, 9000);
  if (r.status === 403 || r.status === 401) throw new Error('Steam API Key 无效或未授权');
  if (r.status === 429) throw new Error('Steam 限流');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const { result } = await r.json();
  if (!result) throw new Error('空响应');
  if (result.error) throw (/not found/i.test(result.error) ? notFound('Steam 未找到') : new Error(result.error));
  if (!Array.isArray(result.players) || !result.players.length) throw new Error('无玩家数据');
  const data = {
    match_id: result.match_id, radiant_win: result.radiant_win, duration: result.duration, start_time: result.start_time,
    radiant_score: result.radiant_score, dire_score: result.dire_score, lobby_type: result.lobby_type, game_mode: result.game_mode,
    source: 'steam',
    players: result.players.map(p => ({
      account_id: p.account_id == null || p.account_id === ANON ? null : p.account_id,
      personaname: null, hero_id: p.hero_id || 0, player_slot: p.player_slot, isRadiant: p.player_slot < 128,
      kills: p.kills ?? 0, deaths: p.deaths ?? 0, assists: p.assists ?? 0,
      gold_per_min: p.gold_per_min ?? 0, xp_per_min: p.xp_per_min ?? 0, last_hits: p.last_hits ?? 0, net_worth: p.net_worth ?? null,
      lane_role: null, is_roaming: null, rank_tier: null,
    })),
  };
  // 顺手用 Steam 拿公开玩家的昵称（一次请求，失败不影响主流程）
  const ids = data.players.filter(p => p.account_id).map(p => (BigInt(p.account_id) + STEAM64_BASE).toString());
  if (ids.length) {
    try {
      const s = await fetchTimeout(`${STEAM_SUMMARY}?key=${encodeURIComponent(key)}&steamids=${ids.join(',')}`, {}, 6000);
      if (s.ok) {
        const list = (await s.json())?.response?.players || [];
        for (const sp of list) {
          const acc = Number(BigInt(sp.steamid) - STEAM64_BASE);
          const p = data.players.find(x => x.account_id === acc);
          if (p && sp.personaname) p.personaname = sp.personaname;
        }
      }
    } catch (e) { data.warnings = [`昵称获取失败：${e.message}`]; }
  }
  return data;
}

// ---------- 可选：STRATZ 补 1-5 号位、昵称、段位 ----------
async function enrichStratz(data, id, token) {
  const query = `{ match(id: ${id}) { players { playerSlot steamAccountId position lane steamAccount { name seasonRank } } } }`;
  const r = await fetchTimeout(STRATZ, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'User-Agent': 'STRATZ_API' },
    body: JSON.stringify({ query }),
  }, 9000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const ps = j?.data?.match?.players;
  if (!ps) throw new Error(j?.errors?.[0]?.message || '无数据');
  for (const sp of ps) {
    const p = data.players.find(x => x.player_slot === sp.playerSlot);
    if (!p) continue;
    const pos = Number(String(sp.position || '').replace('POSITION_', ''));
    if (pos >= 1 && pos <= 5) p.position = pos;
    if (!p.personaname && sp.steamAccount?.name) p.personaname = sp.steamAccount.name;
    if (!p.rank_tier && sp.steamAccount?.seasonRank) p.rank_tier = sp.steamAccount.seasonRank;
  }
  data.enriched = [...(data.enriched || []), 'stratz'];
}

// ---------- 联赛比赛列表：按 start_at_match_id 向前翻页直到 results_remaining 为 0 ----------
async function leagueMatches(leagueId, key) {
  const out = [], seen = new Set();
  let start = null, total = null;
  for (let page = 0; page < 20; page++) {
    const u = `${STEAM_HISTORY}?key=${encodeURIComponent(key)}&league_id=${leagueId}&matches_requested=100${start ? '&start_at_match_id=' + start : ''}`;
    const r = await fetchTimeout(u, {}, 9000);
    if (r.status === 403 || r.status === 401) throw new Error('Steam API Key 无效或未授权');
    if (r.status === 429) throw new Error('Steam 限流，稍后再试');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const res = (await r.json())?.result;
    if (!res || res.status !== 1) throw new Error(res?.statusDetail || '空响应');
    if (total == null) total = res.total_results ?? null;
    const list = res.matches || [];
    let fresh = 0;
    for (const m of list) {
      if (seen.has(m.match_id)) continue;
      seen.add(m.match_id); fresh++;
      out.push({
        match_id: m.match_id, start_time: m.start_time, lobby_type: m.lobby_type, series_id: m.series_id || 0, series_type: m.series_type || 0,
        players: (m.players || []).map(p => ({ account_id: p.account_id == null || p.account_id === ANON ? null : p.account_id, player_slot: p.player_slot, hero_id: p.hero_id || 0 })),
      });
    }
    if (!list.length || !fresh || !res.results_remaining) break;
    start = list[list.length - 1].match_id - 1;
  }
  return { league_id: Number(leagueId), total: total ?? out.length, count: out.length, matches: out };
}

// ---------- 云端数据库：KV 里两把 key ----------
//   state → 整份数据 JSON（players / matches / tournaments）
//   meta  → { version, updatedAt }，单独存是为了 /data/meta 探测时不用下载 1MB+ 的 state
// 写入串行依赖 version 乐观锁：客户端必须带上它读到的版本，不一致就 409 让它先拉再决定。
// KV 是最终一致存储，极端情况下两次几乎同时的写仍可能都通过校验——这是可接受的取舍，
// 真到多人同时录入频繁冲突的程度，该换 D1 按条写入而不是在 KV 上加锁。
const DATA_MAX_BYTES = 20 * 1024 * 1024;   // KV 单值上限 25MB，留余量
const NO_STORE = { 'Cache-Control': 'no-store' };

async function readMeta(db) {
  const m = await db.get('meta', 'json');
  return m && typeof m.version === 'number' ? m : { version: 0, updatedAt: null };
}

// 与页面 buildSnapshot() 同口径：剥 accountId、note、全部赛事 / 拍卖；只在服务端剥，前端不显示不算脱敏
function stripSnapshot(data, meta) {
  const players = (data.players || []).map(p => ({ id: p.id, name: p.name, rank: p.rank, stars: p.stars, positions: p.positions, heroes: p.heroes }));
  const matches = (data.matches || []).map(m => ({
    id: m.id, date: m.date, winner: m.winner, duration: m.duration, createdAt: m.createdAt,
    radiant: (m.radiant || []).map(x => ({ pid: x.pid, hero: x.hero, pos: x.pos, kda: x.kda })),
    dire: (m.dire || []).map(x => ({ pid: x.pid, hero: x.hero, pos: x.pos, kda: x.kda })),
  }));
  return { meta: { publishedAt: meta.updatedAt, version: meta.version, players: players.length, matches: matches.length }, players, matches };
}

async function handleData(req, env, url) {
  if (!env.DB) return json({ error: '中转未绑定 KV（wrangler.toml 里的 [[kv_namespaces]] binding = "DB"）' }, 503, NO_STORE);
  const isMeta = /^\/data\/meta\/?$/.test(url.pathname);

  if (req.method === 'GET') {
    const meta = await readMeta(env.DB);
    if (isMeta) return json({ ok: true, ...meta }, 200, NO_STORE);
    const raw = await env.DB.get('state', 'text');
    const data = raw ? JSON.parse(raw) : null;
    if (url.searchParams.has('strip')) {
      return json(data ? stripSnapshot(data, meta) : { meta: { publishedAt: null, version: 0, players: 0, matches: 0 }, players: [], matches: [] }, 200, NO_STORE);
    }
    return json({ ok: true, ...meta, data }, 200, NO_STORE);
  }

  if (req.method === 'PUT' && !isMeta) {
    if (!env.EDIT_TOKEN) return json({ error: '中转未配置 EDIT_TOKEN（npx wrangler secret put EDIT_TOKEN）' }, 503, NO_STORE);
    const token = req.headers.get('X-Edit-Token') || '';
    if (token !== env.EDIT_TOKEN) return json({ error: '编辑口令不正确' }, 401, NO_STORE);
    const len = Number(req.headers.get('Content-Length') || 0);
    if (len > DATA_MAX_BYTES) return json({ error: `数据过大（${(len / 1048576).toFixed(1)}MB，上限 20MB）` }, 413, NO_STORE);
    const text = await req.text();
    if (text.length > DATA_MAX_BYTES) return json({ error: '数据过大（上限 20MB）' }, 413, NO_STORE);
    let data;
    try { data = JSON.parse(text); } catch { return json({ error: '请求体不是合法 JSON' }, 400, NO_STORE); }
    if (!data || !Array.isArray(data.players) || !Array.isArray(data.matches)) return json({ error: '格式不对：需要 players / matches 数组' }, 400, NO_STORE);
    if (!Array.isArray(data.tournaments)) data.tournaments = [];

    const meta = await readMeta(env.DB);
    const base = Number(req.headers.get('X-Base-Version'));
    if (!Number.isInteger(base) || base !== meta.version) {
      return json({ error: '云端已被其他设备修改，请先拉取最新数据', conflict: true, version: meta.version, updatedAt: meta.updatedAt, base: Number.isInteger(base) ? base : null }, 409, NO_STORE);
    }
    const next = { version: meta.version + 1, updatedAt: new Date().toISOString() };
    await env.DB.put('state', JSON.stringify({ players: data.players, matches: data.matches, tournaments: data.tournaments }));
    await env.DB.put('meta', JSON.stringify(next));
    return json({ ok: true, ...next, players: data.players.length, matches: data.matches.length, tournaments: data.tournaments.length }, 200, NO_STORE);
  }
  return json({ error: '/data 只支持 GET / PUT，/data/meta 只支持 GET' }, 405, NO_STORE);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (/^\/data(\/meta)?\/?$/.test(url.pathname)) return handleData(req, env, url);
    if (req.method !== 'GET') return json({ error: '只支持 GET' }, 405);
    if (url.pathname === '/' || url.pathname === '') {
      return json({ ok: true, usage: ['/match/{比赛ID}', '/league/{联赛ID}', '/data', '/data/meta', '/data?strip=1'], sources: { opendota: true, steam: !!env.STEAM_API_KEY, stratz: !!env.STRATZ_TOKEN }, db: { bound: !!env.DB, editable: !!env.EDIT_TOKEN } });
    }
    const lg = url.pathname.match(/^\/league\/(\d{1,9})\/?$/);
    if (lg) {
      if (!env.STEAM_API_KEY) return json({ error: '中转未配置 STEAM_API_KEY，无法拉取联赛列表' }, 503);
      const cache = caches.default;
      const cacheKey = new Request(`${url.origin}/league/${lg[1]}`, { method: 'GET' });
      if (!url.searchParams.has('nocache')) {
        const hit = await cache.match(cacheKey);
        if (hit) { const h = new Headers(hit.headers); h.set('X-Cache', 'HIT'); return new Response(hit.body, { status: hit.status, headers: h }); }
      }
      try {
        const data = await leagueMatches(lg[1], env.STEAM_API_KEY);
        data.fetchedAt = new Date().toISOString();
        const res = json(data, 200, { 'Cache-Control': 'public, max-age=300', 'X-Cache': 'MISS' });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      } catch (e) { return json({ error: '拉取联赛列表失败：' + e.message, league_id: Number(lg[1]) }, 502); }
    }
    const m = url.pathname.match(/^\/match\/(\d{5,})\/?$/);
    if (!m) return json({ error: '用法：/match/{比赛ID} 或 /league/{联赛ID}' }, 404);
    const id = m[1];

    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/match/${id}`, { method: 'GET' });
    if (!url.searchParams.has('nocache')) {
      const hit = await cache.match(cacheKey);
      if (hit) { const h = new Headers(hit.headers); h.set('X-Cache', 'HIT'); return new Response(hit.body, { status: hit.status, headers: h }); }
    }

    const errors = [];
    let data = null, allNotFound = true;
    try { data = await fromOpenDota(id); } catch (e) { errors.push('opendota: ' + e.message); allNotFound &&= !!e.notFound; }
    if (!data) {
      if (env.STEAM_API_KEY) {
        try { data = await fromSteam(id, env.STEAM_API_KEY); } catch (e) { errors.push('steam: ' + e.message); allNotFound &&= !!e.notFound; }
      } else { errors.push('steam: 未配置 STEAM_API_KEY'); allNotFound = false; }
    }
    if (!data) return json({ error: allNotFound ? '两个数据源都没有这场比赛' : '所有数据源都失败', id, errors }, allNotFound ? 404 : 502);

    if (env.STRATZ_TOKEN) { try { await enrichStratz(data, id, env.STRATZ_TOKEN); } catch (e) { errors.push('stratz: ' + e.message); } }
    data.proxy = { errors, fetchedAt: new Date().toISOString() };

    const res = json(data, 200, { 'Cache-Control': 'public, max-age=600', 'X-Cache': 'MISS' });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
