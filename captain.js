/* 队长方案（拍卖选马 · 队长视角）
   给某一支队的队长用：自己填每个选手的身价（预计成交价），在剩余预算和硬约束下算出最优阵容，
   再给出按轮次排好的拍卖方案：每个目标的止损价、失手后怎么改。
   身价 / 必抢 / 不要 / 自留 是队长的私货，只存本机 localStorage，不进 state，不会随云同步让别的队长看到。
   依赖 app.js 的 window.DotaApp、tournament.js 的 window.DotaTournament、auction.js 的 window.DotaAuction */
(() => {
'use strict';
const A = window.DotaApp, TN = window.DotaTournament, AU = window.DotaAuction;
if (!A || !TN || !AU) { console.error('captain.js 必须在 app.js、tournament.js、auction.js 之后加载'); return; }
const { $, esc, toast, showModal, hideModal, playerMap, pname } = A;
const { TIER, TIERS, QUOTA, SIZE, sizeOf, subSlots, max45Of, teamStat, posGroup, gradeOf, dealOf, lotRound, fmt, groupPos, data: auc, PRICE_MODES } = AU;
const SUB_W = 0.5;             // 替补的实力和配合分按一半算：上场机会少，但也不能是废牌
const posLbl = p => p ? String(p) : '替';
const S = () => A.state;

// ============ 私有方案存取 ============
const KEY = tid => `dota-captain-plan:${tid}`;
const EMPTY = () => ({ tmId: '', prices: {}, must: [], avoid: [], reserve: 0, priceMode: 'fair', strength: 'mix' });
// 实力口径：内战评分（统计页同一口径）和组委会定级各占一半是默认；没打过内战的人评分只剩段位项，全靠定级拉开差距
const TIER_SCORE = { 'SSS': 100, 'S': 88, 'A+': 78, 'A': 70, 'A-': 62, 'B': 54, 'C': 44, 'D': 34 };
const STRENGTH_MODES = { mix: '内战评分 + 定级各半', score: '只看内战评分', tier: '只看定级档位' };
const strengthOf = (score, g, mode) => { const ts = TIER_SCORE[g]; if (ts == null) return score; return mode === 'score' ? score : mode === 'tier' ? ts : (score + ts) / 2; };
/* 搭档配合分：两人同队过的胜率偏离 50% 多少，乘样本置信（g ÷ (g + SYN_TRUST)），再乘 SYN_SCALE。
   同队 5 场全胜 → +6.25，5 场全败 → −6.25；没同队过 = 0。阵容里 10 对两两相加，和实力分同一量纲 */
const SYN_SCALE = 20, SYN_TRUST = 3, SYN_MIN_G = 2;
function synergyMap(duos) {
  const m = new Map();
  for (const d of Object.values(duos || {})) { if (d.g < SYN_MIN_G) continue; const v = (d.w / d.g - 0.5) * (d.g / (d.g + SYN_TRUST)) * SYN_SCALE; if (v) m.set(d.a + '|' + d.b, { v, g: d.g, w: d.w }); }
  return m;
}
const synOf = (map, a, b) => map.get(a < b ? a + '|' + b : b + '|' + a) || null;
function loadPlan(t) {
  try { const d = JSON.parse(localStorage.getItem(KEY(t.id)) || 'null'); if (d) return { ...EMPTY(), ...d, prices: d.prices || {}, must: d.must || [], avoid: d.avoid || [], reserve: Number(d.reserve) || 0 }; } catch (e) { /* 本地存储不可用就当没存过 */ }
  return EMPTY();
}
function savePlan(t, plan) { try { localStorage.setItem(KEY(t.id), JSON.stringify(plan)); } catch (e) { /* 忽略 */ } }

const tierCls = g => `au-t t${(g || '').replace('+', 'p').replace('-', 'm')}`;
// 出价落到「底价 + k×步长」的网格上（向下取）；没档位的人按整数
const snap = (v, g) => { const T = TIER[g]; if (!T) return Math.floor(v); if (v < T.base) return T.base; return T.base + Math.floor((v - T.base) / T.step) * T.step; };
const roundIdx = (t, c) => { const r = c.round; if (!r) return 99; return auc(t).rounds.findIndex(x => x.id === r.id); };

// 候选：参赛名单里还没成交的人。身价：队长填的优先，否则按档位的预估价；没档位又没填价的人进不了方案
function buildCands(t, plan) {
  const all = A.computeStats(S().matches), stats = all.players, so = A.loadScoreOpt();
  const list = TN.rosterPlayers(t).filter(p => !dealOf(t, p.id)).map(p => {
    const g = gradeOf(t, p.id);
    const mine = Number(plan.prices[p.id]);
    const price = mine > 0 ? mine : (TIER[g] ? (TIER[g][plan.priceMode] ?? TIER[g].fair) : 0);
    const sc = A.playerScore(stats[p.id], p, so);
    return { pid: p.id, p, g, cls: TIER[g]?.cls || '', grp: posGroup(p), price, mine: mine > 0, score: strengthOf(sc.score, g, plan.strength), rawScore: sc.score, games: stats[p.id]?.g || 0, must: plan.must.includes(p.id), avoid: plan.avoid.includes(p.id), round: lotRound(t, p.id) };
  });
  list.syn = plan.synergy === false ? new Map() : synergyMap(all.duos);   // 搭档表挂在候选数组上，求解和展示共用
  list.strengthOf = pid => { const p = playerMap().get(pid); return p ? strengthOf(A.playerScore(stats[pid], p, so).score, gradeOf(t, pid), plan.strength) : 0; };   // 已在队的人也要算实力
  return list;
}

// ============ 求解 ============
/* 精确搜索而不是贪心：先把已买的人排到号位上（所有合法排法都试），再为每个空号位挑人。
   每个号位只看该位有效分最高的 K 人 + 必抢的人，K=10 时最多 10^4 种组合，毫秒级。
   目标：总评分 + 阵容内两两搭档配合分 最高，同分取便宜的；降位打的人（能打但不擅长）评分打九折。
   有替补名额时多一个「号位 0 = 替补席」，谁都能坐，实力按 SUB_W 折算。
   约束：预算 − 自留、S 级 ≤2、A 系 ≤3、45 组 ≤2 + 替补数（45 组首发只能占 4/5）、必抢全在、不要的不进 */
const K = 10;
function solve(t, tmId, cands, plan, excludePid) {
  const st = teamStat(t, tmId);
  if (st.slots <= 0) return { ok: false, msg: '该队已满编' };
  const fixed = st.deals.map(d => d.pid);
  const P = playerMap(), subs = subSlots(t), max45 = max45Of(t);
  const posOf = pid => { const ps = P.get(pid)?.positions || []; const base = ps.length ? [...ps] : [1, 2, 3, 4, 5]; return subs ? [...base, 0] : base; };
  const cap = st.left - plan.reserve;
  const pool = cands.filter(c => !c.avoid && c.pid !== excludePid && c.price > 0);
  const mustIds = pool.filter(c => c.must).map(c => c.pid);
  const canPlay = (c, pos) => pos === 0 ? true : c.grp === '45' ? pos >= 4 : true;
  const good = (c, pos) => pos === 0 || (c.p.positions || []).includes(pos);
  const eff = (c, pos) => pos === 0 ? c.score * SUB_W : good(c, pos) ? c.score : c.score * 0.9;
  const syn = cands.syn || new Map();
  const synWith = (pid, others) => { let s = 0; for (const o of others) { const d = synOf(syn, pid, o); if (d) s += d.v; } return s; };
  // 剪枝用的配合分上界：任何一个人最多还能从剩余名额里拿到的正配合分
  const synUpper = Math.max(0, ...pool.map(c => [...syn.entries()].filter(([k, d]) => d.v > 0 && k.split('|').includes(c.pid)).map(([, d]) => d.v).sort((a, b) => b - a).slice(0, SIZE - 1).reduce((s, v) => s + v, 0)));
  const fixedAssigns = [];
  (function dfs(i, used, bench, acc) {
    if (i === fixed.length) { fixedAssigns.push([...acc]); return; }
    for (const pos of posOf(fixed[i])) {
      if (pos === 0) { if (bench >= subs) continue; acc.push(0); dfs(i + 1, used, bench + 1, acc); acc.pop(); }
      else if (!used.has(pos)) { used.add(pos); acc.push(pos); dfs(i + 1, used, bench, acc); acc.pop(); used.delete(pos); }
    }
  })(0, new Set(), 0, []);
  if (!fixedAssigns.length) return { ok: false, msg: '已买的人按擅长位置就排不开 1-5' };
  // 已在队的人按这次排法贡献的实力：首发全额（不擅长九折）、替补席减半。不算进去的话求解器会把队长赶去替补腾位置
  const fixedStrength = asg => fixed.reduce((s, pid, i) => { const v = (cands.strengthOf ? cands.strengthOf(pid) : 0); const pos = asg[i]; return s + (pos === 0 ? v * SUB_W : (P.get(pid)?.positions || []).includes(pos) || !(P.get(pid)?.positions || []).length ? v : v * 0.9); }, 0);
  const seenOpen = new Set(); let best = null;
  for (const asg of fixedAssigns) {
    const open = [...[1, 2, 3, 4, 5].filter(x => !asg.includes(x)), ...Array(subs - asg.filter(x => x === 0).length).fill(0)];
    const base = fixedStrength(asg);
    const key = open.join('') + '|' + base.toFixed(3); if (seenOpen.has(key)) continue; seenOpen.add(key);
    const lists = open.map(pos => { const l = pool.filter(c => canPlay(c, pos)).sort((a, b) => eff(b, pos) - eff(a, pos)); return [...l.filter(c => c.must), ...l.filter(c => !c.must).slice(0, K)]; });
    const order = open.map((_, i) => i).sort((a, b) => lists[a].length - lists[b].length);   // 候选少的号位先定，剪枝更早
    const upper = order.map(i => lists[i].length ? Math.max(...lists[i].map(c => eff(c, open[i]))) : 0);
    const rem = []; for (let k = order.length - 1, s = 0; k >= 0; k--) { s += upper[k]; rem[k] = s; }
    const pick = new Array(open.length).fill(null); const taken = new Set();
    let cost = 0, uS = st.sCnt, uA = st.aCnt, u45 = st.c45, total = base, synTotal = 0;
    const dfs = k => {
      if (k === order.length) {
        if (mustIds.some(id => !taken.has(id))) return;
        const sum = total + synTotal;
        if (!best || sum > best.total + 1e-9 || (Math.abs(sum - best.total) < 1e-9 && cost < best.cost))
          best = { pick: pick.map((c, i) => ({ ...c, pos: open[i], down: !good(c, open[i]) })), cost, total: sum, strength: total, syn: synTotal, fixedPos: fixed.map((pid, i) => ({ pid, pos: asg[i] })) };
        return;
      }
      if (best && total + synTotal + rem[k] + (order.length - k) * synUpper < best.total - 1e-9) return;
      const i = order[k], pos = open[i];
      for (const c of lists[i]) {
        if (taken.has(c.pid)) continue;
        if (c.cls === 'S' && uS >= QUOTA.S) continue;
        if (c.cls === 'A' && uA >= QUOTA.A) continue;
        if (c.grp === '45' && u45 >= max45) continue;
        if (cost + c.price > cap + 1e-9) continue;
        const sAdd = synWith(c.pid, [...fixed, ...taken]) * (pos === 0 ? SUB_W : 1);
        pick[i] = c; taken.add(c.pid); cost += c.price; total += eff(c, pos); synTotal += sAdd;
        if (c.cls === 'S') uS++; else if (c.cls === 'A') uA++;
        if (c.grp === '45') u45++;
        dfs(k + 1);
        pick[i] = null; taken.delete(c.pid); cost -= c.price; total -= eff(c, pos); synTotal -= sAdd;
        if (c.cls === 'S') uS--; else if (c.cls === 'A') uA--;
        if (c.grp === '45') u45--;
      }
    };
    dfs(0);
  }
  if (!best) return { ok: false, msg: mustIds.length ? '带上「必抢」的人在预算 / 配额下凑不出阵容，松一松必抢、身价或自留' : '在预算 / 配额下凑不出阵容 —— 身价填低些、减少自留，或放宽「不要」' };
  return { ok: true, ...best, st, cap };
}

/* 方案 = 最优阵容 + 每个目标的止损价 + 失手备选。
   止损价取两者的小值：
   · 预算上限：其他目标都按身价买到的话，这个人最多还能花多少
   · 价值上限：把他排除后重算一套最优方案（备选方案），再多付的钱 = 备选方案省下的钱 + 损失的评分 × 本方案每分单价；
     超过这个数，不如直接转头买备选方案
   必抢的人只看预算上限 */
function makePlan(t, tmId, cands, plan) {
  const main = solve(t, tmId, cands, plan, null);
  if (!main.ok) return main;
  const ppp = main.total > 0 ? main.cost / main.total : 0;
  const syn = cands.syn || new Map(), P = playerMap();
  const members = [...main.fixedPos.map(f => f.pid), ...main.pick.map(x => x.pid)];
  const synDetail = pid => members.filter(o => o !== pid).map(o => { const d = synOf(syn, pid, o); return d ? { pid: o, name: pname(P, o), ...d } : null; }).filter(Boolean);
  const targets = main.pick.map(x => {
    const alt = x.must ? { ok: false } : solve(t, tmId, cands, plan, x.pid);
    const budgetCeil = main.cap - (main.cost - x.price);
    let valueCeil = Infinity, altDiff = null;
    if (alt.ok) {
      valueCeil = x.price + (alt.cost - main.cost) + (main.total - alt.total) * ppp;
      altDiff = { in: alt.pick.filter(y => !main.pick.some(z => z.pid === y.pid)), out: main.pick.filter(z => z.pid !== x.pid && !alt.pick.some(y => y.pid === z.pid)), cost: alt.cost, total: alt.total };
    }
    const raw = Math.max(x.price, Math.min(budgetCeil, valueCeil));
    const ceil = Math.max(snap(raw, x.g), x.price);
    const sd = synDetail(x.pid);
    return { ...x, budgetCeil, valueCeil, ceil, alt: altDiff, noAlt: !x.must && !alt.ok, overMax: !!TIER[x.g] && ceil > TIER[x.g].max, synDetail: sd, synSum: sd.reduce((s, d) => s + d.v, 0) };
  }).sort((a, b) => roundIdx(t, a) - roundIdx(t, b) || (a.pos || 9) - (b.pos || 9));
  return { ...main, targets };
}

// ============ 弹窗 ============
const cui = { tmId: null };
function open(t, tmId) {
  if (!t.teams.length) return toast('还没有队伍，先在拍卖页「生成队伍」', 'err');
  const plan = loadPlan(t);
  cui.tmId = tmId || plan.tmId || cui.tmId;
  if (!t.teams.some(x => x.id === cui.tmId)) cui.tmId = t.teams[0].id;
  plan.tmId = cui.tmId; savePlan(t, plan);
  const P = playerMap();

  const render = () => {
    const tm = TN.teamOf(t, cui.tmId), st = teamStat(t, cui.tmId);
    const cands = buildCands(t, plan);
    const list = [...cands].sort((a, b) => (TIERS.indexOf(a.g) + 99) % 99 - (TIERS.indexOf(b.g) + 99) % 99 || b.score - a.score);
    const rows = list.map(c => `<tr class="${c.avoid ? 'cp-avoid' : c.must ? 'cp-must' : ''}" data-pid="${c.pid}">
      <td><span class="${tierCls(c.g)}">${esc(c.g || '无')}</span></td>
      <td><strong>${esc(c.p.name)}</strong><span class="hint"> ${esc(groupPos(c.p))}</span></td>
      <td class="num" title="实力 = ${esc(STRENGTH_MODES[plan.strength] || '')}；内战评分 ${c.rawScore.toFixed(1)}（${c.games} 场）${TIER_SCORE[c.g] != null ? `，定级 ${c.g} 记 ${TIER_SCORE[c.g]}` : ''}">${c.score.toFixed(1)}</td>
      <td class="hint">${c.round ? esc(c.round.name.replace(/·.*/, '')) : '-'}</td>
      <td class="num"><input type="number" class="cp-price" data-pid="${c.pid}" min="1" step="1" value="${c.mine ? c.price : ''}" placeholder="${c.price || '?'}"></td>
      <td><label class="inline" title="必抢：方案一定包含他，止损只看预算"><input type="checkbox" class="cp-must" data-pid="${c.pid}" ${c.must ? 'checked' : ''}></label></td>
      <td><label class="inline" title="不要：方案里不考虑他"><input type="checkbox" class="cp-avoid" data-pid="${c.pid}" ${c.avoid ? 'checked' : ''}></label></td>
    </tr>`).join('');
    showModal(`<h2>队长方案 · ${esc(tm?.name || '')} <span class="hint">身价、必抢、自留只存这台设备，不会同步给其他队长</span></h2>
      <div class="row wrap" style="margin-top:8px;align-items:flex-end">
        <label class="grow">我的队伍<select id="cp-team">${t.teams.map(x => { const s2 = teamStat(t, x.id); return `<option value="${x.id}" ${x.id === cui.tmId ? 'selected' : ''}>${esc(x.name)}（剩 ${fmt(s2.left)} 万 / ${s2.slots} 名额）</option>`; }).join('')}</select></label>
        <label class="grow" title="没填身价的人按档位的这个价估">没填身价时按<select id="cp-mode">${Object.entries(PRICE_MODES).map(([k, v]) => `<option value="${k}" ${k === plan.priceMode ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="grow" title="方案按什么衡量一个人的强弱">实力口径<select id="cp-strength">${Object.entries(STRENGTH_MODES).map(([k, v]) => `<option value="${k}" ${k === plan.strength ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="narrow" title="方案里不动用的钱，留给后面的轮次加价或应急">自留(万)<input type="number" id="cp-reserve" min="0" step="1" value="${plan.reserve || 0}"></label>
        <label class="inline" title="阵容里每对人同队过的胜率偏离五成多少，乘样本置信，计入总分；同队 5 场全胜一对 +6，全败 −6"><input type="checkbox" id="cp-syn" ${plan.synergy === false ? '' : 'checked'}> 算上搭档胜率</label>
        <button type="button" id="cp-paste" title="一行一个「昵称 身价」，批量填">粘贴身价</button>
        <button type="button" id="cp-copy" title="把方案复制成文字，拍卖时看手机">复制方案</button>
        <button type="button" class="ghost" id="cp-clear" title="清掉本机存的身价和标记">清空</button>
      </div>
      <p class="hint" id="cp-sum"></p>
      <div class="cp-grid">
        <div>
          <h4 style="margin:6px 0">身价表 <span class="hint" style="text-transform:none">填你预计的成交价；留空按档位估。改完右边立刻重算</span></h4>
          <div class="table-wrap cp-wrap"><table class="tbl cp-table"><thead><tr><th>档</th><th>选手</th><th class="num" title="悬停看口径">实力</th><th>轮次</th><th class="num">身价</th><th title="必抢">抢</th><th title="不要">弃</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">参赛名单里没有未成交的人</td></tr>'}</tbody></table></div>
        </div>
        <div id="cp-right"></div>
      </div>
      <div class="form-actions" style="justify-content:flex-end"><button type="button" class="ghost" id="cp-close">关闭</button></div>`);
    renderRight();
    $('#cp-close').onclick = hideModal;
    $('#cp-team').onchange = e => { cui.tmId = e.target.value; plan.tmId = cui.tmId; savePlan(t, plan); render(); };
    $('#cp-mode').onchange = e => { plan.priceMode = e.target.value; savePlan(t, plan); render(); };
    $('#cp-strength').onchange = e => { plan.strength = e.target.value; savePlan(t, plan); render(); };
    $('#cp-syn').onchange = e => { plan.synergy = e.target.checked; savePlan(t, plan); renderRight(); };
    $('#cp-reserve').oninput = e => { plan.reserve = Math.max(0, Number(e.target.value) || 0); savePlan(t, plan); renderRight(); };
    $('#cp-clear').onclick = () => { if (!confirm('清掉本机存的身价、必抢、不要和自留？')) return; const keep = plan.tmId; Object.assign(plan, EMPTY(), { tmId: keep }); savePlan(t, plan); render(); };
    $('#cp-paste').onclick = () => openPaste(t, plan, render);
    $('#cp-copy').onclick = async () => {
      const txt = planText(t, plan);
      let ok = false; try { await navigator.clipboard.writeText(txt); ok = true; } catch (e) { /* 浏览器不允许自动复制 */ }
      toast(ok ? '方案已复制' : '浏览器不允许自动复制，请手动复制', ok ? 'ok' : 'err');
      if (!ok) showModal(`<h2>队长方案</h2><textarea rows="18" style="width:100%" readonly>${esc(txt)}</textarea><div class="form-actions"><button type="button" class="ghost" id="cp-back">返回</button></div>`), ($('#cp-back').onclick = render);
    };
    const tbody = $('#modal-content .cp-table tbody');
    tbody.addEventListener('input', e => {
      const inp = e.target.closest('input.cp-price'); if (!inp) return;
      const v = Number(inp.value);
      if (v > 0) plan.prices[inp.dataset.pid] = v; else delete plan.prices[inp.dataset.pid];
      savePlan(t, plan); renderRight();
    });
    tbody.addEventListener('change', e => {
      const cb = e.target.closest('input[type=checkbox]'); if (!cb) return;
      const pid = cb.dataset.pid, isMust = cb.classList.contains('cp-must');
      const list = isMust ? plan.must : plan.avoid, other = isMust ? plan.avoid : plan.must;
      const i = list.indexOf(pid); if (cb.checked && i < 0) list.push(pid); if (!cb.checked && i >= 0) list.splice(i, 1);
      if (cb.checked) { const j = other.indexOf(pid); if (j >= 0) { other.splice(j, 1); const o = tbody.querySelector(`input.${isMust ? 'cp-avoid' : 'cp-must'}[data-pid="${pid}"]`); if (o) o.checked = false; } }
      const tr = cb.closest('tr'); tr.className = plan.avoid.includes(pid) ? 'cp-avoid' : plan.must.includes(pid) ? 'cp-must' : '';
      savePlan(t, plan); renderRight();
    });
  };

  const renderRight = () => {
    const st = teamStat(t, cui.tmId);
    const cands = buildCands(t, plan);
    const priced = cands.filter(c => c.price > 0);
    $('#cp-sum').innerHTML = `剩 <b>${fmt(st.left)}</b> 万 / <b>${st.slots}</b> 个名额${subSlots(t) ? `（每队 ${sizeOf(t)} 人，含 ${subSlots(t)} 名替补）` : ''}${plan.reserve ? `，自留 ${fmt(plan.reserve)} 后可用 <b>${fmt(st.left - plan.reserve)}</b>` : ''} · 余量：S级 ${QUOTA.S - st.sCnt} / A系 ${QUOTA.A - st.aCnt} / 45组 ${max45Of(t) - st.c45} · 候选 ${priced.length} 人（自填身价 ${cands.filter(c => c.mine).length}${cands.length - priced.length ? `，${cands.length - priced.length} 人没档位也没身价，不参与` : ''}）`;
    const r = makePlan(t, cui.tmId, cands, plan);
    const box = $('#cp-right');
    if (!r.ok) { box.innerHTML = `<div class="au-plan"><div class="au-plan-h"><b>最优阵容</b></div><p class="empty">${esc(r.msg)}</p></div>`; return; }
    const P2 = playerMap();
    const synCell = x => { if (!x.synDetail.length) return '<span class="hint">-</span>'; const tip = x.synDetail.map(d => `和 ${d.name} 同队 ${d.w} 胜 ${d.g - d.w} 负 → ${d.v > 0 ? '+' : ''}${d.v.toFixed(1)}`).join('\n'); return `<span class="${x.synSum > 0 ? 'win' : x.synSum < 0 ? 'loss' : ''}" title="${esc(tip)}">${x.synSum > 0 ? '+' : ''}${x.synSum.toFixed(1)}</span>`; };
    const fixedRows = r.fixedPos.map(f => `<tr class="cp-fixed"><td><b class="au-pos">${posLbl(f.pos)}</b></td><td>${esc(pname(P2, f.pid))}<span class="hint"> 已在队</span></td><td></td><td></td><td class="num hint">${fmt(st.deals.find(d => d.pid === f.pid)?.price || 0)}</td><td></td><td></td></tr>`).join('');
    const altText = x => x.must ? '<span class="hint">必抢，不设备选</span>' : x.noAlt ? '<span class="loss">没他就凑不齐</span>' : x.alt.in.length ? `${x.alt.in.map(y => `<b>${esc(y.p.name)}</b><span class="hint">${fmt(y.price)}</span>`).join('、')}${x.alt.out.length ? `<span class="hint">（换下 ${x.alt.out.map(y => esc(y.p.name)).join('、')}）</span>` : ''}` : '-';
    const targetRows = [...r.targets].sort((a, b) => (a.pos || 9) - (b.pos || 9)).map(x => `<tr>
      <td><b class="au-pos" title="${x.pos ? x.pos + ' 号位' : '替补：实力和配合按一半计'}">${posLbl(x.pos)}</b>${x.down ? '<i class="hint" title="不擅长这个位，降位打">↓</i>' : ''}</td>
      <td><b>${esc(x.p.name)}</b>${x.must ? '<span class="pc">必抢</span>' : ''}<span class="hint"> ${esc(x.g || '')}</span></td>
      <td class="num">${x.score.toFixed(1)}</td>
      <td class="num">${synCell(x)}</td>
      <td class="num">${fmt(x.price)}${x.mine ? '' : '<span class="hint" title="没填身价，按档位估">*</span>'}</td>
      <td class="num"><b class="${x.overMax ? 'loss' : 'win'}">${fmt(x.ceil)}</b></td>
      <td class="wrap">${altText(x)}</td></tr>`).join('');
    const byRound = [];
    for (const x of r.targets) { const idx = roundIdx(t, x); const last = byRound[byRound.length - 1]; if (last && last.idx === idx) last.items.push(x); else byRound.push({ idx, name: x.round ? x.round.name : '未编排轮次', items: [x] }); }
    let running = st.left;
    const roundBlocks = byRound.map(b => { const lines = b.items.map(x => { running -= x.price; return `<li><b class="au-pos">${posLbl(x.pos)}</b> ${esc(x.p.name)}：身价 ${fmt(x.price)}，<b>最多出到 ${fmt(x.ceil)}</b>${x.overMax ? `<span class="loss" title="规则七.2：超过档位上限需主持人确认预算余量"> 超档位上限 ${TIER[x.g].max}</span>` : ''}${x.must ? '' : x.noAlt ? '，<span class="loss">失手就凑不齐人</span>' : x.alt.in.length ? `，失手改抢 ${x.alt.in.map(y => esc(y.p.name) + ' ' + fmt(y.price)).join(' / ')}` : ''}</li>`; }).join(''); return `<div class="cp-round"><div class="cp-round-h">${esc(b.name)} <span class="hint">按身价买完剩 ${fmt(running)}</span></div><ul>${lines}</ul></div>`; }).join('');
    const warns = [];
    if (r.targets.some(x => !x.mine)) warns.push('带 * 的身价是按档位估的，填上你的预期会更准');
    if (r.targets.some(x => x.down)) warns.push('带 ↓ 的人要降位打（123 组降打 4/5 不违规）');
    if (r.targets.some(x => x.overMax)) warns.push('红色止损价超过了档位上限，规则七.2 要主持人确认预算余量才能继续加');
    warns.push('止损价是逐个算的：某一个顶到止损买，其他人还按身价买才不超预算；连续多个都顶格就得重算');
    box.innerHTML = `<div class="au-plan">
        <div class="au-plan-h"><b>最优阵容</b><span class="hint">合计身价 <b>${fmt(r.cost)}</b> 万 · 余 ${fmt(r.cap - r.cost)}${plan.reserve ? ' + 自留 ' + fmt(plan.reserve) : ''} · 总分 <b>${r.total.toFixed(0)}</b>${r.syn ? `（实力 ${r.strength.toFixed(0)}，搭档 ${r.syn > 0 ? '+' : ''}${r.syn.toFixed(0)}）` : ''}</span></div>
        <table class="tbl"><thead><tr><th>位</th><th>目标</th><th class="num">实力</th><th class="num" title="和阵容里其他人的同队胜率配合分之和，悬停看明细">配合</th><th class="num">身价</th><th class="num" title="超过这个价就别跟了">止损</th><th>失手备选</th></tr></thead><tbody>${fixedRows}${targetRows}</tbody></table>
      </div>
      <div class="au-plan" style="margin-top:10px">
        <div class="au-plan-h"><b>拍卖顺序</b><span class="hint">按轮次走，每人一条：身价 → 止损 → 失手备选</span></div>
        ${roundBlocks}
        <ul class="hint cp-warns">${warns.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
      </div>`;
  };

  render();
}

// 粘贴身价：一行一个「昵称 身价」或「昵称, 身价」
function openPaste(t, plan, back) {
  showModal(`<h2>粘贴身价 <span class="hint">一行一个：昵称 身价（万）</span></h2>
    <textarea id="cp-p-text" rows="10" placeholder="张三 90&#10;李四, 45&#10;王五	30"></textarea>
    <div class="form-actions" style="margin-top:8px"><button type="button" class="primary" id="cp-p-ok">应用</button><button type="button" class="ghost" id="cp-p-cancel">返回</button></div>
    <div id="cp-p-out"></div>`);
  $('#cp-p-cancel').onclick = back;
  $('#cp-p-ok').onclick = () => {
    const byName = new Map(); for (const p of S().players) byName.set(p.name, p);
    const hit = [], miss = [], bad = [];
    for (const ln of $('#cp-p-text').value.split('\n').map(x => x.trim()).filter(Boolean)) {
      const m = /^(.+?)[\s,，\t:：]+(\d+(?:\.\d+)?)\s*万?$/.exec(ln);
      if (!m) { bad.push(ln); continue; }
      const p = byName.get(m[1].trim()); if (!p) { miss.push(m[1].trim()); continue; }
      hit.push([p.id, Number(m[2])]);
    }
    for (const [pid, v] of hit) plan.prices[pid] = v;
    savePlan(t, plan);
    if (!hit.length) { $('#cp-p-out').innerHTML = `<p class="loss">一个都没匹配上${miss.length ? '：找不到 ' + miss.map(esc).join('、') : ''}${bad.length ? '；格式不对 ' + bad.slice(0, 3).map(esc).join(' / ') : ''}</p>`; return; }
    toast(`已填 ${hit.length} 人的身价${miss.length ? `，${miss.length} 人名单里找不到` : ''}`, miss.length ? 'err' : 'ok');
    back();
  };
}

// 文字版方案，拍卖时看手机用
function planText(t, plan) {
  const cands = buildCands(t, plan), r = makePlan(t, cui.tmId, cands, plan), st = teamStat(t, cui.tmId), tm = TN.teamOf(t, cui.tmId);
  const out = [`【${tm?.name || ''} 队长方案】剩 ${fmt(st.left)} 万 / ${st.slots} 名额${plan.reserve ? `，自留 ${fmt(plan.reserve)}` : ''}`];
  if (!r.ok) { out.push(r.msg); return out.join('\n'); }
  out.push(`最优阵容：合计身价 ${fmt(r.cost)} 万，总分 ${r.total.toFixed(0)}${r.syn ? `（实力 ${r.strength.toFixed(0)}，搭档 ${r.syn > 0 ? '+' : ''}${r.syn.toFixed(0)}）` : ''}`);
  const lbl = p => p ? `${p}号位` : '替补';
  for (const f of r.fixedPos) out.push(`  ${lbl(f.pos)} ${pname(playerMap(), f.pid)}（已在队）`);
  for (const x of [...r.targets].sort((a, b) => (a.pos || 9) - (b.pos || 9))) out.push(`  ${lbl(x.pos)} ${x.p.name}${x.g ? ' ' + x.g : ''}${x.down ? '（降位）' : ''}：身价 ${fmt(x.price)}，止损 ${fmt(x.ceil)}${x.synDetail.length ? `，配合 ${x.synSum > 0 ? '+' : ''}${x.synSum.toFixed(1)}（${x.synDetail.map(d => `${d.name} ${d.w}/${d.g}`).join('、')}）` : ''}${x.must ? '，必抢' : x.noAlt ? '，无备选' : x.alt.in.length ? '，失手改抢 ' + x.alt.in.map(y => `${y.p.name} ${fmt(y.price)}`).join(' / ') : ''}`);
  out.push('拍卖顺序：');
  let running = st.left, cur = null;
  for (const x of r.targets) { const name = x.round ? x.round.name : '未编排轮次'; if (name !== cur) { cur = name; out.push(`${name}`); } running -= x.price; out.push(`  ${x.p.name}：最多出到 ${fmt(x.ceil)}（买完剩 ${fmt(running)}）`); }
  return out.join('\n');
}

window.DotaCaptain = { open, solve, makePlan, loadPlan };
})();
