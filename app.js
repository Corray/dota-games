/* Dota 2 内战记录 —— 纯静态单页，数据存 localStorage */
(() => {
'use strict';

// ============ 常量 ============
const STORAGE_KEY = 'dota-records-v1';
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
const OPENDOTA = 'https://api.opendota.com/api';

// ============ 状态 ============
let state = load();
const ui = {
  tab: 'players',
  editingPlayer: null,
  heroTags: [],
  playerSearch: '',
  editingMatch: null,
  activeTeam: 'radiant',
  draft: newDraft(),
  poolSearch: '',
  matchFilter: { pid: '', q: '' },
  statsSort: { key: 'wr', dir: -1 },
};

function newDraft() {
  return { radiant: [null, null, null, null, null], dire: [null, null, null, null, null], winner: null };
}

// ============ 工具 ============
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const pct = (w, g) => g ? Math.round(w / g * 1000) / 10 + '%' : '-';
const pctNum = (w, g) => g ? w / g : -1;
const rankCls = r => 'r' + (RANKS.indexOf(r) + 1);
const rankBadge = p => `<span class="rank ${rankCls(p.rank)}">${esc(p.rank)}${p.stars ? ' ' + p.stars : ''}</span>`;
const playerMap = () => new Map(state.players.map(p => [p.id, p]));
const pname = (P, pid) => P.get(pid)?.name ?? '(已删除)';
const rankIdx = p => RANKS.indexOf(p.rank) * 10 + (p.stars || 0);

let toastTimer;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2200);
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { const d = JSON.parse(raw); return { players: d.players || [], matches: d.matches || [] }; }
  } catch (e) { console.warn('读取本地数据失败', e); }
  return { players: [], matches: [] };
}
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

// ============ 统计计算 ============
function computeStats(matches) {
  const ps = {}, heroes = {}, duos = {};
  let radiantWins = 0, durSum = 0, durN = 0;
  const sorted = [...matches].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
  const getP = pid => ps[pid] ||= { pid, g: 0, w: 0, rg: 0, rw: 0, dg: 0, dw: 0, pos: {}, heroes: {}, mates: {}, opps: {}, streak: 0, results: [], k: 0, d: 0, a: 0, kdaG: 0 };
  for (const m of sorted) {
    if (m.winner === 'radiant') radiantWins++;
    if (m.duration) { durSum += m.duration; durN++; }
    for (const side of ['radiant', 'dire']) {
      const won = m.winner === side;
      const team = m[side] || [], other = m[side === 'radiant' ? 'dire' : 'radiant'] || [];
      for (const s of team) {
        const st = getP(s.pid);
        st.g++; if (won) st.w++;
        if (side === 'radiant') { st.rg++; if (won) st.rw++; } else { st.dg++; if (won) st.dw++; }
        if (s.kda) { st.k += s.kda[0]; st.d += s.kda[1]; st.a += s.kda[2]; st.kdaG++; }
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
  return { players: ps, heroes, duos, total: matches.length, radiantWins, avgDuration: durN ? durSum / durN : null };
}
const topKey = (obj, by = 'g') => Object.entries(obj).sort((a, b) => b[1][by] - a[1][by])[0]?.[0];

// ============ Tab 切换 ============
function switchTab(tab) {
  ui.tab = tab;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  renderAll();
}
$$('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

function renderAll() {
  if (ui.tab === 'players') renderPlayers();
  else if (ui.tab === 'record') renderTeams();
  else if (ui.tab === 'matches') renderMatches();
  else if (ui.tab === 'stats') renderStats();
}

// ============ 选手名单 ============
(function initPlayerForm() {
  $('#p-rank').innerHTML = RANKS.map(r => `<option ${r === '传奇' ? 'selected' : ''}>${r}</option>`).join('');
  $('#p-positions').innerHTML = [1, 2, 3, 4, 5].map(i => `<label><input type="checkbox" value="${i}"> ${POS_NAME[i]}</label>`).join('');
  $('#hero-list').innerHTML = HEROES.map(h => `<option value="${h}">`).join('');

  const heroInput = $('#p-hero');
  const addHeroTags = raw => {
    raw.split(/[,，、/\s]+/).map(s => s.trim()).filter(Boolean).forEach(h => { if (!ui.heroTags.includes(h)) ui.heroTags.push(h); });
    heroInput.value = ''; renderHeroTags();
  };
  heroInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addHeroTags(heroInput.value); } });
  heroInput.addEventListener('input', () => { if (HEROES.includes(heroInput.value.trim())) addHeroTags(heroInput.value); });
  heroInput.addEventListener('blur', () => { if (heroInput.value.trim()) addHeroTags(heroInput.value); });
  $('#p-hero-tags').addEventListener('click', e => {
    const b = e.target.closest('button[data-hero]'); if (!b) return;
    ui.heroTags = ui.heroTags.filter(h => h !== b.dataset.hero); renderHeroTags();
  });

  $('#player-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#p-name').value.trim();
    if (!name) return toast('请填写昵称', 'err');
    if (state.players.some(p => p.name === name && p.id !== ui.editingPlayer)) return toast('已有同名选手', 'err');
    if (heroInput.value.trim()) addHeroTags(heroInput.value);
    const data = {
      name, rank: $('#p-rank').value, stars: Number($('#p-stars').value),
      positions: $$('#p-positions input:checked').map(i => Number(i.value)),
      heroes: [...ui.heroTags], note: $('#p-note').value.trim(),
      accountId: parseAccountId($('#p-account').value),
    };
    if (data.accountId && state.players.some(p => p.accountId === data.accountId && p.id !== ui.editingPlayer)) return toast('该 Steam ID 已绑定到其他选手', 'err');
    if (ui.editingPlayer) {
      const p = state.players.find(p => p.id === ui.editingPlayer);
      Object.assign(p, data); toast('已更新 ' + name, 'ok');
    } else {
      state.players.push({ id: uid(), createdAt: Date.now(), ...data }); toast('已添加 ' + name, 'ok');
    }
    save(); resetPlayerForm(); renderPlayers();
  });
  $('#p-cancel').addEventListener('click', resetPlayerForm);
  $('#player-search').addEventListener('input', e => { ui.playerSearch = e.target.value; renderPlayers(); });

  $('#player-table').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const p = state.players.find(p => p.id === b.dataset.id); if (!p) return;
    if (b.dataset.act === 'edit') startEditPlayer(p);
    else if (b.dataset.act === 'del') {
      const used = state.matches.filter(m => [...m.radiant, ...m.dire].some(s => s.pid === p.id)).length;
      if (!confirm(`删除选手「${p.name}」？${used ? `\n该选手出现在 ${used} 场比赛中，比赛记录会保留但显示为「已删除」。` : ''}`)) return;
      state.players = state.players.filter(x => x.id !== p.id);
      if (ui.editingPlayer === p.id) resetPlayerForm();
      save(); renderPlayers(); toast('已删除', 'ok');
    } else if (b.dataset.act === 'detail') showPlayerDetail(p.id);
  });

  $('#bulk-import').addEventListener('click', () => {
    const lines = $('#bulk-text').value.split('\n').map(s => s.trim()).filter(Boolean);
    let added = 0, skipped = [];
    for (const line of lines) {
      const parts = line.split(/[,，]/).map(s => s.trim());
      const name = parts[0];
      if (!name || state.players.some(p => p.name === name)) { skipped.push(name || '(空)'); continue; }
      const rankRaw = parts[1] || '';
      const rank = RANKS.find(r => rankRaw.startsWith(r)) || '传奇';
      const stars = Number((rankRaw.match(/\d/) || [3])[0]) || 3;
      const positions = (parts[2] || '').match(/[1-5]/g)?.map(Number) || [];
      const heroes = (parts[3] || '').split(/[\/、\s]+/).map(s => s.trim()).filter(Boolean);
      const accountId = parseAccountId(parts[4] || '');
      state.players.push({ id: uid(), createdAt: Date.now(), name, rank, stars, positions: [...new Set(positions)], heroes, note: '', accountId });
      added++;
    }
    save(); renderPlayers();
    if (added) $('#bulk-text').value = '';
    toast(`导入 ${added} 人${skipped.length ? `，跳过 ${skipped.length} 个（重名或为空）` : ''}`, added ? 'ok' : 'err');
  });
})();

function renderHeroTags() {
  $('#p-hero-tags').innerHTML = ui.heroTags.map(h => `<span class="tag">${esc(h)}<button type="button" data-hero="${esc(h)}" title="移除">×</button></span>`).join('');
}
function startEditPlayer(p) {
  ui.editingPlayer = p.id; ui.heroTags = [...p.heroes];
  $('#p-name').value = p.name; $('#p-rank').value = p.rank; $('#p-stars').value = p.stars || 3;
  $$('#p-positions input').forEach(i => i.checked = p.positions.includes(Number(i.value)));
  $('#p-note').value = p.note || '';
  $('#p-account').value = p.accountId || '';
  renderHeroTags();
  $('#player-form-title').textContent = '编辑选手：' + p.name;
  $('#p-submit').textContent = '保存修改';
  $('#p-cancel').classList.remove('hidden');
  $('#p-name').focus();
}
function resetPlayerForm() {
  ui.editingPlayer = null; ui.heroTags = [];
  $('#player-form').reset(); $('#p-rank').value = '传奇'; $('#p-stars').value = 3;
  renderHeroTags();
  $('#player-form-title').textContent = '添加选手';
  $('#p-submit').textContent = '添加选手';
  $('#p-cancel').classList.add('hidden');
}

function renderPlayers() {
  const stats = computeStats(state.matches).players;
  const q = ui.playerSearch.trim().toLowerCase();
  const list = state.players
    .filter(p => !q || p.name.toLowerCase().includes(q) || p.rank.includes(q) || p.heroes.some(h => h.includes(q)))
    .sort((a, b) => rankIdx(b) - rankIdx(a) || a.name.localeCompare(b.name, 'zh'));
  $('#player-count').textContent = state.players.length;
  $('#player-empty').classList.toggle('hidden', state.players.length > 0);
  $('#player-table tbody').innerHTML = list.map(p => {
    const s = stats[p.id];
    return `<tr>
      <td><button class="name-btn" data-act="detail" data-id="${p.id}">${esc(p.name)}</button>${p.accountId ? `<div class="hint" title="Steam 账号 ID">🆔 ${p.accountId}</div>` : ''}${p.note ? `<div class="hint">${esc(p.note)}</div>` : ''}</td>
      <td>${rankBadge(p)}</td>
      <td>${p.positions.map(i => `<span class="pos-chip">${POS_SHORT[i]}</span>`).join('') || '<span class="hint">-</span>'}</td>
      <td class="wrap">${p.heroes.map(h => `<span class="hero-chip">${esc(h)}</span>`).join('') || '<span class="hint">-</span>'}</td>
      <td class="num">${s ? s.g : 0}</td>
      <td class="num">${s ? pct(s.w, s.g) : '-'}</td>
      <td><div class="actions"><button data-act="edit" data-id="${p.id}">编辑</button><button class="danger" data-act="del" data-id="${p.id}">删除</button></div></td>
    </tr>`;
  }).join('');
}

// ============ 记录比赛 ============
(function initRecord() {
  $('#m-date').value = today();
  $('#teams').addEventListener('click', e => {
    const head = e.target.closest('.team-head');
    if (head) { ui.activeTeam = head.closest('.team').dataset.team; renderTeams(); return; }
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const slotEl = b.closest('.slot'); const team = slotEl.closest('.team').dataset.team; const idx = Number(slotEl.dataset.idx);
    const slot = ui.draft[team][idx]; if (!slot) return;
    if (b.dataset.act === 'remove') { ui.draft[team][idx] = null; renderTeams(); }
    else if (b.dataset.act === 'quickhero') { slot.hero = b.dataset.hero; renderTeams(); }
  });
  $('#teams').addEventListener('change', e => {
    const el = e.target; const slotEl = el.closest('.slot'); if (!slotEl) return;
    const slot = ui.draft[slotEl.closest('.team').dataset.team][Number(slotEl.dataset.idx)]; if (!slot) return;
    if (el.dataset.act === 'pos') slot.pos = Number(el.value);
  });
  $('#teams').addEventListener('input', e => {
    const el = e.target; if (el.dataset.act !== 'hero') return;
    const slotEl = el.closest('.slot');
    const slot = ui.draft[slotEl.closest('.team').dataset.team][Number(slotEl.dataset.idx)]; if (slot) slot.hero = el.value.trim();
  });
  $('#pool').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    togglePlayerInDraft(c.dataset.id);
  });
  $('#pool-search').addEventListener('input', e => { ui.poolSearch = e.target.value; renderTeams(); });
  $('#win-radiant').addEventListener('click', () => { ui.draft.winner = 'radiant'; renderTeams(); });
  $('#win-dire').addEventListener('click', () => { ui.draft.winner = 'dire'; renderTeams(); });

  $('#btn-shuffle').addEventListener('click', () => {
    const chosen = [...ui.draft.radiant, ...ui.draft.dire].filter(Boolean);
    if (chosen.length < 2) return toast('先选人再分队', 'err');
    for (let i = chosen.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [chosen[i], chosen[j]] = [chosen[j], chosen[i]]; }
    const half = Math.ceil(chosen.length / 2);
    ui.draft.radiant = [null, null, null, null, null]; ui.draft.dire = [null, null, null, null, null];
    chosen.forEach((s, i) => { const team = i < half ? 'radiant' : 'dire'; const idx = i < half ? i : i - half; ui.draft[team][idx] = { pid: s.pid, pos: 0, hero: '' }; });
    ['radiant', 'dire'].forEach(t => ui.draft[t].forEach(s => { if (s) s.pos = defaultPos(t, s.pid); }));
    renderTeams(); toast('已随机分队');
  });
  $('#btn-swap').addEventListener('click', () => {
    [ui.draft.radiant, ui.draft.dire] = [ui.draft.dire, ui.draft.radiant];
    if (ui.draft.winner) ui.draft.winner = ui.draft.winner === 'radiant' ? 'dire' : 'radiant';
    renderTeams();
  });
  $('#btn-clear-teams').addEventListener('click', () => { ui.draft = newDraft(); renderTeams(); });
  $('#btn-save-match').addEventListener('click', saveMatch);
  $('#btn-cancel-match').addEventListener('click', () => { resetMatchForm(); toast('已取消编辑'); });
})();

function defaultPos(team, pid) {
  const P = playerMap(); const p = P.get(pid);
  const taken = new Set(ui.draft[team].filter(s => s && s.pid !== pid).map(s => s.pos));
  const prefer = (p?.positions || []).find(x => !taken.has(x));
  if (prefer) return prefer;
  return [1, 2, 3, 4, 5].find(x => !taken.has(x)) || 1;
}

function togglePlayerInDraft(pid) {
  for (const t of ['radiant', 'dire']) {
    const i = ui.draft[t].findIndex(s => s && s.pid === pid);
    if (i >= 0) { ui.draft[t][i] = null; renderTeams(); return; }
  }
  let team = ui.activeTeam;
  let idx = ui.draft[team].indexOf(null);
  if (idx < 0) { const other = team === 'radiant' ? 'dire' : 'radiant'; if (ui.draft[other].indexOf(null) >= 0) { team = other; idx = ui.draft[other].indexOf(null); } }
  if (idx < 0) return toast('两队都满了，先移出一人', 'err');
  ui.draft[team][idx] = { pid, pos: 0, hero: '' };
  ui.draft[team][idx].pos = defaultPos(team, pid);
  // 当前队满了自动切到另一队
  if (ui.draft[team].indexOf(null) < 0) { const other = team === 'radiant' ? 'dire' : 'radiant'; if (ui.draft[other].indexOf(null) >= 0) ui.activeTeam = other; }
  else ui.activeTeam = team;
  renderTeams();
}

function renderTeams() {
  const P = playerMap();
  for (const team of ['radiant', 'dire']) {
    const el = $(`#teams .team.${team}`);
    el.classList.toggle('active', ui.activeTeam === team);
    el.querySelector('.slots').innerHTML = ui.draft[team].map((s, idx) => {
      if (!s) return `<div class="slot" data-idx="${idx}">空位 ${idx + 1}</div>`;
      const p = P.get(s.pid);
      return `<div class="slot filled" data-idx="${idx}">
        <div class="slot-main"><span class="slot-name">${esc(p?.name ?? '(已删除)')}</span>${kdaHtml(s)}${p ? rankBadge(p) : ''}<button type="button" class="slot-remove" data-act="remove" title="移出">×</button></div>
        <div class="slot-sub">
          <select data-act="pos" title="位置">${[1, 2, 3, 4, 5].map(i => `<option value="${i}" ${s.pos === i ? 'selected' : ''}>${POS_SHORT[i]}</option>`).join('')}</select>
          <input type="text" data-act="hero" list="hero-list" placeholder="英雄（可选）" value="${esc(s.hero)}">
        </div>
        ${p && p.heroes.length ? `<div class="slot-heroes">${p.heroes.map(h => `<button type="button" class="mini" data-act="quickhero" data-hero="${esc(h)}">${esc(h)}</button>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
  }
  const inTeam = new Map();
  ['radiant', 'dire'].forEach(t => ui.draft[t].forEach(s => s && inTeam.set(s.pid, t)));
  const q = ui.poolSearch.trim().toLowerCase();
  const pool = state.players
    .filter(p => !q || p.name.toLowerCase().includes(q) || p.rank.includes(q) || p.heroes.some(h => h.includes(q)))
    .sort((a, b) => rankIdx(b) - rankIdx(a) || a.name.localeCompare(b.name, 'zh'));
  $('#pool').innerHTML = pool.length ? pool.map(p => `<div class="chip ${inTeam.has(p.id) ? 'in-' + inTeam.get(p.id) : ''}" data-id="${p.id}">
      <span>${esc(p.name)}</span>${rankBadge(p)}<span class="pc">${p.positions.map(i => i).join('/')}</span>
    </div>`).join('') : '<p class="empty" style="width:100%">选手池为空，先去「选手名单」添加。</p>';
  $('#win-radiant').classList.toggle('on', ui.draft.winner === 'radiant');
  $('#win-dire').classList.toggle('on', ui.draft.winner === 'dire');
}

function autoMatchId(date) {
  const base = date.replace(/-/g, '');
  let n = state.matches.filter(m => m.id.startsWith(base + '-')).length + 1;
  while (state.matches.some(m => m.id === `${base}-${String(n).padStart(2, '0')}`)) n++;
  return `${base}-${String(n).padStart(2, '0')}`;
}

function saveMatch() {
  const r = ui.draft.radiant.filter(Boolean), d = ui.draft.dire.filter(Boolean);
  if (!r.length || !d.length) return toast('两队都要有选手', 'err');
  if (!ui.draft.winner) return toast('请选择获胜方', 'err');
  if ((r.length !== 5 || d.length !== 5) && !confirm(`当前是 ${r.length} v ${d.length}，不是 5v5，仍要保存吗？`)) return;
  const date = $('#m-date').value || today();
  const id = $('#m-id').value.trim() || autoMatchId(date);
  if (state.matches.some(m => m.id === id && m.id !== ui.editingMatch)) return toast('比赛 ID 已存在：' + id, 'err');
  const dur = Number($('#m-duration').value);
  const pack = s => { const o = { pid: s.pid, pos: s.pos || 0, hero: (s.hero || '').trim() }; if (s.kda) o.kda = s.kda; return o; };
  const match = { id, date, duration: dur > 0 ? dur : null, note: $('#m-note').value.trim(), radiant: r.map(pack), dire: d.map(pack), winner: ui.draft.winner, createdAt: Date.now() };
  if (ui.editingMatch) {
    const i = state.matches.findIndex(m => m.id === ui.editingMatch);
    match.createdAt = state.matches[i]?.createdAt || match.createdAt;
    state.matches[i] = match; toast('已更新比赛 ' + id, 'ok');
  } else { state.matches.push(match); toast('已保存比赛 ' + id, 'ok'); }
  save(); resetMatchForm();
}
function resetMatchForm() {
  ui.editingMatch = null; ui.draft = newDraft(); ui.activeTeam = 'radiant';
  $('#m-id').value = ''; $('#m-date').value = today(); $('#m-duration').value = ''; $('#m-note').value = '';
  $('#match-form-title').textContent = '新比赛';
  $('#btn-cancel-match').classList.add('hidden');
  renderTeams();
}
function startEditMatch(m) {
  ui.editingMatch = m.id;
  const fill = arr => { const a = [null, null, null, null, null]; arr.slice(0, 5).forEach((s, i) => a[i] = { pid: s.pid, pos: s.pos || 0, hero: s.hero || '', kda: s.kda }); return a; };
  ui.draft = { radiant: fill(m.radiant), dire: fill(m.dire), winner: m.winner };
  $('#m-id').value = m.id; $('#m-date').value = m.date; $('#m-duration').value = m.duration || ''; $('#m-note').value = m.note || '';
  $('#match-form-title').textContent = '编辑比赛：' + m.id;
  $('#btn-cancel-match').classList.remove('hidden');
  switchTab('record');
  window.scrollTo({ top: 0 });
}

// ============ 比赛列表 ============
(function initMatches() {
  $('#mf-player').addEventListener('change', e => { ui.matchFilter.pid = e.target.value; renderMatches(); });
  $('#mf-q').addEventListener('input', e => { ui.matchFilter.q = e.target.value; renderMatches(); });
  $('#match-table').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const m = state.matches.find(m => m.id === b.dataset.id); if (!m) return;
    if (b.dataset.act === 'edit') startEditMatch(m);
    else if (b.dataset.act === 'del') {
      if (!confirm(`删除比赛 ${m.id}？`)) return;
      state.matches = state.matches.filter(x => x.id !== m.id); save(); renderMatches(); toast('已删除', 'ok');
    }
  });
})();

function lineupHtml(P, team, won) {
  return `<div class="lineup ${won ? 'won' : ''}">${[...team].sort((a, b) => (a.pos || 9) - (b.pos || 9)).map(s =>
    `<span class="lp">${s.pos ? `<span class="pos-chip">${s.pos}</span>` : ''}${esc(pname(P, s.pid))}${s.hero ? `<span class="hero">·${esc(s.hero)}</span>` : ''}${s.kda ? `<span class="kda-mini" title="K/D/A">${s.kda.join('/')}</span>` : ''}</span>`).join('')}</div>`;
}

function renderMatches() {
  const P = playerMap();
  const sel = $('#mf-player'); const cur = ui.matchFilter.pid;
  sel.innerHTML = '<option value="">全部选手</option>' + [...state.players].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map(p => `<option value="${p.id}" ${p.id === cur ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const q = ui.matchFilter.q.trim().toLowerCase();
  const list = [...state.matches]
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0))
    .filter(m => !cur || [...m.radiant, ...m.dire].some(s => s.pid === cur))
    .filter(m => !q || m.id.toLowerCase().includes(q) || (m.note || '').toLowerCase().includes(q) || [...m.radiant, ...m.dire].some(s => (s.hero || '').includes(q) || pname(P, s.pid).toLowerCase().includes(q)));
  $('#match-count').textContent = state.matches.length;
  $('#match-empty').classList.toggle('hidden', list.length > 0);
  $('#match-table tbody').innerHTML = list.map(m => `<tr>
    <td><strong>${esc(m.id)}</strong>${m.note ? `<div class="hint">${esc(m.note)}</div>` : ''}</td>
    <td>${esc(m.date)}</td>
    <td><span class="side ${m.winner}">${m.winner === 'radiant' ? '天辉胜' : '夜魇胜'}</span></td>
    <td class="wrap">${lineupHtml(P, m.radiant, m.winner === 'radiant')}</td>
    <td class="wrap">${lineupHtml(P, m.dire, m.winner === 'dire')}</td>
    <td class="num">${m.duration ? m.duration + ' 分' : '-'}</td>
    <td><div class="actions"><button data-act="edit" data-id="${esc(m.id)}">编辑</button><button class="danger" data-act="del" data-id="${esc(m.id)}">删除</button></div></td>
  </tr>`).join('');
}

// ============ 统计 ============
let lastStatsRows = [];
(function initStats() {
  ['#sf-from', '#sf-to', '#sf-min'].forEach(s => $(s).addEventListener('input', renderStats));
  $('#stats-table thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-key]'); if (!th) return;
    const k = th.dataset.key;
    if (ui.statsSort.key === k) ui.statsSort.dir *= -1; else ui.statsSort = { key: k, dir: (k === 'name' || k === 'rank') ? 1 : -1 };
    renderStats();
  });
  $('#stats-table').addEventListener('click', e => { const b = e.target.closest('button[data-pid]'); if (b) showPlayerDetail(b.dataset.pid); });
  $('#duo-table').addEventListener('click', e => { const b = e.target.closest('button[data-pid]'); if (b) showPlayerDetail(b.dataset.pid); });
  $('#hero-table').addEventListener('click', e => { const b = e.target.closest('button[data-pid]'); if (b) showPlayerDetail(b.dataset.pid); });
  $('#btn-copy-md').addEventListener('click', async () => {
    const head = ['选手', '段位', '场次', '胜', '负', '胜率', '天辉', '夜魇', 'KDA', '常用位置', '常用英雄', '连胜/负'];
    const md = ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|', ...lastStatsRows.map(r => '| ' + r.join(' | ') + ' |')].join('\n');
    try { await navigator.clipboard.writeText(md); toast('已复制 Markdown 表格', 'ok'); }
    catch { showModal(`<h2>复制 Markdown</h2><p class="hint">浏览器不允许自动复制，请手动全选复制：</p><textarea rows="14" style="width:100%">${esc(md)}</textarea>`); }
  });
  $('#btn-csv').addEventListener('click', () => {
    const head = ['选手', '段位', '场次', '胜', '负', '胜率', '天辉', '夜魇', 'KDA', '常用位置', '常用英雄', '连胜/负'];
    const csv = '\uFEFF' + [head, ...lastStatsRows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `dota-stats-${today()}.csv`; a.click(); URL.revokeObjectURL(a.href);
  });
  $('#btn-print').addEventListener('click', () => window.print());
})();

function filteredMatches() {
  const from = $('#sf-from').value, to = $('#sf-to').value;
  return state.matches.filter(m => (!from || m.date >= from) && (!to || m.date <= to));
}

function renderStats() {
  const P = playerMap();
  const ms = filteredMatches();
  const st = computeStats(ms);
  const minG = Math.max(1, Number($('#sf-min').value) || 1);

  // 概览
  const rows = Object.values(st.players).filter(s => s.g >= minG && P.has(s.pid));
  const best = [...rows].filter(s => s.g >= Math.max(minG, 3)).sort((a, b) => pctNum(b.w, b.g) - pctNum(a.w, a.g) || b.g - a.g)[0];
  const most = [...rows].sort((a, b) => b.g - a.g)[0];
  const topHero = Object.values(st.heroes).sort((a, b) => b.g - a.g)[0];
  $('#overview').innerHTML = [
    ['总场次', st.total, ms.length !== state.matches.length ? `全部 ${state.matches.length} 场` : `${state.players.length} 名选手`],
    ['天辉胜率', pct(st.radiantWins, st.total), `天辉 ${st.radiantWins} 胜 / 夜魇 ${st.total - st.radiantWins} 胜`],
    ['平均时长', st.avgDuration ? Math.round(st.avgDuration) + ' 分' : '-', '仅统计填写了时长的比赛'],
    ['最高胜率', best ? esc(pname(P, best.pid)) : '-', best ? `${pct(best.w, best.g)} · ${best.g} 场（≥3 场）` : '需至少 3 场'],
    ['出场最多', most ? esc(pname(P, most.pid)) : '-', most ? `${most.g} 场 · ${pct(most.w, most.g)}` : ''],
    ['热门英雄', topHero ? esc(topHero.hero) : '-', topHero ? `${topHero.g} 场 · ${pct(topHero.w, topHero.g)}` : '记录英雄后显示'],
  ].map(([k, v, s]) => `<div class="stat-tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');

  // 选手排行
  const data = rows.map(s => {
    const p = P.get(s.pid);
    return { pid: s.pid, name: p.name, rank: rankIdx(p), rankHtml: rankBadge(p), g: s.g, w: s.w, l: s.g - s.w, wr: pctNum(s.w, s.g), rwr: pctNum(s.rw, s.rg), dwr: pctNum(s.dw, s.dg),
      rg: s.rg, rw: s.rw, dg: s.dg, dw: s.dw, streak: s.streak, kda: s.kdaG ? (s.k + s.a) / Math.max(1, s.d) : -1, kdaStr: s.kdaG ? `${(s.k / s.kdaG).toFixed(1)}/${(s.d / s.kdaG).toFixed(1)}/${(s.a / s.kdaG).toFixed(1)}` : '',
      pos: Object.entries(s.pos).sort((a, b) => b[1].g - a[1].g).slice(0, 2).map(([k, v]) => `${POS_SHORT[k]} ${v.g}场`).join('，'),
      hero: Object.entries(s.heroes).sort((a, b) => b[1].g - a[1].g).slice(0, 3).map(([k, v]) => `${k} ${v.w}/${v.g}`).join('，') };
  });
  const { key, dir } = ui.statsSort;
  data.sort((a, b) => {
    const va = a[key], vb = b[key];
    const c = typeof va === 'string' ? va.localeCompare(vb, 'zh') : va - vb;
    return c * dir || b.g - a.g || a.name.localeCompare(b.name, 'zh');
  });
  $$('#stats-table th[data-key]').forEach(th => { th.classList.toggle('sorted', th.dataset.key === key); th.classList.toggle('asc', th.dataset.key === key && dir === 1); });
  const streakHtml = n => n > 0 ? `<span class="streak-w">${n} 连胜</span>` : n < 0 ? `<span class="streak-l">${-n} 连败</span>` : '-';
  $('#stats-table tbody').innerHTML = data.length ? data.map(r => `<tr>
    <td><button class="name-btn" data-pid="${r.pid}">${esc(r.name)}</button></td>
    <td>${r.rankHtml}</td>
    <td class="num">${r.g}</td><td class="num win">${r.w}</td><td class="num loss">${r.l}</td>
    <td class="num"><strong>${pct(r.w, r.g)}</strong><span class="bar" style="width:${Math.round(r.wr * 40)}px"></span></td>
    <td class="num">${r.rg ? `${pct(r.rw, r.rg)} <span class="hint">(${r.rg})</span>` : '-'}</td>
    <td class="num">${r.dg ? `${pct(r.dw, r.dg)} <span class="hint">(${r.dg})</span>` : '-'}</td>
    <td class="num">${r.kda >= 0 ? `<strong>${r.kda.toFixed(2)}</strong> <span class="hint">${r.kdaStr}</span>` : '-'}</td>
    <td>${esc(r.pos) || '-'}</td>
    <td class="wrap">${esc(r.hero) || '-'}</td>
    <td class="num">${streakHtml(r.streak)}</td>
  </tr>`).join('') : `<tr><td colspan="12" class="empty">没有符合条件的数据</td></tr>`;
  lastStatsRows = data.map(r => [r.name, `${P.get(r.pid).rank}${P.get(r.pid).stars || ''}`, r.g, r.w, r.l, pct(r.w, r.g), r.rg ? `${pct(r.rw, r.rg)}(${r.rg})` : '-', r.dg ? `${pct(r.dw, r.dg)}(${r.dg})` : '-', r.kda >= 0 ? `${r.kda.toFixed(2)} (${r.kdaStr})` : '-', r.pos || '-', r.hero || '-', r.streak > 0 ? `${r.streak}连胜` : r.streak < 0 ? `${-r.streak}连败` : '-']);

  // 英雄
  const heroes = Object.values(st.heroes).sort((a, b) => b.g - a.g || pctNum(b.w, b.g) - pctNum(a.w, a.g));
  $('#hero-table tbody').innerHTML = heroes.length ? heroes.map(h => `<tr>
    <td><strong>${esc(h.hero)}</strong></td><td class="num">${h.g}</td><td class="num">${h.w}</td><td class="num">${pct(h.w, h.g)}</td>
    <td class="wrap">${Object.entries(h.users).sort((a, b) => b[1] - a[1]).map(([pid, n]) => `<button class="link" data-pid="${pid}">${esc(pname(P, pid))}</button><span class="hint">×${n}</span>`).join('　')}</td>
  </tr>`).join('') : `<tr><td colspan="5" class="empty">比赛里填了英雄才会有统计</td></tr>`;

  // 双人组合
  const duos = Object.values(st.duos).filter(d => d.g >= 2 && P.has(d.a) && P.has(d.b)).sort((a, b) => pctNum(b.w, b.g) - pctNum(a.w, a.g) || b.g - a.g).slice(0, 15);
  $('#duo-table tbody').innerHTML = duos.length ? duos.map(d => `<tr>
    <td><button class="link" data-pid="${d.a}">${esc(pname(P, d.a))}</button> + <button class="link" data-pid="${d.b}">${esc(pname(P, d.b))}</button></td>
    <td class="num">${d.g}</td><td class="num">${d.w}</td><td class="num"><strong>${pct(d.w, d.g)}</strong></td>
  </tr>`).join('') : `<tr><td colspan="4" class="empty">同队 ≥ 2 场的组合才会显示</td></tr>`;
}

// ============ 选手详情弹窗 ============
function showPlayerDetail(pid) {
  const P = playerMap(); const p = P.get(pid); if (!p) return;
  const st = computeStats(ui.tab === 'stats' ? filteredMatches() : state.matches).players[pid];
  if (!st) return showModal(`<h2>${esc(p.name)} ${rankBadge(p)}</h2><p class="empty">还没有比赛记录</p>`);
  const tbl = (head, rows, empty) => rows.length
    ? `<div class="table-wrap"><table class="tbl"><thead><tr>${head.map(h => `<th${h.startsWith('#') ? ' class="num"' : ''}>${h.replace('#', '')}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td${head[i].startsWith('#') ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<p class="hint">${empty}</p>`;
  const byPos = Object.entries(st.pos).sort((a, b) => b[1].g - a[1].g).map(([k, v]) => [POS_NAME[k], v.g, v.w, pct(v.w, v.g)]);
  const byHero = Object.entries(st.heroes).sort((a, b) => b[1].g - a[1].g || b[1].w - a[1].w).map(([k, v]) => [esc(k), v.g, v.w, pct(v.w, v.g)]);
  const mates = Object.entries(st.mates).filter(([id]) => P.has(id)).sort((a, b) => pctNum(b[1].w, b[1].g) - pctNum(a[1].w, a[1].g) || b[1].g - a[1].g).map(([id, v]) => [esc(pname(P, id)), v.g, v.w, pct(v.w, v.g)]);
  const opps = Object.entries(st.opps).filter(([id]) => P.has(id)).sort((a, b) => pctNum(b[1].w, b[1].g) - pctNum(a[1].w, a[1].g) || b[1].g - a[1].g).map(([id, v]) => [esc(pname(P, id)), v.g, v.w, pct(v.w, v.g)]);
  const recent = [...st.results].reverse().slice(0, 12).map(r => [esc(r.date), esc(r.id), `<span class="side ${r.side}">${r.side === 'radiant' ? '天辉' : '夜魇'}</span>`, r.pos ? POS_SHORT[r.pos] : '-', esc(r.hero || '-'), r.kda ? r.kda.join('/') : '-', r.won ? '<span class="win">胜</span>' : '<span class="loss">负</span>']);
  showModal(`
    <h2>${esc(p.name)} ${rankBadge(p)}</h2>
    <div class="hint">擅长位置：${p.positions.map(i => POS_SHORT[i]).join(' ') || '-'} ｜ 擅长英雄：${p.heroes.map(esc).join('、') || '-'}${p.note ? ' ｜ ' + esc(p.note) : ''}</div>
    <div class="overview" style="margin-top:12px">
      <div class="stat-tile"><div class="k">总场次</div><div class="v">${st.g}</div><div class="s">${st.w} 胜 ${st.g - st.w} 负</div></div>
      <div class="stat-tile"><div class="k">胜率</div><div class="v">${pct(st.w, st.g)}</div><div class="s">${st.streak > 0 ? `当前 ${st.streak} 连胜` : st.streak < 0 ? `当前 ${-st.streak} 连败` : ''}</div></div>
      <div class="stat-tile"><div class="k">天辉</div><div class="v">${pct(st.rw, st.rg)}</div><div class="s">${st.rw}/${st.rg}</div></div>
      <div class="stat-tile"><div class="k">夜魇</div><div class="v">${pct(st.dw, st.dg)}</div><div class="s">${st.dw}/${st.dg}</div></div>
      ${st.kdaG ? `<div class="stat-tile"><div class="k">场均 KDA</div><div class="v">${((st.k + st.a) / Math.max(1, st.d)).toFixed(2)}</div><div class="s">${(st.k / st.kdaG).toFixed(1)} / ${(st.d / st.kdaG).toFixed(1)} / ${(st.a / st.kdaG).toFixed(1)} · ${st.kdaG} 场</div></div>` : ''}
    </div>
    <div class="grid2">
      <div><h4>按位置</h4>${tbl(['位置', '#场次', '#胜', '#胜率'], byPos, '未记录位置')}</div>
      <div><h4>按英雄</h4>${tbl(['英雄', '#场次', '#胜', '#胜率'], byHero, '未记录英雄')}</div>
      <div><h4>队友（同队时的胜率）</h4>${tbl(['队友', '#同队', '#胜', '#胜率'], mates, '-')}</div>
      <div><h4>对手（对阵时的胜率）</h4>${tbl(['对手', '#对阵', '#胜', '#胜率'], opps, '-')}</div>
    </div>
    <h4>最近比赛</h4>${tbl(['日期', '比赛 ID', '阵营', '位置', '英雄', 'K/D/A', '结果'], recent, '-')}
  `);
}

function showModal(html) { $('#modal-content').innerHTML = html; $('#modal').classList.remove('hidden'); }
function hideModal() { $('#modal').classList.add('hidden'); }
$('#modal-close').addEventListener('click', hideModal);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') hideModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideModal(); });

const kdaHtml = s => s.kda ? `<span class="kda-mini" title="K/D/A">${s.kda.join('/')}</span>` : '';
function parseAccountId(v) {
  const n = String(v || '').replace(/\D/g, '');
  if (!n) return null;
  let id = Number(n);
  if (id > 76561197960265728) id -= 76561197960265728; // 64 位 SteamID → 32 位 account_id
  return id > 0 ? id : null;
}
const rankFromTier = tier => { const t = Math.floor(tier / 10); if (!t || t > 8) return null; return { rank: RANKS[t - 1], stars: t === 8 ? 0 : (tier % 10 || 1) }; }; // 冠绝一世无星级
// ============ OpenDota 导入 ============
let importDraft = null;
const extractMatchId = v => { const m = String(v || '').match(/(\d{6,})/); return m ? m[1] : null; };

// 按分路 + GPM 推测 1-5 号位：中路→2；优势路 GPM 高者→1、其余→5；劣势路 GPM 高者→3、其余→4；野区/游走→4。冲突或缺失时按 GPM 顺序补空位
function guessPositions(team) {
  const byGpm = [...team].sort((a, b) => (b.gpm || 0) - (a.gpm || 0));
  const want = new Map();
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
    const hero = HERO_BY_ID[p.hero_id] || (p.hero_id ? `英雄#${p.hero_id}` : '');
    const side = (typeof p.isRadiant === 'boolean' ? p.isRadiant : p.player_slot < 128) ? '天辉' : '夜魇';
    return {
    accountId: p.account_id || null, anon: !p.account_id,
    name: (p.personaname || '').trim() || (p.account_id ? `玩家${p.account_id}` : `匿名·${side}·${hero || (p.player_slot % 128) + 1}`),
    heroId: p.hero_id, hero,
    kda: [p.kills || 0, p.deaths || 0, p.assists || 0], gpm: p.gold_per_min || 0,
    laneRole: p.lane_role || 0, isRoaming: !!p.is_roaming, rankTier: p.rank_tier || 0, pos: 0,
  }; };
  const isRad = p => (typeof p.isRadiant === 'boolean' ? p.isRadiant : p.player_slot < 128);
  return {
    id: String(m.match_id), date, duration: m.duration ? Math.round(m.duration / 60) : null,
    winner: m.radiant_win ? 'radiant' : 'dire', score: [m.radiant_score ?? '?', m.dire_score ?? '?'],
    radiant: guessPositions(m.players.filter(isRad).map(mk)), dire: guessPositions(m.players.filter(p => !isRad(p)).map(mk)),
  };
}

async function fetchOpenDota() {
  const id = extractMatchId($('#m-id').value);
  if (!id) return toast('请先在「比赛 ID」填入 OpenDota 比赛编号或链接', 'err');
  const btn = $('#btn-opendota'); btn.disabled = true; btn.textContent = '拉取中…';
  try {
    const res = await fetch(`${OPENDOTA}/matches/${id}`);
    if (res.status === 404) throw new Error('OpenDota 上没有这场比赛');
    if (res.status === 429) throw new Error('请求太频繁，稍后再试');
    if (!res.ok) throw new Error('接口返回 ' + res.status);
    const m = await res.json();
    if (!Array.isArray(m.players) || m.players.length < 2) throw new Error('比赛数据不完整，OpenDota 可能还没收录');
    showImportModal(parseOpenDotaMatch(m));
  } catch (e) { toast('拉取失败：' + (e.message || e), 'err'); }
  finally { btn.disabled = false; btn.textContent = '从 OpenDota 拉取'; }
}

// 先按 Steam ID、再按同名匹配已有选手
function matchPlayer(row) {
  if (row.accountId) { const p = state.players.find(p => p.accountId === row.accountId); if (p) return { pid: p.id, how: 'Steam ID 匹配' }; }
  const n = row.name.toLowerCase();
  const p = state.players.find(p => p.name.toLowerCase() === n);
  return p ? { pid: p.id, how: '同名匹配' } : { pid: '__new', how: '' };
}

function showImportModal(parsed) {
  importDraft = parsed;
  const opts = [...state.players].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const rows = side => parsed[side].map((r, i) => {
    const { pid, how } = matchPlayer(r);
    const rk = rankFromTier(r.rankTier);
    return `<tr data-side="${side}" data-idx="${i}">
      <td><span class="side ${side}">${side === 'radiant' ? '天辉' : '夜魇'}</span></td>
      <td class="wrap"><div>${esc(r.name)}</div><div class="hint">${r.accountId ? 'ID ' + r.accountId : '匿名（未公开资料）'}${rk ? ' · ' + rk.rank + (rk.stars || '') : ''}</div></td>
      <td>${esc(r.hero) || '-'}</td>
      <td class="num">${r.kda.join('/')}</td>
      <td><select data-f="pos">${[1, 2, 3, 4, 5].map(x => `<option value="${x}" ${r.pos === x ? 'selected' : ''}>${POS_SHORT[x]}</option>`).join('')}</select></td>
      <td><select data-f="pid">
        <option value="__new" ${pid === '__new' ? 'selected' : ''}>➕ 新建选手「${esc(r.name)}」</option>
        <option value="__skip">— 跳过，不录入此玩家 —</option>
        ${opts.map(p => `<option value="${p.id}" ${pid === p.id ? 'selected' : ''}>${esc(p.name)}（${esc(p.rank)}${p.stars || ''}）</option>`).join('')}
      </select>${how ? `<div class="hint">${how}</div>` : (r.anon ? '<div class="hint">匿名玩家请手动选择对应选手</div>' : '')}</td>
    </tr>`;
  }).join('');
  const exists = state.matches.some(m => m.id === parsed.id);
  const anonCount = [...parsed.radiant, ...parsed.dire].filter(r => r.anon).length;
  const noHero = [...parsed.radiant, ...parsed.dire].every(r => !r.hero);
  showModal(`<h2>OpenDota 导入 · ${esc(parsed.id)}</h2>
    ${noHero ? '<p class="loss">这场比赛的英雄数据还是空的，OpenDota 可能尚未收录完整，建议几分钟后再拉取。</p>' : ''}
    ${anonCount ? `<p class="hint">有 ${anonCount} 名玩家隐藏了资料（匿名），无法自动识别，请在「对应选手」里手动选择；实在不知道是谁可选「跳过」或「新建」。</p>` : ''}
    <div>${parsed.date} · ${parsed.duration ?? '?'} 分 · <span class="side ${parsed.winner}">${parsed.winner === 'radiant' ? '天辉胜' : '夜魇胜'}</span> · 比分 ${parsed.score.join(' : ')}${exists ? ' · <span class="loss">该比赛 ID 已有记录，保存将覆盖</span>' : ''}</div>
    <p class="hint">位置按分路 + GPM 推测，请核对。「对应选手」先按 Steam ID、再按同名自动匹配；选「新建选手」会用 Steam 昵称和 OpenDota 段位建档并绑定 ID，以后自动识别。</p>
    <div class="table-wrap"><table class="tbl od-table"><thead><tr><th>阵营</th><th>Steam 昵称</th><th>英雄</th><th class="num">K/D/A</th><th>位置</th><th>对应选手</th></tr></thead><tbody>${rows('radiant')}${rows('dire')}</tbody></table></div>
    <div id="od-error" class="loss" style="margin-top:10px"></div>
    <div class="form-actions" style="margin-top:8px">
      <button type="button" class="primary" id="od-fill">填入表单（可再调整）</button>
      <button type="button" id="od-save">直接保存</button>
      <button type="button" class="ghost" id="od-cancel">取消</button>
    </div>`);
  $('#od-cancel').onclick = hideModal;
  $('#od-fill').onclick = () => applyImport(false);
  $('#od-save').onclick = () => applyImport(true);
}

function applyImport(saveNow) {
  const parsed = importDraft; if (!parsed) return;
  const P = playerMap();
  const chosen = new Map(), seen = new Set();
  const fail = msg => { toast(msg, 'err'); const el = $('#od-error'); if (el) el.textContent = msg; };
  for (const tr of $$('#modal-content tbody tr')) {
    const side = tr.dataset.side, idx = Number(tr.dataset.idx);
    const pid = tr.querySelector('select[data-f=pid]').value, pos = Number(tr.querySelector('select[data-f=pos]').value);
    if (pid !== '__new' && pid !== '__skip') {
      if (seen.has(pid)) return fail(`「${pname(P, pid)}」被选了两次，请修正后再保存`);
      seen.add(pid);
    }
    chosen.set(side + idx, { pid, pos });
  }
  if ([...chosen.values()].every(c => c.pid === '__skip')) return fail('所有玩家都被跳过了，没有可录入的内容');
  let created = 0, bound = 0;
  for (const side of ['radiant', 'dire']) parsed[side].forEach((r, i) => {
    const c = chosen.get(side + i);
    if (c.pid === '__skip') return;
    if (c.pid === '__new') {
      let name = r.name, n = 2;
      while (state.players.some(p => p.name === name)) name = `${r.name}(${n++})`;
      const rk = rankFromTier(r.rankTier);
      const note = r.anon ? '匿名导入，请改成真实昵称' : (rk ? '' : '段位未知（OpenDota 导入）');
      const np = { id: uid(), createdAt: Date.now(), name, rank: rk ? rk.rank : '传奇', stars: rk ? rk.stars : 3, positions: [c.pos], heroes: r.hero ? [r.hero] : [], note, accountId: r.accountId };
      state.players.push(np); c.pid = np.id; created++;
    } else {
      const p = P.get(c.pid);
      if (p && !p.accountId && r.accountId && !state.players.some(x => x.accountId === r.accountId)) { p.accountId = r.accountId; bound++; }
    }
  });
  if (created || bound) save();
  const exists = state.matches.some(m => m.id === parsed.id);
  ui.editingMatch = exists ? parsed.id : null;
  ui.draft = { winner: parsed.winner, radiant: [null, null, null, null, null], dire: [null, null, null, null, null] };
  let skipped = 0;
  for (const side of ['radiant', 'dire']) { let k = 0; parsed[side].forEach((r, i) => { const c = chosen.get(side + i); if (c.pid === '__skip') { skipped++; return; } if (k < 5) ui.draft[side][k++] = { pid: c.pid, pos: c.pos, hero: r.hero, kda: r.kda }; }); }
  $('#m-id').value = parsed.id; $('#m-date').value = parsed.date; $('#m-duration').value = parsed.duration || '';
  if (!$('#m-note').value.trim()) $('#m-note').value = `OpenDota 导入 · 比分 ${parsed.score.join(':')}`;
  $('#match-form-title').textContent = exists ? '编辑比赛：' + parsed.id : '新比赛（OpenDota 导入）';
  $('#btn-cancel-match').classList.toggle('hidden', !exists);
  hideModal(); importDraft = null; renderTeams();
  const msg = [created ? `新建 ${created} 名选手` : '', bound ? `绑定 ${bound} 个 Steam ID` : '', skipped ? `跳过 ${skipped} 人` : ''].filter(Boolean).join('，');
  if (saveNow) saveMatch(); else toast((msg ? msg + '，' : '') + '已填入表单，核对后点「保存比赛」', 'ok');
}
$('#btn-opendota').addEventListener('click', fetchOpenDota);
$('#m-id').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fetchOpenDota(); } });

// ============ 导入 / 导出 / 示例 ============
$('#btn-export').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  a.download = `dota-records-${today()}.json`; a.click(); URL.revokeObjectURL(a.href);
  toast('已导出', 'ok');
});
$('#btn-import').addEventListener('click', () => $('#file-import').click());
$('#file-import').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.players) || !Array.isArray(d.matches)) throw new Error('格式不对');
    if (!confirm(`导入 ${d.players.length} 名选手、${d.matches.length} 场比赛，将覆盖当前数据（${state.players.length} 人 / ${state.matches.length} 场）。继续？`)) return;
    state = { players: d.players, matches: d.matches }; save(); resetPlayerForm(); resetMatchForm(); renderAll(); toast('导入成功', 'ok');
  } catch (err) { toast('导入失败：' + err.message, 'err'); }
  e.target.value = '';
});
$('#btn-demo').addEventListener('click', () => {
  if ((state.players.length || state.matches.length) && !confirm('载入示例数据会覆盖当前全部数据，继续？')) return;
  state = demoData(); save(); resetPlayerForm(); resetMatchForm(); renderAll(); toast('已载入示例数据', 'ok');
});

function demoData() {
  const defs = [
    ['阿呆', '超凡入圣', 2, [1, 2], ['影魔', '敌法师', '幻影刺客']],
    ['老K', '万古流芳', 5, [2], ['风暴之灵', '帕克', '祈求者']],
    ['胖虎', '传奇', 4, [3], ['斧王', '玛尔斯', '潮汐猎人']],
    ['小美', '万古流芳', 1, [4, 5], ['莱恩', '拉比克', '暗影萨满']],
    ['铁柱', '统帅', 3, [5], ['水晶室女', '巫医', '戴泽']],
    ['凌风', '超凡入圣', 4, [1], ['幽鬼', '恐怖利刃', '美杜莎']],
    ['大熊', '传奇', 1, [3, 4], ['半人马战行者', '孽主', '暗影恶魔']],
    ['团子', '统帅', 5, [4, 5], ['艾欧', '巫妖', '寒冬飞龙']],
    ['狐狸', '万古流芳', 3, [2, 1], ['宙斯', '莉娜', '天怒法师']],
    ['木头', '中军', 4, [5, 4], ['食人魔魔法师', '树精卫士', '陈']],
    ['阿飘', '传奇', 2, [1, 3], ['主宰', '斯温', '龙骑士']],
    ['七七', '统帅', 1, [4], ['米拉娜', '风行者', '大地之灵']],
  ];
  const players = defs.map(([name, rank, stars, positions, heroes], i) => ({ id: 'demo' + i, createdAt: Date.now() - (20 - i) * 86400000, name, rank, stars, positions, heroes, note: '' }));
  let seed = 42; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const matches = [];
  for (let i = 0; i < 16; i++) {
    const idx = players.map((_, k) => k).sort(() => rnd() - 0.5).slice(0, 10);
    const mk = (ks, teamName) => ks.map((k, j) => { const p = players[k]; return { pid: p.id, pos: j + 1, hero: p.heroes[Math.floor(rnd() * p.heroes.length)] }; });
    const d = new Date(Date.now() - (16 - i) * 86400000 * 1.3);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    matches.push({ id: `${date.replace(/-/g, '')}-${String(matches.filter(m => m.date === date).length + 1).padStart(2, '0')}`, date, duration: 28 + Math.floor(rnd() * 30), note: i === 3 ? '加时大逆转' : '', radiant: mk(idx.slice(0, 5)), dire: mk(idx.slice(5)), winner: rnd() < 0.52 ? 'radiant' : 'dire', createdAt: d.getTime() });
  }
  return { players, matches };
}

// ============ 启动 ============
renderAll();
})();
