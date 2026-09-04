/**
 * Dota 2 比赛详情中转（Cloudflare Worker）
 *   GET /match/{比赛ID}        → 统一格式的比赛详情（OpenDota 优先，失败走 Valve 官方 Steam Web API，可选 STRATZ 补位置/昵称）
 *   GET /                       → 健康检查 + 已配置的数据源
 *   ?nocache=1                  → 跳过 10 分钟缓存
 */
const OPENDOTA = 'https://api.opendota.com/api/matches/';
const STEAM_MATCH = 'https://api.steampowered.com/IDOTA2Match_570/GetMatchDetails/v1/';
const STEAM_SUMMARY = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const STRATZ = 'https://api.stratz.com/graphql';
const ANON = 4294967295;             // Steam 对匿名玩家返回的占位 account_id
const STEAM64_BASE = 76561197960265728n;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'GET') return json({ error: '只支持 GET' }, 405);
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '') {
      return json({ ok: true, usage: '/match/{比赛ID}', sources: { opendota: true, steam: !!env.STEAM_API_KEY, stratz: !!env.STRATZ_TOKEN } });
    }
    const m = url.pathname.match(/^\/match\/(\d{5,})\/?$/);
    if (!m) return json({ error: '用法：/match/{比赛ID}' }, 404);
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
