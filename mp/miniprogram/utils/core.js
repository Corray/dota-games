// ⚠ 自动生成，请改仓库根目录的 core.js，再运行 node mp/sync-core.js
/**
 * Dota 内战记录 · 计算核心（网页 app.js 与微信小程序共用，保证两边统计口径一致）
 * 纯函数，不碰 DOM / localStorage / 全局 state：需要选手表的传 P（Map pid → 选手），需要评分权重的传 so。
 * 网页：<script src="core.js"> 后挂在 window.DotaCore；小程序：require('core.js')（由 mp/sync-core.js 复制过去）。
 */
(function (root, factory) {
  const C = factory();
  if (typeof module === 'object' && module.exports) module.exports = C; else root.DotaCore = C;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const rankIdx = p => RANKS.indexOf(p.rank) * 10 + (p.stars || 0);
const pname = (P, pid) => P.get(pid)?.name ?? '(已删除)';
const pct = (w, g) => g ? Math.round(w / g * 1000) / 10 + '%' : '-';
const pctNum = (w, g) => g ? w / g : -1;

const RANKS = ['先锋', '卫士', '中军', '统帅', '传奇', '万古流芳', '超凡入圣', '冠绝一世'];
const POS_NAME = { 1: '1号位 · 核心', 2: '2号位 · 中单', 3: '3号位 · 劣单', 4: '4号位 · 游走', 5: '5号位 · 硬辅' };
const POS_SHORT = { 1: '①核', 2: '②中', 3: '③劣', 4: '④游', 5: '⑤辅' };
const HERO_BY_ID = {
  1:'敌法师',2:'斧王',3:'祸乱之源',4:'血魔',5:'水晶室女',6:'卓尔游侠',7:'撼地者',8:'主宰',9:'米拉娜',10:'变体精灵',
  11:'影魔',12:'幻影长矛手',13:'帕克',14:'帕吉',15:'剃刀',16:'沙王',17:'风暴之灵',18:'斯温',19:'小小',20:'复仇之魂',
  21:'风行者',22:'宙斯',23:'昆卡',25:'莉娜',26:'莱恩',27:'暗影萨满',28:'斯拉达',29:'潮汐猎人',30:'巫医',31:'巫妖',
  32:'力丸',33:'谜团',34:'修补匠',35:'狙击手',36:'瘟疫法师',37:'术士',38:'兽王',39:'痛苦女王',40:'剧毒术士',41:'虚空假面',
  42:'冥魂大帝',43:'死亡先知',44:'幻影刺客',45:'帕格纳',46:'圣堂刺客',47:'冥界亚龙',48:'露娜',49:'龙骑士',50:'戴泽',
  51:'发条技师',52:'拉席克',53:'先知',54:'噬魂鬼',55:'黑暗贤者',56:'克林克兹',57:'全能骑士',58:'魅惑魔女',59:'哈斯卡',60:'暗夜魔王',
  61:'育母蜘蛛',62:'赏金猎人',63:'编织者',64:'杰奇洛',65:'蝙蝠骑士',66:'陈',67:'幽鬼',68:'远古冰魄',69:'末日使者',70:'熊战士',
  71:'裂魂人',72:'矮人直升机',73:'炼金术士',74:'祈求者',75:'沉默术士',76:'殁境神蚀者',77:'狼人',78:'酿酒师',79:'暗影恶魔',80:'德鲁伊',
  81:'混沌骑士',82:'米波',83:'树精卫士',84:'食人魔魔法师',85:'不朽尸王',86:'拉比克',87:'干扰者',88:'司夜刺客',89:'娜迦海妖',90:'光之守卫',
  91:'艾欧',92:'维萨吉',93:'斯拉克',94:'美杜莎',95:'巨魔战将',96:'半人马战行者',97:'马格纳斯',98:'伐木机',99:'钢背兽',100:'巨牙海民',
  101:'天怒法师',102:'亚巴顿',103:'上古巨神',104:'军团指挥官',105:'工程师',106:'灰烬之灵',107:'大地之灵',108:'孽主',109:'恐怖利刃',110:'凤凰',
  111:'神谕者',112:'寒冬飞龙',113:'天穹守望者',114:'齐天大圣',119:'邪影芳灵',120:'石鳞剑士',121:'天涯墨客',123:'森海飞霞',126:'虚无之灵',128:'电炎绝手',
  129:'玛尔斯',131:'驯兽师',135:'破晓辰星',136:'玛西',137:'原始野兽',138:'琼英碧灵',145:'凯',155:'拉戈',
};
const HEROES = Object.values(HERO_BY_ID);

function matchScore(m) {
  let a, b;
  if (Array.isArray(m.score) && m.score.length === 2) [a, b] = m.score.map(Number);
  else { const mt = /比分 (\d+):(\d+)/.exec(m.note || ''); if (mt) { a = Number(mt[1]); b = Number(mt[2]); } }
  if (!Number.isFinite(a) || !Number.isFinite(b) || (!a && !b)) return null;
  return [a, b];
}
const CLOSE_MARGIN = 5;    // 双方击杀差 ≤ 5 记为胶着局
// 比分差 → Elo 步长系数：0 分差 0.7，20 分差 1.0，40+ 分差 1.3。碾压说明实力差距明确，多加多扣；胶着说明接近，少动
const movFactor = sc => sc ? 0.7 + 0.6 * Math.min(Math.abs(sc[0] - sc[1]), 40) / 40 : 1;

function computeStats(matches, so = SCORE_DEF) {
  const useMov = so.mov !== false;
  const ps = {}, heroes = {}, duos = {};
  let radiantWins = 0, durSum = 0, durN = 0;
  const sorted = [...matches].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
  const getP = pid => ps[pid] ||= { pid, g: 0, w: 0, rg: 0, rw: 0, dg: 0, dw: 0, pos: {}, heroes: {}, mates: {}, opps: {}, streak: 0, results: [], k: 0, d: 0, a: 0, kdaG: 0, kdaPosN: {}, closeG: 0, closeW: 0, eloHist: [] };
  const posKda = {};   // 各号位的 KDA 基线：{ pos: { ka, d, n } }，0 = 未填号位
  for (const m of sorted) {
    if (m.winner === 'radiant') radiantWins++;
    if (m.duration) { durSum += m.duration; durN++; }
    const sc = matchScore(m), close = !!sc && Math.abs(sc[0] - sc[1]) <= CLOSE_MARGIN;
    for (const side of ['radiant', 'dire']) {
      const won = m.winner === side;
      const team = m[side] || [], other = m[side === 'radiant' ? 'dire' : 'radiant'] || [];
      for (const s of team) {
        const st = getP(s.pid);
        st.g++; if (won) st.w++;
        if (close) { st.closeG++; if (won) st.closeW++; }
        if (side === 'radiant') { st.rg++; if (won) st.rw++; } else { st.dg++; if (won) st.dw++; }
        if (s.kda) {
          st.k += s.kda[0]; st.d += s.kda[1]; st.a += s.kda[2]; st.kdaG++;
          const pk = s.pos || 0, b = posKda[pk] ||= { ka: 0, d: 0, n: 0 };
          b.ka += s.kda[0] + s.kda[2]; b.d += s.kda[1]; b.n++;
          st.kdaPosN[pk] = (st.kdaPosN[pk] || 0) + 1;
        }
        if (s.pos) { const o = st.pos[s.pos] ||= { g: 0, w: 0 }; o.g++; if (won) o.w++; }
        if (s.hero) {
          const o = st.heroes[s.hero] ||= { g: 0, w: 0 }; o.g++; if (won) o.w++;
          const h = heroes[s.hero] ||= { hero: s.hero, g: 0, w: 0, users: {} }; h.g++; if (won) h.w++;
          h.users[s.pid] = (h.users[s.pid] || 0) + 1;
        }
        for (const t of team) { if (t.pid === s.pid) continue; const o = st.mates[t.pid] ||= { g: 0, w: 0 }; o.g++; if (won) o.w++; }
        for (const t of other) { const o = st.opps[t.pid] ||= { g: 0, w: 0 }; o.g++; if (won) o.w++; }
        st.results.push({ won, id: m.id, date: m.date, side, hero: s.hero, pos: s.pos, kda: s.kda });
        st.streak = won ? (st.streak > 0 ? st.streak + 1 : 1) : (st.streak < 0 ? st.streak - 1 : -1);
      }
      for (let i = 0; i < team.length; i++) for (let j = i + 1; j < team.length; j++) {
        const pair = [team[i].pid, team[j].pid].sort();
        const o = duos[pair.join('|')] ||= { a: pair[0], b: pair[1], g: 0, w: 0 }; o.g++; if (won) o.w++;
      }
    }
  }
  // ---- Elo：按时间顺序逐场更新，队伍实力取上场选手均值；胜负只和「对手多强」有关，和队友是谁无关 ----
  // 顺手记两样东西：每场开打前的天辉期望胜率 ea（= 赛前预测，只用之前的比赛，可拿来回看预测准不准），以及每人每场打完后的 Elo（走势图）
  const elo = {};
  const R = pid => elo[pid] ?? ELO_BASE;
  const preds = [];
  let seq = 0;
  for (const m of sorted) {
    const rad = (m.radiant || []).map(s => s.pid), dire = (m.dire || []).map(s => s.pid);
    if (!rad.length || !dire.length || !m.winner) continue;
    const ra = rad.reduce((s, x) => s + R(x), 0) / rad.length, rb = dire.reduce((s, x) => s + R(x), 0) / dire.length;
    const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
    const sa = m.winner === 'radiant' ? 1 : 0;
    const k = ELO_K * (useMov ? movFactor(matchScore(m)) : 1);
    preds.push({ id: m.id, date: m.date, seq, ea, winner: m.winner, ra, rb, surprise: sa ? 1 - ea : ea });
    for (const x of rad) elo[x] = R(x) + k * (sa - ea);
    for (const x of dire) elo[x] = R(x) + k * ((1 - sa) - (1 - ea));
    for (const x of [...rad, ...dire]) ps[x]?.eloHist.push({ id: m.id, date: m.date, seq, elo: elo[x], won: (m.winner === 'radiant') === rad.includes(x) });
    seq++;
  }
  // ---- 相对 KDA：自己的 KDA ÷ 同号位平均 KDA（按自己各号位场次加权）。辅助天然 KDA 低，不该和核心混算 ----
  const allB = Object.values(posKda).reduce((o, b) => ({ ka: o.ka + b.ka, d: o.d + b.d, n: o.n + b.n }), { ka: 0, d: 0, n: 0 });
  const baseOf = pk => { const b = posKda[pk]; return b && b.n >= 5 ? b.ka / Math.max(b.d, 1) : (allB.n ? allB.ka / Math.max(allB.d, 1) : null); };
  for (const st of Object.values(ps)) {
    st.elo = elo[st.pid] ?? ELO_BASE;
    let wsum = 0, exp = 0;
    for (const [pk, n] of Object.entries(st.kdaPosN)) { const b = baseOf(Number(pk)); if (b) { exp += n * b; wsum += n; } }
    st.kdaExp = wsum ? exp / wsum : null;
    st.kdaRel = st.kdaG && st.kdaExp ? ((st.k + st.a) / Math.max(st.d, 1)) / st.kdaExp : null;
  }
  for (const st of Object.values(ps)) {
    st.eloPeak = st.eloHist.reduce((a, h) => Math.max(a, h.elo), ELO_BASE);
    st.eloLow = st.eloHist.reduce((a, h) => Math.min(a, h.elo), ELO_BASE);
  }
  return { players: ps, heroes, duos, total: matches.length, radiantWins, avgDuration: durN ? durSum / durN : null, elo, posKda, preds, seqTotal: seq };
}

// ============ 录像解析聚合 ============
/* 把已解析比赛里每个人的对线期 / 击杀数据跨场汇总，只看点过「详情解析」或自动解析过的比赛。
   英雄 ↔ 选手的对应：先按 Steam ID，再按英雄名。对线胜负：对线期（约 10 分钟）自己这条路双方净资产之和相比，
   领先 ≥ LANE_EDGE 算赢、落后 ≥ LANE_EDGE 算输，中间算平。击杀参与率 = (击杀 + 助攻) ÷ 本方总击杀，助攻取比赛记录里的 KDA */
const LANE_EDGE = 300;
const COMEBACK_GOLD = 5000;   // 赢的一方曾落后这么多经济才算翻盘
function replayPid(m, rp, h, P) {
  const info = rp.heroes.find(x => x.h === h); if (!info) return null;
  const side = m[info.r ? 'radiant' : 'dire'] || [];
  const p = (info.acc && side.find(s => P.get(s.pid)?.accountId === info.acc)) || side.find(s => s.hero === (HERO_BY_ID[h] || ''));
  return p?.pid || null;
}
function replayStats(matches, P) {
  const ps = {};
  const getP = pid => ps[pid] ||= { pid, g: 0, laneG: 0, laneW: 0, laneL: 0, laneGold: 0, lh: 0, dn: 0, nw: 0, lvl: 0, k: 0, d: 0, kp: 0, kpN: 0, fb: 0, fbDeath: 0, cb: 0, cbMax: 0, fights: 0, fightsW: 0 };
  let games = 0;
  for (const m of matches) {
    const rp = m.replay; if (!rp || !rp.heroes) continue;
    games++;
    const pidOf = h => replayPid(m, rp, h, P);
    for (const side of ['radiant', 'dire']) for (const s of m[side] || []) getP(s.pid).g++;
    for (const l of rp.lanes || []) {
      const sum = arr => arr.reduce((s, x) => s + (x.nw || 0), 0);
      const diff = sum(l.rad) - sum(l.dire);
      for (const [arr, sign] of [[l.rad, 1], [l.dire, -1]]) for (const x of arr) {
        const pid = pidOf(x.h); if (!pid) continue; const st = getP(pid);
        const d = diff * sign;
        st.laneG++; if (d >= LANE_EDGE) st.laneW++; else if (d <= -LANE_EDGE) st.laneL++;
        st.laneGold += d; st.lh += x.lh || 0; st.dn += x.dn || 0; st.nw += x.nw || 0; st.lvl += x.lvl || 0;
      }
    }
    const sideOf = h => rp.heroes.find(x => x.h === h)?.r ? 'radiant' : 'dire';
    const teamKills = { radiant: 0, dire: 0 };
    const kills = [...(rp.kills || [])].sort((a, b) => a[0] - b[0]);
    kills.forEach(([, k, v]) => { teamKills[sideOf(k)]++; const a = pidOf(k), b = pidOf(v); if (a) getP(a).k++; if (b) getP(b).d++; });
    if (kills.length) { const a = pidOf(kills[0][1]), b = pidOf(kills[0][2]); if (a) getP(a).fb++; if (b) getP(b).fbDeath++; }
    const tf = teamfights(rp);
    for (const side of ['radiant', 'dire']) for (const s of m[side] || []) {
      const st = getP(s.pid);
      if (s.kda && teamKills[side]) { st.kp += Math.min(1, (s.kda[0] + s.kda[2]) / teamKills[side]); st.kpN++; }
      st.fights += tf.length; st.fightsW += tf.filter(f => f.winner === side).length;
    }
    if (rp.gold?.length && m.winner) {
      const sign = m.winner === 'radiant' ? 1 : -1; const worst = Math.min(...rp.gold.map(g => g * sign));
      if (worst <= -COMEBACK_GOLD) for (const s of m[m.winner] || []) { const st = getP(s.pid); st.cb++; st.cbMax = Math.max(st.cbMax, -worst); }
    }
  }
  return { players: ps, games };
}

// ============ 团战检测 ============
/* 相邻两次击杀间隔 ≤ FIGHT_GAP 秒视为同一场团战，累计 ≥ FIGHT_MIN 次击杀才算团战（零星单杀不算）。
   赢家 = 击杀多的一方，相同算平；经济变化 = 团战结束那分钟与开始前一分钟的经济差之差（天辉视角） */
const FIGHT_GAP = 20, FIGHT_MIN = 3;
function teamfights(rp) {
  const byHero = new Map((rp.heroes || []).map(h => [h.h, h]));
  const sideOf = h => byHero.get(h)?.r ? 'radiant' : 'dire';
  const kills = [...(rp.kills || [])].sort((a, b) => a[0] - b[0]);
  const groups = []; let cur = null;
  for (const k of kills) {
    if (cur && k[0] - cur.end <= FIGHT_GAP) { cur.kills.push(k); cur.end = k[0]; }
    else { cur = { start: k[0], end: k[0], kills: [k] }; groups.push(cur); }
  }
  return groups.filter(g => g.kills.length >= FIGHT_MIN).map(g => {
    const n = { radiant: 0, dire: 0 }; g.kills.forEach(k => n[sideOf(k[1])]++);
    const last = (rp.gold?.length || 1) - 1;
    const m0 = Math.max(0, Math.floor(g.start / 60) - 1), m1 = Math.min(last, Math.ceil(g.end / 60));
    const swing = rp.gold?.length ? (rp.gold[m1] ?? 0) - (rp.gold[m0] ?? 0) : null;
    return { start: g.start, end: g.end, kills: g.kills, radiant: n.radiant, dire: n.dire, winner: n.radiant > n.dire ? 'radiant' : n.dire > n.radiant ? 'dire' : null, swing };
  });
}

function computeBadges(st, matches, P) {
  const players = Object.values(st.players).filter(s => P.has(s.pid));
  const out = {}; const give = (pid, b) => (out[pid] ||= []).push(b);
  const top = (val, min, badge, fmt) => {
    const list = players.map(s => ({ s, v: val(s) })).filter(x => x.v != null && x.v >= min); if (!list.length) return;
    const mx = Math.max(...list.map(x => x.v));
    list.filter(x => x.v === mx).forEach(x => give(x.s.pid, { ...badge, detail: fmt(x.v, x.s) }));
  };
  const longest = s => { let mx = 0, cur = 0; for (const r of s.results) { cur = r.won ? cur + 1 : 0; mx = Math.max(mx, cur); } return mx; };
  top(s => s.elo, ELO_BASE + 1, { icon: '👑', name: 'Elo 第一' }, v => `Elo ${Math.round(v)}`);
  top(longest, 3, { icon: '🔥', name: '连胜王' }, v => `最长 ${v} 连胜`);
  top(s => s.g, 5, { icon: '🛡', name: '铁人' }, v => `出场 ${v} 场`);
  top(s => s.closeG >= 3 ? s.closeW / s.closeG : null, 0.5, { icon: '🧊', name: '大心脏' }, (v, s) => `胶着局 ${s.closeW} 胜 ${s.closeG - s.closeW} 负（击杀差 ≤ ${CLOSE_MARGIN}）`);
  top(s => s.kdaG >= 5 ? s.kdaRel : null, 1.2, { icon: '🎯', name: 'KDA 之王' }, v => `同号位平均的 ${v.toFixed(2)} 倍`);
  top(s => Object.keys(s.heroes).length, 8, { icon: '🧩', name: '英雄池最广' }, v => `用过 ${v} 个英雄`);
  const duos = Object.values(st.duos).filter(d => d.g >= 5 && P.has(d.a) && P.has(d.b)).sort((a, b) => b.w / b.g - a.w / a.g || b.g - a.g);
  if (duos.length && duos[0].w / duos[0].g > 0.5) { const d = duos[0]; [d.a, d.b].forEach(pid => give(pid, { icon: '🤝', name: '黄金搭档', detail: `和 ${pname(P, pid === d.a ? d.b : d.a)} 同队 ${d.w} 胜 ${d.g - d.w} 负` })); }
  // 录像类：一血 / 翻盘 / 对线 / 团战参与，全部来自已解析比赛的聚合
  const rs = Object.values(replayStats(matches, P).players).filter(s => P.has(s.pid));
  const topR = (val, min, badge, fmt) => {
    const list = rs.map(s => ({ s, v: val(s) })).filter(x => x.v != null && x.v >= min); if (!list.length) return;
    const mx = Math.max(...list.map(x => x.v));
    list.filter(x => x.v === mx).forEach(x => give(x.s.pid, { ...badge, detail: fmt(x.v, x.s) }));
  };
  topR(s => s.fb || null, 2, { icon: '🩸', name: '一血机器' }, n => `${n} 次一血（只算已解析的比赛）`);
  topR(s => s.cb || null, 1, { icon: '🔄', name: '翻盘王' }, (n, s) => `${n} 次落后 ${COMEBACK_GOLD}+ 经济翻盘，最多落后 ${s.cbMax}（只算已解析的比赛）`);
  topR(s => s.laneG >= 3 ? s.laneW / s.laneG : null, 0.5, { icon: '⚔️', name: '对线霸主' }, (v, s) => `对线 ${s.laneW} 胜 ${s.laneL} 负 ${s.laneG - s.laneW - s.laneL} 平（10 分钟本路经济领先 ≥ ${LANE_EDGE}，只算已解析的比赛）`);
  topR(s => s.kpN >= 3 ? s.kp / s.kpN : null, 0.6, { icon: '🤜', name: '团战核心' }, (v, s) => `击杀参与率 ${(v * 100).toFixed(0)}%（${s.kpN} 场，只算已解析的比赛）`);
  return out;
}

// ============ 赛前预测 ============
/* 两队各取上场选手 Elo 均值，套 Elo 期望公式得天辉胜率。和 computeStats 里逐场更新用的是同一个公式，
   所以统计页「预测回看」的准确率就是这个函数在历史上的真实表现。Elo 来自 st.elo（没打过的人按 1500） */
function predictMatch(radPids, direPids, stPlayers) {
  const R = pid => stPlayers[pid]?.elo ?? ELO_BASE;
  const rad = radPids.filter(Boolean), dire = direPids.filter(Boolean);
  if (!rad.length || !dire.length) return null;
  const ra = rad.reduce((s, x) => s + R(x), 0) / rad.length, rb = dire.reduce((s, x) => s + R(x), 0) / dire.length;
  const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
  const known = [...rad, ...dire].filter(pid => stPlayers[pid]?.g).length;
  return { ea, ra, rb, known, total: rad.length + dire.length };
}
// 预测回看：只统计「有倾向」的比赛（赛前胜率偏离 50% 超过 margin），五五开的场次本来就没法说准不准
function predictionReport(preds, margin = 0.05) {
  const decisive = preds.filter(p => Math.abs(p.ea - 0.5) >= margin);
  const hit = decisive.filter(p => (p.ea > 0.5) === (p.winner === 'radiant')).length;
  const upsets = [...preds].filter(p => p.surprise > 0.5).sort((a, b) => b.surprise - a.surprise);
  // Brier 分：预测概率与结果的均方差，0 最好，瞎猜 0.25；比准确率更能反映「有多自信」
  const brier = preds.length ? preds.reduce((s, p) => s + ((p.winner === 'radiant' ? 1 : 0) - p.ea) ** 2, 0) / preds.length : null;
  return { total: preds.length, decisive: decisive.length, hit, acc: decisive.length ? hit / decisive.length : null, upsets, brier };
}
const topKey = (obj, by = 'g') => Object.entries(obj).sort((a, b) => b[1][by] - a[1][by])[0]?.[0];


const SCORE_DEF = { wRank: 40, wElo: 30, wKda: 20, wHero: 10, trust: 3, heroMode: 'main', heroTop: 3, poolCap: 12, mov: true };

const ELO_BASE = 1500, ELO_K = 32;

const KDA_REL_CAP = 2;      // 相对 KDA 归一封顶：达到同号位平均的 2 倍记满分，等于平均记 0.5

/* 段位归一的分母。最高档「冠绝一世」不分星级（rankIdx 恒为 70），
   写死 75 会让最高段永远只拿 93.3% 的段位分，所以按最高档的档位值取 */
const RANK_MAX = (RANKS.length - 1) * 10;

/* 英雄维度三种口径：
   main 主力英雄战绩（场次最多的前 N 个英雄的加权胜率，衡量招牌英雄硬不硬）
   pool 英雄池广度（打过多少个不同英雄，封顶归一，衡量好不好 ban / 能不能补位）
   both 两者各半 */
function heroScore(st, o) {
  const hs = st ? Object.values(st.heroes || {}) : [];
  if (!hs.length) return 0.5;
  const pool = Math.min(hs.length / (o.poolCap || 12), 1);
  if (o.heroMode === 'pool') return pool;
  const top = [...hs].sort((a, b) => b.g - a.g).slice(0, o.heroTop || 3);
  const g = top.reduce((s, x) => s + x.g, 0), w = top.reduce((s, x) => s + x.w, 0);
  const main = g >= (o.trust || 1) ? w / g : 0.5;
  return o.heroMode === 'both' ? (main + pool) / 2 : main;
}
function playerScore(st, p, opt) {
  const o = { ...SCORE_DEF, ...opt };
  const g = st?.g || 0, trust = Math.max(1, o.trust || 1);
  const conf = g / (g + trust);                               // 样本置信度：0 场 0，trust 场 0.5，趋近 1
  const shrink = v => v == null ? 0.5 : 0.5 + (v - 0.5) * conf;
  const rank = p ? Math.min(rankIdx(p), RANK_MAX) / RANK_MAX : 0.5;
  const eloRaw = st ? st.elo ?? ELO_BASE : ELO_BASE;
  const elo = 1 / (1 + 10 ** ((ELO_BASE - eloRaw) / 400));   // 换成「对阵平均水平的期望胜率」，1500 → 0.5
  const kdaRaw = st && st.kdaG ? (st.k + st.a) / Math.max(st.d, 1) : null;
  const kda = shrink(st?.kdaRel != null ? Math.min(st.kdaRel / KDA_REL_CAP, 1) : null);
  const hero = shrink(st ? heroScore(st, o) : null);
  const wsum = (o.wRank + o.wElo + o.wKda + o.wHero) || 1;
  const raw = (o.wRank * rank + o.wElo * elo + o.wKda * kda + o.wHero * hero) / wsum;
  const win = g ? st.w / g : null;
  return { score: raw * 100, raw, rank, elo, eloRaw, kda, kdaRaw, kdaRel: st?.kdaRel ?? null, kdaExp: st?.kdaExp ?? null, hero, win, conf, enough: conf >= 0.5, g, closeG: st?.closeG || 0, closeW: st?.closeW || 0 };
}


const leagueOf = m => m.leagueId != null ? (Number(m.leagueId) || 0) : (Number(m.replay?.leagueId) || 0);   // 手填 / 清空过的优先于录像里带的

return { RANKS, POS_NAME, POS_SHORT, HERO_BY_ID, HEROES, matchScore, CLOSE_MARGIN, movFactor, computeStats, LANE_EDGE, COMEBACK_GOLD, replayPid, replayStats, FIGHT_GAP, FIGHT_MIN, teamfights, computeBadges, predictMatch, predictionReport, topKey, SCORE_DEF, ELO_BASE, ELO_K, RANK_MAX, KDA_REL_CAP, heroScore, playerScore, leagueOf, rankIdx, pname, pct, pctNum };
});
