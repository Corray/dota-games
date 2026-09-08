/* 正式比赛（赛事）模块 —— 固定 5 人队 + 公共替补池；阶段化赛制：瑞士轮 / 单循环积分 / 单败 / 双败；每场系列赛 BO1/3/5/7
   依赖 app.js 末尾暴露的 window.DotaApp，数据存在 state.tournaments，随 app.js 的 save() 一起写入 localStorage */
(() => {
'use strict';
const A = window.DotaApp;
if (!A) { console.error('tournament.js 必须在 app.js 之后加载'); return; }
const { $, $$, esc, uid, today, toast, showModal, hideModal, playerMap, pname, rankBadge, rankIdx, save, switchTab } = A;
const S = () => A.state;
const T = () => (S().tournaments || (S().tournaments = []));

const STAGE_TYPES = { swiss: '瑞士轮', rr: '单循环积分', groups: '分组循环', se: '单败淘汰', de: '双败淘汰' };
const GROUP_TYPES = ['swiss', 'rr', 'groups'];          // 小组类阶段：有积分榜、允许加赛
const TB_ROUND = 1000;                                  // 加赛所在的特殊轮次编号
const GN = i => String.fromCharCode(65 + i);            // 组名 A/B/C…
const regRounds = st => st.rounds.filter(r => !r.extra);
const BO_OPTS = [1, 3, 5, 7];
const tui = { view: 'list', tid: null, sub: 'teams', stageIdx: 0, pending: null };

// ============ 基础访问 ============
const cur = () => T().find(t => t.id === tui.tid) || null;
const teamOf = (t, id) => t.teams.find(x => x.id === id) || null;
const tname = (t, id) => id ? (teamOf(t, id)?.name || '(已删队)') : '—';
const stageOf = (t, sid) => t.stages.find(s => s.id === sid);
const seriesOf = (st, id) => st.series.find(s => s.id === id);
const needWins = s => Math.ceil(s.bo / 2);
const wins = s => s.games.reduce((o, g) => (o[g.w]++, o), { a: 0, b: 0 });
const pairKey = (x, y) => [x, y].sort().join('|');
const avgRank = (team, P) => { const v = team.players.filter(Boolean).map(pid => P.get(pid)).filter(Boolean); return v.length ? v.reduce((s, p) => s + rankIdx(p), 0) / v.length : 0; };
const rankText = v => { const R = A.RANKS; const i = Math.floor(v / 10); return R[i] ? R[i] + (v % 10 ? ' ' + Math.round(v % 10) : '') : '-'; };

/* 系列赛槽位解析：对阵双方可能来自上游系列赛（胜者 / 败者）。void = 这个位置永远不会有人（轮空）
   返回 { a, b, voidA, voidB, done, winner, loser, wa, wb } */
function resolve(st, s) {
  const slot = side => {
    if (s[side]) return { team: s[side], v: false };
    const f = s.from?.[side];
    if (!f) return { team: null, v: true };                       // 无来源又无队伍 → 轮空位
    const src = seriesOf(st, f.sid); if (!src) return { team: null, v: true };
    const r = resolve(st, src);
    if (!r.done) return { team: null, v: false };
    const team = f.take === 'w' ? r.winner : r.loser;
    return { team, v: !team };                                    // 上游打完却没人（上游轮空）→ 本位也轮空
  };
  const ra = slot('a'), rb = slot('b');
  const { a: wa, b: wb } = wins(s);
  let done = false, winner = null, loser = null;
  if (ra.v && rb.v) { done = true; }
  else if (ra.v && rb.team) { done = true; winner = rb.team; }
  else if (rb.v && ra.team) { done = true; winner = ra.team; }
  else if (ra.team && rb.team) {
    const n = needWins(s);
    if (wa >= n) { done = true; winner = ra.team; loser = rb.team; }
    else if (wb >= n) { done = true; winner = rb.team; loser = ra.team; }
  }
  return { a: ra.team, b: rb.team, voidA: ra.v, voidB: rb.v, done, winner, loser, wa, wb, bye: done && (ra.v || rb.v) };
}
const stageDone = st => st.status === 'running' && st.series.length > 0 && st.series.every(s => resolve(st, s).done) && (st.type !== 'swiss' || regRounds(st).length >= st.roundCount);
// 本阶段晋级队数 / 每组晋级数
const perGroupAdv = (st, size) => Math.max(0, Math.min(size, st.advMode === 'cut' ? size - (st.advN || 1) : (st.advN || 2)));
function advanceCount(st, teamCount) {
  if (st.type !== 'groups') return st.advance || 8;
  const n = teamCount ?? st.teamIds.length, g = Math.max(1, st.groupCount || 2);
  let total = 0; for (let i = 0; i < g; i++) total += perGroupAdv(st, Math.floor(n / g) + (i < n % g ? 1 : 0));
  return total;
}
// 下游是否已有记录（用于锁定改分）
function downstreamHasGames(st, sid) {
  return st.series.some(x => (x.from?.a?.sid === sid || x.from?.b?.sid === sid) && (x.games.length || downstreamHasGames(st, x.id)));
}

// ============ 积分榜（瑞士轮 / 单循环） ============
function standings(st, t, groupIdx = null) {
  const ids = groupIdx == null ? st.teamIds : (st.groups?.[groupIdx] || []);
  const rows = new Map(ids.map((id, i) => [id, { id, seed: st.teamIds.indexOf(id), w: 0, l: 0, gw: 0, gl: 0, opps: [], byes: 0, tb: 0 }]));
  const tb = new Map(), h2h = new Map();   // 加赛结果 / 常规交手结果，都只用来决并列
  for (const s of st.series) {
    const r = resolve(st, s);
    if (r.bye && r.winner && rows.has(r.winner)) { const x = rows.get(r.winner); x.w++; x.byes++; continue; }
    if (!r.a || !r.b) continue;
    const A_ = rows.get(r.a), B_ = rows.get(r.b); if (!A_ || !B_) continue;
    if (s.tb) { if (r.done) { tb.set(pairKey(r.a, r.b), r.winner); rows.get(r.winner).tb++; } continue; }
    A_.gw += r.wa; A_.gl += r.wb; B_.gw += r.wb; B_.gl += r.wa;
    if (r.done) { A_.opps.push(r.b); B_.opps.push(r.a); h2h.set(pairKey(r.a, r.b), r.winner); if (r.winner === r.a) { A_.w++; B_.l++; } else { B_.w++; A_.l++; } }
  }
  for (const x of rows.values()) x.buch = x.opps.reduce((s, o) => s + (rows.get(o)?.w || 0), 0);
  const byKey = (m, x, y) => { const w = m.get(pairKey(x.id, y.id)); return w ? (w === x.id ? -1 : 1) : 0; };
  return [...rows.values()].sort((x, y) =>
    y.w - x.w ||
    byKey(tb, x, y) ||                                     // 同分先看加赛
    x.l - y.l ||
    (st.type === 'swiss' ? y.buch - x.buch : byKey(h2h, x, y)) ||   // 瑞士轮看对手分；循环赛看常规交手
    (y.gw - y.gl) - (x.gw - x.gl) || x.seed - y.seed);
}

// ============ 赛程生成 ============
const roundLabel = (count, isLast) => isLast ? '决赛' : count === 2 ? '半决赛' : count === 4 ? '四分之一决赛（八强）' : count === 8 ? '八分之一决赛（十六强）' : `第 ${count} 组对决`;
function seedOrder(size) { let a = [1]; while (a.length < size) { const m = a.length * 2 + 1; const b = []; for (const x of a) b.push(x, m - x); a = b; } return a; }
const mkSeries = (st, round, extra = {}) => ({ id: uid(), round, a: null, b: null, bo: st.bo, games: [], from: null, ...extra });

function genRoundRobin(st, teamIds = st.teamIds, group = null) {
  const ids = [...teamIds]; if (ids.length % 2) ids.push(null);
  const n = ids.length, half = n / 2, arr = ids.slice(1);
  for (let r = 0; r < n - 1; r++) {
    if (!st.rounds.some(x => x.idx === r)) st.rounds.push({ idx: r, label: `第 ${r + 1} 轮`, date: '' });
    const cur_ = [ids[0], ...arr];
    for (let i = 0; i < half; i++) {
      const x = cur_[i], y = cur_[n - 1 - i];
      if (!x || !y) continue;                       // 奇数队：轮到 null 的队本轮休息，不算胜场
      st.series.push(mkSeries(st, r, { a: x, b: y, group }));
    }
    arr.unshift(arr.pop());
  }
}
// 分组循环：按种子蛇形分到各组（1→A 2→B 3→B 4→A …），每组各打单循环
function genGroups(st) {
  const g = Math.max(2, st.groupCount || 2);
  st.groups = Array.from({ length: g }, () => []);
  st.teamIds.forEach((id, i) => { const round = Math.floor(i / g), pos = i % g; st.groups[round % 2 ? g - 1 - pos : pos].push(id); });
  st.groups.forEach((ids, gi) => genRoundRobin(st, ids, gi));
}
function genSwissRound(st, t) {
  const r = regRounds(st).length;
  const played = new Set(), byeHad = new Set();
  for (const s of st.series) { const x = resolve(st, s); if (x.a && x.b) played.add(pairKey(x.a, x.b)); if (x.bye && x.winner) byeHad.add(x.winner); }
  let pool = r === 0 ? [...st.teamIds] : standings(st, t).map(x => x.id);
  let bye = null;
  if (pool.length % 2) { for (let i = pool.length - 1; i >= 0; i--) if (!byeHad.has(pool[i])) { bye = pool.splice(i, 1)[0]; break; } if (!bye) bye = pool.pop(); }
  const pairs = [];
  if (r === 0) { const half = pool.length / 2; for (let i = 0; i < half; i++) pairs.push([pool[i], pool[i + half]]); } // 首轮：上半区 vs 下半区
  else while (pool.length) { const x = pool.shift(); let j = pool.findIndex(y => !played.has(pairKey(x, y))); if (j < 0) j = 0; pairs.push([x, pool.splice(j, 1)[0]]); }
  st.rounds.push({ idx: r, label: `第 ${r + 1} 轮`, date: '' });
  pairs.forEach(([x, y]) => st.series.push(mkSeries(st, r, { a: x, b: y })));
  if (bye) st.series.push(mkSeries(st, r, { a: bye, b: null }));
}
function genSingleElim(st) {
  const n = st.teamIds.length; let size = 1; while (size < n) size *= 2;
  const k = Math.log2(size);
  const slots = seedOrder(size).map(seed => st.teamIds[seed - 1] || null);
  let prev = [];
  for (let r = 0; r < k; r++) {
    const count = size >> (r + 1);
    const last = r === k - 1;
    st.rounds.push({ idx: r, label: roundLabel(count, last), date: '' });
    const list = [];
    for (let i = 0; i < count; i++) {
      const s = mkSeries(st, r, { bo: last && st.finalBo ? st.finalBo : st.bo, bracket: 'wb' });
      if (r === 0) { s.a = slots[2 * i]; s.b = slots[2 * i + 1]; }
      else s.from = { a: { sid: prev[2 * i].id, take: 'w' }, b: { sid: prev[2 * i + 1].id, take: 'w' } };
      list.push(s); st.series.push(s);
    }
    if (last && st.thirdPlace && k >= 2) {
      const semis = prev;
      st.series.push(mkSeries(st, r, { bracket: 'tp', label: '三四名决赛', from: { a: { sid: semis[0].id, take: 'l' }, b: { sid: semis[1].id, take: 'l' } } }));
    }
    prev = list;
  }
}
function genDoubleElim(st) {
  const n = st.teamIds.length; let size = 1; while (size < n) size *= 2;
  const k = Math.log2(size);
  const slots = seedOrder(size).map(seed => st.teamIds[seed - 1] || null);
  const wb = [];
  for (let r = 0; r < k; r++) {
    const count = size >> (r + 1); const list = [];
    for (let i = 0; i < count; i++) {
      const s = mkSeries(st, r, { bracket: 'wb' });
      if (r === 0) { s.a = slots[2 * i]; s.b = slots[2 * i + 1]; }
      else s.from = { a: { sid: wb[r - 1][2 * i].id, take: 'w' }, b: { sid: wb[r - 1][2 * i + 1].id, take: 'w' } };
      list.push(s); st.series.push(s);
    }
    wb.push(list);
    st.rounds.push({ idx: r, label: r === k - 1 ? '胜者组决赛' : `胜者组第 ${r + 1} 轮`, date: '', bracket: 'wb' });
  }
  const lb = []; let ri = k;
  if (k >= 2) {
    // 败者组第 1 轮：胜者组首轮败者互相打
    let list = [];
    for (let i = 0; i < size / 4; i++) list.push(mkSeries(st, ri, { bracket: 'lb', from: { a: { sid: wb[0][2 * i].id, take: 'l' }, b: { sid: wb[0][2 * i + 1].id, take: 'l' } } }));
    list.forEach(s => st.series.push(s)); lb.push(list); st.rounds.push({ idx: ri++, label: '败者组第 1 轮', date: '', bracket: 'lb' });
    for (let j = 1; j < k; j++) {
      // 掉落轮：上轮败者组胜者 vs 胜者组第 j+1 轮败者（倒序，减少立刻重赛）
      const drop = wb[j]; const prevL = lb[lb.length - 1]; const count = drop.length;
      list = [];
      for (let i = 0; i < count; i++) list.push(mkSeries(st, ri, { bracket: 'lb', from: { a: { sid: prevL[i].id, take: 'w' }, b: { sid: drop[count - 1 - i].id, take: 'l' } } }));
      list.forEach(s => st.series.push(s)); lb.push(list); st.rounds.push({ idx: ri++, label: j === k - 1 ? '败者组决赛' : `败者组第 ${lb.length} 轮`, date: '', bracket: 'lb' });
      if (j < k - 1) {
        const p2 = list; list = [];
        for (let i = 0; i < p2.length / 2; i++) list.push(mkSeries(st, ri, { bracket: 'lb', from: { a: { sid: p2[2 * i].id, take: 'w' }, b: { sid: p2[2 * i + 1].id, take: 'w' } } }));
        list.forEach(s => st.series.push(s)); lb.push(list); st.rounds.push({ idx: ri++, label: `败者组第 ${lb.length} 轮`, date: '', bracket: 'lb' });
      }
    }
  }
  const wbFinal = wb[k - 1][0];
  const lbFinal = k >= 2 ? lb[lb.length - 1][0] : null;
  st.series.push(mkSeries(st, ri, { bracket: 'gf', label: '总决赛', bo: st.finalBo || st.bo, from: { a: { sid: wbFinal.id, take: 'w' }, b: lbFinal ? { sid: lbFinal.id, take: 'w' } : { sid: wbFinal.id, take: 'l' } } }));
  st.rounds.push({ idx: ri, label: '总决赛', date: '', bracket: 'gf' });
}

function startStage(t, idx, teamIds) {
  const st = t.stages[idx];
  st.teamIds = teamIds; st.series = []; st.rounds = []; st.status = 'running';
  if (st.type === 'rr') genRoundRobin(st);
  else if (st.type === 'groups') genGroups(st);
  else if (st.type === 'swiss') genSwissRound(st, t);
  else if (st.type === 'se') genSingleElim(st);
  else if (st.type === 'de') genDoubleElim(st);
  t.currentStage = idx; tui.stageIdx = idx;
}

// 阶段最终名次（用于晋级 / 榜单）
function placements(st, t) {
  if (st.type === 'swiss' || st.type === 'rr') return standings(st, t).map(x => x.id);
  if (st.type === 'groups') {
    const tables = (st.groups || []).map((_, gi) => standings(st, t, gi).map(x => x.id));
    const out = []; const maxLen = Math.max(0, ...tables.map(x => x.length));
    for (let r = 0; r < maxLen; r++) for (const tb of tables) if (tb[r]) out.push(tb[r]);
    return out;
  }
  const res = resolve.bind(null, st);
  const out = [], seen = new Set(); const push = id => { if (id && !seen.has(id)) { seen.add(id); out.push(id); } };
  const gf = st.series.find(s => s.bracket === 'gf'), fin = st.series.filter(s => s.bracket === 'wb').sort((x, y) => y.round - x.round)[0];
  const top = gf || fin; if (top) { const r = res(top); push(r.winner); push(r.loser); }
  const tp = st.series.find(s => s.bracket === 'tp'); if (tp) { const r = res(tp); push(r.winner); push(r.loser); }
  // 其余按被淘汰的轮次倒序（双败按败者组轮次）
  const elim = [];
  for (const s of st.series) { const r = res(s); if (r.done && r.loser && !seen.has(r.loser)) { if (st.type === 'de' && s.bracket === 'wb') continue; elim.push([s.round, r.loser]); } }
  elim.sort((x, y) => y[0] - x[0]).forEach(([, id]) => push(id));
  st.teamIds.forEach(push);
  return out;
}

// 本阶段晋级名单（分组按每组名额取，再按名次交错）
function advancing(st, t) {
  if (st.type !== 'groups') return placements(st, t).slice(0, advanceCount(st));
  const tables = (st.groups || []).map((g, gi) => standings(st, t, gi).map(x => x.id).slice(0, perGroupAdv(st, g.length)));
  const out = []; const maxLen = Math.max(0, ...tables.map(x => x.length));
  for (let r = 0; r < maxLen; r++) for (const tb of tables) if (tb[r]) out.push(tb[r]);
  return out;
}

// ============ 队伍分配 ============
/* 综合实力分：段位 + 胜率 + KDA 按权重加权（各项归一到 0-1）。场次不足的选手，胜率 / KDA 取中性值 0.5 */
function strengthScores(pids, opt) {
  const P = playerMap();
  const stats = A.computeStats(S().matches).players;
  const wsum = (opt.wRank + opt.wWin + opt.wKda) || 1;
  return new Map(pids.map(pid => {
    const p = P.get(pid), st = stats[pid];
    const rank = p ? Math.min(rankIdx(p), 75) / 75 : 0.5;
    const enough = st && st.g >= opt.minGames;
    const win = enough ? st.w / st.g : 0.5;
    const kdaRaw = st && st.kdaG ? (st.k + st.a) / Math.max(st.d, 1) : null;
    const kda = enough && kdaRaw != null ? Math.min(kdaRaw / 6, 1) : 0.5;
    const score = (opt.wRank * rank + opt.wWin * win + opt.wKda * kda) / wsum;
    return [pid, { score, rank, win, kda, kdaRaw, g: st?.g || 0, positions: p?.positions || [] }];
  }));
}
/* 随机均衡分组：多次「加随机扰动后蛇形分配」，取各队总分最均衡（可选：位置覆盖最好）的一组 */
function balancedRandomGroups(pids, k, opt) {
  const sc = strengthScores(pids, opt);
  let best = null;
  const trials = 600;
  for (let n = 0; n < trials; n++) {
    const jitter = 0.18;
    const order = [...pids].sort((x, y) => (sc.get(y).score + (Math.random() - 0.5) * jitter) - (sc.get(x).score + (Math.random() - 0.5) * jitter));
    const teams = Array.from({ length: k }, () => []);
    // 蛇形，同时按扰动后顺序，天然带随机；超出 5 人 × 队数的（排序靠后的）进替补
    const extra = order.slice(k * 5);
    order.slice(0, k * 5).forEach((pid, i) => { const round = Math.floor(i / k), pos = i % k; teams[round % 2 ? k - 1 - pos : pos].push(pid); });
    const totals = teams.map(tm => tm.reduce((s, pid) => s + sc.get(pid).score, 0) / (tm.length || 1));
    const mean = totals.reduce((a, b) => a + b, 0) / k;
    let cost = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / k);
    if (opt.positions) {
      // 每队覆盖不到的号位数 → 惩罚；用贪心给每人分配一个偏好位
      for (const tm of teams) {
        const used = new Set();
        const sorted = [...tm].sort((x, y) => sc.get(x).positions.length - sc.get(y).positions.length);
        for (const pid of sorted) { const want = sc.get(pid).positions.find(p => !used.has(p)); if (want) used.add(want); }
        cost += (Math.min(tm.length, 5) - used.size) * 0.02;
      }
    }
    // 少量随机偏好，避免每次都收敛到同一组
    cost += Math.random() * 0.002;
    if (!best || cost < best.cost) best = { teams, totals, cost, extra };
  }
  best.scores = sc;
  return best;
}
function openBalanceModal(t) {
  const assigned = [...assignedPids(t)];
  const subSet = new Set(t.subs || []);
  const free = S().players.filter(p => !assigned.includes(p.id) && !subSet.has(p.id)).map(p => p.id);
  const readOpt = () => ({
    wRank: Number($('#bl-w-rank').value) || 0, wWin: Number($('#bl-w-win').value) || 0, wKda: Number($('#bl-w-kda').value) || 0,
    minGames: Number($('#bl-min').value) || 1, positions: $('#bl-pos').checked, includeFree: $('#bl-free').checked, k: Math.max(2, Number($('#bl-k').value) || 2),
  });
  let result = null;
  const P = playerMap();
  const preview = () => {
    const o = readOpt();
    const pids = o.includeFree ? [...assigned, ...free] : assigned;
    const box = $('#bl-preview');
    if (pids.length < o.k * 2) { box.innerHTML = `<p class="loss">参与 ${pids.length} 人，不够分 ${o.k} 队。</p>`; result = null; return; }
    result = balancedRandomGroups(pids, o.k, o);
    const sc = result.scores;
    box.innerHTML = `<div class="tn-teams">${result.teams.map((tm, i) => `<div class="tn-team"><div class="tn-team-head"><span class="tn-seed">#${i + 1}</span><strong>${esc(t.teams[i]?.name || `${i + 1} 队`)}</strong><span class="hint" title="综合实力（0-1）">实力 ${result.totals[i].toFixed(3)}</span></div>
      ${tm.map(pid => { const p = P.get(pid), x = sc.get(pid); return `<div class="tn-member"><span>${esc(p?.name ?? '(已删除)')} ${p ? rankBadge(p) : ''}</span><span class="hint" title="胜率 / KDA / 场次">${x.g ? `胜率 ${Math.round(x.win * 100)}%${x.kdaRaw != null ? ` · KDA ${x.kdaRaw.toFixed(1)}` : ''} · ${x.g} 场` : '无战绩'} · ${(p?.positions || []).join('/') || '-'}</span></div>`; }).join('')}
      ${tm.length < 5 ? `<div class="tn-member hint">空位 ×${5 - tm.length}</div>` : ''}</div>`).join('')}</div>
      ${result.extra.length ? `<p class="hint" style="margin-top:8px">多出 ${result.extra.length} 人进入替补池：${result.extra.map(pid => esc(P.get(pid)?.name ?? '')).join('、')}</p>` : ''}
      <p class="hint" style="margin-top:6px">各队实力差（标准差）${(Math.sqrt(result.totals.reduce((a, b, _, arr) => a + (b - arr.reduce((x, y) => x + y, 0) / arr.length) ** 2, 0) / result.totals.length)).toFixed(4)}，越小越均衡。</p>`;
  };
  showModal(`<h2>随机均衡分组 <span class="hint">按综合实力随机分配，多次尝试取最均衡的一组</span></h2>
    <div class="row wrap" style="margin-top:8px">
      <label class="narrow">队伍数<input type="number" id="bl-k" min="2" max="32" value="${Math.max(2, t.teams.length || Math.floor((assigned.length + free.length) / 5) || 2)}"></label>
      <label class="narrow">段位权重<input type="number" id="bl-w-rank" min="0" max="100" value="50"></label>
      <label class="narrow">胜率权重<input type="number" id="bl-w-win" min="0" max="100" value="30"></label>
      <label class="narrow">KDA 权重<input type="number" id="bl-w-kda" min="0" max="100" value="20"></label>
      <label class="narrow" title="场次少于此数的选手，胜率 / KDA 按中性值算">最少场次<input type="number" id="bl-min" min="1" max="50" value="3"></label>
    </div>
    <div class="inline-actions wrap" style="margin-bottom:8px">
      <label class="inline hint"><input type="checkbox" id="bl-free" ${assigned.length < 10 ? 'checked' : ''}> 把未分队选手（${free.length} 人，不含替补池）也加入分组</label>
      <label class="inline hint"><input type="checkbox" id="bl-pos" checked> 尽量凑齐 1-5 号位</label>
      <span class="hint">当前已入队 ${assigned.length} 人</span>
    </div>
    <div id="bl-preview"></div>
    <div class="form-actions" style="margin-top:10px">
      <button type="button" id="bl-again">🎲 换一组</button>
      <button type="button" class="primary" id="bl-apply">应用到队伍</button>
      <button type="button" class="ghost" id="bl-cancel">取消</button>
    </div>`);
  preview();
  $('#bl-again').onclick = preview;
  $$('#modal-content input').forEach(el => el.onchange = preview);
  $('#bl-cancel').onclick = hideModal;
  $('#bl-apply').onclick = () => {
    if (!result) return;
    const k = result.teams.length;
    while (t.teams.length < k) t.teams.push({ id: uid(), name: `${t.teams.length + 1} 队`, players: [null, null, null, null, null] });
    if (t.teams.length > k && !confirm(`当前有 ${t.teams.length} 队，分组只有 ${k} 队，多出的队伍将被删除。继续？`)) return;
    t.teams.length = k;
    const overflow = result.extra || [];
    result.teams.forEach((tm, i) => { t.teams[i].players = [...tm, null, null, null, null, null].slice(0, 5); });
    if (overflow.length) t.subs = [...new Set([...(t.subs || []), ...overflow])];
    save(); hideModal(); render();
    toast(`已分成 ${k} 队${overflow.length ? `，${overflow.length} 人进入替补池` : ''}`, 'ok');
  };
}
const assignedPids = t => new Set(t.teams.flatMap(x => x.players).filter(Boolean));

// ============ 渲染入口 ============
const root = () => $('#tournament-root');
function render() {
  const t = cur();
  if (tui.view !== 'list' && !t) tui.view = 'list';
  root().innerHTML = tui.view === 'list' ? viewList() : viewDetail(t);
}
A.hooks.renderTab.tournament = render;

function viewList() {
  const list = [...T()].sort((x, y) => y.createdAt - x.createdAt);
  const statusTxt = { setup: '筹备中', running: '进行中', done: '已结束' };
  return `<div class="card">
    <div class="card-head"><h2>正式比赛 <span class="count">${list.length}</span></h2>
      <form id="tn-create" class="inline-actions"><input type="text" id="tn-name" placeholder="赛事名称，如「夏季杯」" maxlength="40" required style="min-width:220px"><input type="date" id="tn-date" value="${today()}"><button class="primary">新建赛事</button></form></div>
    ${list.length ? `<div class="tn-list">${list.map(t => `<div class="tn-card" data-open="${t.id}">
        <div class="tn-card-head"><strong>${esc(t.name)}</strong><span class="chip-s ${t.status}">${statusTxt[t.status]}</span></div>
        <div class="hint">${t.date || ''} · ${t.teams.length} 队 · ${t.stages.map(s => `${esc(s.name)}(${STAGE_TYPES[s.type]} BO${s.bo})`).join(' → ') || '未配置赛制'}</div>
        ${t.status === 'done' ? `<div class="tn-champ">🏆 冠军：${esc(tname(t, placements(t.stages[t.stages.length - 1], t)[0]))}</div>` : t.status === 'running' ? `<div class="hint">当前阶段：${esc(t.stages[t.currentStage]?.name || '')}</div>` : ''}
      </div>`).join('')}</div>` : '<p class="empty">还没有赛事。新建一个，然后分队、配置赛制、开始比赛。</p>'}
  </div>
  <details class="card"><summary>怎么用</summary>
    <ol class="hint" style="line-height:1.9;margin:0;padding-left:18px">
      <li><b>分队</b>：每队固定 5 人，从选手名单里选；可「随机均衡分组」按段位 / 胜率 / KDA 综合实力随机分配并尽量凑齐号位，点「换一组」直到满意。没进队的选手可放进<b>公共替补池</b>，任何队临时缺人都能用。</li>
      <li><b>赛制</b>：由多个阶段串起来，每阶段独立选 瑞士轮 / 单循环积分 / 分组循环 / 单败 / 双败，独立设 BO；小组类阶段同分可「添加加赛」；决赛可单独设 BO。默认模板：瑞士轮小组赛 → 八强 / 半决赛 / 决赛。</li>
      <li><b>记分</b>：点开一场系列赛，直接给某队 +1，或「录入本局」跳去记录比赛页（自动预填两队阵容，保存后回填比分），也可以关联已有记录。</li>
      <li>瑞士轮每轮打完后点「生成下一轮」；阶段全部打完后点「进入下一阶段」，按名次自动晋级并排种子。</li>
    </ol></details>`;
}

function viewDetail(t) {
  const subs = [['teams', '队伍与替补'], ['format', '赛制'], ...t.stages.map((s, i) => ['stage' + i, s.name]), ['board', '榜单']];
  if (t.status === 'setup') subs.splice(2, t.stages.length);
  const active = subs.some(([k]) => k === tui.sub) ? tui.sub : 'teams';
  tui.sub = active;
  const statusTxt = { setup: '筹备中', running: '进行中', done: '已结束' };
  let body = '';
  if (active === 'teams') body = viewTeams(t);
  else if (active === 'format') body = viewFormat(t);
  else if (active === 'board') body = viewBoard(t);
  else body = viewStage(t, Number(active.slice(5)));
  return `<div class="card">
    <div class="card-head">
      <div class="inline-actions"><button type="button" class="ghost" id="tn-back">← 赛事列表</button><h2 style="margin:0">${esc(t.name)} <span class="chip-s ${t.status}">${statusTxt[t.status]}</span></h2><span class="hint">${esc(t.date || '')}</span></div>
      <div class="inline-actions">
        ${t.status === 'setup' ? '<button type="button" class="primary" id="tn-start">开始赛事</button>' : ''}
        <button type="button" class="ghost" id="tn-rename">重命名</button>
        <button type="button" class="ghost danger" id="tn-delete">删除赛事</button>
      </div>
    </div>
    <nav class="tn-subnav">${subs.map(([k, l], i) => `<button type="button" class="${k === active ? 'on' : ''} ${k.startsWith('stage') && t.stages[Number(k.slice(5))]?.status === 'done' ? 'done' : ''}" data-sub="${k}">${esc(l)}</button>`).join('')}</nav>
    ${body}
  </div>`;
}

// ---- 队伍与替补 ----
function viewTeams(t) {
  const P = playerMap();
  const editable = t.status === 'setup';
  const assigned = assignedPids(t);
  const subSet = new Set(t.subs || []);
  const free = S().players.filter(p => !assigned.has(p.id)).sort((x, y) => rankIdx(y) - rankIdx(x) || x.name.localeCompare(y.name, 'zh'));
  const opt = (cur_, pid) => `<option value="${pid}" ${cur_ === pid ? 'selected' : ''}>${esc(P.get(pid)?.name ?? '(已删除)')}（${esc(P.get(pid)?.rank || '')}${P.get(pid)?.stars || ''}）</option>`;
  const teams = t.teams.map((tm, ti) => `<div class="tn-team">
    <div class="tn-team-head">
      <span class="tn-seed">#${ti + 1}</span>
      ${editable ? `<input type="text" data-team="${tm.id}" data-f="name" value="${esc(tm.name)}" maxlength="20">` : `<strong>${esc(tm.name)}</strong>`}
      <span class="hint" title="平均段位">${rankText(avgRank(tm, P))}</span>
      ${editable ? `<span class="tn-team-ops"><button type="button" class="mini" data-team="${tm.id}" data-act="up" title="种子上移">↑</button><button type="button" class="mini" data-team="${tm.id}" data-act="down" title="种子下移">↓</button><button type="button" class="mini danger" data-team="${tm.id}" data-act="del">删</button></span>` : ''}
    </div>
    ${tm.players.map((pid, i) => editable
      ? `<select data-team="${tm.id}" data-slot="${i}"><option value="">— 空位 ${i + 1} —</option>${pid && !P.has(pid) ? `<option value="${pid}" selected>(已删除)</option>` : ''}${[...(pid && P.has(pid) ? [pid] : []), ...free.map(p => p.id).filter(id => !subSet.has(id))].map(id => opt(pid, id)).join('')}</select>`
      : `<div class="tn-member">${pid ? `${esc(pname(P, pid))} ${P.get(pid) ? rankBadge(P.get(pid)) : ''}` : '<span class="hint">空位</span>'}</div>`).join('')}
  </div>`).join('');
  const subChips = editable || t.status !== 'done'
    ? `<div class="pool">${free.length ? free.map(p => `<div class="chip ${subSet.has(p.id) ? 'in-radiant' : ''}" data-sub="${p.id}"><span>${esc(p.name)}</span>${rankBadge(p)}</div>`).join('') : '<p class="empty" style="width:100%">没有未分队的选手</p>'}</div>`
    : `<div class="pool">${[...subSet].map(pid => `<div class="chip">${esc(pname(P, pid))}</div>`).join('') || '<span class="hint">无</span>'}</div>`;
  return `<div class="tn-toolbar">
      ${editable ? `<button type="button" id="tn-add-team">＋ 添加队伍</button>
      <button type="button" class="primary" id="tn-balance" title="按段位 / 胜率 / KDA 综合实力随机分组，各队实力尽量均衡，并尽量凑齐 1-5 号位">随机均衡分组</button>
      <button type="button" id="tn-fill" title="用未分队且不在替补池的选手，按段位蛇形填满空位">填满空位</button>
      <span class="hint">共 ${t.teams.length} 队 · 已分配 ${assigned.size} 人 · 未分配 ${free.length} 人</span>` : `<span class="hint">赛事已开始，阵容锁定；替补池仍可调整。</span>`}
    </div>
    <div class="tn-teams">${teams || '<p class="empty" style="grid-column:1/-1">还没有队伍，点「添加队伍」。</p>'}</div>
    <h3 style="margin-top:16px">公共替补池 <span class="hint">点选手加入 / 移出；任何队临时缺人都可从这里补，录入比赛时把替补换进阵容即可</span></h3>
    ${subChips}`;
}

// ---- 赛制 ----
function viewFormat(t) {
  const editable = t.status === 'setup';
  const rows = t.stages.map((s, i) => {
    const locked = !editable && s.status !== 'pending';
    const dis = locked ? 'disabled' : '';
    return `<tr data-stage="${s.id}">
      <td>${i + 1}</td>
      <td><input type="text" data-f="name" value="${esc(s.name)}" maxlength="20" ${dis} style="min-width:120px"></td>
      <td><select data-f="type" ${dis}>${Object.entries(STAGE_TYPES).map(([k, v]) => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td><select data-f="bo" ${dis}>${BO_OPTS.map(b => `<option value="${b}" ${s.bo === b ? 'selected' : ''}>BO${b}</option>`).join('')}</select></td>
      <td>${s.type === 'se' || s.type === 'de' ? `<select data-f="finalBo" ${dis}><option value="0" ${!s.finalBo ? 'selected' : ''}>同上</option>${BO_OPTS.map(b => `<option value="${b}" ${s.finalBo === b ? 'selected' : ''}>BO${b}</option>`).join('')}</select>` : '<span class="hint">—</span>'}</td>
      <td>${s.type === 'swiss' ? `<label class="inline">轮数 <input type="number" data-f="roundCount" min="1" max="15" value="${s.roundCount || 5}" ${dis} style="width:4.5em"></label>`
        : s.type === 'groups' ? `<label class="inline">分 <input type="number" data-f="groupCount" min="2" max="16" value="${s.groupCount || 2}" ${dis} style="width:4em"> 组</label>`
        : s.type === 'se' ? `<label class="inline"><input type="checkbox" data-f="thirdPlace" ${s.thirdPlace ? 'checked' : ''} ${dis}> 三四名决赛</label>` : '<span class="hint">—</span>'}</td>
      <td>${i >= t.stages.length - 1 ? '<span class="hint">最终阶段</span>'
        : s.type === 'groups' ? `<span class="inline-actions"><select data-f="advMode" ${dis} style="width:auto"><option value="top" ${s.advMode !== 'cut' ? 'selected' : ''}>每组前</option><option value="cut" ${s.advMode === 'cut' ? 'selected' : ''}>每组淘汰末</option></select><input type="number" data-f="advN" min="1" max="32" value="${s.advN || 2}" ${dis} style="width:4em"><span class="hint">名${t.teams.length ? `，共 ${advanceCount(s, t.teams.length)} 队晋级` : ''}</span></span>`
        : `<input type="number" data-f="advance" min="2" max="64" value="${s.advance || 8}" ${dis} style="width:4.5em">`}</td>
      <td class="num">${editable ? `<button type="button" class="mini" data-act="up">↑</button> <button type="button" class="mini" data-act="down">↓</button> <button type="button" class="mini danger" data-act="del">删</button>` : `<span class="chip-s ${s.status}">${{ pending: '未开始', running: '进行中', done: '已结束' }[s.status]}</span>`}</td>
    </tr>`;
  }).join('');
  return `<div class="tn-toolbar">
      ${editable ? `<button type="button" id="tn-add-stage">＋ 添加阶段</button>
      <button type="button" id="tn-preset" title="瑞士轮小组赛 5 轮 BO1，前 8 名进入单败淘汰赛 BO3，决赛 BO5">套用模板：瑞士轮 → 八强 / 半决赛 / 决赛</button>
      <button type="button" id="tn-preset2" title="所有队单循环积分 BO1，前 4 名双败淘汰 BO3，总决赛 BO5">模板：单循环 → 四强双败</button>
      <button type="button" id="tn-preset3" title="分 2 组各打单循环 BO1，每组前 2 名进入单败淘汰赛 BO3，决赛 BO5；队多时把组数或每组晋级数调大">模板：分组循环 → 淘汰赛</button>` : '<span class="hint">赛事已开始，只能改尚未开始的阶段。</span>'}
    </div>
    <div class="table-wrap"><table class="tbl tn-format"><thead><tr><th>#</th><th>阶段名</th><th>赛制</th><th>每场</th><th>决赛</th><th>参数</th><th>晋级</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="empty">还没有阶段</td></tr>'}</tbody></table></div>
    <p class="hint" style="margin-top:10px">瑞士轮：每轮按当前积分配对、避免重赛，奇数队自动轮空（算胜一场）；排名依次看 胜场 → 对手分（Buchholz）→ 小局净胜。单循环：所有队互打一次，同分看交手。分组循环：按种子蛇形分组（1→A、2→B、3→B、4→A…），组内单循环，可选每组前 N 名晋级或淘汰末 N 名，淘汰赛种子按 A1、B1、A2、B2… 排，同组不会首轮相遇。小组类阶段都可以「添加加赛」决并列：加赛不算胜负场，只在两队同分时决定先后。单败 / 双败：按上一阶段名次排种子（1 vs 8、2 vs 7 …），队数不足 2 的幂自动轮空；双败总决赛只打一场，不设加赛。每轮日期可在阶段页里填，用来安排「第 1 天 / 第 2 天」。</p>`;
}

// ---- 阶段 ----
function seriesCard(t, st, s) {
  const r = resolve(st, s);
  const side = (id, v, w, isWin) => `<div class="t ${isWin ? 'win' : ''} ${!id && !v ? 'tbd' : ''}">${v ? '<span class="hint">轮空</span>' : `<span class="tn-name">${esc(id ? tname(t, id) : '待定')}</span>`}${id && (r.a && r.b) ? `<span class="sc">${w}</span>` : ''}</div>`;
  const cls = r.done ? 'done' : (r.a && r.b ? (s.games.length ? 'live' : 'ready') : 'wait');
  return `<div class="series ${cls} ${s.tb ? 'tb' : ''} ${r.a && r.b ? 'clickable' : ''}" data-series="${s.id}" title="${r.a && r.b ? '点击记分' : ''}">
    ${s.label || s.tb ? `<div class="series-label">${esc(s.label || '加赛')}</div>` : ''}
    ${side(r.a, r.voidA, r.wa, r.done && r.winner && r.winner === r.a)}
    ${side(r.b, r.voidB, r.wb, r.done && r.winner && r.winner === r.b)}
    <div class="series-foot">BO${s.bo}${s.games.some(g => g.matchId) ? ' · 📎' : ''}</div>
  </div>`;
}
function viewStage(t, idx) {
  const st = t.stages[idx]; if (!st) return '';
  const isLast = idx === t.stages.length - 1;
  const done = stageDone(st);
  let top = '';
  if (st.status === 'pending') return `<p class="empty">「${esc(st.name)}」尚未开始。上一阶段结束后点「进入下一阶段」。</p>`;
  const advN = advanceCount(st);
  const advTxt = st.type === 'groups' ? `${st.advMode === 'cut' ? `每组淘汰末 ${st.advN || 1} 名` : `每组前 ${st.advN || 2} 名`}，共 ${advN} 队晋级` : `前 ${advN} 名晋级`;
  if (done && st.status === 'running') top = `<div class="tn-banner">本阶段所有场次已结束。${isLast ? '<button type="button" class="primary" id="tn-finish">结束赛事，生成最终榜单</button>' : `<button type="button" class="primary" id="tn-next">进入下一阶段：${esc(t.stages[idx + 1].name)}（${advTxt}）</button>`}</div>`;
  if (st.status === 'done') top = `<div class="tn-banner done">本阶段已结束。${isLast ? '' : `晋级：${advancing(st, t).map(id => esc(tname(t, id))).join('、')}`}</div>`;
  const roundBlock = (rd, filter = () => true) => {
    const list = st.series.filter(s => s.round === rd.idx && filter(s));
    if (rd.extra && !list.length) return '';
    return `<div class="tn-round"><div class="tn-round-head"><strong>${esc(rd.label)}</strong><label class="inline hint">日期 <input type="date" data-round="${rd.idx}" value="${esc(rd.date || '')}"></label></div>
      <div class="tn-series-list">${list.map(s => seriesCard(t, st, s)).join('')}</div></div>`;
  };
  const sortedRounds = [...st.rounds].sort((a, b) => a.idx - b.idx);
  const tbBtn = st.status === 'running' ? `<button type="button" class="ghost" id="tn-tiebreak" title="两队同分时安排一场加赛决定名次；加赛不计入胜负场">＋ 添加加赛</button>` : '';
  const table = (rows, advCount, showBuch) => `<div class="table-wrap"><table class="tbl"><thead><tr><th>#</th><th>队伍</th><th class="num">胜</th><th class="num">负</th>${showBuch ? '<th class="num" title="对手分：所有已交手对手的胜场之和">对手分</th>' : ''}<th class="num">小局</th></tr></thead>
        <tbody>${rows.map((x, i) => `<tr class="${!isLast && i < advCount ? 'adv' : ''}"><td>${i + 1}</td><td>${esc(tname(t, x.id))}${x.byes ? ' <span class="hint">(轮空×' + x.byes + ')</span>' : ''}${x.tb ? ' <span class="hint" title="加赛获胜">加赛✓</span>' : ''}</td><td class="num">${x.w}</td><td class="num">${x.l}</td>${showBuch ? `<td class="num">${x.buch}</td>` : ''}<td class="num">${x.gw}-${x.gl}</td></tr>`).join('')}</tbody></table></div>`;
  if (st.type === 'groups') {
    return `${top}<div class="tn-toolbar">${tbBtn}<span class="hint">${(st.groups || []).length} 组 · ${advTxt}</span></div>
      ${(st.groups || []).map((g, gi) => `<div class="tn-group"><h3>${GN(gi)} 组 <span class="hint">${g.map(id => esc(tname(t, id))).join('、')}</span></h3>
        <div class="tn-stage-grid"><div>${sortedRounds.map(rd => roundBlock(rd, s => s.group === gi)).join('')}</div>
        <div>${table(standings(st, t, gi), perGroupAdv(st, g.length), false)}${!isLast ? `<p class="hint">高亮 = 本组晋级区（${perGroupAdv(st, g.length)} 队）</p>` : ''}</div></div></div>`).join('')}`;
  }
  if (st.type === 'swiss' || st.type === 'rr') {
    const rows = standings(st, t);
    const reg = regRounds(st);
    const canNext = st.type === 'swiss' && st.status === 'running' && reg.length < st.roundCount && st.series.every(s => resolve(st, s).done);
    const lastRound = reg[reg.length - 1];
    const canUndoRound = st.type === 'swiss' && st.status === 'running' && reg.length > 1 && st.series.filter(s => s.round === lastRound.idx).every(s => !s.games.length);
    return `${top}<div class="tn-stage-grid">
      <div>
        <div class="tn-toolbar">${canNext ? `<button type="button" class="primary" id="tn-swiss-next">生成第 ${reg.length + 1} 轮（共 ${st.roundCount} 轮）</button>` : ''}${canUndoRound ? `<button type="button" class="ghost" id="tn-swiss-undo">撤销第 ${reg.length} 轮配对</button>` : ''}${tbBtn}${st.type === 'swiss' ? `<span class="hint">已生成 ${reg.length} / ${st.roundCount} 轮</span>` : ''}</div>
        ${sortedRounds.map(rd => roundBlock(rd)).join('')}
      </div>
      <div><h3>积分榜</h3>${table(rows, advN, st.type === 'swiss')}
        ${!isLast ? `<p class="hint">高亮 = 当前晋级区（前 ${advN} 名）</p>` : ''}</div>
    </div>`;
  }
  // 淘汰赛：按轮分列
  const groups = st.type === 'de' ? [['wb', '胜者组'], ['lb', '败者组'], ['gf', '总决赛']] : [['wb', '']];
  const bracket = groups.map(([b, title]) => {
    const rds = st.rounds.filter(r => (r.bracket || 'wb') === b);
    if (!rds.length) return '';
    return `${title ? `<h3 style="margin-top:14px">${title}</h3>` : ''}<div class="bracket">${rds.map(rd => `<div class="b-round"><div class="tn-round-head"><strong>${esc(rd.label)}</strong><input type="date" data-round="${rd.idx}" value="${esc(rd.date || '')}" title="本轮日期"></div>${st.series.filter(s => s.round === rd.idx && (s.bracket === b || (b === 'wb' && s.bracket === 'tp'))).map(s => seriesCard(t, st, s)).join('')}</div>`).join('')}</div>`;
  }).join('');
  return `${top}${bracket}`;
}

// ---- 榜单 ----
function viewBoard(t) {
  const P = playerMap();
  const last = t.stages[t.stages.length - 1];
  const st = t.stages.slice().reverse().find(s => s.status !== 'pending') || null;
  if (!st) return '<p class="empty">赛事还没开始。</p>';
  const order = placements(st, t);
  const medal = ['🥇', '🥈', '🥉'];
  const linked = [];
  for (const s of t.stages) for (const se of s.series) for (const g of se.games) if (g.matchId) linked.push(g.matchId);
  const ms = linked.map(id => S().matches.find(m => m.id === id)).filter(Boolean);
  // 选手小局战绩（仅统计已关联详细记录的局）
  const pstat = new Map();
  for (const m of ms) for (const side of ['radiant', 'dire']) for (const x of m[side]) { const o = pstat.get(x.pid) || { g: 0, w: 0 }; o.g++; if (m.winner === side) o.w++; pstat.set(x.pid, o); }
  const top = [...pstat.entries()].sort((a, b) => b[1].w - a[1].w || a[1].g - b[1].g).slice(0, 10);
  return `<h3>${st === last && t.status === 'done' ? '最终名次' : `当前名次（${esc(st.name)}）`}</h3>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>#</th><th>队伍</th><th>成员</th><th>平均段位</th></tr></thead><tbody>
    ${order.map((id, i) => { const tm = teamOf(t, id); return `<tr><td>${medal[i] || i + 1}</td><td><strong>${esc(tname(t, id))}</strong></td><td class="wrap">${tm ? tm.players.filter(Boolean).map(pid => esc(pname(P, pid))).join('、') : ''}</td><td>${tm ? rankText(avgRank(tm, P)) : ''}</td></tr>`; }).join('')}
    </tbody></table></div>
    <h3 style="margin-top:16px">已关联的详细记录 <span class="count">${ms.length}</span> <span class="hint">这些比赛同时计入「统计」页</span></h3>
    ${top.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>选手</th><th class="num">局</th><th class="num">胜</th><th class="num">胜率</th></tr></thead><tbody>${top.map(([pid, o]) => `<tr><td>${esc(pname(P, pid))}</td><td class="num">${o.g}</td><td class="num">${o.w}</td><td class="num">${Math.round(o.w / o.g * 100)}%</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">还没有关联任何详细记录。在系列赛里点「录入本局」或「关联已有记录」。</p>'}`;
}

// ============ 系列赛弹窗 ============
function seriesTitle(t, st, s) { const rd = st.rounds.find(r => r.idx === s.round); return `${t.name} · ${st.name} · ${s.label || rd?.label || ''}`.replace(/ · $/, ''); }
function openSeries(sid) {
  const t = cur(); const st = t.stages[tui.stageIdx]; const s = seriesOf(st, sid); if (!s) return;
  const r = resolve(st, s); if (!r.a || !r.b) return;
  const P = playerMap();
  const locked = st.status === 'done' || t.status === 'done' || downstreamHasGames(st, s.id) || (st.type === 'swiss' && st.rounds.length - 1 > s.round && st.series.some(x => x.round > s.round && x.games.length));
  const roster = id => { const tm = teamOf(t, id); return tm ? tm.players.filter(Boolean).map(pid => `<span class="tag">${esc(pname(P, pid))}</span>`).join(' ') : ''; };
  const gameRow = (g, i) => {
    const m = g.matchId ? S().matches.find(x => x.id === g.matchId) : null;
    return `<tr><td>第 ${i + 1} 局</td><td><span class="${g.w === 'a' ? 'win' : 'loss'}">${esc(tname(t, g.w === 'a' ? r.a : r.b))} 胜</span></td>
      <td>${g.matchId ? (m ? `<button type="button" class="link" data-act="view-match" data-mid="${esc(m.id)}">${esc(m.id)}</button> <span class="hint">${m.date}${m.duration ? ' · ' + m.duration + '分' : ''}</span>` : `<span class="hint">记录 ${esc(g.matchId)} 已被删除</span>`) : '<span class="hint">仅比分</span>'}</td>
      <td class="num">${locked ? '' : `${!g.matchId ? `<button type="button" class="mini" data-act="link" data-gi="${i}">关联记录</button>` : `<button type="button" class="mini" data-act="unlink" data-gi="${i}">取消关联</button>`} <button type="button" class="mini danger" data-act="del-game" data-gi="${i}">删除</button>`}</td></tr>`;
  };
  const n = needWins(s);
  showModal(`<h2>${esc(seriesTitle(t, st, s))} <span class="hint">BO${s.bo}，先胜 ${n} 局</span></h2>
    <div class="tn-vs">
      <div class="tn-vs-team ${r.winner === r.a ? 'won' : ''}"><div class="tn-vs-name">${esc(tname(t, r.a))}</div><div class="tn-vs-score">${r.wa}</div><div class="tn-roster">${roster(r.a)}</div></div>
      <div class="vs">VS</div>
      <div class="tn-vs-team ${r.winner === r.b ? 'won' : ''}"><div class="tn-vs-name">${esc(tname(t, r.b))}</div><div class="tn-vs-score">${r.wb}</div><div class="tn-roster">${roster(r.b)}</div></div>
    </div>
    ${r.done ? `<p class="tn-banner done" style="margin:8px 0">系列赛结束，<b>${esc(tname(t, r.winner))}</b> 胜出${locked ? '（后续场次已开始，本场已锁定）' : ''}</p>` : ''}
    ${!locked && !r.done ? `<div class="form-actions" style="flex-wrap:wrap">
      <button type="button" class="win-btn radiant" data-act="score" data-w="a">${esc(tname(t, r.a))} 胜一局</button>
      <button type="button" class="win-btn dire" data-act="score" data-w="b">${esc(tname(t, r.b))} 胜一局</button>
      <button type="button" class="primary" data-act="record">录入本局详细比赛 →</button>
      <button type="button" data-act="link" data-gi="-1">关联已有记录</button>
    </div><p class="hint">「录入本局」会跳到记录比赛页并预填两队阵容（${esc(tname(t, r.a))} 为天辉、${esc(tname(t, r.b))} 为夜魇，可交换 / 换替补），保存后自动回填本局胜负。</p>` : ''}
    <table class="tbl" style="margin-top:8px"><thead><tr><th>局</th><th>结果</th><th>详细记录</th><th></th></tr></thead><tbody>${s.games.map(gameRow).join('') || '<tr><td colspan="4" class="hint">还没有记录</td></tr>'}</tbody></table>
    <div class="form-actions" style="justify-content:flex-end">${s.tb && !locked ? '<button type="button" class="ghost danger" data-act="del-series">删除这场加赛</button>' : ''}<button type="button" class="ghost" id="tn-series-close">关闭</button></div>`);
  const box = $('#modal-content');
  $('#tn-series-close').onclick = hideModal;
  box.onclick = e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'score') { s.games.push({ w: b.dataset.w }); save(); afterScore(t, st); openSeries(sid); }
    else if (act === 'del-game') { s.games.splice(Number(b.dataset.gi), 1); save(); afterScore(t, st); openSeries(sid); }
    else if (act === 'unlink') { delete s.games[Number(b.dataset.gi)].matchId; save(); openSeries(sid); }
    else if (act === 'del-series') { if (s.games.length && !confirm('这场加赛已有比分，确定删除？')) return; st.series = st.series.filter(x => x.id !== s.id); if (!st.series.some(x => x.tb)) st.rounds = st.rounds.filter(x => !x.extra); save(); hideModal(); render(); }
    else if (act === 'record') startRecordGame(t, st, s, r);
    else if (act === 'link') openLinkPicker(t, st, s, r, Number(b.dataset.gi));
    else if (act === 'view-match') { const m = S().matches.find(x => x.id === b.dataset.mid); if (m) { hideModal(); A.startEditMatch(m); } }
  };
}
function afterScore(t, st) {
  // 若阶段刚好打完，仅刷新；晋级由用户点按钮触发
  render();
}
// 跳去记录比赛页，预填阵容
function startRecordGame(t, st, s, r) {
  const ta = teamOf(t, r.a), tb = teamOf(t, r.b); if (!ta || !tb) return;
  const gi = s.games.length + 1;
  const rd = st.rounds.find(x => x.idx === s.round);
  const base = `${t.name}-${st.name}-${(s.label || rd?.label || '').replace(/[（(].*?[）)]/g, '')}-${ta.name}vs${tb.name}-G${gi}`.replace(/\s+/g, '');
  let id = base, k = 2; while (S().matches.some(m => m.id === id)) id = `${base}-${k++}`;
  tui.pending = { tid: t.id, sid: st.id, seriesId: s.id, matchId: id, a: r.a, b: r.b };
  hideModal();
  A.prefillMatch(ta.players.filter(Boolean), tb.players.filter(Boolean), { id, date: rd?.date || today(), note: `${seriesTitle(t, st, s)} · 第 ${gi} 局`, title: `正式比赛：${ta.name} vs ${tb.name} · 第 ${gi} 局` });
  toast('已预填两队阵容，保存后自动回填比分', 'ok');
}
// 关联已有记录：按双方成员重合度筛
function openLinkPicker(t, st, s, r, gi) {
  const ta = new Set(teamOf(t, r.a)?.players || []), tb = new Set(teamOf(t, r.b)?.players || []);
  const used = new Set(); for (const x of t.stages) for (const se of x.series) for (const g of se.games) if (g.matchId) used.add(g.matchId);
  const cand = S().matches.map(m => {
    const rp = m.radiant.map(x => x.pid), dp = m.dire.map(x => x.pid);
    const ov1 = rp.filter(p => ta.has(p)).length + dp.filter(p => tb.has(p)).length;
    const ov2 = rp.filter(p => tb.has(p)).length + dp.filter(p => ta.has(p)).length;
    const aIsRadiant = ov1 >= ov2;
    return { m, score: Math.max(ov1, ov2), aIsRadiant, used: used.has(m.id) };
  }).filter(x => x.score >= 4).sort((x, y) => y.score - x.score || y.m.date.localeCompare(x.m.date)).slice(0, 30);
  const P = playerMap();
  showModal(`<h2>关联已有比赛记录 <span class="hint">${esc(tname(t, r.a))} vs ${esc(tname(t, r.b))}${gi >= 0 ? ` · 第 ${gi + 1} 局` : ' · 新增一局'}</span></h2>
    <p class="hint">只列出两队成员重合 ≥ 4 人的记录，按重合度排序。选择后本局胜负以该记录的胜方为准。</p>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>比赛 ID</th><th>日期</th><th>胜方</th><th>天辉</th><th>夜魇</th><th class="num">重合</th><th></th></tr></thead><tbody>
    ${cand.map(({ m, score, aIsRadiant, used: u }) => `<tr><td>${esc(m.id)}</td><td>${m.date}</td><td>${esc(tname(t, (m.winner === 'radiant') === aIsRadiant ? r.a : r.b))}</td><td class="wrap lineup">${m.radiant.map(x => esc(pname(P, x.pid))).join(' ')}</td><td class="wrap lineup">${m.dire.map(x => esc(pname(P, x.pid))).join(' ')}</td><td class="num">${score}/10</td><td>${u ? '<span class="hint">已关联</span>' : `<button type="button" class="mini" data-link="${esc(m.id)}" data-air="${aIsRadiant ? 1 : 0}">选择</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">没有匹配的记录。先在「记录比赛」录一场，或用「录入本局」。</td></tr>'}
    </tbody></table></div>
    <div class="form-actions" style="justify-content:flex-end"><button type="button" class="ghost" id="tn-link-back">返回</button></div>`);
  $('#tn-link-back').onclick = () => openSeries(s.id);
  $('#modal-content').onclick = e => {
    const b = e.target.closest('button[data-link]'); if (!b) return;
    const m = S().matches.find(x => x.id === b.dataset.link); if (!m) return;
    const aIsRadiant = b.dataset.air === '1';
    const w = (m.winner === 'radiant') === aIsRadiant ? 'a' : 'b';
    if (gi >= 0) { s.games[gi].matchId = m.id; s.games[gi].w = w; } else s.games.push({ w, matchId: m.id });
    save(); render(); openSeries(s.id);
  };
}
// 添加加赛：小组类阶段两队同分时手动安排
function openTiebreakModal(t, st) {
  const opt = ids => ids.map(id => `<option value="${id}">${esc(tname(t, id))}</option>`).join('');
  const options = st.type === 'groups' ? (st.groups || []).map((g, gi) => `<optgroup label="${GN(gi)} 组">${opt(g)}</optgroup>`).join('') : opt(st.teamIds);
  showModal(`<h2>添加加赛</h2>
    <p class="hint">加赛用来决出并列名次：结果不计入胜负场和小局，只在两队胜场相同时决定谁排前面。${st.type === 'groups' ? '只能安排同组两队。' : ''}</p>
    <div class="row wrap"><label>队伍 A<select id="tb-a">${options}</select></label><label>队伍 B<select id="tb-b">${options}</select></label><label class="narrow">局数<select id="tb-bo">${BO_OPTS.map(b => `<option value="${b}" ${b === st.bo ? 'selected' : ''}>BO${b}</option>`).join('')}</select></label></div>
    <div class="form-actions"><button type="button" class="primary" id="tb-ok">添加</button><button type="button" class="ghost" id="tb-cancel">取消</button></div>`);
  const selB = $('#tb-b'); if (selB.options.length > 1) selB.selectedIndex = 1;
  $('#tb-cancel').onclick = hideModal;
  $('#tb-ok').onclick = () => {
    const a = $('#tb-a').value, b = $('#tb-b').value;
    if (a === b) return toast('两队不能相同', 'err');
    const gi = st.type === 'groups' ? (st.groups || []).findIndex(g => g.includes(a)) : null;
    if (gi != null && !(st.groups[gi] || []).includes(b)) return toast('加赛只能安排同组两队', 'err');
    if (!st.rounds.some(r => r.extra)) st.rounds.push({ idx: TB_ROUND, label: '加赛', date: '', extra: true });
    st.series.push(mkSeries(st, TB_ROUND, { a, b, bo: Number($('#tb-bo').value) || st.bo, tb: true, group: gi }));
    save(); hideModal(); render(); toast('已添加加赛，点卡片记分', 'ok');
  };
}
// 记录比赛页保存后：回填待定局，或同步已关联记录的胜负
A.hooks.afterSaveMatch.push(m => {
  const p = tui.pending;
  if (p && m.id === p.matchId) {
    const t = T().find(x => x.id === p.tid), st = t && stageOf(t, p.sid), s = st && seriesOf(st, p.seriesId);
    if (s) {
      const ta = new Set(teamOf(t, p.a)?.players || []);
      const rad = m.radiant.filter(x => ta.has(x.pid)).length, dire = m.dire.filter(x => ta.has(x.pid)).length;
      const aIsRadiant = rad >= dire;
      const w = (m.winner === 'radiant') === aIsRadiant ? 'a' : 'b';
      if (!s.games.some(g => g.matchId === m.id)) s.games.push({ w, matchId: m.id });
      save(); tui.pending = null; tui.tid = t.id; tui.view = 'detail'; tui.stageIdx = t.stages.indexOf(st); tui.sub = 'stage' + tui.stageIdx;
      switchTab('tournament'); toast(`已回填：${tname(t, w === 'a' ? p.a : p.b)} 胜`, 'ok');
      return;
    }
  }
  // 编辑了已关联的记录 → 同步胜负
  let changed = false;
  for (const t of T()) for (const st of t.stages) for (const s of st.series) for (const g of s.games) if (g.matchId === m.id) {
    const r = resolve(st, s); const ta = new Set(teamOf(t, r.a)?.players || []);
    const aIsRadiant = m.radiant.filter(x => ta.has(x.pid)).length >= m.dire.filter(x => ta.has(x.pid)).length;
    const w = (m.winner === 'radiant') === aIsRadiant ? 'a' : 'b';
    if (g.w !== w) { g.w = w; changed = true; }
  }
  if (changed) { save(); toast('已同步赛事比分', 'ok'); }
});

// ============ 事件 ============
function newStage(type = 'swiss') { return { id: uid(), name: STAGE_TYPES[type], type, bo: 1, finalBo: 0, roundCount: 5, thirdPlace: false, advance: 8, groupCount: 2, advMode: 'top', advN: 2, status: 'pending', teamIds: [], rounds: [], series: [] }; }
function presetGroupsSE() { return [{ ...newStage('groups'), name: '小组赛（分组循环）', bo: 1, groupCount: 2, advMode: 'top', advN: 2 }, { ...newStage('se'), name: '淘汰赛', bo: 3, finalBo: 5, thirdPlace: false }]; }
function presetSwissSE() { return [{ ...newStage('swiss'), name: '小组赛（瑞士轮）', bo: 1, roundCount: 5, advance: 8 }, { ...newStage('se'), name: '淘汰赛', bo: 3, finalBo: 5, thirdPlace: false }]; }
function presetRRDE() { return [{ ...newStage('rr'), name: '循环赛', bo: 1, advance: 4 }, { ...newStage('de'), name: '四强双败', bo: 3, finalBo: 5 }]; }

function validateStart(t) {
  if (t.teams.length < 2) return '至少要 2 支队伍';
  for (const tm of t.teams) if (tm.players.filter(Boolean).length !== 5) return `「${tm.name}」不满 5 人`;
  const all = t.teams.flatMap(x => x.players); if (new Set(all).size !== all.length) return '有选手同时在两支队伍里';
  if (!t.stages.length) return '至少要配置一个阶段';
  for (const s of t.stages) if (s.type === 'groups' && t.teams.length < (s.groupCount || 2) * 2) return `「${s.name}」分 ${s.groupCount || 2} 组至少要 ${(s.groupCount || 2) * 2} 队`;
  for (let i = 0; i < t.stages.length - 1; i++) { const adv = advanceCount(t.stages[i], t.teams.length); if (adv >= t.teams.length) return `「${t.stages[i].name}」晋级 ${adv} 队，没有淘汰任何队`; if (adv < 2) return `「${t.stages[i].name}」晋级名额至少 2`; }
  return '';
}

root().addEventListener('submit', e => {
  if (e.target.id !== 'tn-create') return;
  e.preventDefault();
  const name = $('#tn-name').value.trim(); if (!name) return;
  const t = { id: uid(), name, date: $('#tn-date').value || today(), createdAt: Date.now(), status: 'setup', teams: [], subs: [], stages: presetSwissSE(), currentStage: -1 };
  T().push(t); save(); tui.tid = t.id; tui.view = 'detail'; tui.sub = 'teams'; render(); toast('已创建赛事，先分队再配置赛制', 'ok');
});

root().addEventListener('click', e => {
  const t = cur();
  const card = e.target.closest('.tn-card[data-open]'); if (card) { tui.tid = card.dataset.open; tui.view = 'detail'; const tt = cur(); tui.sub = tt.status === 'setup' ? 'teams' : 'stage' + Math.max(0, tt.currentStage); tui.stageIdx = Math.max(0, tt.currentStage); render(); return; }
  const sub = e.target.closest('.tn-subnav button[data-sub]'); if (sub) { tui.sub = sub.dataset.sub; if (tui.sub.startsWith('stage')) tui.stageIdx = Number(tui.sub.slice(5)); render(); return; }
  const b = e.target.closest('button'); const id = b?.id;
  if (id === 'tn-back') { tui.view = 'list'; render(); return; }
  if (!t) return;
  if (id === 'tn-rename') { const v = prompt('赛事名称', t.name); if (v && v.trim()) { t.name = v.trim(); save(); render(); } return; }
  if (id === 'tn-delete') { if (confirm(`删除赛事「${t.name}」？已关联的比赛记录本身不会删除。`)) { S().tournaments = T().filter(x => x.id !== t.id); save(); tui.view = 'list'; render(); toast('已删除'); } return; }
  if (id === 'tn-start') { const err = validateStart(t); if (err) return toast(err, 'err'); t.status = 'running'; startStage(t, 0, t.teams.map(x => x.id)); save(); tui.sub = 'stage0'; render(); toast('赛事开始，第一阶段赛程已生成', 'ok'); return; }
  // 队伍
  if (id === 'tn-add-team') { t.teams.push({ id: uid(), name: `${t.teams.length + 1} 队`, players: [null, null, null, null, null] }); save(); render(); return; }
  if (id === 'tn-balance') { if (S().players.length < 4) return toast('选手太少，先去「选手名单」添加', 'err'); openBalanceModal(t); return; }
  if (id === 'tn-fill') {
    const assigned = assignedPids(t), subSet = new Set(t.subs || []);
    const free = S().players.filter(p => !assigned.has(p.id) && !subSet.has(p.id)).sort((x, y) => rankIdx(y) - rankIdx(x));
    const empties = t.teams.flatMap(tm => tm.players.map((p, i) => p ? null : [tm, i]).filter(Boolean));
    if (!empties.length) return toast('没有空位', 'err'); if (!free.length) return toast('没有可用的未分队选手', 'err');
    // 每次把段位最高的空闲选手给当前平均段位最低且还有空位的队
    const P = playerMap(); let k = 0;
    for (;;) { const cands = t.teams.filter(tm => tm.players.includes(null)); if (!cands.length || k >= free.length) break; cands.sort((x, y) => avgRank(x, P) - avgRank(y, P)); const tm = cands[0]; tm.players[tm.players.indexOf(null)] = free[k++].id; }
    save(); render(); toast(k < empties.length ? `已填 ${k} 个空位，选手不够` : '已填满空位', 'ok'); return;
  }
  const tb = e.target.closest('button[data-team][data-act]');
  if (tb) { const i = t.teams.findIndex(x => x.id === tb.dataset.team); if (i < 0) return; const act = tb.dataset.act;
    if (act === 'del') t.teams.splice(i, 1); else if (act === 'up' && i > 0) [t.teams[i - 1], t.teams[i]] = [t.teams[i], t.teams[i - 1]]; else if (act === 'down' && i < t.teams.length - 1) [t.teams[i + 1], t.teams[i]] = [t.teams[i], t.teams[i + 1]];
    save(); render(); return; }
  const chip = e.target.closest('.chip[data-sub]');
  if (chip && t.status !== 'done') { t.subs = t.subs || []; const pid = chip.dataset.sub; const i = t.subs.indexOf(pid); if (i >= 0) t.subs.splice(i, 1); else t.subs.push(pid); save(); render(); return; }
  // 赛制
  if (id === 'tn-add-stage') { t.stages.push(newStage('se')); save(); render(); return; }
  if (id === 'tn-preset') { t.stages = presetSwissSE(); save(); render(); toast('已套用模板', 'ok'); return; }
  if (id === 'tn-preset2') { t.stages = presetRRDE(); save(); render(); toast('已套用模板', 'ok'); return; }
  if (id === 'tn-preset3') { t.stages = presetGroupsSE(); save(); render(); toast('已套用模板', 'ok'); return; }
  const sr = e.target.closest('tr[data-stage] button[data-act]');
  if (sr) { const tr = sr.closest('tr'); const i = t.stages.findIndex(x => x.id === tr.dataset.stage); const act = sr.dataset.act;
    if (act === 'del') t.stages.splice(i, 1); else if (act === 'up' && i > 0) [t.stages[i - 1], t.stages[i]] = [t.stages[i], t.stages[i - 1]]; else if (act === 'down' && i < t.stages.length - 1) [t.stages[i + 1], t.stages[i]] = [t.stages[i], t.stages[i + 1]];
    save(); render(); return; }
  // 阶段推进
  const st = t.stages[tui.stageIdx];
  if (id === 'tn-swiss-next' && st) { genSwissRound(st, t); save(); render(); toast(`第 ${st.rounds.length} 轮配对已生成`, 'ok'); return; }
  if (id === 'tn-swiss-undo' && st) { const reg = regRounds(st); const last = reg[reg.length - 1]; st.rounds = st.rounds.filter(r => r !== last); st.series = st.series.filter(s => s.round !== last.idx); save(); render(); return; }
  if (id === 'tn-tiebreak' && st) { openTiebreakModal(t, st); return; }
  if (id === 'tn-next' && st) { if (!stageDone(st)) return toast('本阶段还有未打完的场次', 'err'); st.status = 'done'; const adv = advancing(st, t); startStage(t, tui.stageIdx + 1, adv); save(); tui.sub = 'stage' + tui.stageIdx; render(); toast(`已进入「${t.stages[tui.stageIdx].name}」，${adv.length} 队晋级`, 'ok'); return; }
  if (id === 'tn-finish' && st) { if (!stageDone(st)) return toast('还有未打完的场次', 'err'); st.status = 'done'; t.status = 'done'; save(); tui.sub = 'board'; render(); toast('赛事已结束 🏆', 'ok'); return; }
  const sc = e.target.closest('.series.clickable[data-series]');
  if (sc) { openSeries(sc.dataset.series); }
});

root().addEventListener('change', e => {
  const t = cur(); if (!t) return;
  const el = e.target;
  if (el.matches('select[data-team][data-slot]')) { const tm = teamOf(t, el.dataset.team); const pid = el.value || null; if (pid) for (const x of t.teams) x.players = x.players.map(p => p === pid ? null : p); tm.players[Number(el.dataset.slot)] = pid; save(); render(); return; }
  if (el.matches('input[data-team][data-f=name]')) { const tm = teamOf(t, el.dataset.team); tm.name = el.value.trim() || tm.name; save(); render(); return; }
  const tr = el.closest('tr[data-stage]');
  if (tr) { const s = t.stages.find(x => x.id === tr.dataset.stage); const f = el.dataset.f; if (!s || !f) return;
    if (f === 'thirdPlace') s.thirdPlace = el.checked; else if (f === 'name') s.name = el.value.trim() || s.name; else if (f === 'advMode') s.advMode = el.value; else if (f === 'type') { const wasDefault = Object.values(STAGE_TYPES).includes(s.name); s.type = el.value; if (wasDefault) s.name = STAGE_TYPES[s.type]; } else s[f] = Number(el.value) || 0;
    save(); render(); return; }
  if (el.matches('input[type=date][data-round]')) { const st = t.stages[tui.stageIdx]; const rd = st?.rounds.find(r => r.idx === Number(el.dataset.round)); if (rd) { rd.date = el.value; save(); } return; }
});

// 顶栏导入 / 示例数据 会整体替换 state，切回本 tab 时 render() 重新取 state，无需额外处理
})();
