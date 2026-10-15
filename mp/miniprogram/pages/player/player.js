// 选手详情（对应网页选手详情弹窗）。从统计页进来按统计页的筛选范围算（scope=stats），其他入口按全部比赛
const S = require('../../utils/store.js');
const chart = require('../../utils/chart.js');
const C = S.core;
const pct = C.pct, pctNum = C.pctNum;
const LIST_N = 10;

Page({
  data: { ok: false, err: '', more: {}, open: '' },

  async onLoad(o) {
    this.pid = o.pid; this.scoped = o.scope === 'stats';
    try { if (!S.data) await S.load(); this.render(); }
    catch (e) { this.setData({ err: '加载失败：' + e.message }); }
  },
  onShareAppMessage() { return { title: (this.data.name || '选手') + ' 的内战战绩', path: `/pages/player/player?pid=${this.pid}` }; },

  render() {
    const d = S.data, P = d.P, f = this.scoped ? S.filter : S.ALL;
    const v = S.view(f);
    const p = P.get(this.pid); if (!p) return this.setData({ err: '找不到这名选手' });
    wx.setNavigationBarTitle({ title: p.name });
    const s = v.st.players[this.pid], sc = v.scores[this.pid], r = v.rs.players[this.pid];
    const scopeTxt = this.scoped && (f.from || f.to || f.league) ? `统计范围：${S.scopeTitle(v)}` : '全部比赛';
    const base = { ok: true, name: p.name, rank: p.rank + (p.stars ? ' ' + p.stars : ''), scopeTxt,
      posTxt: (p.positions || []).map(i => C.POS_SHORT[i]).join(' ') || '-', heroTxt: (p.heroes || []).join('、') || '-' };
    if (!s) return this.setData({ ...base, none: true });

    const sp = n => Math.round(n * 100);
    const tbl = o => Object.entries(o);
    const rel = (o) => tbl(o).filter(([id]) => P.has(id)).sort((a, b) => pctNum(b[1].w, b[1].g) - pctNum(a[1].w, a[1].g) || b[1].g - a[1].g).map(([id, x]) => ({ pid: id, k: S.pname(id), g: x.g, w: x.w, wr: pct(x.w, x.g) }));
    this._lists = {
      pos: tbl(s.pos).sort((a, b) => b[1].g - a[1].g).map(([k, x]) => ({ k: C.POS_NAME[k] || k, g: x.g, w: x.w, wr: pct(x.w, x.g) })),
      hero: tbl(s.heroes).sort((a, b) => b[1].g - a[1].g || b[1].w - a[1].w).map(([k, x]) => ({ k, g: x.g, w: x.w, wr: pct(x.w, x.g) })),
      mates: rel(s.mates), opps: rel(s.opps),
    };
    this._hist = s.eloHist;
    const so = v.so, wsum = (so.wRank + so.wElo + so.wKda + so.wHero) || 1;
    this.setData({
      ...base, none: false,
      badges: (v.badges[this.pid] || []).map(b => ({ t: `${b.icon} ${b.name}`, d: b.detail })),
      tiles: [
        { k: '总场次', v: s.g, s: `${s.w} 胜 ${s.g - s.w} 负` },
        { k: '胜率', v: pct(s.w, s.g), s: s.streak > 0 ? `当前 ${s.streak} 连胜` : s.streak < 0 ? `当前 ${-s.streak} 连败` : '' },
        { k: '天辉', v: pct(s.rw, s.rg), s: `${s.rw}/${s.rg}` },
        { k: '夜魇', v: pct(s.dw, s.dg), s: `${s.dw}/${s.dg}` },
        { k: 'Elo', v: Math.round(s.elo), s: `最高 ${Math.round(s.eloPeak)} · 最低 ${Math.round(s.eloLow)}` },
        s.kdaG ? { k: '场均 KDA', v: ((s.k + s.a) / Math.max(1, s.d)).toFixed(2), s: `${(s.k / s.kdaG).toFixed(1)}/${(s.d / s.kdaG).toFixed(1)}/${(s.a / s.kdaG).toFixed(1)} · ${s.kdaG} 场` }
          : { k: '场均 KDA', v: '-', s: '没有 KDA 数据' },
      ],
      score: sc.score.toFixed(1), thin: !sc.enough,
      parts: [
        { k: '段位', v: sp(sc.rank), w: Math.round(so.wRank / wsum * 100) },
        { k: 'Elo', v: sp(sc.elo), w: Math.round(so.wElo / wsum * 100), s: `Elo ${Math.round(sc.eloRaw)}` },
        { k: 'KDA', v: sp(sc.kda), w: Math.round(so.wKda / wsum * 100), s: sc.kdaRel != null ? `同号位平均的 ${sc.kdaRel.toFixed(2)} 倍` : '' },
        { k: '英雄', v: sp(sc.hero), w: Math.round(so.wHero / wsum * 100) },
      ],
      conf: `样本置信度 ${Math.round(sc.conf * 100)}%（${s.g} 场，可信场次 ${so.trust}）`,
      closeTxt: s.closeG ? `胶着局（击杀差 ≤5）${s.closeW} 胜 ${s.closeG - s.closeW} 负` : '',
      replay: r && r.g ? this.replayTiles(r) : null, replayG: r ? r.g : 0,
      recent: [...s.results].reverse().slice(0, 12).map(x => ({ id: x.id, date: x.date, won: x.won, side: x.side === 'radiant' ? '天辉' : '夜魇', scls: x.side,
        pos: x.pos ? C.POS_SHORT[x.pos] : '-', hero: x.hero || '-', kda: x.kda ? x.kda.join('/') : '-' })),
      eloN: s.eloHist.length, eloTip: s.eloHist.length >= 2 ? '点图表看某一场' : '',
    }, () => { this.renderLists(); if (s.eloHist.length >= 2) this.drawElo(-1); });
  },

  replayTiles(r) {
    const t = [];
    if (r.laneG) {
      t.push({ k: '对线胜率', v: pct(r.laneW, r.laneG), s: `${r.laneW} 胜 ${r.laneL} 负 ${r.laneG - r.laneW - r.laneL} 平 · 平均领先 ${r.laneGold > 0 ? '+' : ''}${Math.round(r.laneGold / r.laneG)}` });
      t.push({ k: '10 分钟补刀', v: (r.lh / r.laneG).toFixed(1), s: `反补 ${(r.dn / r.laneG).toFixed(1)} · ${(r.lvl / r.laneG).toFixed(1)} 级` });
      t.push({ k: '10 分钟净资产', v: Math.round(r.nw / r.laneG), s: '对线期结束时' });
    }
    if (r.kpN) t.push({ k: '击杀参与率', v: (r.kp / r.kpN * 100).toFixed(0) + '%', s: `${r.kpN} 场` });
    if (r.fights) t.push({ k: '团战胜率', v: pct(r.fightsW, r.fights), s: `${r.fightsW}/${r.fights} 次` });
    t.push({ k: '一血', v: r.fb, s: `拿 ${r.fb} 次 · 送 ${r.fbDeath} 次` });
    if (r.cb) t.push({ k: '翻盘', v: r.cb, s: `最多落后 ${r.cbMax} 经济` });
    return t;
  },

  renderLists() {
    const L = this._lists, more = this.data.more, cut = (k) => more[k] ? L[k] : L[k].slice(0, LIST_N);
    this.setData({ posList: L.pos, heroList: cut('hero'), mateList: cut('mates'), oppList: cut('opps'),
      cnt: { hero: L.hero.length, mates: L.mates.length, opps: L.opps.length } });
  },
  toggleMore(e) { const k = e.currentTarget.dataset.k; this.setData({ more: { ...this.data.more, [k]: !this.data.more[k] } }); this.renderLists(); },

  async drawElo(mark) { this._geo = await chart.draw(this, 'pelo', [{ v: this._hist.map(h => h.elo), color: '#e0a83a' }], { mark }); },
  onEloTap(e) {
    const t = (e.touches && e.touches[0]) || {}; const i = chart.indexAt(this._geo, t.x); if (i < 0) return;
    const h = this._hist[i];
    this.setData({ eloTip: `第 ${i + 1} 场 · ${h.date} · ${h.id} · ${h.won ? '胜' : '负'} · Elo ${Math.round(h.elo)}` });
    this.drawElo(i);
  },

  // 最近比赛：点一下展开这场的完整对阵
  toggleMatch(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.open === id) return this.setData({ open: '', detail: null });
    const m = S.matchById(id);
    if (!m) return this.setData({ open: id, detail: { gone: true } });
    const side = arr => (arr || []).map(x => ({ pid: x.pid, name: S.pname(x.pid), me: x.pid === this.pid, pos: x.pos ? C.POS_SHORT[x.pos] : '', hero: x.hero || '', kda: x.kda ? x.kda.join('/') : '' }));
    this.setData({ open: id, detail: { id: m.id, date: m.date, dur: m.duration ? m.duration + ' 分' : '', score: Array.isArray(m.score) ? m.score.join(' : ') : '',
      league: S.leagueOf(m) || '', winner: m.winner === 'radiant' ? '天辉胜' : '夜魇胜', rad: side(m.radiant), dire: side(m.dire), rw: m.winner === 'radiant' } });
  },
  openPlayer(e) { const pid = e.currentTarget.dataset.pid; if (pid && pid !== this.pid) wx.navigateTo({ url: `/pages/player/player?pid=${pid}${this.scoped ? '&scope=stats' : ''}` }); },
});
