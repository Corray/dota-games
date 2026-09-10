/* 拍卖选马（星动次元杯规则 L1：记账与校验）
   —— 拍卖过程在群里喊，本模块做唯一真相源：定级 / 身价 / 预算 / 六条硬约束 / 成交流水 / 公示
   依赖 app.js 的 window.DotaApp 与 tournament.js 的 window.DotaTournament，数据存在 t.auction */
(() => {
'use strict';
const A = window.DotaApp, TN = window.DotaTournament;
if (!A || !TN) { console.error('auction.js 必须在 app.js、tournament.js 之后加载'); return; }
const { $, $$, esc, uid, today, toast, showModal, hideModal, playerMap, pname, rankBadge, save } = A;
const S = () => A.state;

// ============ 规则常量（来源：星动次元杯测试联赛拍卖选马规则公告 2026-09-09）============
// base 起拍底价(表1) · cap 队长占用身价(表2) · fair 建议均衡价(七.1) · max 出价上限参考(七.2) · step 加价步长(四.1) · cls 级别配额归类(五.4)
const TIERS = ['SSS', 'S', 'A+', 'A', 'A-', 'B', 'C', 'D'];
const TIER = {
  'SSS': { base: 80, cap: 96, fair: 160, max: 192, step: 5, cls: 'S' },
  'S':   { base: 50, cap: 57, fair: 90,  max: 108, step: 5, cls: 'S' },
  'A+':  { base: 40, cap: 44, fair: 68,  max: 82,  step: 5, cls: 'A' },
  'A':   { base: 32, cap: 34, fair: 51,  max: 61,  step: 5, cls: 'A' },
  'A-':  { base: 26, cap: 27, fair: 39,  max: 47,  step: 2, cls: 'A' },
  'B':   { base: 22, cap: 22, fair: 31,  max: 37,  step: 2, cls: '' },
  'C':   { base: 15, cap: 15, fair: 19,  max: 23,  step: 2, cls: '' },
  'D':   { base: 10, cap: 10, fair: 12,  max: 14,  step: 2, cls: '' },
};
const QUOTA = { S: 2, A: 3 };            // 五.4 每队 S 级(含 SSS) ≤2、A 系 ≤3
const SIZE = 5;                          // 五.2 每队恰好 5 人
const DEF = { budget: 270, minPrice: 10 };  // 三.1 每队 270 万；五.1 保底按最低身价 10 万
const MAX45 = 2;                         // 五.5 45 组禁打 1/2/3，故一队最多容纳 2 名 45 组选手
const DEFAULT_PENALTY = 0.1;             // 六.3 成交后反悔罚该队预算 10%

// 四 拍卖流程（5 轮 12 批）：轮次结构照规则表格预设，可改
const MODES = { open: '公开竞价', sealed: '暗写出价', timed: '计时抢拍', floor: '底价明拍' };
const ROUND_PRESET = [
  { name: '第1轮·锚定明拍', mode: 'open',   from: 1, to: 2,  planned: 14, secs: 0,  note: '含全部 SSS 与高分 S，锚定全场价格基准；未成交流入第 5 轮' },
  { name: '第2轮·核心明拍', mode: 'open',   from: 3, to: 5,  planned: 25, secs: 0,  note: '每批含 2 名 S 级保证热度' },
  { name: '第3轮·中坚暗拍', mode: 'sealed', from: 6, to: 8,  planned: 23, secs: 0,  note: '同时写价、同时亮牌，最高价得；同价按抽签顺序优先' },
  { name: '第4轮·功能计时', mode: 'timed',  from: 9, to: 11, planned: 21, secs: 90, note: '每名 60-90 秒倒计时' },
  { name: '第5轮·补位清仓', mode: 'floor',  from: 12, to: 12, planned: 8, secs: 0,  note: '压轴重磅（开拍前揭晓）+ 流拍选手 + 自由人池收尾' },
];

// 五.5 位置组：报名位置含 1/2/3 任一 → 123 组；仅纯 4/5 → 45 组
const posGroup = p => { const ps = p?.positions || []; return !ps.length ? '' : ps.some(x => x <= 3) ? '123' : '45'; };
const groupTxt = g => g === '123' ? '123组' : g === '45' ? '45组' : '未定组';
// 位置组 + 擅长号位，如「123组·1/3」
const groupPos = p => { const g = groupTxt(posGroup(p)); const ps = (p?.positions || []); return ps.length ? `${g}·${ps.join('/')}` : g; };
const fmt = v => (Math.round(v * 10) / 10).toLocaleString('zh-CN');

// ============ 数据 ============
function auc(t) {
  if (!t.auction) t.auction = { budget: DEF.budget, minPrice: DEF.minPrice, grades: {}, captains: {}, deals: [] };
  const a = t.auction;
  a.grades ||= {}; a.captains ||= {}; a.deals ||= [];
  // L2 拍卖流程
  a.rounds ||= ROUND_PRESET.map((r, i) => ({ id: 'r' + (i + 1), ...r, revealed: i === 0 }));  // 四：开赛前仅公开第 1 轮名单
  a.lots ||= {};          // pid -> 轮次 id
  a.passed ||= {};        // pid -> true，流拍
  a.order ||= [];         // 六.1 抽签起拍顺序（teamId），全程有效
  a.penalties ||= [];     // 六.3 违约罚款
  if (!('live' in a)) a.live = null;
  return a;
}
const roundOf = (t, rid) => auc(t).rounds.find(r => r.id === rid) || null;
const lotRound = (t, pid) => roundOf(t, auc(t).lots[pid]);
// 六.3 违约罚款计入预算：该队可用预算 = 基础预算 − 罚款合计
const penaltyOf = (t, tmId) => auc(t).penalties.filter(x => x.teamId === tmId).reduce((s, x) => s + x.amount, 0);
const budgetOf = (t, tmId) => auc(t).budget - penaltyOf(t, tmId);
const enabled = t => !!t.auction;
const gradeOf = (t, pid) => auc(t).grades[pid] || '';
const dealOf = (t, pid) => auc(t).deals.find(d => d.pid === pid) || null;

/* 单队账目：花了多少、剩多少、还差几个名额、配额用量、风险 */
function teamStat(t, tmId) {
  const a = auc(t), P = playerMap();
  const deals = a.deals.filter(d => d.teamId === tmId);
  const spent = deals.reduce((s, d) => s + d.price, 0);
  const budget = budgetOf(t, tmId), fine = penaltyOf(t, tmId);
  const left = budget - spent, slots = SIZE - deals.length;
  const g = deals.map(d => a.grades[d.pid]);
  const sCnt = g.filter(x => TIER[x]?.cls === 'S').length;
  const aCnt = g.filter(x => TIER[x]?.cls === 'A').length;
  const c45 = deals.filter(d => posGroup(P.get(d.pid)) === '45').length;
  return {
    deals, spent, left, slots, sCnt, aCnt, c45, budget, fine,
    banned: a.penalties.filter(x => x.teamId === tmId).length >= 2,   // 六.3 两次违约取消后续出价权
    floor: slots * a.minPrice,                       // 五.1 保底所需
    afford: slots > 0 ? left / slots : null,         // 七.3 可支配均价
    bankrupt: left < slots * a.minPrice,             // 保底破产
    blown: spent > budget,                           // 五.6 爆仓
    lineup: lineupCheck(t, deals.map(d => d.pid)),
  };
}

/* 五.3 阵容必须覆盖 1-5 各 1 人。
   hard: 45 组选手只能占 4/5，超过 2 人就永远排不出 1-5（这是硬伤，规则五.5 单向锁定）
   soft: 只按各人「擅长位置」能否完美匹配 —— 排不出说明得有人降位/换位打，不违规但要心里有数 */
function lineupCheck(t, pids) {
  const P = playerMap();
  const match = lists => {                            // 5 人各占一个号位的完美匹配，规模小直接回溯
    const used = {}; const dfs = i => {
      if (i === lists.length) return true;
      for (const pos of lists[i]) if (!used[pos]) { used[pos] = true; if (dfs(i + 1)) return true; used[pos] = false; }
      return false;
    }; return dfs(0);
  };
  const c45 = pids.filter(pid => posGroup(P.get(pid)) === '45').length;
  const strict = pids.map(pid => { const ps = P.get(pid)?.positions || []; return ps.length ? [...ps].sort() : [1, 2, 3, 4, 5]; });
  const full = pids.length === SIZE;
  return { hard: c45 <= MAX45, soft: !full || match(strict), full, c45 };
}

/* 六条硬约束（五.1-五.6）逐条校验一笔出价。errors 阻断入账，warns 只提示 */
function checkBid(t, pid, tmId, price, opt = {}) {
  const a = auc(t), P = playerMap(), errors = [], warns = [];
  const g = gradeOf(t, pid), T = TIER[g], p = P.get(pid);
  const st = teamStat(t, tmId);
  if (!p) errors.push('该选手已从「选手名单」删除');
  if (!g) errors.push('该选手还没有定级档位，先导入定级表');
  if (!opt.self && dealOf(t, pid)) errors.push('该选手已成交，要改先撤销原成交');
  if (st.deals.length >= SIZE) errors.push(`该队已满 ${SIZE} 人`);            // 五.2
  if (st.banned) errors.push('该队已两次违约，按规则六.3 取消后续出价权');
  if (!(price > 0)) errors.push('成交价要大于 0');
  else if (T && price < T.base) errors.push(`低于 ${g} 档起拍底价 ${T.base} 万`);   // 二.3
  // 五.1 预算约束：任何出价后，剩余预算 ≥ 剩余名额 × 最低身价
  if (price > st.left) errors.push(`超出剩余预算（只剩 ${fmt(st.left)} 万）`);
  else {
    const after = st.left - price, slotsAfter = st.slots - 1;
    if (after < slotsAfter * a.minPrice) errors.push(`保底破产：成交后剩 ${fmt(after)} 万 < 剩余 ${slotsAfter} 名额 × ${a.minPrice} 万`);
  }
  // 五.4 级别配额
  if (T?.cls === 'S' && st.sCnt >= QUOTA.S) errors.push(`该队 S 级（含 SSS）已满 ${QUOTA.S} 人`);
  if (T?.cls === 'A' && st.aCnt >= QUOTA.A) errors.push(`该队 A 系已满 ${QUOTA.A} 人`);
  // 五.5 45 组名额（超过 2 人就排不出 1-5）
  if (posGroup(p) === '45' && st.c45 >= MAX45) errors.push(`该队已有 ${MAX45} 名 45 组选手，再进将无法排出 1-5 号位`);
  // 软提示
  if (T && price > T.max) warns.push(`超过 ${g} 档建议上限 ${T.max} 万（均衡价 ${T.fair} × 120%），规则七.2 需主持人确认预算余量`);
  // 四.1 加价步长：成交价应落在 底价 + k×步长 上（底价本身即 k=0）
  if (T && (price - T.base) % T.step !== 0) warns.push(`${g} 档每次加价不低于 ${T.step} 万，${fmt(price)} 不在「底价 ${T.base} + ${T.step} 的整数倍」上`);
  if (p && !(p.positions || []).length) warns.push('该选手没填擅长位置，判不出 123 组 / 45 组');
  if (!errors.length && st.deals.length + 1 === SIZE) {
    const test = lineupCheck(t, [...st.deals.map(d => d.pid), pid]);
    if (!test.soft) warns.push('成交后满 5 人，但按各人擅长位置排不出 1-5，需有人降位打');
  }
  return { ok: !errors.length, errors, warns };
}

// 成交入账：同时把人放进队伍阵容空位，让后面的赛制 / 替补 / 榜单直接沿用
function commit(t, pid, tmId, price, kind) {
  const a = auc(t);
  a.deals.push({ id: uid(), pid, teamId: tmId, price, kind: kind || 'bid', at: Date.now() });
  if (!TN.rosterOf(t).includes(pid)) TN.rosterOf(t).push(pid);
  const tm = TN.teamOf(t, tmId);
  if (tm && !tm.players.includes(pid)) { const i = tm.players.indexOf(null); if (i >= 0) tm.players[i] = pid; else tm.players.push(pid); }
}
function revoke(t, dealId) {
  const a = auc(t), i = a.deals.findIndex(d => d.id === dealId); if (i < 0) return null;
  const d = a.deals[i]; a.deals.splice(i, 1);
  const tm = TN.teamOf(t, d.teamId);
  if (tm) tm.players = tm.players.map(x => x === d.pid ? null : x);
  if (a.captains[d.teamId] === d.pid) delete a.captains[d.teamId];
  return d;
}

// ============ L2 拍卖流程引擎 ============
/* 四首段：每轮名单「混排各档」，避免核心扎堆导致抢不到或不敢出价。
   第 1 轮吃满 SSS + 高分 S（锚定基准）；末轮留给清仓；中间各轮按档位轮转取人，保证每轮档位分布均匀 */
function autoLots(t) {
  const a = auc(t), R = a.rounds;
  if (!R.length) return 0;
  const pool = TN.rosterPlayers(t).filter(p => gradeOf(t, p.id)).map(p => p.id);
  const byTier = g => pool.filter(pid => gradeOf(t, pid) === g);
  const taken = new Set(), lots = {};
  const put = (pid, rid) => { lots[pid] = rid; taken.add(pid); };

  const first = R[0], last = R[R.length - 1];
  [...byTier('SSS'), ...byTier('S')].slice(0, first.planned).forEach(pid => put(pid, first.id));
  if (R.length > 1) [...TIERS].reverse().flatMap(byTier).filter(pid => !taken.has(pid)).slice(0, last.planned).forEach(pid => put(pid, last.id));

  /* 中间各轮：逐个档位桶按「各轮需求比例」摊分，而不是排成一条队再切片 ——
     切片会把大桶（B 档 24 人）的尾巴整段甩给最后一轮，正是规则要避免的扎堆 */
  const mid = R.slice(1, -1);
  const buckets = TIERS.map(g => byTier(g).filter(pid => !taken.has(pid)));
  const bins = mid.map(() => []), overflow = [];
  for (const bucket of buckets) for (const pid of bucket) {
    let best = -1, bestRatio = Infinity;
    for (let k = 0; k < mid.length; k++) {
      if (bins[k].length >= mid[k].planned) continue;
      const ratio = bins[k].length / (mid[k].planned || 1);
      if (ratio < bestRatio) { bestRatio = ratio; best = k; }
    }
    if (best < 0) overflow.push(pid); else bins[best].push(pid);
  }
  mid.forEach((r, k) => bins[k].forEach(pid => put(pid, r.id)));
  overflow.forEach(pid => put(pid, last.id));                 // 池子比计划人数多，多出的塞末轮

  a.lots = lots;
  return Object.keys(lots).length;
}

// 六.1 起拍顺序抽签，全程有效（暗拍同价按此优先）
function drawOrder(t) {
  const ids = t.teams.map(x => x.id);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  auc(t).order = ids;
  return ids;
}
const seatOf = (t, tmId) => { const i = auc(t).order.indexOf(tmId); return i < 0 ? 99 : i + 1; };

// 某轮待拍的人：已编排进本轮、未成交、未流拍
const lotsOf = (t, rid) => TN.rosterPlayers(t).map(p => p.id)
  .filter(pid => auc(t).lots[pid] === rid && !dealOf(t, pid) && !auc(t).passed[pid]);

function openLot(t, pid) {
  const a = auc(t), r = lotRound(t, pid); if (!r) return toast('该选手还没编排进任何轮次', 'err');
  a.live = { rid: r.id, pid, bids: [], sealed: {}, opened: false, endsAt: r.secs ? Date.now() + r.secs * 1000 : null };
}
const liveTop = a => a.live?.bids.length ? a.live.bids[a.live.bids.length - 1] : null;
const clockTxt = ends => { const s = Math.max(0, Math.ceil((ends - Date.now()) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
// 明拍下一口价：首口 = 底价，之后 = 当前最高 + 步长
function nextPrice(t) {
  const a = auc(t); if (!a.live) return 0;
  const T = TIER[gradeOf(t, a.live.pid)], top = liveTop(a);
  return top ? top.price + (T?.step || 1) : (T?.base || a.minPrice);
}
/* 明拍出价校验：五.6「明拍由主持人实时校验，出价将触发保底违约的直接否决，从源头拦截」
   所以这里除了六条硬约束，还要卡住「不足一个加价步长」 */
function checkOpenBid(t, tmId, price) {
  const a = auc(t), r = checkBid(t, a.live.pid, tmId, price);
  // 首口的底价检查由 checkBid 负责，这里只管「已有出价后必须加满一口」，避免报两条重复的
  if (liveTop(a) && price < nextPrice(t)) r.errors.unshift(`不足一口加价（至少 ${fmt(nextPrice(t))} 万）`);
  r.ok = !r.errors.length;
  return r;
}
function settleLive(t, tmId, price) {
  const a = auc(t); if (!a.live) return;
  commit(t, a.live.pid, tmId, price, 'bid');
  a.live = null;
}
/* 流拍：第 1 轮未成交流入第 5 轮（规则四表格第 1 行说明），其余轮就地标记 */
function passLive(t) {
  const a = auc(t); if (!a.live) return '';
  const pid = a.live.pid, r = roundOf(t, a.live.rid), last = a.rounds[a.rounds.length - 1];
  let msg = '已流拍';
  if (last && r && r.id !== last.id) { a.lots[pid] = last.id; msg = `已流拍，转入「${last.name}」`; }
  else a.passed[pid] = true;
  a.live = null;
  return msg;
}
/* 暗拍亮牌：按价降序，同价按抽签顺序（六.1）。
   五.6 明说爆仓「主要见于暗拍亮牌成交」—— 所以每口价都要标出是否会触发保底违约 */
function openSealed(t) {
  const a = auc(t); if (!a.live) return [];
  a.live.opened = true;
  return sealedRank(t);
}
function sealedRank(t) {
  const a = auc(t); if (!a.live) return [];
  return Object.entries(a.live.sealed).filter(([, v]) => v > 0)
    .map(([teamId, price]) => ({ teamId, price, seat: seatOf(t, teamId), check: checkBid(t, a.live.pid, teamId, price) }))
    .sort((x, y) => y.price - x.price || x.seat - y.seat);
}
// 六.3 违约：撤销成交 + 罚该队预算 10% + 选手重新上拍
function defaultDeal(t, dealId) {
  const a = auc(t), d = a.deals.find(x => x.id === dealId); if (!d) return null;
  const fine = Math.round(a.budget * DEFAULT_PENALTY * 10) / 10;
  revoke(t, d.id);
  a.penalties.push({ id: uid(), teamId: d.teamId, amount: fine, reason: `${pname(playerMap(), d.pid)} 成交后反悔`, at: Date.now() });
  delete a.passed[d.pid];                                  // 重新上拍
  return { fine, count: a.penalties.filter(x => x.teamId === d.teamId).length };
}

// ============ 视图 ============
function view(t) {
  if (!enabled(t)) return `<div class="tn-banner" style="display:block">
    <b>拍卖选马</b>（星动次元杯规则）—— 队长用虚拟币竞价买选手组队，替代「随机均衡分组」。
    <p class="hint" style="margin:8px 0">启用后本页负责：八档定级与身价、每队预算与剩余名额、六条硬约束实时校验、成交流水与公示。拍卖过程仍在群里喊，这里当唯一真相源。</p>
    <div class="form-actions"><button type="button" class="primary" id="au-enable">启用拍卖选马</button></div></div>`;
  const a = auc(t), P = playerMap();
  const pool = TN.rosterPlayers(t);
  const graded = pool.filter(p => gradeOf(t, p.id));
  const dealt = a.deals.length, total = a.deals.reduce((s, d) => s + d.price, 0);
  const editable = t.status === 'setup';

  const cfg = `<div class="tn-toolbar">
    <label class="narrow">每队预算<input type="number" id="au-budget" min="1" max="99999" value="${a.budget}" ${editable ? '' : 'disabled'}></label>
    <label class="narrow" title="保底约束用：剩余预算须 ≥ 剩余名额 × 该值">最低身价<input type="number" id="au-min" min="1" max="999" value="${a.minPrice}" ${editable ? '' : 'disabled'}></label>
    ${editable ? `<button type="button" class="primary" id="au-import">导入定级表</button>
    <button type="button" id="au-mkteams" title="按规则一次性建满队伍并命名">生成队伍</button>
    <button type="button" class="ghost danger" id="au-reset">清空成交</button>` : '<span class="hint">赛事已开始，拍卖账目锁定</span>'}
    <span class="hint">选手池 ${pool.length} 人（已定级 ${graded.length}）· 已成交 ${dealt} 人 · 总成交额 ${fmt(total)} 万 / ${fmt(a.budget * t.teams.length)} 万</span>
  </div>`;

  // ---- 队伍看板 ----
  const quotaChip = (n, max, label) => `<span class="au-q ${n > max ? 'bad' : n === max ? 'full' : ''}">${label} ${n}/${max}</span>`;
  const board = t.teams.length ? `<div class="tn-teams">${t.teams.map((tm, ti) => {
    const st = teamStat(t, tm.id);
    const capPid = a.captains[tm.id];
    const risk = `${st.blown ? '<span class="au-risk bad">爆仓</span>' : st.bankrupt ? '<span class="au-risk warn">保底破产</span>' : ''}${st.banned ? '<span class="au-risk bad">出价权已取消</span>' : ''}`;
    const lineWarn = !st.lineup.hard ? '<span class="au-risk bad">45 组超员</span>' : (st.lineup.full && !st.lineup.soft) ? '<span class="au-risk warn">排不出 1-5</span>' : '';
    const rows = st.deals.map(d => {
      const g = a.grades[d.pid], p = P.get(d.pid);
      return `<div class="au-row"><span class="au-t t${(g || '').replace('+', 'p').replace('-', 'm')}">${esc(g || '?')}</span>
        <span class="au-nm">${esc(pname(P, d.pid))}${d.kind === 'captain' ? '<span class="pc">队长</span>' : ''}${d.kind === 'fa' ? '<span class="pc">自由人</span>' : ''}</span>
        <span class="hint au-g">${esc(groupPos(p))}</span>
        <span class="au-p">${fmt(d.price)}<i>万</i></span>
        ${editable ? `<button type="button" class="mini danger" data-au-revoke="${d.id}" title="撤销这笔成交">×</button>` : ''}</div>`;
    }).join('');
    return `<div class="tn-team au-team">
      <div class="tn-team-head"><span class="tn-seed">#${ti + 1}</span><strong>${esc(tm.name)}</strong></div>
      <div class="au-money"><b>${fmt(st.spent)}</b> / ${fmt(st.budget)} 万${st.fine ? ` <span class="loss" title="六.3 违约罚款">−${fmt(st.fine)} 罚</span>` : ''} · 剩 <b class="${st.bankrupt ? 'loss' : ''}">${fmt(st.left)}</b> · 名额 ${st.slots}
        ${st.slots > 0 ? ` · 均价 <b class="${st.afford < a.minPrice * 1.5 ? 'loss' : 'win'}">${fmt(st.afford)}</b>` : ' · <span class="win">满编</span>'}</div>
      <div class="au-quotas">${quotaChip(st.deals.length, SIZE, '人数')}${quotaChip(st.sCnt, QUOTA.S, 'S级')}${quotaChip(st.aCnt, QUOTA.A, 'A系')}${quotaChip(st.c45, MAX45, '45组')}${risk}${lineWarn}</div>
      <div class="au-cap">队长：${capPid ? `${esc(pname(P, capPid))}` : '<span class="hint">未定</span>'}
        ${editable ? `<button type="button" class="mini" data-au-cap="${tm.id}">设置</button>` : ''}</div>
      ${rows || '<div class="hint" style="padding:4px 2px">还没买人</div>'}
      ${editable && st.slots > 0 ? `<button type="button" class="mini au-add" data-au-buy="${tm.id}">＋ 录入成交</button>` : ''}
    </div>`;
  }).join('')}</div>` : '<p class="empty">还没有队伍，点上面「生成队伍」。</p>';

  // ---- 选手池 ----
  const q = (ui.q || '').trim().toLowerCase();
  const onlyOpen = ui.onlyOpen;
  const list = [...pool].sort((x, y) => (TIERS.indexOf(gradeOf(t, x.id)) + 99) % 99 - (TIERS.indexOf(gradeOf(t, y.id)) + 99) % 99 || x.name.localeCompare(y.name, 'zh'));
  const poolRows = list.filter(p => {
    const d = dealOf(t, p.id);
    if (onlyOpen && d) return false;
    if (!q) return true;
    return `${p.name} ${gradeOf(t, p.id)} ${groupTxt(posGroup(p))}`.toLowerCase().includes(q);
  }).map(p => {
    const g = gradeOf(t, p.id), d = dealOf(t, p.id), T = TIER[g];
    return `<tr class="${d ? 'au-done' : ''}">
      <td><span class="au-t t${(g || '').replace('+', 'p').replace('-', 'm')}">${esc(g || '未定级')}</span></td>
      <td class="num">${T ? fmt(T.base) : '-'}</td>
      <td><strong>${esc(p.name)}</strong> ${rankBadge(p)}</td>
      <td>${esc(groupTxt(posGroup(p)))}<span class="hint"> ${(p.positions || []).join('/') || '未填位置'}</span></td>
      <td class="num hint">${T ? `${fmt(T.fair)} / ${fmt(T.max)}` : '-'}</td>
      <td>${lotCell(t, p.id)}</td>
      <td>${d ? `<span class="win">${esc(TN.teamOf(t, d.teamId)?.name || '(已删队)')}</span> <b>${fmt(d.price)}</b> 万` : a.passed[p.id] ? '<span class="loss">流拍</span>' : '<span class="hint">未成交</span>'}</td>
      <td class="num">${editable && !d ? `${lotRound(t, p.id)?.revealed ? `<button type="button" class="mini au-go" data-au-lot="${p.id}" title="把这名选手推上拍卖台">开拍</button> ` : ''}<button type="button" class="mini" data-au-buy-p="${p.id}">录入成交</button>` : editable ? `<button type="button" class="mini danger" data-au-revoke="${d.id}">撤销</button>` : ''}</td>
    </tr>`;
  }).join('');

  // ---- 公示：剩余预算排名 + 成交流水 ----
  const rank = t.teams.map(tm => ({ tm, st: teamStat(t, tm.id) })).sort((x, y) => y.st.left - x.st.left);
  const flow = [...a.deals].sort((x, y) => y.at - x.at).slice(0, 30);

  return `${cfg}
    ${viewFlow(t)}
    <h3 style="margin-top:16px">队伍看板 <span class="hint">硬约束实时校验：预算保底 / 恰好 5 人 / 1-5 号位 / S级≤2 / A系≤3 / 45 组禁打 1-3</span></h3>
    ${board}
    <div class="two-col" style="margin-top:16px;grid-template-columns:1fr 1fr">
      <div>
        <h3>剩余预算公示 <span class="hint">规则六.5，每轮开拍前参考</span></h3>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>队伍</th><th class="num">已用</th><th class="num">剩余</th><th class="num">名额</th><th class="num">可支配均价</th></tr></thead><tbody>
          ${rank.map(({ tm, st }) => `<tr><td>${esc(tm.name)}</td><td class="num">${fmt(st.spent)}</td><td class="num"><b class="${st.bankrupt ? 'loss' : ''}">${fmt(st.left)}</b></td><td class="num">${st.slots}</td><td class="num">${st.slots > 0 ? `<b class="${st.afford < a.minPrice * 1.5 ? 'loss' : ''}">${fmt(st.afford)}</b>${st.afford < a.minPrice * 1.5 ? ' <span class="hint">买不起人</span>' : ''}` : '-'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">还没有队伍</td></tr>'}
        </tbody></table></div>
      </div>
      <div>
        <h3>拍卖记录表 <span class="hint">规则六.2，最近 30 笔</span></h3>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>选手</th><th>档位</th><th>归属</th><th class="num">成交价</th><th class="num">溢价</th><th></th></tr></thead><tbody>
          ${flow.map(d => { const g = a.grades[d.pid], T = TIER[g]; const ov = T ? (d.price / T.base - 1) * 100 : null;
            return `<tr><td>${esc(pname(P, d.pid))}${d.kind === 'captain' ? '<span class="pc">队长</span>' : ''}${d.kind === 'fa' ? '<span class="pc">自由人</span>' : ''}</td><td>${esc(g || '?')}</td><td>${esc(TN.teamOf(t, d.teamId)?.name || '(已删队)')}</td><td class="num"><b>${fmt(d.price)}</b></td><td class="num ${ov > 100 ? 'loss' : ''}">${ov == null ? '-' : (ov >= 0 ? '+' : '') + Math.round(ov) + '%'}</td><td class="num">${editable ? `<button type="button" class="mini" data-au-default="${d.id}" title="规则六.3：成交后反悔，罚预算 10% 并重新上拍">违约</button> <button type="button" class="mini danger" data-au-revoke="${d.id}">撤销</button>` : ''}</td></tr>`; }).join('')
            || '<tr><td colspan="6" class="empty">还没有成交记录</td></tr>'}
        </tbody></table></div>
      </div>
    </div>
    <h3 style="margin-top:16px">选手池 <span class="hint">按档位排序；起拍底价 / 均衡价 / 上限参考出自规则表 1、七.1、七.2</span></h3>
    <div class="tn-toolbar">
      <input type="search" id="au-q" placeholder="搜索昵称 / 档位 / 位置组" value="${esc(ui.q || '')}">
      <label class="inline hint"><input type="checkbox" id="au-open" ${onlyOpen ? 'checked' : ''}> 只看未成交</label>
    </div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>档位</th><th class="num">底价</th><th>选手</th><th>位置组</th><th class="num">均衡价/上限</th><th>轮次</th><th>成交</th><th></th></tr></thead>
      <tbody>${poolRows || '<tr><td colspan="8" class="empty">选手池是空的 —— 先去「参赛选手」勾人，或直接「导入定级表」（会自动加进参赛名单）</td></tr>'}</tbody></table></div>`;
}

const ui = { q: '', onlyOpen: false };
// 四：名单逐轮揭晓 —— 未揭晓的轮次在公示里统一显示「待揭晓」，保留竞价博弈空间
function lotCell(t, pid) {
  const r = lotRound(t, pid);
  if (!r) return '<span class="hint">未编排</span>';
  if (!r.revealed) return '<span class="hint">待揭晓</span>';
  return `<span class="au-rd">${esc(r.name)}</span>`;
}

// ---- 轮次结构 + 拍卖台 ----
// 某轮的档位构成，用来肉眼检查规则四「混排各档」有没有做到
function tierDist(t, rid) {
  const a = auc(t), cnt = {};
  for (const [pid, r] of Object.entries(a.lots)) if (r === rid) { const g = a.grades[pid]; if (g) cnt[g] = (cnt[g] || 0) + 1; }
  const parts = TIERS.filter(g => cnt[g]).map(g => `<span class="au-t t${g.replace('+', 'p').replace('-', 'm')}">${esc(g)}</span><i>${cnt[g]}</i>`);
  return parts.length ? parts.join('') : '<span class="hint">-</span>';
}

function viewFlow(t) {
  const a = auc(t), P = playerMap(), editable = t.status === 'setup';
  const counts = {}; for (const pid of Object.keys(a.lots)) counts[a.lots[pid]] = (counts[a.lots[pid]] || 0) + 1;
  const soldIn = rid => lotsOf(t, rid).length;

  const rows = a.rounds.map((r, i) => {
    const n = counts[r.id] || 0, left = soldIn(r.id);
    return `<tr data-round="${r.id}">
      <td>${i + 1}</td>
      <td><input type="text" data-rf="name" value="${esc(r.name)}" maxlength="24" ${editable ? '' : 'disabled'} style="min-width:130px"></td>
      <td><select data-rf="mode" ${editable ? '' : 'disabled'}>${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${r.mode === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td class="num"><input type="number" data-rf="from" value="${r.from}" min="1" max="99" ${editable ? '' : 'disabled'} class="au-nnum">-<input type="number" data-rf="to" value="${r.to}" min="1" max="99" ${editable ? '' : 'disabled'} class="au-nnum"></td>
      <td class="num"><input type="number" data-rf="planned" value="${r.planned}" min="0" max="999" ${editable ? '' : 'disabled'} class="au-nnum wide"></td>
      <td class="num">${r.mode === 'timed' ? `<input type="number" data-rf="secs" value="${r.secs || 90}" min="10" max="600" ${editable ? '' : 'disabled'} class="au-nnum wide">秒` : '<span class="hint">-</span>'}</td>
      <td class="num">${n}${n !== r.planned ? ` <span class="hint">(计划 ${r.planned})</span>` : ''}</td>
      <td class="wrap au-dist">${tierDist(t, r.id)}</td>
      <td class="num">${left ? `<b>${left}</b> 待拍` : n ? '<span class="win">拍完</span>' : '<span class="hint">-</span>'}</td>
      <td>${r.revealed ? '<span class="win">已揭晓</span>' : '<span class="hint">待揭晓</span>'}</td>
      <td class="num"><button type="button" class="mini" data-au-reveal="${r.id}">${r.revealed ? '收起' : '揭晓名单'}</button>
        ${left ? `<button type="button" class="mini au-go" data-au-start="${r.id}">开拍</button>` : ''}</td>
    </tr>`;
  }).join('');

  const orderTxt = a.order.length
    ? a.order.map((id, i) => `<span class="tag">${i + 1}. ${esc(TN.teamOf(t, id)?.name || '(已删队)')}</span>`).join(' ')
    : '<span class="hint">未抽签 —— 暗拍同价时无法判优先，先抽一次</span>';

  return `<h3 style="margin-top:4px">拍卖流程 <span class="hint">规则四：5 轮 12 批，名单逐轮揭晓；未揭晓的轮次在选手池里统一显示「待揭晓」</span></h3>
    <div class="tn-toolbar">
      ${editable ? `<button type="button" class="primary" id="au-autolots">自动编排名单</button>
      <button type="button" id="au-draw">抽签起拍顺序</button>
      <button type="button" class="ghost" id="au-preset-rounds">恢复规则默认轮次</button>` : ''}
      <span class="hint">已编排 ${Object.keys(a.lots).length} 人 / 选手池 ${TN.rosterPlayers(t).filter(p => gradeOf(t, p.id)).length} 人</span>
    </div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>轮</th><th>名称</th><th>方式</th><th class="num">批次</th><th class="num">计划</th><th class="num">计时</th><th class="num">已编排</th><th>档位分布</th><th class="num">进度</th><th>名单</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="au-order"><b>起拍顺序</b>（六.1，全程有效）${orderTxt}</div>
    ${a.live ? viewStage(t) : ''}`;
}

// 拍卖台：按当前轮的方式渲染明拍 / 暗拍 / 计时 / 底价明拍
function viewStage(t) {
  const a = auc(t), P = playerMap(), live = a.live;
  const r = roundOf(t, live.rid), pid = live.pid, p = P.get(pid), g = gradeOf(t, pid), T = TIER[g];
  const top = liveTop(a);
  const eligible = t.teams.map(tm => ({ tm, st: teamStat(t, tm.id), chk: checkBid(t, pid, tm.id, nextPrice(t)) }));

  const head = `<div class="au-lot">
    <span class="au-t t${(g || '').replace('+', 'p').replace('-', 'm')}">${esc(g || '?')}</span>
    <strong class="au-lot-nm">${esc(pname(P, pid))}</strong> ${p ? rankBadge(p) : ''}
    <span class="hint">${esc(groupPos(p))} · 底价 ${T ? fmt(T.base) : '?'} 万 · 均衡 ${T ? fmt(T.fair) : '?'} / 上限 ${T ? fmt(T.max) : '?'}</span>
    <span class="au-mode">${esc(r?.name || '')} · ${MODES[r?.mode] || ''}</span>
  </div>`;

  const teamOpts = (filterFn) => t.teams.map(({ id, name }) => {
    const e = eligible.find(x => x.tm.id === id);
    const bad = filterFn ? filterFn(e) : !e.chk.ok;
    return `<option value="${id}" ${bad ? 'disabled' : ''}>${esc(name)}（剩 ${fmt(e.st.left)} / ${e.st.slots} 名额）${bad ? ' — ' + esc(e.chk.errors[0] || '不可出价') : ''}</option>`;
  }).join('');

  let panel = '';
  if (r?.mode === 'sealed') {
    // 暗拍：各队同时写价 → 亮牌 → 最高价得，同价按抽签顺序
    const rank = live.opened ? sealedRank(t) : [];
    panel = `<div class="au-sealed">
      ${live.opened ? '' : `<p class="hint">规则四·第 3 轮：同时写价、同时亮牌。逐队录入后点「全部亮牌」，${a.order.length ? '同价按抽签顺序判优先' : '⚠ 还没抽签，同价无法判优先'}。</p>
      <div class="au-sealed-grid">${t.teams.map(tm => { const e = eligible.find(x => x.tm.id === tm.id);
        return `<label class="au-sealed-cell ${e.chk.ok ? '' : 'off'}"><span>${esc(tm.name)}<i>${fmt(e.st.left)} / ${e.st.slots}名额</i></span>
          <input type="number" data-au-sealed="${tm.id}" min="0" max="99999" value="${live.sealed[tm.id] || ''}" placeholder="${e.chk.ok ? '出价' : '不可出价'}" ${e.chk.ok ? '' : 'disabled'}></label>`; }).join('')}</div>
      <div class="form-actions"><button type="button" class="primary" id="au-open-sealed">全部亮牌</button><button type="button" class="ghost danger" id="au-pass">流拍</button><button type="button" class="ghost" id="au-cancel-lot">收回本拍品</button></div>`}
      ${live.opened ? `<div class="table-wrap"><table class="tbl"><thead><tr><th class="num">名次</th><th>队伍</th><th class="num">出价</th><th class="num">签序</th><th>校验</th><th></th></tr></thead><tbody>
        ${rank.map((x, i) => `<tr class="${x.check.ok ? '' : 'au-invalid'}"><td class="num">${i + 1}</td><td>${esc(TN.teamOf(t, x.teamId)?.name || '')}</td><td class="num"><b>${fmt(x.price)}</b></td><td class="num">${x.seat}</td>
          <td>${x.check.ok ? '<span class="win">有效</span>' : `<span class="loss">${esc(x.check.errors[0])}</span>`}</td>
          <td class="num">${x.check.ok ? `<button type="button" class="mini au-go" data-au-award="${x.teamId}" data-price="${x.price}">判给此队</button>` : '<span class="hint">五.6 爆仓，不得成交</span>'}</td></tr>`).join('')
          || '<tr><td colspan="6" class="empty">没有任何队出价</td></tr>'}
      </tbody></table></div>
      <div class="form-actions"><button type="button" class="ghost danger" id="au-pass">全部无效 / 流拍</button><button type="button" class="ghost" id="au-reseal">重开暗拍</button></div>` : ''}
    </div>`;
  } else {
    // 明拍 / 计时 / 底价明拍：一口一口加价，主持人实时校验后落槌
    const min = nextPrice(t);
    const timer = r?.mode === 'timed' && live.endsAt ? `<span class="au-clock" id="au-clock" data-ends="${live.endsAt}">${clockTxt(live.endsAt)}</span>` : '';
    panel = `<div class="au-open">
      <div class="au-cur">${top ? `当前最高 <b>${fmt(top.price)}</b> 万 · <b>${esc(TN.teamOf(t, top.team)?.name || '')}</b>` : `起拍价 <b>${fmt(min)}</b> 万 · 尚无人出价`}${timer}</div>
      <div class="row wrap" style="align-items:flex-end">
        <label class="grow">出价队伍<select id="au-bid-team">${teamOpts()}</select></label>
        <label class="narrow">价格<input type="number" id="au-bid-price" value="${min}" min="0" max="99999" step="${T?.step || 1}"></label>
        <button type="button" class="primary" id="au-bid">出价</button>
        ${r?.mode === 'timed' ? '<button type="button" class="ghost" id="au-reclock">重置计时</button>' : ''}
      </div>
      <div id="au-bid-check" class="hint">一口加价 ${T?.step || 1} 万（规则四.1）；触发保底违约的出价按五.6 直接否决</div>
      ${live.bids.length ? `<div class="au-chain">${live.bids.map(b => `<span class="tag">${esc(TN.teamOf(t, b.team)?.name || '')} ${fmt(b.price)}</span>`).join(' → ')}</div>` : ''}
      <div class="form-actions">
        <button type="button" class="primary big" id="au-hammer" ${top ? '' : 'disabled'}>落槌成交${top ? `：${esc(TN.teamOf(t, top.team)?.name || '')} ${fmt(top.price)} 万` : ''}</button>
        <button type="button" class="ghost danger" id="au-pass">流拍</button>
        <button type="button" class="ghost" id="au-cancel-lot">收回本拍品</button>
      </div>
      <details><summary class="hint">各队出价资格（${eligible.filter(e => e.chk.ok).length}/${t.teams.length} 可出价）</summary>
        <div class="au-elig">${eligible.map(e => `<span class="tag ${e.chk.ok ? '' : 'off'}">${esc(e.tm.name)}${e.chk.ok ? '' : ' — ' + esc(e.chk.errors[0])}</span>`).join(' ')}</div>
      </details>
    </div>`;
  }
  return `<div class="card au-stage"><h3 style="margin:0 0 8px">🔨 正在拍卖</h3>${head}${panel}</div>`;
}

// ============ 弹窗：录入成交 ============
function openBuy(t, presetPid, presetTeam) {
  const P = playerMap(), a = auc(t);
  const open = TN.rosterPlayers(t).filter(p => !dealOf(t, p.id) && gradeOf(t, p.id));
  if (!open.length) return toast('没有可录入的选手（未定级或已全部成交）', 'err');
  if (!t.teams.length) return toast('还没有队伍，先点「生成队伍」', 'err');
  const pidInit = presetPid && open.some(p => p.id === presetPid) ? presetPid : open[0].id;
  showModal(`<h2>录入成交 <span class="hint">按规则五.1-五.6 实时校验，硬约束不过不给入账</span></h2>
    <div class="row wrap" style="margin-top:8px">
      <label class="grow">选手<select id="au-b-pid">${open.map(p => `<option value="${p.id}" ${p.id === pidInit ? 'selected' : ''}>${esc(p.name)}（${esc(gradeOf(t, p.id))} · 底价 ${TIER[gradeOf(t, p.id)]?.base ?? '?'} 万 · ${groupTxt(posGroup(p))}）</option>`).join('')}</select></label>
      <label class="grow">队伍<select id="au-b-team">${t.teams.map(tm => { const st = teamStat(t, tm.id); return `<option value="${tm.id}" ${tm.id === presetTeam ? 'selected' : ''}>${esc(tm.name)}（剩 ${fmt(st.left)} 万 / ${st.slots} 名额）</option>`; }).join('')}</select></label>
      <label class="narrow">成交价(万)<input type="number" id="au-b-price" min="1" max="99999" step="1"></label>
    </div>
    <div id="au-b-check"></div>
    <div class="form-actions" style="margin-top:10px">
      <button type="button" class="primary" id="au-b-ok">确认成交</button>
      <button type="button" class="ghost" id="au-b-cancel">取消</button>
    </div>`);
  const $p = $('#au-b-pid'), $t = $('#au-b-team'), $pr = $('#au-b-price'), $c = $('#au-b-check');
  const syncBase = () => { const T = TIER[gradeOf(t, $p.value)]; if (T) { $pr.min = T.base; $pr.step = T.step; if (!$pr.value || Number($pr.value) < T.base) $pr.value = T.base; } };
  const run = () => {
    const r = checkBid(t, $p.value, $t.value, Number($pr.value));
    $c.innerHTML = `${r.errors.map(x => `<p class="loss" style="margin:4px 0">✗ ${esc(x)}</p>`).join('')}
      ${r.warns.map(x => `<p class="hint" style="margin:4px 0">⚠ ${esc(x)}</p>`).join('')}
      ${r.ok && !r.warns.length ? '<p class="win" style="margin:4px 0">✓ 六条硬约束全部通过</p>' : ''}`;
    $('#au-b-ok').disabled = !r.ok;
    return r;
  };
  syncBase(); run();
  $p.onchange = () => { syncBase(); run(); };
  $t.onchange = run; $pr.oninput = run;
  $('#au-b-cancel').onclick = hideModal;
  $('#au-b-ok').onclick = () => {
    const r = run(); if (!r.ok) return;
    if (r.warns.length && !confirm(`有 ${r.warns.length} 条提示：\n\n${r.warns.join('\n')}\n\n仍然确认成交？`)) return;
    commit(t, $p.value, $t.value, Number($pr.value), 'bid');
    save(); hideModal(); TN.render(); toast(`成交：${pname(playerMap(), $p.value)} → ${TN.teamOf(t, $t.value)?.name} ${fmt(Number($pr.value))} 万`, 'ok');
  };
}

// ============ 弹窗：设置队长（规则三.2）============
function openCaptain(t, tmId) {
  const P = playerMap(), a = auc(t), tm = TN.teamOf(t, tmId); if (!tm) return;
  const st = teamStat(t, tmId);
  const curCap = a.captains[tmId];
  const cands = TN.rosterPlayers(t).filter(p => gradeOf(t, p.id) && (!dealOf(t, p.id) || p.id === curCap));
  showModal(`<h2>设置队长 · ${esc(tm.name)}</h2>
    <p class="hint">规则三.2：队长若本身参赛，按<b>队长身价</b>（底价 × (1+档位溢价率)）直接从 270 万预算扣除并占 1 个名额，该队实际再拍 4 人；队长不参赛则不扣不占。</p>
    <div class="row wrap" style="margin-top:8px">
      <label class="grow">队长<select id="au-c-pid"><option value="">— 队长不参赛（只当经理）—</option>${cands.map(p => { const g = gradeOf(t, p.id); return `<option value="${p.id}" ${p.id === curCap ? 'selected' : ''}>${esc(p.name)}（${esc(g)} · 队长身价 ${TIER[g]?.cap ?? '?'} 万）</option>`; }).join('')}</select></label>
    </div>
    <div id="au-c-check"></div>
    <div class="form-actions" style="margin-top:10px">
      <button type="button" class="primary" id="au-c-ok">确定</button>
      <button type="button" class="ghost" id="au-c-cancel">取消</button>
    </div>`);
  const $p = $('#au-c-pid'), $c = $('#au-c-check');
  const run = () => {
    const pid = $p.value;
    if (!pid) { $c.innerHTML = '<p class="hint" style="margin:4px 0">该队 5 个名额全部用于拍卖。</p>'; $('#au-c-ok').disabled = false; return { ok: true, warns: [] }; }
    const g = gradeOf(t, pid), price = TIER[g]?.cap ?? 0;
    const r = checkBid(t, pid, tmId, price, { self: pid === curCap });
    $c.innerHTML = `<p class="hint" style="margin:4px 0">占用身价 <b>${fmt(price)}</b> 万（${g} 档底价 ${TIER[g]?.base} × 溢价），占 1 个名额，该队再拍 ${SIZE - st.deals.length - (pid === curCap ? 0 : 1)} 人。</p>
      ${r.errors.map(x => `<p class="loss" style="margin:4px 0">✗ ${esc(x)}</p>`).join('')}
      ${r.warns.map(x => `<p class="hint" style="margin:4px 0">⚠ ${esc(x)}</p>`).join('')}`;
    $('#au-c-ok').disabled = !r.ok;
    return r;
  };
  run(); $p.onchange = run;
  $('#au-c-cancel').onclick = hideModal;
  $('#au-c-ok').onclick = () => {
    const pid = $p.value;
    // 先撤掉旧队长那笔
    const old = a.deals.find(d => d.teamId === tmId && d.kind === 'captain');
    if (old) revoke(t, old.id);
    if (pid) { const r = checkBid(t, pid, tmId, TIER[gradeOf(t, pid)]?.cap ?? 0); if (!r.ok) { if (old) { commit(t, old.pid, tmId, old.price, 'captain'); a.captains[tmId] = old.pid; } return toast(r.errors[0], 'err'); }
      a.captains[tmId] = pid; commit(t, pid, tmId, TIER[gradeOf(t, pid)].cap, 'captain'); }
    else delete a.captains[tmId];
    save(); hideModal(); TN.render(); toast(pid ? '队长已设置并扣除身价' : '已设为队长不参赛', 'ok');
  };
}

// ============ 弹窗：导入定级表（规则二）============
function openImport(t) {
  showModal(`<h2>导入定级表 <span class="hint">组委会《定级结果》直接拷进来</span></h2>
    <p class="hint">每行一个选手：<code>昵称, 档位</code>（逗号 / 制表符 / 空格分隔都行）。档位取 ${TIERS.join(' / ')}。<br>
      匹配「选手名单」里的昵称；匹配上的会自动<b>加进本赛事参赛名单</b>，无需再去勾选。</p>
    <textarea id="au-i-text" rows="10" placeholder="张三, SSS&#10;李四, S&#10;王五, A+&#10;赵六, D"></textarea>
    <div class="form-actions" style="margin-top:8px">
      <button type="button" id="au-i-pre">预览</button>
      <button type="button" class="primary" id="au-i-ok" disabled>应用</button>
      <button type="button" class="ghost" id="au-i-cancel">取消</button>
    </div>
    <div id="au-i-out"></div>`);
  let parsed = null;
  const parse = () => {
    const lines = $('#au-i-text').value.split('\n').map(x => x.trim()).filter(Boolean);
    const byName = new Map(); const dup = new Set();
    for (const p of S().players) { if (byName.has(p.name)) dup.add(p.name); else byName.set(p.name, p); }
    const hit = [], miss = [], bad = [], ambiguous = [];
    for (const ln of lines) {
      const parts = ln.split(/[,，\t]+|\s{2,}/).map(x => x.trim()).filter(Boolean);
      const name = parts[0]; let g = (parts[1] || '').toUpperCase().replace('＋', '+').replace('－', '-');
      if (!name) continue;
      if (!TIERS.includes(g)) { bad.push(ln); continue; }
      if (dup.has(name)) { ambiguous.push(name); continue; }
      const p = byName.get(name);
      if (!p) { miss.push(name); continue; }
      hit.push({ pid: p.id, name, g });
    }
    return { hit, miss, bad, ambiguous };
  };
  $('#au-i-pre').onclick = () => {
    parsed = parse();
    const { hit, miss, bad, ambiguous } = parsed;
    const byTier = TIERS.map(g => [g, hit.filter(h => h.g === g).length]).filter(([, n]) => n);
    $('#au-i-out').innerHTML = `<p style="margin-top:10px">匹配 <b class="win">${hit.length}</b> 人：${byTier.map(([g, n]) => `${g}×${n}`).join('、') || '-'}</p>
      ${miss.length ? `<p class="loss">名单里找不到 ${miss.length} 人：${miss.map(esc).join('、')}</p>` : ''}
      ${ambiguous.length ? `<p class="loss">重名无法确定 ${ambiguous.length} 人：${ambiguous.map(esc).join('、')} —— 先去「选手名单」改成不重名</p>` : ''}
      ${bad.length ? `<p class="loss">档位无法识别 ${bad.length} 行：${bad.slice(0, 5).map(esc).join(' / ')}${bad.length > 5 ? ' …' : ''}</p>` : ''}`;
    $('#au-i-ok').disabled = !hit.length;
  };
  $('#au-i-cancel').onclick = hideModal;
  $('#au-i-ok').onclick = () => {
    if (!parsed?.hit.length) return;
    const a = auc(t), roster = TN.rosterOf(t);
    for (const h of parsed.hit) { a.grades[h.pid] = h.g; if (!roster.includes(h.pid)) roster.push(h.pid); }
    save(); hideModal(); TN.render(); toast(`已定级 ${parsed.hit.length} 人，并加入参赛名单`, 'ok');
  };
}

// ============ 事件 ============
const root = () => document.querySelector('#tournament-root');
document.addEventListener('click', e => {
  if (!e.target.closest('#tournament-root')) return;
  const t = TN.cur(); if (!t) return;
  const b = e.target.closest('button'); if (!b) return;
  const id = b.id;
  if (id === 'au-enable') {
    const dirty = t.teams.some(tm => tm.players.some(Boolean));
    if (dirty && !confirm('启用拍卖选马会清空现有队伍阵容（改由成交记录填充）。继续？')) return;
    auc(t); t.teams.forEach(tm => tm.players = [null, null, null, null, null]);
    save(); TN.render(); toast('已启用拍卖选马', 'ok'); return;
  }
  if (!enabled(t)) return;
  if (id === 'au-import') { openImport(t); return; }
  if (id === 'au-buy' || b.dataset.auBuy) { openBuy(t, null, b.dataset.auBuy); return; }
  if (b.dataset.auBuyP) { openBuy(t, b.dataset.auBuyP, null); return; }
  if (b.dataset.auCap) { openCaptain(t, b.dataset.auCap); return; }
  if (b.dataset.auRevoke) {
    const d = auc(t).deals.find(x => x.id === b.dataset.auRevoke); if (!d) return;
    if (!confirm(`撤销「${pname(playerMap(), d.pid)}」${fmt(d.price)} 万的成交？该选手回到未成交状态。`)) return;
    revoke(t, d.id); save(); TN.render(); toast('已撤销'); return;
  }
  // ---- L2 流程 ----
  if (id === 'au-autolots') {
    if (Object.keys(auc(t).lots).length && !confirm('重新自动编排会覆盖现有名单归属（已成交的不受影响）。继续？')) return;
    const n = autoLots(t); save(); TN.render(); toast(`已编排 ${n} 人进 ${auc(t).rounds.length} 轮`, 'ok'); return;
  }
  if (id === 'au-draw') { const o = drawOrder(t); save(); TN.render(); toast(`已抽签，首位：${TN.teamOf(t, o[0])?.name || '-'}`, 'ok'); return; }
  if (id === 'au-preset-rounds') {
    if (!confirm('恢复规则默认的 5 轮 12 批结构？已编排的名单归属会清空。')) return;
    const a = auc(t); a.rounds = ROUND_PRESET.map((r, i) => ({ id: 'r' + (i + 1), ...r, revealed: i === 0 })); a.lots = {}; a.live = null;
    save(); TN.render(); toast('已恢复默认轮次'); return;
  }
  if (b.dataset.auReveal) { const r = roundOf(t, b.dataset.auReveal); if (r) { r.revealed = !r.revealed; save(); TN.render(); toast(r.revealed ? `已揭晓「${r.name}」名单` : '已收起名单'); } return; }
  if (b.dataset.auStart) {
    const rid = b.dataset.auStart, r = roundOf(t, rid), waiting = lotsOf(t, rid);
    if (!waiting.length) return toast('本轮没有待拍选手', 'err');
    if (!r.revealed) { r.revealed = true; }
    if (r.mode === 'sealed' && !auc(t).order.length) toast('还没抽签，暗拍同价将无法判优先', 'err');
    openLot(t, waiting[0]); save(); TN.render(); return;
  }
  if (b.dataset.auLot) { openLot(t, b.dataset.auLot); save(); TN.render(); return; }
  if (id === 'au-cancel-lot') { auc(t).live = null; save(); TN.render(); return; }
  if (id === 'au-bid') {
    const a = auc(t); if (!a.live) return;
    const tmId = document.querySelector('#au-bid-team').value, price = Number(document.querySelector('#au-bid-price').value);
    const r = checkOpenBid(t, tmId, price);
    if (!r.ok) return toast(r.errors[0], 'err');
    if (r.warns.length && !confirm(`${r.warns.join('\n')}\n\n仍然接受这口价？`)) return;
    a.live.bids.push({ team: tmId, price, at: Date.now() });
    const rd = roundOf(t, a.live.rid); if (rd?.mode === 'timed' && rd.secs) a.live.endsAt = Date.now() + rd.secs * 1000;  // 每口价重置倒计时
    save(); TN.render(); return;
  }
  if (id === 'au-reclock') { const a = auc(t), rd = roundOf(t, a.live?.rid); if (a.live && rd?.secs) { a.live.endsAt = Date.now() + rd.secs * 1000; save(); TN.render(); } return; }
  if (id === 'au-hammer') {
    const a = auc(t), top = liveTop(a); if (!top) return;
    const chk = checkBid(t, a.live.pid, top.team, top.price);
    if (!chk.ok) return toast(`落槌被否决：${chk.errors[0]}`, 'err');
    const nm = pname(playerMap(), a.live.pid), tn = TN.teamOf(t, top.team)?.name;
    settleLive(t, top.team, top.price); save(); TN.render(); toast(`落槌：${nm} → ${tn} ${fmt(top.price)} 万`, 'ok'); return;
  }
  if (id === 'au-pass') { const m = passLive(t); save(); TN.render(); toast(m); return; }
  if (id === 'au-open-sealed') {
    const a = auc(t); if (!a.live) return;
    if (!Object.values(a.live.sealed).some(v => v > 0)) return toast('还没有任何队写价', 'err');
    openSealed(t); save(); TN.render(); toast('已亮牌', 'ok'); return;
  }
  if (id === 'au-reseal') { const a = auc(t); if (a.live) { a.live.opened = false; a.live.sealed = {}; save(); TN.render(); } return; }
  if (b.dataset.auAward) {
    const a = auc(t), tmId = b.dataset.auAward, price = Number(b.dataset.price);
    const chk = checkBid(t, a.live.pid, tmId, price);
    if (!chk.ok) return toast(`不得成交：${chk.errors[0]}`, 'err');
    const nm = pname(playerMap(), a.live.pid);
    settleLive(t, tmId, price); save(); TN.render(); toast(`${nm} → ${TN.teamOf(t, tmId)?.name} ${fmt(price)} 万`, 'ok'); return;
  }
  if (b.dataset.auDefault) {
    const d = auc(t).deals.find(x => x.id === b.dataset.auDefault); if (!d) return;
    if (!confirm(`按规则六.3 判该队违约？\n\n· 撤销「${pname(playerMap(), d.pid)}」${fmt(d.price)} 万的成交\n· 罚该队预算 10%\n· 该选手重新上拍\n· 累计两次违约将取消其后续出价权`)) return;
    const r = defaultDeal(t, d.id); save(); TN.render();
    toast(`已判违约，罚 ${fmt(r.fine)} 万${r.count >= 2 ? '；该队已达 2 次，出价权取消' : ''}`, 'err'); return;
  }
  if (id === 'au-mkteams') {
    const n = Number(prompt('要建多少支队伍？（星动次元杯为 14 队）', String(t.teams.length || 14)));
    if (!n || n < 2 || n > 64) return;
    if (n < t.teams.length && !confirm(`当前 ${t.teams.length} 队，缩到 ${n} 队会删掉多出的队伍及其成交记录。继续？`)) return;
    while (t.teams.length < n) t.teams.push({ id: uid(), name: `${t.teams.length + 1} 队`, players: [null, null, null, null, null] });
    if (t.teams.length > n) { const gone = t.teams.slice(n).map(x => x.id); t.teams.length = n; auc(t).deals = auc(t).deals.filter(d => !gone.includes(d.teamId)); }
    save(); TN.render(); toast(`已建 ${n} 支队伍`, 'ok'); return;
  }
  if (id === 'au-reset') {
    if (!confirm('清空全部成交记录和队长设置？定级档位会保留。')) return;
    const a = auc(t); a.deals = []; a.captains = {};
    t.teams.forEach(tm => tm.players = [null, null, null, null, null]);
    save(); TN.render(); toast('已清空成交'); return;
  }
});
document.addEventListener('input', e => {
  if (!e.target.closest('#tournament-root')) return;
  if (e.target.id === 'au-bid-price' || e.target.id === 'au-bid-team') {
    const t = TN.cur(); if (!t || !auc(t).live) return;
    const box = document.querySelector('#au-bid-check'); if (!box) return;
    const r = checkOpenBid(t, document.querySelector('#au-bid-team').value, Number(document.querySelector('#au-bid-price').value));
    box.className = r.ok ? (r.warns.length ? 'hint' : 'win') : 'loss';
    box.textContent = r.errors[0] || r.warns[0] || '✓ 可以接受这口价';
    document.querySelector('#au-bid').disabled = !r.ok;
    return;
  }
  if (e.target.id !== 'au-q') return;
  ui.q = e.target.value;
  const q = ui.q.trim().toLowerCase();
  root().querySelectorAll('.tbl tbody tr').forEach(tr => {
    if (!tr.querySelector('.au-t')) return;
    tr.style.display = q && !tr.innerText.toLowerCase().includes(q) ? 'none' : '';
  });
});
document.addEventListener('change', e => {
  if (!e.target.closest('#tournament-root')) return;
  const t = TN.cur(); if (!t || !enabled(t)) return;
  const el = e.target;
  if (el.id === 'au-budget') { auc(t).budget = Math.max(1, Number(el.value) || DEF.budget); save(); TN.render(); return; }
  if (el.id === 'au-min') { auc(t).minPrice = Math.max(1, Number(el.value) || DEF.minPrice); save(); TN.render(); return; }
  if (el.id === 'au-open') { ui.onlyOpen = el.checked; TN.render(); return; }
  if (el.dataset.auSealed) { const a = auc(t); if (a.live) { const v = Number(el.value) || 0; if (v > 0) a.live.sealed[el.dataset.auSealed] = v; else delete a.live.sealed[el.dataset.auSealed]; save(); } return; }
  const rtr = el.closest('tr[data-round]');
  if (rtr && el.dataset.rf) {
    const r = roundOf(t, rtr.dataset.round), f = el.dataset.rf; if (!r) return;
    if (f === 'name' || f === 'mode') r[f] = el.value.trim() || r[f]; else r[f] = Math.max(0, Number(el.value) || 0);
    save(); TN.render(); return;
  }
});

// 计时轮倒计时：只更新这一个元素，不整页 render
setInterval(() => {
  const el = document.querySelector('#au-clock'); if (!el) return;
  const left = Number(el.dataset.ends) - Date.now();
  const sec = Math.max(0, Math.ceil(left / 1000));
  el.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  el.classList.toggle('out', left <= 0);
  el.classList.toggle('warn', left > 0 && left <= 10000);
}, 250);

window.DotaAuction = { view, TIER, TIERS, checkBid, teamStat, posGroup, autoLots, drawOrder, openLot, checkOpenBid, sealedRank, passLive, defaultDeal, lotsOf };
})();
