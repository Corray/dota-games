const S = require('../../utils/store.js');
const SORTS = [
  { key: 'score', label: '评分' }, { key: 'wr', label: '胜率' }, { key: 'g', label: '场次' }, { key: 'elo', label: 'Elo' },
];
const MINS = [1, 3, 5, 10];
const STEP = 50;
const pct = (w, g) => g ? Math.round(w / g * 1000) / 10 + '%' : '-';

Page({
  data: { loading: true, err: '', offline: '', tiles: [], rows: [], total: 0, shown: STEP,
    leagueOpts: [], leagueIdx: 0, sorts: SORTS, sort: 'score', mins: MINS, minIdx: 0, updated: '' },

  onLoad() { return this.refresh(false); },
  onPullDownRefresh() { this.refresh(true).then(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.shown < this.data.total) { this.setData({ shown: this.data.shown + STEP }); this.render(); } },
  onShareAppMessage() { return { title: 'Dota 内战排行', path: '/pages/rank/rank' }; },

  async refresh(force) {
    this.setData({ loading: true, err: '' });
    try {
      const d = await S.load({ force });
      this.setData({ offline: d.offline ? `连不上云端，显示的是本机缓存（${d.error}）` : '', updated: `数据 v${d.version} · ${S.fmtTime(d.updatedAt)}` });
      this.render();
    } catch (e) {
      this.setData({ err: '加载失败：' + e.message });
    }
    this.setData({ loading: false });
  },

  render() {
    const opts = S.leagues();
    const idx = Math.min(this.data.leagueIdx, opts.length - 1);
    const v = S.view(opts[idx].value); if (!v) return;
    const { st, scores, badges } = v; const P = S.data.P;
    const minG = MINS[this.data.minIdx];
    let list = Object.values(st.players).filter(s => s.g >= minG && P.has(s.pid)).map(s => {
      const p = P.get(s.pid), sc = scores[s.pid];
      return { pid: s.pid, name: p.name, rank: p.rank + (p.stars ? ' ' + p.stars : ''), g: s.g, w: s.w, wrN: s.w / s.g, wr: pct(s.w, s.g),
        elo: Math.round(s.elo), score: sc ? sc.score.toFixed(1) : '-', scoreN: sc ? sc.score : 0,
        badges: (badges[s.pid] || []).map(b => b.icon).join(''),
        streak: s.streak >= 3 ? `${s.streak} 连胜` : s.streak <= -3 ? `${-s.streak} 连败` : '' };
    });
    const by = { score: x => x.scoreN, wr: x => x.wrN, g: x => x.g, elo: x => x.elo }[this.data.sort];
    list.sort((a, b) => by(b) - by(a) || b.g - a.g);
    list.forEach((x, i) => { x.no = i + 1; });
    const hero = Object.values(st.heroes).sort((a, b) => b.g - a.g)[0];
    this.setData({
      leagueOpts: opts.map(o => o.label), leagueIdx: idx, total: list.length,
      rows: list.slice(0, this.data.shown),
      tiles: [
        { k: '总场次', v: st.total, s: `${list.length} 人上榜` },
        { k: '天辉胜率', v: pct(st.radiantWins, st.total), s: `天辉 ${st.radiantWins} 胜` },
        { k: '热门英雄', v: hero ? hero.hero : '-', s: hero ? `${hero.g} 场 · ${pct(hero.w, hero.g)}` : '' },
      ],
    });
  },

  onLeague(e) { this.setData({ leagueIdx: Number(e.detail.value), shown: STEP }); this.render(); },
  onMin(e) { this.setData({ minIdx: Number(e.detail.value), shown: STEP }); this.render(); },
  onSort(e) { this.setData({ sort: e.currentTarget.dataset.k, shown: STEP }); this.render(); },
  openPlayer(e) {
    const league = S.leagues()[this.data.leagueIdx]?.value || '';
    wx.navigateTo({ url: `/pages/player/player?pid=${e.currentTarget.dataset.pid}&league=${league}` });
  },
});
