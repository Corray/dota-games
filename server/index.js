/**
 * Dota 内战记录 · 云同步接口（MySQL / MongoDB 二选一）
 * 与 worker/src/index.js 里的 /data 接口完全一致，页面把「☁ → 云同步地址」指到这里即可，其余代码不用改。
 *
 *   GET  /                 → 健康检查（db: ok 表示连上了数据库）
 *   GET  /data             → { ok, version, updatedAt, data: { players, matches, tournaments } | null }
 *   GET  /data?strip=1     → 脱敏快照（去 accountId / note / 赛事），给 ?share=cloud 只读分享页用
 *   GET  /data/meta        → { ok, version, updatedAt }，轻量探测
 *   PUT  /data             → 整份覆盖写入。请求头 X-Edit-Token = EDIT_TOKEN，X-Base-Version = 客户端读到的版本号；
 *                            不一致返回 409（乐观锁：条件更新 WHERE version = base，数据库保证原子）
 *
 * 存储选择（按环境变量自动判断，MySQL 优先）：
 *   MySQL：MYSQL_HOST（必填）MYSQL_PORT=3306 MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE
 *          自动建表 dota_state(id, version, updated_at, data LONGTEXT)，只有一行 id = 'state'
 *   MongoDB：MONGODB_URI（必填）MONGODB_DB=dota，集合 state 里一条 _id = 'state' 的文档
 *
 * 其他环境变量：
 *   EDIT_TOKEN    编辑口令；不设则接口只读
 *   PORT          监听端口，默认 8787；阿里云 / 百度云函数计算注入的 FC_SERVER_PORT 优先
 *   DNS_SERVERS   可选，逗号分隔，本机 DNS 解析不了数据库域名时填 223.5.5.5,119.29.29.29
 */
import http from 'node:http';
import dns from 'node:dns';
import { createStore } from './store.js';

const PORT = Number(process.env.FC_SERVER_PORT || process.env.PORT || 8787);
const EDIT_TOKEN = process.env.EDIT_TOKEN || '';
const DATA_MAX_BYTES = 15 * 1024 * 1024;   // MongoDB 单文档 16MB；MySQL LONGTEXT 够大，统一按 15MB 拦
if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(',').map(s => s.trim()).filter(Boolean));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token, X-Base-Version',
  'Access-Control-Max-Age': '86400',
};

const store = createStore();

// ---------- 接口 ----------

// 与 Worker / 页面 buildSnapshot() 同口径：剥 accountId、note、全部赛事 / 拍卖
function stripSnapshot(data, meta) {
  const players = (data.players || []).map(p => ({ id: p.id, name: p.name, rank: p.rank, stars: p.stars, positions: p.positions, heroes: p.heroes }));
  const matches = (data.matches || []).map(m => ({
    id: m.id, date: m.date, winner: m.winner, duration: m.duration, createdAt: m.createdAt, leagueId: (m.leagueId != null ? Number(m.leagueId) : Number(m.replay?.leagueId)) || undefined,
    radiant: (m.radiant || []).map(x => ({ pid: x.pid, hero: x.hero, pos: x.pos, kda: x.kda })),
    dire: (m.dire || []).map(x => ({ pid: x.pid, hero: x.hero, pos: x.pos, kda: x.kda })),
  }));
  return { meta: { publishedAt: meta.updatedAt, version: meta.version, players: players.length, matches: matches.length }, players, matches };
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', ch => {
      size += ch.length;
      if (size > max) { reject(Object.assign(new Error(`数据过大（上限 ${max / 1048576}MB）`), { status: 413 })); req.destroy(); return; }
      chunks.push(ch);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleData(req, url) {
  if (!store) return [503, { error: '未配置数据库：设置 MYSQL_HOST 等或 MONGODB_URI' }];
  const isMeta = /^\/data\/meta\/?$/.test(url.pathname);

  if (req.method === 'GET') {
    if (isMeta) return [200, { ok: true, ...await store.readMeta() }];
    const { meta, data } = await store.read();
    if (url.searchParams.has('strip')) {
      return [200, data ? stripSnapshot(data, meta) : { meta: { publishedAt: null, version: 0, players: 0, matches: 0 }, players: [], matches: [] }];
    }
    return [200, { ok: true, ...meta, data }];
  }

  if (req.method === 'PUT' && !isMeta) {
    if (!EDIT_TOKEN) return [503, { error: '服务端未配置 EDIT_TOKEN，接口只读' }];
    if ((req.headers['x-edit-token'] || '') !== EDIT_TOKEN) return [401, { error: '编辑口令不正确' }];
    const len = Number(req.headers['content-length'] || 0);
    if (len > DATA_MAX_BYTES) return [413, { error: `数据过大（${(len / 1048576).toFixed(1)}MB，上限 15MB）` }];
    const text = await readBody(req, DATA_MAX_BYTES);
    let data;
    try { data = JSON.parse(text); } catch { return [400, { error: '请求体不是合法 JSON' }]; }
    if (!data || !Array.isArray(data.players) || !Array.isArray(data.matches)) return [400, { error: '格式不对：需要 players / matches 数组' }];
    if (!Array.isArray(data.tournaments)) data.tournaments = [];
    const base = Number(req.headers['x-base-version']);
    const next = Number.isInteger(base) && base >= 0
      ? await store.write(base, { players: data.players, matches: data.matches, tournaments: data.tournaments })
      : null;
    if (!next) return [409, { error: '云端已被其他设备修改，请先拉取最新数据', conflict: true, ...await store.readMeta(), base: Number.isInteger(base) ? base : null }];
    return [200, { ok: true, ...next, players: data.players.length, matches: data.matches.length, tournaments: data.tournaments.length }];
  }
  return [405, { error: '/data 只支持 GET / PUT，/data/meta 只支持 GET' }];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...CORS });
    res.end(body);
  };
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (/^\/data(\/meta)?\/?$/.test(url.pathname)) return send(...await handleData(req, url));
    if (url.pathname === '/' || url.pathname === '') {
      let db = '未配置';
      if (store) { try { await store.ping(); db = 'ok'; } catch (e) { db = '连接失败：' + e.message; } }
      return send(200, { ok: true, backend: store?.name || null, usage: ['/data', '/data/meta', '/data?strip=1'], db, editable: !!EDIT_TOKEN });
    }
    send(404, { error: '没有这个路径', usage: ['/data', '/data/meta', '/data?strip=1'] });
  } catch (e) {
    send(e.status || 500, { error: e.message || String(e) });
  }
});
server.listen(PORT, () => console.log(`dota data server listening on :${PORT} (backend=${store?.name || 'none'}, editable=${!!EDIT_TOKEN})`));
