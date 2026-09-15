#!/usr/bin/env node
/* 生成 bp-data.json（BP 助手主数据源：STRATZ 英雄两两对位 / 同队胜率 + 各号位出场率）
   两种输入，二选一：
   1) 有 STRATZ API token（https://stratz.com/api 登录后 My Tokens）：
        STRATZ_TOKEN=xxx node scripts/build-bp-data.mjs
   2) 没 token：在浏览器打开 https://stratz.com 任意英雄页，DevTools 控制台里执行下面的抓取片段，
      把生成的 JSON 存成文件，再：
        node scripts/build-bp-data.mjs path/to/stratz-dump.json
      抓取片段（token 取自网页自身请求的 authorization 头，只在同一 IP、45 分钟内有效）：
        (async()=>{const T=prompt('bearer token');const gql=async ops=>(await fetch('https://api.stratz.com/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'bearer '+T},body:JSON.stringify(ops)})).json();
        const c=await gql([{operationName:'H',variables:{},query:'query H { constants { heroes { id displayName } } heroStats { stats(groupByPosition: true, bracketBasicIds:[LEGEND_ANCIENT, DIVINE_IMMORTAL]) { heroId position matchCount } } }'}]);
        const heroes=c[0].data.constants.heroes,posStats=c[0].data.heroStats.stats,matchups={},ids=heroes.map(h=>h.id);
        for(let i=0;i<ids.length;i+=4){const ch=ids.slice(i,i+4);const res=await gql(ch.map(id=>({operationName:'M',variables:{id},query:'query M($id: Short!) { heroStats { heroVsHeroMatchup(heroId: $id, bracketBasicIds:[LEGEND_ANCIENT, DIVINE_IMMORTAL]) { advantage { heroId with { heroId2 winsAverage synergy matchCount } vs { heroId2 winsAverage synergy matchCount } } } } }'})));
        res.forEach((r,k)=>{const a=r?.data?.heroStats?.heroVsHeroMatchup?.advantage?.[0];if(a)matchups[ch[k]]={with:a.with,vs:a.vs};});await new Promise(r=>setTimeout(r,300));}
        const dump={fetchedAt:new Date().toISOString(),bracket:['LEGEND_ANCIENT','DIVINE_IMMORTAL'],heroes,posStats,matchups,errs:[]};
        const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(dump)]));a.download='stratz-dump.json';a.click();console.log('done',Object.keys(matchups).length);})();

   矩阵口径与 Sino-Huang/DOTA-2-ban-pick-tool 的 stratz_api_calling.py 一致：
     versus = vs.winsAverage, counter = vs.synergy / 100, with = with.winsAverage, synergy = with.synergy / 100
     每格按场次收缩：优势值 × n/(n+50)，胜率向 0.5 收缩同样比例 —— 只有几场的冷门对位不再出现 ±28% 这种极端值
     缺失的对位用该英雄在该维度的平均值补；输出千分制整数
   分段：传奇-万古 + 超凡-冠绝（LEGEND_ANCIENT, DIVINE_IMMORTAL） */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'bp-data.json');
const BRACKET = ['LEGEND_ANCIENT', 'DIVINE_IMMORTAL'];
const SHRINK_K = 50;   // 收缩系数：n 场的可信度 = n / (n + 50)
const shrinkAdv = (v, n) => v * n / (n + SHRINK_K);
const shrinkWr = (v, n) => 0.5 + (v - 0.5) * n / (n + SHRINK_K);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithToken(token) {
  const gql = async ops => {
    const r = await fetch('https://api.stratz.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'user-agent': 'STRATZ_API' }, body: JSON.stringify(ops) });
    if (!r.ok) throw new Error('STRATZ HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return r.json();
  };
  const c = await gql([{ operationName: 'H', variables: {}, query: `query H { constants { heroes { id displayName } } heroStats { stats(groupByPosition: true, bracketBasicIds:[${BRACKET}]) { heroId position matchCount } } }` }]);
  const heroes = c[0].data.constants.heroes, posStats = c[0].data.heroStats.stats, matchups = {};
  const ids = heroes.map(h => h.id);
  for (let i = 0; i < ids.length; i += 4) {
    const ch = ids.slice(i, i + 4);
    const res = await gql(ch.map(id => ({ operationName: 'M', variables: { id }, query: `query M($id: Short!) { heroStats { heroVsHeroMatchup(heroId: $id, bracketBasicIds:[${BRACKET}]) { advantage { heroId with { heroId2 winsAverage synergy matchCount } vs { heroId2 winsAverage synergy matchCount } } } } }` })));
    res.forEach((r, k) => { const a = r?.data?.heroStats?.heroVsHeroMatchup?.advantage?.[0]; if (a) matchups[ch[k]] = { with: a.with, vs: a.vs }; else console.error('英雄', ch[k], JSON.stringify(r?.errors || r).slice(0, 200)); });
    process.stdout.write(`\r${Math.min(i + 4, ids.length)}/${ids.length}`);
    await sleep(300);
  }
  console.log();
  return { fetchedAt: new Date().toISOString(), bracket: BRACKET, heroes, posStats, matchups, errs: [] };
}

const dumpPath = process.argv[2];
const dump = dumpPath ? JSON.parse(readFileSync(dumpPath, 'utf8')) : process.env.STRATZ_TOKEN ? await fetchWithToken(process.env.STRATZ_TOKEN) : null;
if (!dump) { console.error('用法：STRATZ_TOKEN=xxx node scripts/build-bp-data.mjs  或  node scripts/build-bp-data.mjs stratz-dump.json'); process.exit(1); }

const heroes = dump.heroes.map(h => h.id).sort((a, b) => a - b);
const n = heroes.length, idx = new Map(heroes.map((id, i) => [id, i]));
const zero = () => heroes.map(() => Array(n).fill(null));
const versus = zero(), counter = zero(), withM = zero(), synergy = zero();
for (const [idStr, m] of Object.entries(dump.matchups)) {
  const i = idx.get(Number(idStr)); if (i == null) continue;
  for (const d of m.vs) { const j = idx.get(d.heroId2); if (j == null || j === i) continue; versus[i][j] = shrinkWr(d.winsAverage, d.matchCount); counter[i][j] = shrinkAdv(d.synergy / 100, d.matchCount); }
  for (const d of m.with) { const j = idx.get(d.heroId2); if (j == null || j === i) continue; withM[i][j] = shrinkWr(d.winsAverage, d.matchCount); synergy[i][j] = shrinkAdv(d.synergy / 100, d.matchCount); }
}
// 缺失补该行平均；自身位置 0
let filled = 0;
const finish = (M, scale) => M.map((row, i) => { const vals = row.filter(v => v != null); const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0; return row.map((v, j) => { if (j === i) return 0; if (v == null) { filled++; v = avg; } return Math.round(v * scale); }); });
const out = {
  source: `STRATZ heroVsHeroMatchup（${dump.bracket.join(' + ')} 分段），scripts/build-bp-data.mjs 生成`,
  updated: dump.fetchedAt.slice(0, 10),
  heroes,
  versus: finish(versus, 1000), with: finish(withM, 1000), counter: finish(counter, 1000), synergy: finish(synergy, 1000),
  lanes: heroes.map(id => { const rows = dump.posStats.filter(p => p.heroId === id); const tot = rows.reduce((s, p) => s + p.matchCount, 0) || 1; return [1, 2, 3, 4, 5].map(k => Math.round((rows.find(p => p.position === 'POSITION_' + k)?.matchCount || 0) / tot * 1000)); }),
  pools: [],
};
// 默认英雄池：沿用旧文件里人工整理的池子；新英雄按出场率 ≥ 25% 的号位补进去
const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
out.pools = [0, 1, 2, 3, 4].map(k => (old?.pools?.[k] || []).filter(id => idx.has(id)));
for (const id of heroes) if (!out.pools.some(p => p.includes(id))) out.lanes[idx.get(id)].forEach((v, k) => { if (v >= 250) out.pools[k].push(id); });
writeFileSync(OUT, JSON.stringify(out));
console.log(`写入 ${OUT}：${n} 个英雄，补平均 ${filled} 格，英雄池 ${out.pools.map(p => p.length).join('/')}，${(JSON.stringify(out).length / 1024).toFixed(0)} KB，数据日期 ${out.updated}`);
