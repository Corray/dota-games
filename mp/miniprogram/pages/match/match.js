// 比赛详情（对应网页比赛列表的「详情解析」弹窗）。录像数据来自完美世界解析，网页解析后存进数据库
const S = require('../../utils/store.js');
const chart = require('../../utils/chart.js');
const C = S.core;
const LANE = { 1: '优势路', 2: '中路', 3: '劣势路' };

Page({
  data: { loading: true, err: '', showTable: false, showKills: false, tip: '点任一张图看某一分钟' },

  async onLoad(o) {
    this.id = o.id;
    try {
      if (!S.data) await S.load();
      const m = await S.match(this.id);
      this.m = m; this.render();
    } catch (e) { this.setData({ err: '加载失败：' + e.message }); }
    this.setData({ loading: false });
  },
  onShareAppMessage() { return { title: `内战 ${this.id}`, path: `/pages/match/match?id=${this.id}` }; },

  render() {
    const m = this.m, P = S.data.P, rp = m.replay && m.replay.heroes ? m.replay : null;
    wx.setNavigationBarTitle({ title: `比赛 ${m.id}` });
    const heroName = h => C.HERO_BY_ID[h] || `英雄#${h}`;
    const lineup = key => [...(m[key] || [])].sort((a, b) => (a.pos || 9) - (b.pos || 9)).map(s => ({ pid: s.pid, name: S.pname(s.pid), pos: s.pos ? C.POS_SHORT[s.pos] : '-', hero: s.hero || '', kda: s.kda ? s.kda.join('/') : '' }));
    const out = {
      id: m.id, date: m.date, dur: m.duration ? m.duration + ' 分' : '', winner: m.winner === 'radiant' ? '天辉胜' : '夜魇胜', wcls: m.winner,
      league: S.leagueOf(m) || '', note: m.note || '', score: Array.isArray(m.score) ? m.score.join(' : ') : '',
      rad: lineup('radiant'), dire: lineup('dire'), rw: m.winner === 'radiant', hasReplay: !!rp,
    };
    if (rp) {
      const byHero = new Map(rp.heroes.map(h => [h.h, h]));
      const who = h => { const info = byHero.get(h); if (!info) return heroName(h);
        const side = m[info.r ? 'radiant' : 'dire'] || [];
        const p = (info.acc && side.find(s => (P.get(s.pid) || {}).accountId === info.acc)) || side.find(s => s.hero === heroName(h));
        return p ? S.pname(p.pid) : (info.name || '未知'); };
      const sideOf = h => (byHero.get(h) || {}).r ? 'radiant' : 'dire';
      this._sideOf = sideOf;
      const kills = { radiant: 0, dire: 0 }; (rp.kills || []).forEach(([, k]) => kills[sideOf(k)]++);
      out.kills = `${kills.radiant} : ${kills.dire}`;
      out.saved = rp.at ? new Date(rp.at).toLocaleString() : '';
      out.roster = ['radiant', 'dire'].map(side => ({ side, label: side === 'radiant' ? '天辉' : '夜魇',
        list: rp.heroes.filter(h => h.r === (side === 'radiant')).sort((a, b) => (a.line || 9) - (b.line || 9)).map(h => ({ h: h.h, pos: h.line ? C.POS_SHORT[h.line] || h.line : '-', who: who(h.h), hero: heroName(h.h) })) }));
      out.lanes = (rp.lanes || []).map((l, i) => ({ i, name: LANE[l.type] || '分路 ' + l.type,
        rows: [...l.rad, ...l.dire].map(h => ({ h: h.h, side: sideOf(h.h), who: who(h.h), hero: heroName(h.h), lvl: h.lvl, lh: `${h.lh}/${h.dn}`, nw: h.nw, kda: `${h.k}/${h.d}/${h.a}` })) }));
      const res = rp.res || {};
      out.res = res.radiant ? ['radiant', 'dire'].map(s => { const r = res[s] || {}; return { side: s, label: s === 'radiant' ? '天辉' : '夜魇', v: [r.observerWards, r.sentryWards, r.campsStacked, r.expRune, r.abilityRune, r.smoke, r.dust, r.gem] }; }) : [];
      out.bp = (rp.bp || []).map(([h, pick, team], i) => ({ i: i + 1, name: heroName(h), pick: !!pick, side: team === 0 ? 'radiant' : 'dire' }));
      const fights = C.teamfights(rp); const won = { radiant: 0, dire: 0 }; fights.forEach(f => { if (f.winner) won[f.winner]++; });
      const span = Math.max(m.duration ? m.duration * 60 : 0, ...(rp.kills || []).map(k => k[0]), 60);
      out.fightSum = fights.length ? `${fights.length} 次（${C.FIGHT_GAP} 秒内连续 ≥ ${C.FIGHT_MIN} 杀算一次）· 天辉赢 ${won.radiant} · 夜魇赢 ${won.dire}${fights.length - won.radiant - won.dire ? ` · 平 ${fights.length - won.radiant - won.dire}` : ''}` : '没有连续 3 杀以上的交战';
      out.fights = fights.map((f, i) => ({ i: i + 1, t: `${C.fmtClock(f.start)}–${C.fmtClock(f.end)}`, sc: `${f.radiant} : ${f.dire}`, winner: f.winner, wtxt: f.winner ? (f.winner === 'radiant' ? '天辉赢' : '夜魇赢') : '平',
        swing: f.swing == null ? '-' : (f.swing > 0 ? '+' : '') + f.swing, scls: f.swing > 0 ? 'win' : f.swing < 0 ? 'lose' : '',
        dead: f.kills.map((k, j) => ({ j, side: sideOf(k[2]), who: who(k[2]) })),
        left: (f.start / span * 100).toFixed(2), width: Math.max(1, (f.end - f.start) / span * 100).toFixed(2), h: Math.min(100, 30 + f.kills.length * 12) }));
      out.killDots = (rp.kills || []).map((k, i) => ({ i, left: (k[0] / span * 100).toFixed(2), side: sideOf(k[1]) }));
      out.killList = (rp.kills || []).map(([t, k, v], i) => ({ i, t: C.fmtClock(t), ks: sideOf(k), kw: who(k), kh: heroName(k), vs: sideOf(v), vw: who(v), vh: heroName(v) }));
      out.minutes = (rp.gold || []).map((g, i) => ({ i, g: (g > 0 ? '+' : '') + g, x: rp.exp && rp.exp[i] != null ? (rp.exp[i] > 0 ? '+' : '') + rp.exp[i] : '-', wr: rp.wr && rp.wr[i] != null ? rp.wr[i] + '%' : '-' }));
      out.hasWr = !!(rp.wr && rp.wr.length);
      this.rp = rp;
    }
    this.setData(out, () => { if (rp) this.drawAll(-1); });
  },

  async drawAll(mark) {
    const rp = this.rp, k = v => (v / 1000).toFixed(0) + 'k';
    this._geo = await chart.draw(this, 'gold', [{ v: rp.gold || [], color: '#e0a83a' }], { zero: true, yFmt: k, mark, x0: 0 });
    await chart.draw(this, 'exp', [{ v: rp.exp || [], color: '#4ea1e0' }], { zero: true, yFmt: k, mark, x0: 0 });
    if (rp.wr && rp.wr.length) await chart.draw(this, 'wr', [{ v: rp.wr, color: '#7fb135' }], { yFmt: v => Math.round(v) + '%', mark, x0: 0 });
  },
  onChartTap(e) {
    const t = (e.touches && e.touches[0]) || {}; const i = chart.indexAt(this._geo, t.x); if (i < 0) return;
    const rp = this.rp, f = v => v == null ? '-' : (v > 0 ? '+' : '') + v;
    this.setData({ tip: `第 ${i} 分钟　经济差 ${f(rp.gold[i])}　经验差 ${f(rp.exp && rp.exp[i])}　天辉胜率 ${rp.wr && rp.wr[i] != null ? rp.wr[i] + '%' : '-'}` });
    this.drawAll(i);
  },
  toggleTable() { this.setData({ showTable: !this.data.showTable }); },
  toggleKills() { this.setData({ showKills: !this.data.showKills }); },
  openPlayer(e) { const pid = e.currentTarget.dataset.pid; if (pid) wx.navigateTo({ url: `/pages/player/player?pid=${pid}` }); },
});
