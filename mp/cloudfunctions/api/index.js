/**
 * 小程序云函数 api：读百度云 MySQL 里的 dota_state（网页版 server/ 写的同一张表）
 *   { action: 'meta' }            → { ok, version, updatedAt }
 *   { action: 'data', part: n }   → { ok, version, updatedAt, parts, part, players?(仅 part 0), matches: 第 n 页 }
 * 数据库连接信息走云函数环境变量 MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE（mp/deploy.js 从 server/.env 读取后设置），不进代码。
 * 第一期只读；写入（录比赛）放第二期，按微信 openid 白名单鉴权。
 */
const mysql = require('mysql2/promise');

const PAGE = 200;   // 每页比赛数：小程序本地缓存单个 key 上限 1MB，云函数返回也别太大
let pool = null;
const getPool = () => pool || (pool = mysql.createPool({
  host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
  connectionLimit: 2, connectTimeout: 10000, charset: 'utf8mb4',
}));

async function readMeta() {
  const [[r]] = await getPool().query("SELECT version, updated_at FROM dota_state WHERE id = 'state'");
  return r ? { version: r.version, updatedAt: r.updated_at } : { version: 0, updatedAt: null };
}

// 只留小程序用得到的字段：录像只留统计称号要的分路 / 击杀 / 经济，去掉胜率曲线、BP、资源等
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

let cache = null;   // 同一个热实例里复用，版本没变就不重新解析 1MB 的 JSON
async function readAll() {
  const meta = await readMeta();
  if (cache && cache.version === meta.version) return cache;
  const [[r]] = await getPool().query("SELECT version, updated_at, data FROM dota_state WHERE id = 'state'");
  const d = r && r.data ? slim(JSON.parse(r.data)) : { players: [], matches: [] };
  cache = { version: r ? r.version : 0, updatedAt: r ? r.updated_at : null, ...d };
  return cache;
}

exports.main = async (event) => {
  try {
    if (event.action === 'meta') return { ok: true, ...await readMeta() };
    if (event.action === 'data') {
      const d = await readAll();
      const parts = Math.max(1, Math.ceil(d.matches.length / PAGE));
      const part = Math.min(Math.max(0, Number(event.part) || 0), parts - 1);
      return {
        ok: true, version: d.version, updatedAt: d.updatedAt, parts, part,
        players: part === 0 ? d.players : undefined,
        matches: d.matches.slice(part * PAGE, (part + 1) * PAGE),
      };
    }
    return { error: '未知操作：' + event.action };
  } catch (e) {
    return { error: e.message || String(e) };
  }
};
