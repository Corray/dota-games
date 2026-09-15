#!/usr/bin/env node
/* 从 OpenDota 拉英雄两两对位数据，生成 bp-data-od.json（BP 助手的第二数据源）
   接口：GET https://api.opendota.com/api/heroes/{id}/matchups  → [{ hero_id, games_played, wins }]
   口径：OpenDota 收录的职业比赛，样本比 STRATZ 天梯小得多（冷门对位只有个位数场次），bp.js 里会按场次做收缩
   用法：node scripts/fetch-opendota-matchups.mjs   （无需 token；匿名限额 60 次/分钟，脚本每次间隔 1.1 秒，约 2.5 分钟跑完）
   输出：{ source, updated, heroes:[id], versus:[[千分胜率]], games:[[场次]] }，行 = 我方英雄，列 = 对手 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OD = 'https://api.opendota.com/api';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bp-data-od.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(path, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(OD + path, { signal: AbortSignal.timeout(90000) });
      if (r.status === 429) { await sleep(15000); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(3000 * (i + 1)); }
  }
}

const heroes = (await get('/heroes')).map(h => h.id).sort((a, b) => a - b);
const idx = new Map(heroes.map((id, i) => [id, i]));
const n = heroes.length;
const wins = heroes.map(() => Array(n).fill(0)), games = heroes.map(() => Array(n).fill(0)), reports = heroes.map(() => Array(n).fill(0));
let done = 0;
for (const id of heroes) {
  const rows = await get(`/heroes/${id}/matchups`);
  const i = idx.get(id);
  for (const r of rows) {
    const j = idx.get(r.hero_id); if (j == null || j === i) continue;
    // 同一对位两边各报一次，理论上应互补；两边都累计，场次最后按上报次数取平均，减少单边缺漏
    games[i][j] += r.games_played; wins[i][j] += r.wins; reports[i][j]++;
    games[j][i] += r.games_played; wins[j][i] += r.games_played - r.wins; reports[j][i]++;
  }
  done++; process.stdout.write(`\r${done}/${n} 英雄 ${id} 对位 ${rows.length} 条`);
  await sleep(1100);
}
const versus = games.map((row, i) => row.map((g, j) => g ? Math.round(wins[i][j] / g * 1000) : 0));   // 胜 / 场，两边合计后比值不变
const gamesOut = games.map((row, i) => row.map((g, j) => reports[i][j] ? Math.round(g / reports[i][j]) : 0));
const total = gamesOut.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0) / 2;
const out = { source: 'OpenDota heroes/{id}/matchups（职业比赛）', updated: new Date().toISOString().slice(0, 10), heroes, versus, games: gamesOut };
writeFileSync(OUT, JSON.stringify(out));
console.log(`\n写入 ${OUT}：${n} 个英雄，约 ${Math.round(total)} 场对位样本，${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
