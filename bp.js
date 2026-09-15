/* BP 助手 —— 选人 / 禁人建议 + 英雄克制查询
   数据：bp-data.json（STRATZ 英雄两两对位 / 同队胜率，由 Sino-Huang/DOTA-2-ban-pick-tool 整理，MIT），千分制整数
   算法：移植自该项目 heuristic.py —— 我方优势 = mean(克制分, 配合分)
     克制分 = 对每个我方英雄，取它对每个敌方英雄的 counter × 1.2 × 号位权重 + 0.5 的平均，再对我方取平均
     配合分 = 我方两两 with 胜率的平均
   草稿存 localStorage（dota-bp-v1），不进 state，不进备份 */
(() => {
'use strict';
const A = window.DotaApp;
if (!A) { console.error('bp.js 必须在 app.js 之后加载'); return; }
const { $, $$, esc, toast, HERO_BY_ID, POS_SHORT, POS_NAME, rankBadge } = A;
const S = () => A.state;

const KEY = 'dota-bp-v1';
const COUNTER_WEIGHT = 1.2;
// TEMP[我方号位][敌方号位]：3 号位更看重克制对方 1 号位，5 号位更看重克制对方 3 号位……（原项目 config.py）
const TEMP = [[1.1, .8, 1.2, .8, .8], [.8, 1.2, .8, .8, .8], [1.3, 1.0, .8, .8, .8], [1.2, 1.2, .8, .8, .8], [.8, .8, 1.4, .8, .8]];
const SUGGEST_N = 8;

let D = null, loading = null;      // STRATZ 数据 + 索引（bp-data.json）
let idx = new Map();               // heroId → 矩阵下标
let OD = null, odLoading = null, odIdx = new Map();   // 第二数据源：OpenDota 职业比赛对位（bp-data-od.json），只有克制维度
const OD_K = 20;                   // 收缩系数：胜率按 (胜 + 10) / (场 + 20) 算，2 场 2 胜不会变成 100%
const bp = load();
function load() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && d.ally && d.enemy) return d; } catch {}
  return { ally: Array.from({ length: 5 }, () => ({ hero: null, pid: null })), enemy: Array.from({ length: 5 }, () => ({ hero: null, pid: null })), bans: [], mode: 'enemy', q: '', focus: null };
}
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(bp)); } catch {} };

// ============ 数据 ============
function ensureData() {
  if (D) return Promise.resolve(D);
  if (!loading) loading = fetch('bp-data.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(d => { D = d; idx = new Map(d.heroes.map((id, i) => [id, i])); return d; })
    .catch(e => { loading = null; throw e; });
  return loading;
}
function ensureOd() {
  if (OD) return Promise.resolve(OD);
  if (!odLoading) odLoading = fetch('bp-data-od.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(d => { OD = d; odIdx = new Map(d.heroes.map((id, i) => [id, i])); return d; })
    .catch(e => { odLoading = null; throw e; });
  return odLoading;
}
const useOd = () => bp.src === 'od' && !!OD;
const has = id => idx.has(id);
// OpenDota 对位：{ v: 收缩后胜率, g: 场次 }
function odVersus(a, b) {
  const i = odIdx.get(a), j = odIdx.get(b);
  if (i == null || j == null) return { v: 0.5, g: 0 };
  const g = OD.games[i][j]; if (!g) return { v: 0.5, g: 0 };
  return { v: (OD.versus[i][j] / 1000 * g + OD_K / 2) / (g + OD_K), g };
}
// 矩阵读取：克制 / 对位胜率按当前数据源；同队胜率 / 配合率只有 STRATZ 有
const M = (name, a, b) => {
  if (useOd() && (name === 'versus' || name === 'counter')) { const { v } = odVersus(a, b); return name === 'versus' ? v : v - 0.5; }
  const i = idx.get(a), j = idx.get(b); return i == null || j == null ? 0 : D[name][i][j] / 1000;
};
const lanes = id => { const i = idx.get(id); return i == null ? [0, 0, 0, 0, 0] : D.lanes[i].map(x => x / 1000); };
const hname = id => HERO_BY_ID[id] || `英雄#${id}`;
const pct = x => (x * 100).toFixed(1) + '%';
const spct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';

// ============ 打分 ============
function heuristic(ally, enemy) {
  const es = enemy.map((h, j) => [h, j]).filter(([h]) => h);
  let vs = 0.5;
  if (es.length) {
    const per = [];
    ally.forEach((a, i) => { if (!a) return; per.push(es.reduce((s, [e, j]) => s + M('counter', a, e) * COUNTER_WEIGHT * TEMP[i][j] + 0.5, 0) / es.length); });
    if (per.length) vs = per.reduce((s, x) => s + x, 0) / per.length;
  }
  const as = ally.filter(Boolean);
  let wt = 0.5, n = 0, sum = 0;
  for (let i = 0; i < as.length; i++) for (let j = i + 1; j < as.length; j++) { sum += M('with', as[i], as[j]); n++; }
  if (n) wt = sum / n;
  return { h: (vs + wt) / 2, vs, wt };
}
const allyIds = () => bp.ally.map(s => s.hero);
const enemyIds = () => bp.enemy.map(s => s.hero);
const usedSet = () => new Set([...allyIds(), ...enemyIds(), ...bp.bans].filter(Boolean));

// 某一侧某号位的候选池：绑定了选手用选手的擅长英雄（并入默认池但标记），否则用默认池
function candidates(side, pos) {
  const slot = bp[side][pos];
  const P = A.playerMap(); const p = slot.pid ? P.get(slot.pid) : null;
  const mine = new Set((p?.heroes || []).map(n => Object.keys(HERO_BY_ID).find(k => HERO_BY_ID[k] === n)).filter(Boolean).map(Number));
  const base = new Set([...D.pools[pos], ...mine]);
  if (bp.wide) D.heroes.forEach(id => { if (lanes(id)[pos] >= 0.05) base.add(id); });
  const used = usedSet();
  return [...base].filter(id => has(id) && !used.has(id)).map(id => ({ id, mine: mine.has(id) }));
}

// 我方各空位推荐：把候选放进该位后的整体优势
function suggestPicks() {
  const ally = allyIds(), enemy = enemyIds();
  const base = heuristic(ally, enemy);
  const out = [];
  bp.ally.forEach((s, pos) => {
    if (s.hero) return;
    const rows = candidates('ally', pos).map(c => { const a = [...ally]; a[pos] = c.id; const r = heuristic(a, enemy); return { ...c, ...r, d: r.h - base.h }; })
      .sort((x, y) => y.h - x.h);
    out.push({ pos, rows, worst: [...rows].reverse().slice(0, 3) });
  });
  return { base, out };
}
// 禁用建议：敌方各空位放入候选后，对我方优势伤害最大的
function strength(id) { let s = 0, n = 0; for (const h of D.heroes) { if (h === id) continue; const v = M('versus', id, h); if (v) { s += v; n++; } } return n ? s / n : 0.5; }
function suggestBans() {
  const ally = allyIds(), enemy = enemyIds();
  if (!ally.some(Boolean)) {   // 没有我方英雄时克制分恒为 0.5，改按版本强势度排
    const best = new Map();
    bp.enemy.forEach((s, pos) => { if (s.hero) return; for (const c of candidates('enemy', pos)) { const cur = best.get(c.id); const st = strength(c.id); if (!cur || lanes(c.id)[pos] > lanes(c.id)[cur.pos]) best.set(c.id, { id: c.id, h: st, d: st - 0.5, pos, mine: c.mine || cur?.mine, byStrength: true }); } });
    return [...best.values()].sort((x, y) => (Number(!!y.mine) - Number(!!x.mine)) || (y.h - x.h)).slice(0, 10);   // 对方选手擅长的永远排前面
  }
  const base = heuristic(ally, enemy).h;
  const best = new Map();
  bp.enemy.forEach((s, pos) => {
    if (s.hero) return;
    for (const c of candidates('enemy', pos)) {
      const e = [...enemy]; e[pos] = c.id; const h = heuristic(ally, e).h;
      const cur = best.get(c.id); if (!cur || h < cur.h) best.set(c.id, { id: c.id, h, d: h - base, pos, mine: c.mine || cur?.mine });
    }
  });
  return [...best.values()].sort((x, y) => (Number(!!y.mine) - Number(!!x.mine)) || (x.h - y.h)).slice(0, 10);   // 对方选手擅长的永远排前面
}
// 英雄查询：它克制的 / 克制它的 / 配合好的
function heroInfo(id) {
  const others = D.heroes.filter(h => h !== id);
  const by = (name, dir) => [...others].sort((a, b) => dir * (M(name, id, b) - M(name, id, a))).slice(0, 8).map(h => ({ id: h, v: M(name, id, h), g: useOd() && name === 'versus' ? odVersus(id, h).g : null }));
  return { good: by('versus', 1), bad: by('versus', -1), with: by('with', 1), lanes: lanes(id) };
}
// 自动分配号位：把这一侧所有自动放入（未手动换位）的英雄一起重排，取出场率总和最大的排列；手动定过位置的槽固定不动
function autoAssign(side) {
  const arr = bp[side];
  const free = arr.map((s, i) => (!s.hero || s.auto) ? i : -1).filter(i => i >= 0);
  const heroes = free.map(i => arr[i].hero).filter(Boolean);
  if (heroes.length < 2) return;
  let best = null, bv = -1;
  const perm = (rest, acc) => {
    if (acc.length === heroes.length) { const v = acc.reduce((s, pos, k) => s + lanes(heroes[k])[pos], 0); if (v > bv) { bv = v; best = [...acc]; } return; }
    rest.forEach((pos, k) => perm(rest.filter((_, j) => j !== k), [...acc, pos]));
  };
  perm(free, []);
  free.forEach(i => { arr[i].hero = null; arr[i].auto = false; });
  best.forEach((pos, k) => { arr[pos].hero = heroes[k]; arr[pos].auto = true; });
}
// 放英雄：挑空位里该英雄出场率最高的号位
function bestEmptyPos(side, id) {
  const l = lanes(id); let best = -1, bv = -1;
  bp[side].forEach((s, i) => { if (!s.hero && l[i] > bv) { bv = l[i]; best = i; } });
  return best;
}

// ============ 操作 ============
function placeHero(id, side, pos) {
  removeHero(id);
  if (side === 'ban') { bp.bans.push(id); return; }
  const auto = pos == null;
  if (auto) pos = bestEmptyPos(side, id);
  if (pos < 0) return toast(side === 'ally' ? '我方已满 5 人' : '敌方已满 5 人', 'err');
  bp[side][pos].hero = id; bp[side][pos].auto = auto;
  if (auto) autoAssign(side);
  if (bp.target && bp[bp.target.side][bp.target.pos].hero) bp.target = null;
}
function removeHero(id) {
  for (const side of ['ally', 'enemy']) bp[side].forEach(s => { if (s.hero === id) s.hero = null; });
  bp.bans = bp.bans.filter(x => x !== id);
}
function whereIs(id) {
  if (bp.ally.some(s => s.hero === id)) return 'ally';
  if (bp.enemy.some(s => s.hero === id)) return 'enemy';
  if (bp.bans.includes(id)) return 'ban';
  return null;
}
function onHeroClick(id) {
  if (bp.mode === 'view') { bp.focus = id; persist(); render(); return; }
  if (!has(id)) return toast('这个英雄还没有对位数据', 'err');
  if (bp.target && !whereIs(id)) { placeHero(id, bp.target.side, bp.target.pos); bp.target = null; }
  else if (whereIs(id)) removeHero(id); else placeHero(id, bp.mode, null);
  persist(); render();
}

// ============ 渲染 ============
function render() {
  const root = $('#bp-root'); if (!root) return;
  if (!D) {
    root.innerHTML = '<div class="card"><p class="empty">正在加载英雄对位数据…</p></div>';
    ensureData().then(() => bp.src === 'od' ? ensureOd().catch(() => { bp.src = 'stratz'; }) : null).then(render)
      .catch(e => { root.innerHTML = `<div class="card"><p class="empty">加载 bp-data.json 失败：${esc(e.message)}</p></div>`; });
    return;
  }
  const P = A.playerMap();
  const players = [...S().players].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const ev = heuristic(allyIds(), enemyIds());
  const anyAlly = allyIds().some(Boolean), anyEnemy = enemyIds().some(Boolean);

  const slotHtml = (side, s, i) => {
    const p = s.pid ? P.get(s.pid) : null;
    const l = s.hero ? lanes(s.hero) : null;
    const isTarget = bp.target && bp.target.side === side && bp.target.pos === i;
    return `<div class="bp-slot ${s.hero ? 'filled' : 'empty'} ${isTarget ? 'target' : ''}" data-side="${side}" data-pos="${i}" ${s.hero ? '' : 'title="点一下选中这个位置，再点下方英雄就放到这里"'}>
      <span class="pos-chip" title="${POS_NAME[i + 1]}">${POS_SHORT[i + 1]}</span>
      <span class="bp-slot-hero">${s.hero ? esc(hname(s.hero)) : `<span class="hint">${isTarget ? '← 点下方英雄放到这里' : '空位'}</span>`}${l ? `<span class="hint" title="该英雄在此号位的出场率（STRATZ）"> ${Math.round(l[i] * 100)}%</span>` : ''}</span>
      ${s.hero ? `<label class="bp-move hint">换位 <select data-act="move" title="把这个英雄换到别的号位（对方位置上的英雄会互换）">${[0, 1, 2, 3, 4].map(k => `<option value="${k}" ${k === i ? 'selected' : ''}>${POS_SHORT[k + 1]}</option>`).join('')}</select></label>` : ''}
      <select data-act="pid" title="绑定名单里的选手：推荐 / 禁用会优先用他的擅长英雄"><option value="">选手…</option>${players.map(x => `<option value="${x.id}" ${x.id === s.pid ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      ${s.hero ? `<button type="button" class="slot-remove" data-act="rm" title="移出">×</button>` : ''}
      ${p && p.heroes.length ? `<div class="bp-slot-pool hint">${p.heroes.map(h => { const id = Number(Object.keys(HERO_BY_ID).find(k => HERO_BY_ID[k] === h)); const w = id ? whereIs(id) : null; return `<button type="button" class="mini ${w ? 'used' : ''}" data-act="quick" data-hero="${id || ''}" ${!id || !has(id) ? 'disabled' : ''} title="${w ? '已在阵容 / 禁用里' : '放到这个位置'}">${esc(h)}</button>`; }).join('')}</div>` : ''}
    </div>`;
  };
  const modeBtn = (m, label, cls) => `<button type="button" class="bp-mode ${cls || ''} ${bp.mode === m ? 'on' : ''}" data-mode="${m}">${label}</button>`;

  // 推荐区
  let right = '';
  if (bp.mode === 'view' || bp.focus) {
    const f = bp.focus;
    if (f && has(f)) {
      const info = heroInfo(f);
      const list = (rows, fmt) => `<div class="bp-list">${rows.map(r => `<button type="button" class="bp-cand" data-act="focus" data-hero="${r.id}" ${r.g != null ? `title="${r.g} 场职业比赛，已按场次收缩"` : ''}><span>${esc(hname(r.id))}</span><b>${fmt(r.v)}</b>${r.g != null ? `<i class="hint">${r.g}场</i>` : ''}</button>`).join('')}</div>`;
      right += `<div class="card"><div class="card-head"><h3>英雄查询：${esc(hname(f))}</h3><span class="hint">常见号位 ${info.lanes.map((v, i) => `${POS_SHORT[i + 1]} ${Math.round(v * 100)}%`).join(' · ')}</span></div>
        <div class="bp-grid3">
          <div><h4>它克制的 <span class="hint">对位胜率</span></h4>${list(info.good, pct)}</div>
          <div><h4>克制它的 <span class="hint">对位胜率</span></h4>${list(info.bad, pct)}</div>
          <div><h4>配合好的 <span class="hint">同队胜率</span></h4>${list(info.with, pct)}</div>
        </div>
        <div class="form-actions" style="margin-top:8px"><button type="button" class="mini" data-act="place" data-side="ally" data-hero="${f}">放入我方</button><button type="button" class="mini" data-act="place" data-side="enemy" data-hero="${f}">放入敌方</button><button type="button" class="mini" data-act="place" data-side="ban" data-hero="${f}">禁用</button><button type="button" class="mini" data-act="unfocus">关闭</button></div></div>`;
    } else if (bp.mode === 'view') right += '<div class="card"><p class="empty">「查询」模式下点任意英雄，看它克制谁、被谁克制、和谁配合好。</p></div>';
  }
  if (!anyAlly && !anyEnemy) {
    right += '<div class="card"><p class="empty">先把敌方已选的英雄放进去（默认「敌方」模式，点下方英雄即可），这里会按我方每个号位给出推荐和禁用建议。也可以先放我方英雄，看配合。</p></div>';
  } else {
    const { out } = suggestPicks();
    const bans = suggestBans(); const byStr = !!bans[0]?.byStrength;
    right += `<div class="card"><div class="card-head"><h3>我方推荐 <span class="hint">数字是放入后我方整体优势，50% 为均势</span></h3><div class="inline-actions">${anyAlly && anyEnemy ? `<span class="bp-eval">当前 <b>${pct(ev.h)}</b> <span class="hint">克制 ${pct(ev.vs)} · 配合 ${pct(ev.wt)}</span></span>` : ''}<label class="inline hint" title="默认只从该号位的常用英雄池里挑；勾上后所有在该号位出场率 ≥ 5% 的英雄都参与"><input type="checkbox" id="bp-wide" ${bp.wide ? 'checked' : ''}> 全英雄候选</label></div></div>
      ${out.length ? out.map(({ pos, rows, worst }) => `<div class="bp-pos-block"><h4>${POS_NAME[pos + 1]}${bp.ally[pos].pid ? ` <span class="hint">${esc(P.get(bp.ally[pos].pid)?.name || '')} 的英雄池 ★</span>` : ''}</h4>
        <div class="bp-list">${rows.slice(0, SUGGEST_N).map(r => `<button type="button" class="bp-cand ${r.mine ? 'mine' : ''}" data-act="pick" data-pos="${pos}" data-hero="${r.id}" title="克制 ${pct(r.vs)} · 配合 ${pct(r.wt)}${r.mine ? ' · 选手擅长' : ''}">${r.mine ? '★ ' : ''}<span>${esc(hname(r.id))}</span><b>${pct(r.h)}</b><i class="${r.d >= 0 ? 'up' : 'down'}">${spct(r.d)}</i></button>`).join('') || '<span class="hint">没有可选英雄</span>'}</div>
        ${worst.length ? `<div class="hint bp-avoid">避坑：${worst.map(r => `${esc(hname(r.id))} ${pct(r.h)}`).join('、')}</div>` : ''}</div>`).join('') : '<p class="hint">我方 5 个位置都已选满</p>'}
    </div>
    <div class="card"><div class="card-head"><h3>禁用建议 <span class="hint">${byStr ? '我方还没选人，先按版本强势度（平均对位胜率）排' : '敌方空位放入后对我方伤害最大的'}</span></h3></div>
      ${bans.length ? `<div class="bp-list">${bans.map(r => `<button type="button" class="bp-cand ban ${r.mine ? 'mine' : ''}" data-act="ban" data-hero="${r.id}" title="${byStr ? `平均对位胜率 ${pct(r.h)}` : `敌方 ${POS_SHORT[r.pos + 1]} 选它后我方优势 ${pct(r.h)}`}${r.mine ? ' · 对方选手擅长' : ''}">${r.mine ? '★ ' : ''}<span>${esc(hname(r.id))}</span><span class="pos-chip">${POS_SHORT[r.pos + 1]}</span><i class="${byStr ? 'up' : 'down'}">${byStr ? pct(r.h) : spct(r.d)}</i></button>`).join('')}</div>
      <p class="hint">★ = 敌方绑定选手的擅长英雄，永远排在最前；内战里对手会玩什么比版本数据更重要。</p>` : '<p class="hint">敌方已满或没有候选</p>'}
    </div>`;
  }

  // 英雄网格
  const q = bp.q.trim().toLowerCase();
  const heroes = Object.entries(HERO_BY_ID).map(([id, n]) => [Number(id), n]).filter(([, n]) => !q || n.toLowerCase().includes(q)).sort((a, b) => a[1].localeCompare(b[1], 'zh'));
  const grid = heroes.map(([id, n]) => { const w = whereIs(id); return `<button type="button" class="bp-hero ${w || ''} ${has(id) ? '' : 'nodata'} ${bp.focus === id ? 'focus' : ''}" data-act="hero" data-hero="${id}" title="${has(id) ? (w === 'ally' ? '我方 · 点击移出' : w === 'enemy' ? '敌方 · 点击移出' : w === 'ban' ? '已禁用 · 点击撤销' : '') : '无对位数据'}">${esc(n)}</button>`; }).join('');

  root.innerHTML = `<div class="bp-layout">
    <div class="bp-left">
      <div class="card">
        <div class="card-head"><h2>阵容</h2><div class="inline-actions"><button type="button" class="ghost" data-act="swap" title="我方 / 敌方互换">交换</button><button type="button" class="ghost" data-act="reset">清空</button></div></div>
        <div class="bp-modes"><span class="hint">点英雄放入：</span>${modeBtn('ally', '我方', 'ally')}${modeBtn('enemy', '敌方', 'enemy')}${modeBtn('ban', '禁用', 'ban')}${modeBtn('view', '查询', '')}</div>
        <p class="hint" style="margin:-6px 0 10px">号位默认按出场率自动排；想指定位置，先点一个空位再点英雄，或用已放入英雄旁的「换位」。</p>
        <div class="bp-side ally"><div class="bp-side-head">我方</div>${bp.ally.map((s, i) => slotHtml('ally', s, i)).join('')}</div>
        <div class="bp-side enemy"><div class="bp-side-head">敌方 <span class="hint">位置按出场率猜，可手动改</span></div>${bp.enemy.map((s, i) => slotHtml('enemy', s, i)).join('')}</div>
        <div class="bp-bans"><span class="hint">已禁用：</span>${bp.bans.length ? bp.bans.map(id => `<button type="button" class="mini" data-act="hero" data-hero="${id}" title="点击撤销">${esc(hname(id))} ×</button>`).join('') : '<span class="hint">无</span>'}</div>
      </div>
    </div>
    <div class="bp-right">${right}</div>
  </div>
  <div class="card">
    <div class="card-head"><h3>英雄 <span class="hint">当前模式：${{ ally: '放入我方', enemy: '放入敌方', ban: '禁用', view: '查询' }[bp.mode]}</span></h3><input type="search" id="bp-q" placeholder="搜索英雄" value="${esc(bp.q)}"></div>
    <div class="bp-heroes">${grid}</div>
    <div class="bp-src hint" style="margin-top:10px">克制数据源：
      <label class="inline"><input type="radio" name="bp-src" value="stratz" ${bp.src !== 'od' ? 'checked' : ''}> STRATZ 天梯（传奇-冠绝，截止 ${esc(D.updated)}）</label>
      <label class="inline"><input type="radio" name="bp-src" value="od" ${bp.src === 'od' ? 'checked' : ''}> OpenDota 职业比赛${OD ? `（截止 ${esc(OD.updated)}）` : ''}</label>
      <span>${useOd() ? '职业比赛样本小，冷门对位只有几场，胜率已按场次向 50% 收缩；配合分仍用 STRATZ。' : `同队胜率 / 配合率只有 STRATZ 有；OpenDota 源只替换克制维度。`}</span>
    </div>
  </div>`;
  const qi = $('#bp-q'); if (qi && document.activeElement !== qi && bp._qFocus) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
}

// ============ 事件 ============
(function init() {
  const root = $('#bp-root'); if (!root) return;
  root.addEventListener('click', e => {
    const mb = e.target.closest('.bp-mode'); if (mb) { bp.mode = mb.dataset.mode; if (bp.mode !== 'view') bp.focus = null; persist(); render(); return; }
    const emptySlot = e.target.closest('.bp-slot.empty');
    if (emptySlot && !e.target.closest('select,button')) {
      const side = emptySlot.dataset.side, pos = Number(emptySlot.dataset.pos);
      bp.target = bp.target && bp.target.side === side && bp.target.pos === pos ? null : { side, pos };
      if (bp.target && bp.mode === 'view') bp.mode = side;
      persist(); render(); return;
    }
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const act = b.dataset.act; const id = Number(b.dataset.hero) || null;
    if (act === 'hero') onHeroClick(id);
    else if (act === 'pick') { placeHero(id, 'ally', Number(b.dataset.pos)); }
    else if (act === 'ban') { placeHero(id, 'ban'); }
    else if (act === 'place') { if (b.dataset.side === 'ban') placeHero(id, 'ban'); else placeHero(id, b.dataset.side, null); bp.focus = null; if (bp.mode === 'view') bp.mode = 'enemy'; }
    else if (act === 'focus') { bp.focus = id; }
    else if (act === 'unfocus') { bp.focus = null; if (bp.mode === 'view') bp.mode = 'enemy'; }
    else if (act === 'quick') { const slot = b.closest('.bp-slot'); placeHero(id, slot.dataset.side, Number(slot.dataset.pos)); }
    else if (act === 'rm') { const slot = b.closest('.bp-slot'); bp[slot.dataset.side][Number(slot.dataset.pos)].hero = null; }
    else if (act === 'swap') { [bp.ally, bp.enemy] = [bp.enemy, bp.ally]; }
    else if (act === 'reset') { if (!confirm('清空我方 / 敌方 / 禁用？（选手绑定保留）')) return; bp.ally.forEach(s => s.hero = null); bp.enemy.forEach(s => s.hero = null); bp.bans = []; bp.focus = null; }
    else return;
    persist(); render();
  });
  root.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 'bp-wide') { bp.wide = el.checked; persist(); render(); return; }
    if (el.name === 'bp-src') {
      const v = el.value;
      if (v === 'od' && !OD) { el.disabled = true; ensureOd().then(() => { bp.src = 'od'; persist(); render(); }).catch(err => { toast('加载 OpenDota 对位数据失败：' + err.message + '（先跑 scripts/fetch-opendota-matchups.mjs 生成 bp-data-od.json）', 'err'); render(); }); return; }
      bp.src = v; persist(); render(); return;
    }
    const slot = el.closest('.bp-slot'); if (!slot) return;
    const side = slot.dataset.side, pos = Number(slot.dataset.pos);
    if (el.dataset.act === 'pid') {
      const pid = el.value || null;
      if (pid) bp[side].forEach((s, i) => { if (i !== pos && s.pid === pid) s.pid = null; });   // 一个选手只能在一个位置
      bp[side][pos].pid = pid;
    } else if (el.dataset.act === 'move') {
      const to = Number(el.value); const arr = bp[side];
      [arr[pos].hero, arr[to].hero] = [arr[to].hero, arr[pos].hero];
      arr[pos].auto = false; arr[to].auto = false;   // 手动定位后不再被自动重排
    } else return;
    persist(); render();
  });
  root.addEventListener('input', e => { if (e.target.id === 'bp-q') { bp.q = e.target.value; bp._qFocus = true; render(); bp._qFocus = false; } });
})();

A.hooks.renderTab.bp = render;
})();
