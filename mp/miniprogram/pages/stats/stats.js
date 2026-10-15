// 统计（对应网页「统计」页）：筛选 / 概览 / 选手排行 / 称号 / Elo 走势 / 预测回看 / 对线与节奏 / 英雄 / 搭档 / 战报 / 评分权重
const S = require('../../utils/store.js');
const chart = require('../../utils/chart.js');
const C = S.core;
const pct = C.pct, pctNum = C.pctNum;
const STEP = 40;
const SECS = [{ k: 'rank', t: '排行' }, { k: 'badge', t: '称号' }, { k: 'elo', t: 'Elo 走势' }, { k: 'pred', t: '预测回看' }, { k: 'lane', t: '对线节奏' }, { k: 'hero', t: '英雄' }, { k: 'duo', t: '搭档' }];
const RSORTS = [{ k: 'wr', t: '胜率' }, { k: 'score', t: '评分' }, { k: 'pts', t: '积分' }, { k: 'g', t: '场次' }, { k: 'w', t: '胜' }, { k: 'l', t: '负' }, { k: 'rwr', t: '天辉' }, { k: 'dwr', t: '夜魇' }, { k: 'kda', t: 'KDA' }, { k: 'streak', t: '连胜' }, { k: 'rank', t: '段位' }, { k: 'name', t: '昵称' }];
const HERO_MODES = [{ v: 'main', t: '主力英雄战绩' }, { v: 'pool', t: '英雄池广度' }, { v: 'both', t: '两者各半' }];
const streakTxt = n => n > 0 ? `${n} 连胜` : n < 0 ? `${-n} 连败` : '-';

Page({
  data: {
    loading: true, err: '', offline: '', updated: '',
    from: '', to: '', leagueOpts: [], leagueIdx: 0, minG: 1,
    tiles: [], secs: SECS, sec: 'rank',
    rsorts: RSORTS, rsort: 'wr', rdir: -1, rows: [], rtotal: 0, shown: STEP,
    badgeList: [], eloLegend: [], eloTip: '', pred: [], upsets: [],
    laneRows: [], laneInfo: '', heroes: [], heroTotal: 0, best: [], worst: [],
    showW: false, w: {}, heroModes: HERO_MODES, heroModeIdx: 0, wsum: 0,
  },

  onLoad() { this.syncFilter(); return this.refresh(false); },
  onShow() { if (S.data && this._key && this._key !== this.key()) this.render(); },
  onPullDownRefresh() { this.refresh(true).then(() => wx.stopPullDownRefresh()); },
  onReachBottom() {
    if (this.data.sec === 'rank' && this.data.shown < this.data.rtotal) { this.setData({ shown: this.data.shown + STEP }); this.renderRank(); }
    if (this.data.sec === 'hero' && this.data.heroes.length < this.data.heroTotal) { this._heroN = (this._heroN || 40) + 40; this.renderHero(); }
  },
  onShareAppMessage() { return { title: 'Dota 内战统计', path: '/pages/stats/stats' }; },
  key() { return S.data.version + JSON.stringify(S.scoreOpt()) + JSON.stringify(S.filter); },
  syncFilter() { const f = S.filter; this.setData({ from: f.from, to: f.to, minG: f.minG }); },

  async refresh(force) {
    this.setData({ loading: true, err: '' });
    try {
      const d = await S.load({ force });
      this.setData({ offline: d.offline ? `连不上云端，显示的是本机缓存（${d.error}）` : '', updated: `数据 v${d.version} · ${S.fmtTime(d.updatedAt)}` });
      this.render();
    } catch (e) { this.setData({ err: '加载失败：' + e.message }); }
    this.setData({ loading: false });
  },

  // ---------- 筛选 ----------
  onFrom(e) { S.setFilter({ from: e.detail.value }); this.setData({ from: e.detail.value }); this.render(); },
  onTo(e) { S.setFilter({ to: e.detail.value }); this.setData({ to: e.detail.value }); this.render(); },
  clearDates() { S.setFilter({ from: '', to: '' }); this.setData({ from: '', to: '' }); this.render(); },
  onLeague(e) { const o = S.leagues()[Number(e.detail.value)]; S.setFilter({ league: o ? o.value : '' }); this.render(); },
  onMin(e) { const n = Math.max(1, Number(e.detail.value) || 1); S.setFilter({ minG: n }); this.setData({ minG: n, shown: STEP }); this.render(); },
  onSec(e) { this.setData({ sec: e.currentTarget.dataset.k }); this.renderSec(); },

  view() { return S.view(S.filter); },

  render() {
    if (!S.data) return;
    this._key = this.key();
    const opts = S.leagues();
    const idx = Math.max(0, opts.findIndex(o => o.value === S.filter.league));
    const v = this.view(), st = v.st, P = S.data.P;
    const { rows } = S.statRows(v, S.filter.minG);
    const best = rows.filter(s => s.g >= Math.max(S.filter.minG, 3)).sort((a, b) => pctNum(b.w, b.g) - pctNum(a.w, a.g) || b.g - a.g)[0];
    const most = [...rows].sort((a, b) => b.g - a.g)[0];
    const topHero = Object.values(st.heroes).sort((a, b) => b.g - a.g)[0];
    const total = S.data.matches.length;
    this.setData({
      leagueOpts: opts.map(o => o.label), leagueIdx: idx,
      tiles: [
        { k: '总场次', v: st.total, s: v.ms.length !== total ? `全部 ${total} 场` : `${S.data.players.length} 名选手` },
        { k: '天辉胜率', v: pct(st.radiantWins, st.total), s: `天辉 ${st.radiantWins} / 夜魇 ${st.total - st.radiantWins}` },
        { k: '平均时长', v: st.avgDuration ? Math.round(st.avgDuration) + ' 分' : '-', s: '填了时长的比赛' },
        { k: '最高胜率', v: best ? P.get(best.pid).name : '-', s: best ? `${pct(best.w, best.g)} · ${best.g} 场（≥3 场）` : '需至少 3 场', pid: best ? best.pid : '' },
        { k: '出场最多', v: most ? P.get(most.pid).name : '-', s: most ? `${most.g} 场 · ${pct(most.w, most.g)}` : '', pid: most ? most.pid : '' },
        { k: '热门英雄', v: topHero ? topHero.hero : '-', s: topHero ? `${topHero.g} 场 · ${pct(topHero.w, topHero.g)}` : '' },
      ],
    });
    this.renderSec();
  },

  renderSec() {
    if (!S.data) return;
    const s = this.data.sec;
    if (s === 'rank') this.renderRank();
    else if (s === 'badge') this.renderBadge();
    else if (s === 'elo') this.renderElo();
    else if (s === 'pred') this.renderPred();
    else if (s === 'lane') this.renderLane();
    else if (s === 'hero') this.renderHero();
    else if (s === 'duo') this.renderDuo();
  },

  // ---------- 选手排行 ----------
  // 当前筛选 + 当前排序下的全部排行（复制排行表也用它，保证和屏幕上一致）
  sortedRows() {
    const { data } = S.statRows(this.view(), S.filter.minG);
    const { rsort: key, rdir: dir } = this.data;
    return data.sort((a, b) => { const va = a[key], vb = b[key]; const c = typeof va === 'string' ? va.localeCompare(vb, 'zh') : va - vb; return c * dir || b.g - a.g || a.name.localeCompare(b.name, 'zh'); });
  },
  renderRank() {
    const v = this.view(), P = S.data.P;
    const data = this.sortedRows();
    const rows = data.slice(0, this.data.shown).map((r, i) => {
      const p = P.get(r.pid);
      return { pid: r.pid, no: i + 1, name: r.name, rank: p.rank + (p.stars ? ' ' + p.stars : ''), score: r.score.toFixed(1), thin: !r.sc.enough,
        g: r.g, w: r.w, l: r.l, wr: pct(r.w, r.g), wrBar: Math.round(r.wr * 100), pts: r.pts,
        rad: r.rg ? `${pct(r.rw, r.rg)}（${r.rg}）` : '-', dire: r.dg ? `${pct(r.dw, r.dg)}（${r.dg}）` : '-',
        kda: r.kda >= 0 ? r.kda.toFixed(2) : '-', kdaStr: r.kdaStr, pos: r.pos || '-', hero: r.hero || '-',
        streak: streakTxt(r.streak), scls: r.streak > 0 ? 'win' : r.streak < 0 ? 'lose' : 'muted',
        badges: (v.badges[r.pid] || []).map(b => b.icon).join('') };
    });
    this.setData({ rows, rtotal: data.length });
  },
  onRSort(e) {
    const k = e.currentTarget.dataset.k;
    const rdir = this.data.rsort === k ? -this.data.rdir : ((k === 'name' || k === 'rank') ? 1 : -1);
    this.setData({ rsort: k, rdir, shown: STEP }); this.renderRank();
  },

  // ---------- 称号榜 ----------
  renderBadge() {
    const v = this.view(), byName = new Map();
    for (const [pid, list] of Object.entries(v.badges)) for (const b of list) { const o = byName.get(b.name) || { icon: b.icon, name: b.name, who: [], detail: b.detail }; o.who.push({ pid, name: S.pname(pid) }); byName.set(b.name, o); }
    this.setData({ badgeList: [...byName.values()] });
  },

  // ---------- Elo 走势（出场最多的 8 人，同网页） ----------
  renderElo() {
    const v = this.view(), st = v.st;
    const { rows } = S.statRows(v, S.filter.minG);
    const top = [...rows].sort((a, b) => b.g - a.g || b.elo - a.elo).slice(0, 8);
    const n = st.seqTotal;
    this._eloSeries = top.map((s, i) => {
      const val = new Array(n).fill(null); let cur = null, j = 0;
      for (let q = 0; q < n; q++) { while (j < s.eloHist.length && s.eloHist[j].seq === q) { cur = s.eloHist[j].elo; j++; } val[q] = cur; }
      return { v: val, color: chart.COLORS[i % chart.COLORS.length], pid: s.pid, hist: s.eloHist };
    });
    this._bySeq = new Map(st.preds.map(p => [p.seq, p]));
    this.setData({ eloLegend: this._eloSeries.map(s => ({ color: s.color, name: S.pname(s.pid), elo: Math.round(st.players[s.pid].elo), pid: s.pid })), eloTip: '点图表看某一场' }, () => this.drawElo(-1));
  },
  async drawElo(mark) { this._eloGeo = await chart.draw(this, 'elo', this._eloSeries || [], { mark }); },
  onEloTap(e) {
    const t = (e.touches && e.touches[0]) || e.detail || {}; const i = chart.indexAt(this._eloGeo, t.x);
    if (i < 0) return;
    const m = this._bySeq.get(i);
    const lines = this._eloSeries.filter(s => s.v[i] != null).map(s => { const h = s.hist.find(x => x.seq === i); return `${S.pname(s.pid)}${h ? (h.won ? ' 胜' : ' 负') : ''} ${Math.round(s.v[i])}`; });
    this.setData({ eloTip: `第 ${i + 1} 场${m ? ` · ${m.date} · ${m.id}` : ''}\n${lines.join('　')}` });
    this.drawElo(i);
  },

  // ---------- 预测回看 ----------
  renderPred() {
    const v = this.view(), r = C.predictionReport(v.st.preds), top = r.upsets[0];
    const name = pid => S.pname(pid);
    const byId = new Map(v.ms.map(m => [m.id, m]));
    this.setData({
      pred: [
        { k: '预测准确率', v: r.acc != null ? pct(r.hit, r.decisive) : '-', s: r.decisive ? `有倾向的 ${r.decisive} 场里猜中 ${r.hit} 场` : '赛前都是五五开，没法评估' },
        { k: 'Brier 分', v: r.brier != null ? r.brier.toFixed(3) : '-', s: '0 最好，瞎猜 0.25' },
        { k: '爆冷场次', v: r.upsets.length, s: r.total ? `占 ${pct(r.upsets.length, r.total)}` : '' },
        { k: '最大爆冷', v: top ? top.date : '-', s: top ? `赛前只给 ${Math.round((1 - top.surprise) * 100)}% 的${top.winner === 'radiant' ? '天辉' : '夜魇'}赢了` : '' },
      ],
      upsets: r.upsets.slice(0, 10).map(u => { const m = byId.get(u.id); const pa = Math.round(u.ea * 100); return {
        id: u.id, date: u.date, pa, pb: 100 - pa, winner: u.winner === 'radiant' ? '天辉胜' : '夜魇胜', wcls: u.winner, surprise: Math.round(u.surprise * 100),
        rad: m ? (m.radiant || []).map(s => name(s.pid)).join('、') : '', dire: m ? (m.dire || []).map(s => name(s.pid)).join('、') : '' }; }),
    });
  },

  // ---------- 对线与节奏（只看已解析的比赛） ----------
  renderLane() {
    const v = this.view(), rs = v.rs, P = S.data.P;
    const rows = Object.values(rs.players).filter(s => P.has(s.pid) && s.g >= S.filter.minG)
      .sort((a, b) => pctNum(b.laneW, b.laneG) - pctNum(a.laneW, a.laneG) || b.laneG - a.laneG || b.g - a.g)
      .map(s => ({ pid: s.pid, name: S.pname(s.pid), g: s.g,
        lane: s.laneG ? `${pct(s.laneW, s.laneG)}（${s.laneW}/${s.laneL}/${s.laneG - s.laneW - s.laneL}）` : '-',
        gold: s.laneG ? `${s.laneGold > 0 ? '+' : ''}${Math.round(s.laneGold / s.laneG)}` : '-',
        lh: s.laneG ? `${(s.lh / s.laneG).toFixed(1)} / ${(s.dn / s.laneG).toFixed(1)}` : '-',
        nw: s.laneG ? Math.round(s.nw / s.laneG) : '-',
        kp: s.kpN ? (s.kp / s.kpN * 100).toFixed(0) + '%' : '-',
        fight: s.fights ? `${pct(s.fightsW, s.fights)}（${s.fights}）` : '-',
        fb: s.fb + (s.fbDeath ? ` · 送 ${s.fbDeath}` : ''), cb: s.cb || '-' }));
    this.setData({ laneRows: rows, laneInfo: rs.games ? `已解析 ${rs.games} / ${v.ms.length} 场` : '还没有已解析的比赛（网页「比赛」页点「批量解析」）' });
  },

  // ---------- 英雄统计 ----------
  renderHero() {
    const v = this.view();
    const all = Object.values(v.st.heroes).sort((a, b) => b.g - a.g || pctNum(b.w, b.g) - pctNum(a.w, a.g));
    const n = this._heroN || 40;
    this.setData({ heroTotal: all.length, heroes: all.slice(0, n).map(h => ({ hero: h.hero, g: h.g, w: h.w, wr: pct(h.w, h.g),
      users: Object.entries(h.users).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([pid, c]) => ({ pid, name: S.pname(pid), c })) })) });
  },

  // ---------- 搭档 ----------
  renderDuo() {
    const v = this.view(), P = S.data.P;
    const all = Object.values(v.st.duos).filter(d => d.g >= 2 && P.has(d.a) && P.has(d.b));
    const row = d => ({ id: d.a + '|' + d.b, a: d.a, b: d.b, an: S.pname(d.a), bn: S.pname(d.b), g: d.g, w: d.w, l: d.g - d.w, wr: pct(d.w, d.g) });
    this.setData({
      best: [...all].sort((a, b) => pctNum(b.w, b.g) - pctNum(a.w, a.g) || b.g - a.g).slice(0, 15).map(row),
      worst: [...all].sort((a, b) => pctNum(a.w, a.g) - pctNum(b.w, b.g) || b.g - a.g).slice(0, 15).map(row),
    });
  },

  // ---------- 战报 / 复制排行 ----------
  copyReport() {
    const md = S.report(this.view(), S.filter.minG);
    wx.setClipboardData({ data: md, success: () => wx.showToast({ title: '战报已复制，可粘到群里', icon: 'none' }) });
  },
  copyTable() {
    const rows = this.sortedRows();
    const md = S.rankTable(this.view(), S.filter.minG, rows);
    wx.setClipboardData({ data: md, success: () => wx.showToast({ title: `已复制 ${rows.length} 行排行`, icon: 'none' }) });
  },

  // ---------- 评分权重（存本机） ----------
  toggleW() {
    const so = S.scoreOpt();
    this.setData({ showW: !this.data.showW, w: { ...so }, heroModeIdx: Math.max(0, HERO_MODES.findIndex(m => m.v === so.heroMode)), wsum: C.scoreWsum(so) });
  },
  onW(e) {
    const k = e.currentTarget.dataset.k, n = Math.max(0, Math.min(k === 'trust' ? 99 : 100, Number(e.detail.value) || 0));
    const so = { ...S.scoreOpt(), [k]: k === 'trust' ? Math.max(1, n) : n };
    S.saveScoreOpt(so); this.setData({ w: so, wsum: C.scoreWsum(so) }); this.render();
  },
  onHeroMode(e) { const i = Number(e.detail.value); const so = { ...S.scoreOpt(), heroMode: HERO_MODES[i].v }; S.saveScoreOpt(so); this.setData({ w: so, heroModeIdx: i }); this.render(); },
  onMov(e) { const so = { ...S.scoreOpt(), mov: e.detail.value }; S.saveScoreOpt(so); this.setData({ w: so }); this.render(); },
  resetW() { S.resetScoreOpt(); const so = S.scoreOpt(); this.setData({ w: so, heroModeIdx: 0, wsum: C.scoreWsum(so) }); this.render(); wx.showToast({ title: '已恢复默认权重', icon: 'none' }); },

  open(e) { const pid = e.currentTarget.dataset.pid; if (pid) wx.navigateTo({ url: `/pages/player/player?pid=${pid}&scope=stats` }); },
});
