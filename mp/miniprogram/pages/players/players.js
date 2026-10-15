// 选手名单（对应网页「选手名单」页右侧表格；按全部比赛统计，和网页一致）
const S = require('../../utils/store.js');
const STEP = 40;
const SORTS = [{ k: 'rank', t: '段位' }, { k: 'score', t: '评分' }, { k: 'pts', t: '积分' }, { k: 'mmr', t: 'MMR' }, { k: 'g', t: '场次' }, { k: 'wr', t: '胜率' }, { k: 'name', t: '昵称' }];

Page({
  data: { loading: true, err: '', offline: '', q: '', sorts: SORTS, sort: 'rank', dir: -1, rows: [], total: 0, all: 0, shown: STEP, updated: '' },

  onLoad() { return this.refresh(false); },
  onShow() { if (S.data && this._key && this._key !== this.key()) this.render(); },
  onPullDownRefresh() { this.refresh(true).then(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.shown < this.data.total) { this.setData({ shown: this.data.shown + STEP }); this.render(); } },
  onShareAppMessage() { return { title: 'Dota 内战选手名单', path: '/pages/players/players' }; },
  key() { return S.data.version + JSON.stringify(S.scoreOpt()); },

  async refresh(force) {
    this.setData({ loading: true, err: '' });
    try {
      const d = await S.load({ force });
      this.setData({ offline: d.offline ? `连不上云端，显示的是本机缓存（${d.error}）` : '', updated: `数据 v${d.version} · ${S.fmtTime(d.updatedAt)}` });
      this.render();
    } catch (e) { this.setData({ err: '加载失败：' + e.message }); }
    this.setData({ loading: false });
  },

  render() {
    const d = S.data; if (!d) return;
    this._key = this.key();
    const v = S.view(S.ALL), C = S.core;
    const q = this.data.q.trim().toLowerCase();
    const { sort, dir } = this.data;
    const list = d.players
      .filter(p => !q || p.name.toLowerCase().includes(q) || (p.rank || '').includes(q) || (p.heroes || []).some(h => h.includes(q)) || String(p.mmr || '') === q)
      .map(p => { const s = v.st.players[p.id], sc = v.scores[p.id]; return { p, s, sc }; });
    const val = r => sort === 'score' ? r.sc.score : sort === 'pts' ? (r.s ? r.s.pts : 0) : sort === 'mmr' ? (r.p.mmr || 0) : sort === 'g' ? (r.s ? r.s.g : 0) : sort === 'wr' ? C.pctNum(r.s ? r.s.w : 0, r.s ? r.s.g : 0) : sort === 'name' ? r.p.name : C.rankIdx(r.p);
    list.sort((a, b) => {
      const va = val(a), vb = val(b);
      const c = typeof va === 'string' ? va.localeCompare(vb, 'zh') : va - vb;
      return c * dir || C.rankIdx(b.p) - C.rankIdx(a.p) || a.p.name.localeCompare(b.p.name, 'zh');
    });
    const rows = list.slice(0, this.data.shown).map(({ p, s, sc }) => ({
      pid: p.id, name: p.name, rank: p.rank + (p.stars ? ' ' + p.stars : ''),
      pos: (p.positions || []).map(i => C.POS_SHORT[i]).filter(Boolean),
      heroes: (p.heroes || []).slice(0, 6),
      score: sc.score.toFixed(1), thin: !sc.enough, bar: s && s.ptsMax ? Math.round(s.pts / s.ptsMax * 100) : 0,
      g: s ? s.g : 0, wr: s ? C.pct(s.w, s.g) : '-', pts: s ? s.pts : 0, mmr: p.mmr || '',
      badges: (v.badges[p.id] || []).map(b => b.icon).join(''),
    }));
    this.setData({ rows, total: list.length, all: d.players.length });
  },

  onSearch(e) { this.setData({ q: e.detail.value, shown: STEP }); clearTimeout(this._t); this._t = setTimeout(() => this.render(), 250); },
  onSort(e) {
    const k = e.currentTarget.dataset.k;
    // 同一列再点一次反过来；昵称 / 段位默认升序以外都默认降序（同网页）
    const dir = this.data.sort === k ? -this.data.dir : (k === 'name' ? 1 : -1);
    this.setData({ sort: k, dir, shown: STEP }); this.render();
  },
  open(e) { wx.navigateTo({ url: `/pages/player/player?pid=${e.currentTarget.dataset.pid}` }); },
});
