/**
 * Dota 内战记录 · 云同步接口（MongoDB Atlas 版）
 * 与 worker/src/index.js 里的 /data 接口完全一致，页面只要把「云同步地址」指到这里即可，其余代码不用改。
 *
 *   GET  /                 → 健康检查
 *   GET  /data             → { ok, version, updatedAt, data: { players, matches, tournaments } | null }
 *   GET  /data?strip=1     → 脱敏快照（去 accountId / note / 赛事），给 ?share=cloud 只读分享页用
 *   GET  /data/meta        → { ok, version, updatedAt }，轻量探测
 *   PUT  /data             → 整份覆盖写入。请求头 X-Edit-Token = EDIT_TOKEN，X-Base-Version = 客户端读到的版本号；
 *                            不一致返回 409（乐观锁，靠 MongoDB 单文档条件更新保证原子）
 *
 * 环境变量：
 *   MONGODB_URI   必填，Atlas 连接串（mongodb+srv://user:pass@cluster0.xxx.mongodb.net）
 *   EDIT_TOKEN    编辑口令；不设则接口只读
 *   MONGODB_DB    库名，默认 dota
 *   PORT          监听端口，默认 8787；阿里云函数计算自定义运行时会注入 FC_SERVER_PORT（9000），自动识别
 *   DNS_SERVERS   可选，逗号分隔。国内部分运营商 DNS 解析不了 Atlas 的 SRV/TXT 记录时填 223.5.5.5,119.29.29.29
 *
 * 存储：库里一张 state 集合、一条 _id = 'state' 的文档 { version, updatedAt, data }。
 * MongoDB 单文档上限 16MB，这里按 15MB 拦截；页面全量数据目前 1MB 量级，够用很久。
 */
import http from 'node:http';
import dns from 'node:dns';
import { MongoClient } from 'mongodb';

const PORT = Number(process.env.FC_SERVER_PORT || process.env.PORT || 8787);
const URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.MONGODB_DB || 'dota';
const EDIT_TOKEN = process.env.EDIT_TOKEN || '';
const DATA_MAX_BYTES = 15 * 1024 * 1024;
if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(',').map(s => s.trim()).filter(Boolean));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token, X-Base-Version',
  'Access-Control-Max-Age': '86400',
};

// ---------- MongoDB 连接（懒连接 + 复用；连不上时下次请求再试） ----------
let client = null, connecting = null;
async function col() {
  if (!URI) throw Object.assign(new Error('未配置 MONGODB_URI'), { status: 503 });
  if (!client) {
    if (!connecting) {
      const c = new MongoClient(URI, { serverSelectionTimeoutMS: 15000, maxPoolSize: 5 });
      connecting = c.connect().then(() => { client = c; }).finally(() => { connecting = null; });
    }
    await connecting;
  }
  return client.db(DB_NAME).collection('state');
}

async function readMeta(c) {
  const m = await c.findOne({ _id: 'state' }, { projection: { data: 0 } });
  return m && typeof m.version === 'number' ? { version: m.version, updatedAt: m.updatedAt || null } : { version: 0, updatedAt: null };
}

// 与 Worker / 页面 buildSnapshot() 同口径：剥 accountId、note、全部赛事 / 拍卖
function stripSnapshot(data, meta) {
  const players = (data.players || []).map(p => ({ id: p.id, name: p.name, rank: p.rank, stars: p.stars, positions: p.positions, heroes: p.heroes }));
  const matches = (data.matches || []).map(m => ({
    id: m.id, date: m.date, winner: m.winner, duration: m.duration, createdAt: m.createdAt,
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
  const isMeta = /^\/data\/meta\/?$/.test(url.pathname);
  const c = await col();

  if (req.method === 'GET') {
    if (isMeta) return [200, { ok: true, ...await readMeta(c) }];
    const doc = await c.findOne({ _id: 'state' });
    const meta = doc ? { version: doc.version, updatedAt: doc.updatedAt || null } : { version: 0, updatedAt: null };
    const data = doc?.data || null;
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
    if (!Number.isInteger(base)) {
      const meta = await readMeta(c);
      return [409, { error: '缺少 X-Base-Version，请先拉取最新数据', conflict: true, ...meta, base: null }];
    }
    // 条件更新 = 乐观锁：只有 version 仍等于客户端读到的值才写入；首次写入（base 0、文档不存在）走 upsert
    const updatedAt = new Date().toISOString();
    let res = null;
    try {
      res = await c.findOneAndUpdate(
        { _id: 'state', version: base },
        { $set: { data: { players: data.players, matches: data.matches, tournaments: data.tournaments }, updatedAt }, $inc: { version: 1 } },
        { upsert: base === 0, returnDocument: 'after', projection: { data: 0 } },
      );
    } catch (e) { if (e.code !== 11000) throw e; }   // upsert 撞上已存在的文档 = 别人已经写过第一版
    if (!res) {
      const meta = await readMeta(c);
      return [409, { error: '云端已被其他设备修改，请先拉取最新数据', conflict: true, ...meta, base }];
    }
    return [200, { ok: true, version: res.version, updatedAt: res.updatedAt, players: data.players.length, matches: data.matches.length, tournaments: data.tournaments.length }];
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
      let db = 'unknown';
      try { await (await col()).estimatedDocumentCount(); db = 'ok'; } catch (e) { db = '连接失败：' + e.message; }
      return send(200, { ok: true, backend: 'mongodb', usage: ['/data', '/data/meta', '/data?strip=1'], db, editable: !!EDIT_TOKEN });
    }
    send(404, { error: '没有这个路径', usage: ['/data', '/data/meta', '/data?strip=1'] });
  } catch (e) {
    send(e.status || 500, { error: e.message || String(e) });
  }
});
server.listen(PORT, () => console.log(`dota data server listening on :${PORT} (db=${DB_NAME}, editable=${!!EDIT_TOKEN})`));
