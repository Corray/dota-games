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
  return a;
}
const enabled = t => !!t.auction;
const gradeOf = (t, pid) => auc(t).grades[pid] || '';
const dealOf = (t, pid) => auc(t).deals.find(d => d.pid === pid) || null;

/* 单队账目：花了多少、剩多少、还差几个名额、配额用量、风险 */
function teamStat(t, tmId) {
  const a = auc(t), P = playerMap();
  const deals = a.deals.filter(d => d.teamId === tmId);
  const spent = deals.reduce((s, d) => s + d.price, 0);
  const left = a.budget - spent, slots = SIZE - deals.length;
  const g = deals.map(d => a.grades[d.pid]);
  const sCnt = g.filter(x => TIER[x]?.cls === 'S').length;
  const aCnt = g.filter(x => TIER[x]?.cls === 'A').length;
  const c45 = deals.filter(d => posGroup(P.get(d.pid)) === '45').length;
  return {
    deals, spent, left, slots, sCnt, aCnt, c45,
    floor: slots * a.minPrice,                       // 五.1 保底所需
    afford: slots > 0 ? left / slots : null,         // 七.3 可支配均价
    bankrupt: left < slots * a.minPrice,             // 保底破产
    blown: spent > a.budget,                         // 五.6 爆仓
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
    const risk = st.blown ? '<span class="au-risk bad">爆仓</span>' : st.bankrupt ? '<span class="au-risk warn">保底破产</span>' : '';
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
      <div class="au-money"><b>${fmt(st.spent)}</b> / ${fmt(a.budget)} 万 · 剩 <b class="${st.bankrupt ? 'loss' : ''}">${fmt(st.left)}</b> · 名额 ${st.slots}
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
      <td>${d ? `<span class="win">${esc(TN.teamOf(t, d.teamId)?.name || '(已删队)')}</span> <b>${fmt(d.price)}</b> 万` : '<span class="hint">未成交</span>'}</td>
      <td class="num">${editable ? (d ? `<button type="button" class="mini danger" data-au-revoke="${d.id}">撤销</button>` : `<button type="button" class="mini" data-au-buy-p="${p.id}">录入成交</button>`) : ''}</td>
    </tr>`;
  }).join('');

  // ---- 公示：剩余预算排名 + 成交流水 ----
  const rank = t.teams.map(tm => ({ tm, st: teamStat(t, tm.id) })).sort((x, y) => y.st.left - x.st.left);
  const flow = [...a.deals].sort((x, y) => y.at - x.at).slice(0, 30);

  return `${cfg}
    <h3 style="margin-top:4px">队伍看板 <span class="hint">硬约束实时校验：预算保底 / 恰好 5 人 / 1-5 号位 / S级≤2 / A系≤3 / 45 组禁打 1-3</span></h3>
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
            return `<tr><td>${esc(pname(P, d.pid))}${d.kind === 'captain' ? '<span class="pc">队长</span>' : ''}${d.kind === 'fa' ? '<span class="pc">自由人</span>' : ''}</td><td>${esc(g || '?')}</td><td>${esc(TN.teamOf(t, d.teamId)?.name || '(已删队)')}</td><td class="num"><b>${fmt(d.price)}</b></td><td class="num ${ov > 100 ? 'loss' : ''}">${ov == null ? '-' : (ov >= 0 ? '+' : '') + Math.round(ov) + '%'}</td><td class="num">${editable ? `<button type="button" class="mini danger" data-au-revoke="${d.id}">撤销</button>` : ''}</td></tr>`; }).join('')
            || '<tr><td colspan="6" class="empty">还没有成交记录</td></tr>'}
        </tbody></table></div>
      </div>
    </div>
    <h3 style="margin-top:16px">选手池 <span class="hint">按档位排序；起拍底价 / 均衡价 / 上限参考出自规则表 1、七.1、七.2</span></h3>
    <div class="tn-toolbar">
      <input type="search" id="au-q" placeholder="搜索昵称 / 档位 / 位置组" value="${esc(ui.q || '')}">
      <label class="inline hint"><input type="checkbox" id="au-open" ${onlyOpen ? 'checked' : ''}> 只看未成交</label>
    </div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>档位</th><th class="num">底价</th><th>选手</th><th>位置组</th><th class="num">均衡价/上限</th><th>成交</th><th></th></tr></thead>
      <tbody>${poolRows || '<tr><td colspan="7" class="empty">选手池是空的 —— 先去「参赛选手」勾人，或直接「导入定级表」（会自动加进参赛名单）</td></tr>'}</tbody></table></div>`;
}

const ui = { q: '', onlyOpen: false };

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
});

window.DotaAuction = { view, TIER, TIERS, checkBid, teamStat, posGroup };
})();
