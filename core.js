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

// ============ 内战积分：赢一场 +10，输一场 +2（只看筛选范围内的比赛） ============
const PTS_WIN = 10, PTS_LOSS = 2;
const ptsOf = (w, g) => w * PTS_WIN + (g - w) * PTS_LOSS;

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
    st.pts = ptsOf(st.w, st.g);
  }
  // 范围内最高积分挂到每个人身上，列表里画积分条用
  const ptsMax = Object.values(ps).reduce((a, s) => Math.max(a, s.pts), 0);
  for (const st of Object.values(ps)) st.ptsMax = ptsMax;
  return { players: ps, heroes, duos, total: matches.length, radiantWins, avgDuration: durN ? durSum / durN : null, elo, posKda, preds, seqTotal: seq };
}

// ============ 录像解析聚合 ============
/* 把已解析比赛里每个人的对线期 / 击杀数据跨场汇总，只看点过「详情解析」或自动解析过的比赛。
   英雄 ↔ 选手的对应：先按 Steam ID，再按英雄名。对线胜负：对线期（约 10 分钟）自己这条路双方净资产之和相比，
   领先 ≥ LANE_EDGE 算赢、落后 ≥ LANE_EDGE 算输，中间算平。击杀参与率 = (击杀 + 助攻) ÷ 本方总击杀，助攻取比赛记录里的 KDA */
const LANE_EDGE = 300;
const COMEBACK_GOLD = 5000;   // 赢的一方曾落后这么多经济才算翻盘
// 录像英雄 ↔ 选手账号：2026-10 之前存的录像 acc 有精度误差（≤8，见 parseReplayJson），允许 16 以内的偏差
const accNear = (a, b) => !!a && !!b && Math.abs(a - b) <= 16;
function replaySidePlayer(m, info, P) {
  const side = m[info.r ? 'radiant' : 'dire'] || [];
  return (info.acc && (side.find(s => P.get(s.pid)?.accountId === info.acc) || side.find(s => accNear(P.get(s.pid)?.accountId, info.acc))))
    || side.find(s => s.hero === (HERO_BY_ID[info.h] || '')) || null;
}
function replayPid(m, rp, h, P) {
  const info = rp.heroes.find(x => x.h === h); if (!info) return null;
  return replaySidePlayer(m, info, P)?.pid || null;
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
// 评分四项权重和（积分只展示，不计入评分）
const scoreWsum = o => ((o.wRank || 0) + (o.wElo || 0) + (o.wKda || 0) + (o.wHero || 0)) || 1;

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
  const wsum = scoreWsum(o);
  const raw = (o.wRank * rank + o.wElo * elo + o.wKda * kda + o.wHero * hero) / wsum;
  const win = g ? st.w / g : null;
  return { score: raw * 100, raw, rank, elo, eloRaw, kda, kdaRaw, kdaRel: st?.kdaRel ?? null, kdaExp: st?.kdaExp ?? null, hero, win, conf, enough: conf >= 0.5, g, closeG: st?.closeG || 0, closeW: st?.closeW || 0 };
}


const leagueOf = m => m.leagueId != null ? (Number(m.leagueId) || 0) : (Number(m.replay?.leagueId) || 0);   // 手填 / 清空过的优先于录像里带的

// ============ 统计页排行行数据（网页统计表、战报、小程序共用） ============
// rows = computeStats 的选手对象（已按最少场次 / 在名单内过滤）
function statsRows(rows, P, so) {
  return rows.map(s => {
    const p = P.get(s.pid);
    const sc = playerScore(s, p, so);
    return { pid: s.pid, name: p.name, rank: rankIdx(p), g: s.g, w: s.w, l: s.g - s.w, wr: pctNum(s.w, s.g), rwr: pctNum(s.rw, s.rg), dwr: pctNum(s.dw, s.dg),
      rg: s.rg, rw: s.rw, dg: s.dg, dw: s.dw, streak: s.streak, pts: s.pts || 0, kda: s.kdaG ? (s.k + s.a) / Math.max(1, s.d) : -1, kdaStr: s.kdaG ? `${(s.k / s.kdaG).toFixed(1)}/${(s.d / s.kdaG).toFixed(1)}/${(s.a / s.kdaG).toFixed(1)}` : '',
      pos: Object.entries(s.pos).sort((a, b) => b[1].g - a[1].g).slice(0, 2).map(([k, v]) => `${POS_SHORT[k]} ${v.g}场`).join('，'),
      hero: Object.entries(s.heroes).sort((a, b) => b[1].g - a[1].g).slice(0, 3).map(([k, v]) => `${k} ${v.w}/${v.g}`).join('，'),
      sc, score: sc.score };
  });
}

// ============ 一键战报（Markdown） ============
// title = 「2026-06-11 ~ 2026-10-14 · 联赛 19638」这类范围说明；rows 同上，data = statsRows(rows, …)
function buildReport({ title, st, ms, rows, P, data }) {
  const L = [`# Dota 2 内战战报（${title}）`, '', `- 共 **${st.total}** 场，天辉 ${st.radiantWins} 胜 / 夜魇 ${st.total - st.radiantWins} 胜${st.avgDuration ? `，平均 ${Math.round(st.avgDuration)} 分钟` : ''}，${rows.length} 人出场`];
  if (!st.total) return L.join('\n');
  const byScore = [...data].sort((a, b) => b.score - a.score);
  const mvp = byScore.find(r => r.g >= 3) || byScore[0];
  if (mvp) L.push(`- **MVP**：${mvp.name}（评分 ${mvp.score.toFixed(1)}，${mvp.g} 场 ${pct(mvp.w, mvp.g)}）`);
  const byElo = [...rows].sort((a, b) => b.elo - a.elo);
  if (byElo.length >= 2) L.push(`- **Elo 涨最多**：${pname(P, byElo[0].pid)} ${byElo[0].elo - ELO_BASE >= 0 ? '+' : ''}${Math.round(byElo[0].elo - ELO_BASE)}　**跌最多**：${pname(P, byElo[byElo.length - 1].pid)} ${Math.round(byElo[byElo.length - 1].elo - ELO_BASE)}（本期内从 1500 起算）`);
  const badges = computeBadges(st, ms, P); const byName = new Map();
  for (const [pid, list] of Object.entries(badges)) for (const b of list) { const o = byName.get(b.name) || { b, who: [] }; o.who.push(pid); byName.set(b.name, o); }
  if (byName.size) { L.push('', '## 称号'); for (const { b, who } of byName.values()) L.push(`- ${b.icon} **${b.name}**：${who.map(pid => pname(P, pid)).join('、')}（${badges[who[0]].find(x => x.name === b.name).detail}）`); }
  const pr = predictionReport(st.preds);
  if (pr.decisive) { L.push('', '## 预测回看', `- 赛前 Elo 预测准确率 ${pct(pr.hit, pr.decisive)}（有倾向的 ${pr.decisive} 场），Brier ${pr.brier.toFixed(3)}`); const u = pr.upsets[0]; if (u) { const m = ms.find(x => x.id === u.id); L.push(`- 最大爆冷：${u.date} ${u.id}，赛前只给 ${Math.round((1 - u.surprise) * 100)}% 的${u.winner === 'radiant' ? '天辉' : '夜魇'}赢了${m ? `（${(m[u.winner] || []).map(s => pname(P, s.pid)).join('、')}）` : ''}`); } }
  const byPts = [...data].sort((a, b) => b.pts - a.pts || b.w - a.w)[0];
  if (byPts) L.push(`- **积分王**：${byPts.name} ${byPts.pts} 分（${byPts.w} 胜 ${byPts.l} 负，胜 +${PTS_WIN} / 负 +${PTS_LOSS}）`);
  L.push('', '## 排行（按评分，前 10）', '| # | 选手 | 评分 | 积分 | 场次 | 胜率 | KDA | 连胜/负 |', '|---|---|---|---|---|---|---|---|');
  byScore.slice(0, 10).forEach((r, i) => L.push(`| ${i + 1} | ${r.name} | ${r.score.toFixed(1)} | ${r.pts} | ${r.g} | ${pct(r.w, r.g)} | ${r.kda >= 0 ? r.kda.toFixed(2) : '-'} | ${r.streak > 0 ? r.streak + '连胜' : r.streak < 0 ? -r.streak + '连败' : '-'} |`));
  const duos = Object.values(st.duos).filter(d => d.g >= 2 && P.has(d.a) && P.has(d.b));
  if (duos.length) { const best = [...duos].sort((a, b) => b.w / b.g - a.w / a.g || b.g - a.g)[0], worst = [...duos].sort((a, b) => a.w / a.g - b.w / b.g || b.g - a.g)[0]; L.push('', '## 搭档', `- 最佳：${pname(P, best.a)} + ${pname(P, best.b)}，${best.w}/${best.g}`, `- 最差：${pname(P, worst.a)} + ${pname(P, worst.b)}，${worst.w}/${worst.g}`); }
  const heroes = Object.values(st.heroes).sort((a, b) => b.g - a.g).slice(0, 5);
  if (heroes.length) L.push('', '## 热门英雄', ...heroes.map(h => `- ${h.hero}：${h.g} 场 ${pct(h.w, h.g)}`));
  return L.join('\n');
}

// ============ 比赛导入（网页「查询比赛 / 联赛导入 / 发现内战」与小程序云函数共用） ============
// 录像里的 Steam64 → 32 位账号 ID。BigInt 只在调用时用到（网页 / 云函数），不写成字面量，免得小程序编译器不认
const steam32 = s => typeof BigInt === 'function' ? Number(BigInt(String(s)) - BigInt('76561197960265728')) : null;
// 完美世界录像接口的 steamId 是超出 2^53 的裸数字，JSON.parse 会丢精度（差几个数，按 Steam ID 对不上选手）。
// 解析前先把它变成字符串，再交给 compactReplay 精确换算
const parseReplayJson = text => JSON.parse(String(text).replace(/"steamId"\s*:\s*(\d{15,})/g, '"steamId":"$1"'));
// 按分路 + GPM 推测 1-5 号位：中路→2；优势路 GPM 高者→1、其余→5；劣势路 GPM 高者→3、其余→4；野区/游走→4。冲突或缺失时按 GPM 顺序补空位
function guessPositions(team) {
  const byGpm = [...team].sort((a, b) => (b.gpm || 0) - (a.gpm || 0));
  const want = new Map();
  if (team.every(p => p.position >= 1 && p.position <= 5) && new Set(team.map(p => p.position)).size === team.length) {
    team.forEach(p => p.pos = p.position); return team;
  }
  if (team.every(p => p.laneRole)) {
    const grp = r => byGpm.filter(p => p.laneRole === r && !p.isRoaming);
    grp(2).forEach((p, i) => want.set(p, i === 0 ? 2 : 0));
    grp(1).forEach((p, i) => want.set(p, i === 0 ? 1 : 5));
    grp(3).forEach((p, i) => want.set(p, i === 0 ? 3 : 4));
    team.filter(p => p.laneRole === 4 || p.isRoaming).forEach(p => want.set(p, 4));
  }
  const used = new Set();
  for (const p of byGpm) { const pos = want.get(p) || 0; if (pos && !used.has(pos)) { p.pos = pos; used.add(pos); } else p.pos = 0; }
  const free = [1, 2, 3, 4, 5].filter(x => !used.has(x));
  for (const p of byGpm) if (!p.pos) p.pos = free.shift() || 1;
  return team;
}

function parseOpenDotaMatch(m) {
  const d = new Date((m.start_time || Date.now() / 1000) * 1000);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const mk = p => {
    const hero = HERO_BY_ID[p.hero_id] || p.hero_name_zh || (p.hero_id ? `英雄#${p.hero_id}` : '');
    const side = (typeof p.isRadiant === 'boolean' ? p.isRadiant : p.player_slot < 128) ? '天辉' : '夜魇';
    return {
    accountId: p.account_id || null, anon: !p.account_id,
    name: (p.personaname || '').trim() || (p.account_id ? `玩家${p.account_id}` : `匿名·${side}·${hero || (p.player_slot % 128) + 1}`),
    hidden: !!p.hidden_name,
    heroId: p.hero_id, hero,
    kda: [p.kills || 0, p.deaths || 0, p.assists || 0], gpm: p.gold_per_min || 0,
    laneRole: p.lane_role || 0, isRoaming: !!p.is_roaming, rankTier: p.rank_tier || 0, pos: 0, position: p.position || 0,
  }; };
  const isRad = p => (typeof p.isRadiant === 'boolean' ? p.isRadiant : p.player_slot < 128);
  return {
    id: String(m.match_id), date, duration: m.duration ? Math.round(m.duration / 60) : null, leagueId: Number(m.leagueid || m.league_id) || 0,
    winner: m.radiant_win ? 'radiant' : 'dire', score: [m.radiant_score ?? '?', m.dire_score ?? '?'],
    radiant: guessPositions(m.players.filter(isRad).map(mk)), dire: guessPositions(m.players.filter(p => !isRad(p)).map(mk)),
  };
}


function pwesportsMatch(body) {
  if (body.code !== 0) throw new Error(body.message || '返回 code ' + body.code);
  const m = (body.result && body.result.find ? body.result.find(g => g.group === 'match') : null)?.data;
  if (!m) throw Object.assign(new Error('尚未收录这场比赛（刚结束的比赛通常要等几分钟）'), { notFound: true });
  return {
    match_id: m.match_id, start_time: m.start_time, duration: m.duration, radiant_win: !!m.radiant_win,
    radiant_score: m.radiant_score, dire_score: m.dire_score, source: 'pwesports', leagueid: Number(m.leagueid) || 0,
    players: (m.players || []).map(p => {
      const hidden = !p.nickname || p.nickname === '匿名';
      return { account_id: p.account_id || null, personaname: hidden ? '' : p.nickname, hidden_name: hidden, player_slot: p.player_slot,
        hero_id: p.hero_id, hero_name_zh: p.hero_name_zh, kills: p.kills, deaths: p.deaths, assists: p.assists, gold_per_min: p.gold_per_min, rank_tier: p.rank || 0 };
    }),
  };
}

// 压缩成小对象存进 match.replay（每场约 5KB；原始返回 120KB+，localStorage 存不下）
function compactReplay(r) {
  const heroes = (r.heroInfos || []).map(h => ({ h: h.heroId, line: h.line || 0, r: !!h.radiant, name: h.userName || '', acc: h.steamId ? steam32(h.steamId) : null }));
  if (!heroes.length) return null;
  const pack = x => ({ h: x.heroId, lvl: x.level, k: x.kills, d: x.deaths, a: x.assists, lh: x.lastHits, dn: x.denies, nw: x.netWorth, xp: x.experience });
  const rg = r.radiantGraphList || [], dg = r.direGraphList || [];
  const n = Math.min(rg.length, dg.length);
  return {
    at: Date.now(), leagueId: r.leagueId || 0, gameMode: r.gameMode || 0, heroes,
    lanes: (r.lineAnalyses || []).map(l => ({ type: l.type, goldType: l.lineGoldType, rad: (l.radiantHeroes || []).map(pack), dire: (l.direHeroes || []).map(pack) })),
    gold: Array.from({ length: n }, (_, i) => rg[i].gold - dg[i].gold), exp: Array.from({ length: n }, (_, i) => rg[i].exp - dg[i].exp),
    kills: (r.logEvents || []).filter(e => e.type === 4).map(e => [e.time, e.sourceId, e.targetId]),
    wr: (r.graphWinRate || []).map(x => Math.round(x * 100)),
    res: { radiant: r.radiantResources || null, dire: r.direResources || null },
    bp: (r.picksBans || []).sort((a, b) => a.order - b.order).map(x => [x.heroId, x.pick ? 1 : 0, x.team]),
  };
}

function importParsed(state, parsed, { leagueId, autoNew, source, uid }) {
  let created = 0;
  const label = source || `联赛 ${leagueId} 导入`;
  const side = rows => rows.map(r => {
    let p = r.accountId ? state.players.find(x => x.accountId === r.accountId) : null;
    if (!p && !r.hidden && !r.anon) { const n = r.name.toLowerCase(); p = state.players.find(x => !x.accountId && x.name.toLowerCase() === n); if (p && r.accountId) p.accountId = r.accountId; }
    if (!p) {
      if (!autoNew) return null;
      const rk = rankFromTier(r.rankTier);
      let name = r.name, k = 2; while (state.players.some(x => x.name === name)) name = `${r.name}(${k++})`;
      p = { id: uid(), createdAt: Date.now(), name, rank: rk ? rk.rank : '传奇', stars: rk ? rk.stars : 3, positions: [r.pos], heroes: r.hero ? [r.hero] : [], note: (r.anon || r.hidden) ? `${label}，昵称未公开，请改成真实昵称` : label, accountId: r.accountId };
      state.players.push(p); created++;
    }
    const o = { pid: p.id, pos: r.pos, hero: r.hero }; if (r.kda) o.kda = r.kda; return o;
  }).filter(Boolean);
  const radiant = side(parsed.radiant), dire = side(parsed.dire);
  if (!radiant.length || !dire.length) throw new Error('两队都没有可识别的选手（未勾选自动新建）');
  const match = { id: parsed.id, date: parsed.date, duration: parsed.duration, note: `${label} · 比分 ${parsed.score.join(':')}`, radiant, dire, winner: parsed.winner, createdAt: Date.now() };
  if (leagueId || parsed.leagueId) match.leagueId = Number(leagueId || parsed.leagueId);
  if (parsed.score.every(x => Number.isFinite(Number(x)))) match.score = parsed.score.map(Number);
  const i = state.matches.findIndex(m => m.id === match.id);
  if (i >= 0) state.matches[i] = { ...match, createdAt: state.matches[i].createdAt, ...(state.matches[i].replay ? { replay: state.matches[i].replay } : {}) }; else state.matches.push(match);
  return { created, match };
}

// ============ OpenDota 字典 / 段位换算 / 时间格式（天梯资料、录像详情用） ============
const LOBBY_NAME = { 0: '普通匹配', 1: '练习赛', 2: '锦标赛', 3: '教程', 4: '合作人机', 5: '组排天梯', 6: '单排天梯', 7: '天梯', 8: '1v1 中路', 9: '战斗杯', 10: '本地人机', 11: '自定义', 12: '活动', 13: '人机组队', 14: '组排人机' };
const GAME_MODE_NAME = { 0: '未知', 1: '全阵营选择', 2: '队长模式', 3: '随机征召', 4: '单一征召', 5: '全部随机', 6: '新手模式', 7: '外交', 8: '反向征召', 9: '贪婪', 10: '教程', 11: '中路对决', 12: '至少选择', 13: '新手组队', 14: '同英雄', 15: '自定义', 16: '队长征召', 17: '均衡征召', 18: '技能征召', 19: '活动', 20: '全随机死亡竞赛', 21: '1v1 中路', 22: '全英雄选择', 23: '加速模式', 24: '突变' };
const LANE_ROLE_NAME = { 0: '未知 / 未解析', 1: '优势路', 2: '中路', 3: '劣势路', 4: '打野 / 游走' };
const LEAVER_NAME = { 0: '正常完成', 1: '提前退出（安全）', 2: '断线过久', 3: '放弃', 4: 'AFK', 5: '从未连接', 6: '从未连接（超时）' };
const REGION_NAME = { 1: '美西', 2: '美东', 3: '欧洲', 5: '新加坡（东南亚）', 6: '迪拜', 7: '澳大利亚', 8: '斯德哥尔摩', 9: '奥地利', 10: '巴西', 11: '南非', 12: '完美·电信上海', 13: '完美·联通', 14: '智利', 15: '秘鲁', 16: '印度', 17: '完美·电信广东', 18: '完美·电信浙江', 19: '日本', 20: '完美·电信武汉', 25: '完美·联通天津', 37: '台湾', 38: '阿根廷' };
const PATCH_NAME = { 39: '7.20', 40: '7.21', 41: '7.22', 42: '7.23', 43: '7.24', 44: '7.25', 45: '7.26', 46: '7.27', 47: '7.28', 48: '7.29', 49: '7.30', 50: '7.31', 51: '7.32', 52: '7.33', 53: '7.34', 54: '7.35', 55: '7.36', 56: '7.37', 57: '7.38', 58: '7.39', 59: '7.40', 60: '7.41' };
const rankFromTier = tier => { const t = Math.floor(tier / 10); if (!t || t > 8) return null; return { rank: RANKS[t - 1], stars: t === 8 ? 0 : (tier % 10 || 1) }; }; // 冠绝一世无星级
const fmtClock = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

return { RANKS, POS_NAME, POS_SHORT, HERO_BY_ID, HEROES, matchScore, CLOSE_MARGIN, movFactor, computeStats, LANE_EDGE, COMEBACK_GOLD, replayPid, replayStats, FIGHT_GAP, FIGHT_MIN, teamfights, computeBadges, predictMatch, predictionReport, topKey, SCORE_DEF, ELO_BASE, ELO_K, RANK_MAX, KDA_REL_CAP, heroScore, playerScore, leagueOf, rankIdx, pname, pct, pctNum, PTS_WIN, PTS_LOSS, ptsOf, scoreWsum, statsRows, buildReport, LOBBY_NAME, GAME_MODE_NAME, LANE_ROLE_NAME, LEAVER_NAME, REGION_NAME, PATCH_NAME, rankFromTier, fmtClock, guessPositions, parseOpenDotaMatch, pwesportsMatch, compactReplay, importParsed, steam32, parseReplayJson, replaySidePlayer, accNear };
});
