/**
 * 把现有云端数据原样搬进数据库（版本号、更新时间一起搬，页面会认成同一份数据）。
 *
 *   node migrate.mjs --from https://dota-match-proxy.corray.workers.dev   从旧接口拉 /data
 *   node migrate.mjs --file dump.json                                     从文件读（/data 的返回，或导出备份的 JSON）
 *   加 --force 才会覆盖库里已有的数据；默认只在库为空或库里版本更旧时写入
 *
 * 数据库按 .env.example 里的环境变量配置（MYSQL_* 或 MONGODB_URI），和 index.js 用的是同一套。
 * Node 自带的 fetch 不走 HTTP_PROXY；workers.dev 要代理才能访问时，先用 curl 下载成文件再 --file。
 */
import fs from 'node:fs';
import dns from 'node:dns';
import { createStore } from './store.js';

if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(',').map(s => s.trim()).filter(Boolean));
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const force = process.argv.includes('--force');
const from = arg('--from'), file = arg('--file');
if (!from && !file) { console.error('用法：node migrate.mjs --from <旧接口地址> | --file <json 文件> [--force]'); process.exit(1); }

const store = createStore();
if (!store) { console.error('未配置数据库：设置 MYSQL_HOST 等或 MONGODB_URI'); process.exit(1); }

try {
  const raw = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : await (await fetch(from.replace(/\/+$/, '') + '/data', { cache: 'no-store' })).json();
  const data = raw.data ?? raw;   // /data 返回 { version, updatedAt, data }；导出备份直接是 { players, matches, tournaments }
  if (!Array.isArray(data?.players) || !Array.isArray(data?.matches)) throw new Error('源数据格式不对：需要 players / matches 数组');
  const version = Number.isInteger(raw.version) && raw.version > 0 ? raw.version : 1;
  const updatedAt = raw.updatedAt || new Date().toISOString();
  const payload = { players: data.players, matches: data.matches, tournaments: data.tournaments || [] };
  console.log(`源数据：v${version} · ${updatedAt} · ${payload.players.length} 名选手 / ${payload.matches.length} 场比赛 / ${payload.tournaments.length} 个赛事 · ${(JSON.stringify(payload).length / 1048576).toFixed(2)} MB`);

  const cur = await store.readMeta();
  console.log(`目标库（${store.name}）：${cur.version ? `已有 v${cur.version} · ${cur.updatedAt}` : '空'}`);
  if (cur.version && !force && cur.version >= version) throw new Error(`目标库已有 v${cur.version}，不比源数据旧。确认要覆盖请加 --force`);

  await store.overwrite(version, updatedAt, payload);
  const { meta, data: back } = await store.read();
  const same = JSON.stringify(back) === JSON.stringify(payload);
  console.log(`已写入：v${meta.version} · ${meta.updatedAt} · 回读 ${back.players.length} 名选手 / ${back.matches.length} 场比赛 / ${back.tournaments.length} 个赛事 · 与源数据${same ? '完全一致' : '不一致！'}`);
  if (!same) process.exitCode = 2;
} catch (e) { console.error('迁移失败：' + e.message); process.exitCode = 1; }
finally { await store.close(); }
