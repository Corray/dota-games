const S = require('../../utils/store.js');
const pct = (w, g) => g ? Math.round(w / g * 1000) / 10 + '%' : '-';
const POS = { 1: '1号位 核心', 2: '2号位 中单', 3: '3号位 劣单', 4: '4号位 游走', 5: '5号位 辅助' };

Page({
  data: { ok: false, err: '' },

  async onLoad(o) {
    this.pid = o.pid; this.league = o.league || '';
    try { if (!S.data) await S.load(); this.render(); }
    catch (e) { this.setData({ err: '加载失败：' + e.message }); }
  },
  onShareAppMessage() { return { title: (this.data.name || '选手') + ' 的内战战绩', path: `/pages/player/player?pid=${this.pid}` }; },

  render() {
    const d = S.data, v = S.view(this.league), P = d.P;
    const p = P.get(this.pid); if (!p) return this.setData({ err: '找不到这名选手' });
    const s = v.st.players[this.pid], sc = v.scores[this.pid], r = v.rs.players[this.pid];
    wx.setNavigationBarTitle({ title: p.name });
    const name = pid => (P.get(pid) || {}).name || '(已删除)';
    const base = { ok: true, name: p.name, rank: p.rank + (p.stars ? ' ' + p.stars : ''), league: this.league,
      profile: [(p.positions || []).map(i => POS[i] || i).join('、'), (p.heroes || []).slice(0, 3).join('、')].filter(Boolean).join(' ｜ ') };
    if (!s) return this.setData({ ...base, none: true });

    const sp = n => Math.round(n * 100);
    const kda = s.kdaG ? `${(s.k / s.kdaG).toFixed(1)}/${(s.d / s.kdaG).toFixed(1)}/${(s.a / s.kdaG).toFixed(1)}` : '-';
    const rel = (o, min) => Object.entries(o).filter(([id, x]) => x.g >= min && P.has(id)).map(([id, x]) => ({ pid: id, name: name(id), g: x.g, w: x.w, wrN: x.w / x.g, wr: pct(x.w, x.g) }));
    const mates = rel(s.mates, 3).sort((a, b) => b.wrN - a.wrN || b.g - a.g).slice(0, 5);
    const nemesis = rel(s.opps, 3).sort((a, b) => a.wrN - b.wrN || b.g - a.g).slice(0, 5);
    const hist = s.eloHist.slice(-40);
    const lo = Math.min(...hist.map(h => h.elo)), hi = Math.max(...hist.map(h => h.elo));
    const bars = hist.map(h => ({ h: hi > lo ? 12 + Math.round((h.elo - lo) / (hi - lo) * 88) : 50, won: h.won }));

    this.setData({
      ...base, none: false,
      tiles: [
        { k: '场次', v: s.g, s: `${s.w} 胜 ${s.g - s.w} 负` },
        { k: '胜率', v: pct(s.w, s.g), s: s.streak >= 2 ? `${s.streak} 连胜中` : s.streak <= -2 ? `${-s.streak} 连败中` : '' },
        { k: '评分', v: sc.score.toFixed(1), s: sc.enough ? '' : '样本少，向中间收缩' },
        { k: 'Elo', v: Math.round(s.elo), s: `最高 ${Math.round(s.eloPeak)}` },
        { k: '场均 KDA', v: kda, s: s.kdaRel != null ? `同号位平均的 ${s.kdaRel.toFixed(2)} 倍` : '' },
        { k: '胶着局', v: s.closeG ? pct(s.closeW, s.closeG) : '-', s: s.closeG ? `${s.closeW} 胜 ${s.closeG - s.closeW} 负` : '击杀差 ≤5 的局' },
      ],
      parts: [
        { k: '段位', v: sp(sc.rank) }, { k: 'Elo', v: sp(sc.elo) }, { k: 'KDA', v: sp(sc.kda) }, { k: '英雄', v: sp(sc.hero) },
      ],
      sides: `天辉 ${pct(s.rw, s.rg)}（${s.rg} 场） · 夜魇 ${pct(s.dw, s.dg)}（${s.dg} 场）`,
      badges: (v.badges[this.pid] || []).map(b => ({ t: `${b.icon} ${b.name}`, d: b.detail })),
      pos: Object.entries(s.pos).sort((a, b) => b[1].g - a[1].g).map(([k, x]) => ({ k: POS[k] || k, g: x.g, wr: pct(x.w, x.g) })),
      heroes: Object.entries(s.heroes).sort((a, b) => b[1].g - a[1].g).slice(0, 8).map(([h, x]) => ({ h, g: x.g, wr: pct(x.w, x.g) })),
      mates, nemesis, bars,
      replay: r && r.g ? [
        r.laneG ? `对线 ${r.laneW} 胜 ${r.laneL} 负 ${r.laneG - r.laneW - r.laneL} 平` : '',
        r.kpN ? `参团率 ${Math.round(r.kp / r.kpN * 100)}%` : '',
        r.fb ? `一血 ${r.fb} 次` : '', r.cb ? `翻盘 ${r.cb} 次` : '',
      ].filter(Boolean).join(' · ') + `（${r.g} 场有录像解析）` : '',
      recent: s.results.slice(-20).reverse().map(x => ({ id: x.id, date: x.date, won: x.won, hero: x.hero || '-', pos: x.pos || '', kda: x.kda ? x.kda.join('/') : '', side: x.side === 'radiant' ? '天辉' : '夜魇' })),
    });
  },

  openPlayer(e) { wx.navigateTo({ url: `/pages/player/player?pid=${e.currentTarget.dataset.pid}&league=${this.league}` }); },
});
