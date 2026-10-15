const S = require('../../utils/store.js');
const STEP = 30;

Page({
  data: { loading: true, err: '', leagueOpts: [], leagueIdx: 0, q: '', items: [], total: 0, shown: STEP, updated: '' },

  onLoad(o) { if (o && o.q) this.setData({ q: decodeURIComponent(o.q) }); return this.refresh(false); },
  onShow() { if (S.data && this._ver !== S.data.version) this.render(); },
  onPullDownRefresh() { this.refresh(true).then(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.shown < this.data.total) { this.setData({ shown: this.data.shown + STEP }); this.render(); } },

  async refresh(force) {
    this.setData({ loading: true, err: '' });
    try { const d = await S.load({ force }); this.setData({ updated: `数据 v${d.version} · ${S.fmtTime(d.updatedAt)}` }); this.render(); }
    catch (e) { this.setData({ err: '加载失败：' + e.message }); }
    this.setData({ loading: false });
  },

  render() {
    const d = S.data; if (!d) return;
    this._ver = d.version;
    const opts = S.leagues();
    const idx = Math.min(this.data.leagueIdx, opts.length - 1), lg = opts[idx].value;
    const P = d.P, q = this.data.q.trim().toLowerCase();
    const name = pid => (P.get(pid) || {}).name || '(已删除)';
    const list = d.matches
      .filter(m => !lg || (lg === 'none' ? !S.leagueOf(m) : String(S.leagueOf(m)) === lg))
      .filter(m => !q || m.id.toLowerCase().includes(q) || String(S.leagueOf(m) || '') === q
        || [...(m.radiant || []), ...(m.dire || [])].some(s => (s.hero || '').includes(q) || name(s.pid).toLowerCase().includes(q)))
      .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
    const side = (arr, won) => ({ won, list: (arr || []).map(s => ({ pid: s.pid, name: name(s.pid), hero: s.hero || '', pos: s.pos || '', kda: s.kda ? s.kda.join('/') : '' })) });
    const items = list.slice(0, this.data.shown).map(m => ({
      id: m.id, date: m.date, league: S.leagueOf(m) || '', replay: !!(m.replay && m.replay.heroes), dur: m.duration ? m.duration + ' 分' : '',
      score: Array.isArray(m.score) ? m.score.join(' : ') : '', winner: m.winner === 'radiant' ? '天辉胜' : '夜魇胜', wcls: m.winner,
      rad: side(m.radiant, m.winner === 'radiant'), dire: side(m.dire, m.winner === 'dire'),
    }));
    this.setData({ leagueOpts: opts.map(o => o.label), leagueIdx: idx, items, total: list.length });
  },

  onLeague(e) { this.setData({ leagueIdx: Number(e.detail.value), shown: STEP }); this.render(); },
  onSearch(e) { this.setData({ q: e.detail.value, shown: STEP }); clearTimeout(this._t); this._t = setTimeout(() => this.render(), 250); },
  openMatch(e) { wx.navigateTo({ url: `/pages/match/match?id=${e.currentTarget.dataset.id}` }); },
  openPlayer(e) { wx.navigateTo({ url: `/pages/player/player?pid=${e.currentTarget.dataset.pid}` }); },
});
