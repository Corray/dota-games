// 导入比赛（对应网页「记录比赛 → 查询比赛」，可一次多场）：先查询看阵容，再确认写入
const S = require('../../utils/store.js');
const BATCH = 10;

Page({
  data: { loading: true, err: '', admin: false, writable: false, token: '', text: '', ids: [], autoNew: true, overwrite: false,
    busy: '', preview: [], ready: 0, done: null },

  onLoad(o) { if (o && o.ids) this.setData({ text: decodeURIComponent(o.ids), ids: S.extractIds(decodeURIComponent(o.ids)) }); return this.checkMe(); },
  async checkMe() {
    try { const r = await S.me(); this.setData({ admin: r.admin, writable: r.writable, loading: false }); }
    catch (e) { this.setData({ err: '查询权限失败：' + e.message, loading: false }); }
  },
  onToken(e) { this.setData({ token: e.detail.value }); },
  async doBind() {
    if (!this.data.token.trim()) return wx.showToast({ title: '先输入编辑口令', icon: 'none' });
    this.setData({ busy: '绑定中…' });
    try { await S.bind(this.data.token.trim()); this.setData({ admin: true, token: '' }); wx.showToast({ title: '已绑定，这个微信以后可以直接导入', icon: 'none' }); }
    catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
    this.setData({ busy: '' });
  },

  onText(e) { const ids = S.extractIds(e.detail.value); this.setData({ text: e.detail.value, ids, preview: [], ready: 0, done: null }); },
  onAutoNew(e) { this.setData({ autoNew: e.detail.value, preview: [], ready: 0 }); },
  onOverwrite(e) { this.setData({ overwrite: e.detail.value, preview: [], ready: 0 }); },
  paste() { wx.getClipboardData({ success: r => this.onText({ detail: { value: (this.data.text ? this.data.text + '\n' : '') + r.data } }) }); },

  opts() { return { autoNew: this.data.autoNew, overwrite: this.data.overwrite }; },
  async doPreview() {
    const ids = this.data.ids; if (!ids.length) return wx.showToast({ title: '没有识别到比赛 ID', icon: 'none' });
    this.setData({ preview: [], ready: 0, done: null });
    const all = [];
    try {
      for (let i = 0; i < ids.length; i += BATCH) {
        this.setData({ busy: `查询中… ${Math.min(i + BATCH, ids.length)} / ${ids.length}（每场要拉比赛 + 录像，约 1-2 秒）` });
        const r = await S.previewIds(ids.slice(i, i + BATCH), this.opts());
        all.push(...r.results);
        this.setData({ preview: all.map(x => ({ ...x, wtxt: x.winner === 'radiant' ? '天辉胜' : '夜魇胜' })), ready: all.filter(x => x.ok).length });
      }
    } catch (e) { wx.showToast({ title: '查询失败：' + e.message, icon: 'none' }); }
    this.setData({ busy: '' });
  },
  async doImport() {
    const ids = this.data.preview.filter(x => x.ok).map(x => x.id);
    if (!ids.length) return;
    // 同一个陌生人可能在几场里都出现，按昵称去重后再报数（导入时同样按 Steam ID 只建一次）
    const newP = new Set(this.data.preview.filter(x => x.ok).flatMap(x => [...x.radiant, ...x.dire]).filter(p => p.isNew).map(p => p.name)).size;
    const go = await new Promise(r => wx.showModal({ title: '确认导入', content: `导入 ${ids.length} 场${newP ? `，约会新建 ${newP} 名选手` : ''}${this.data.overwrite ? '，已存在的会被覆盖' : ''}。导入后网页和小程序都能看到。`, success: x => r(x.confirm) }));
    if (!go) return;
    const res = [];
    try {
      for (let i = 0; i < ids.length; i += BATCH) {
        this.setData({ busy: `导入中… ${Math.min(i + BATCH, ids.length)} / ${ids.length}` });
        const r = await S.importIds(ids.slice(i, i + BATCH), this.opts());
        res.push(...r.results);
      }
    } catch (e) { wx.showToast({ title: '导入失败：' + e.message, icon: 'none' }); }
    const ok = res.filter(x => x.ok);
    this.setData({ busy: '刷新数据…', done: { ok: ok.length, fail: res.length - ok.length, created: ok.reduce((n, x) => n + (x.created || 0), 0), replay: ok.filter(x => x.replay).length, errs: res.filter(x => !x.ok).map(x => `${x.id}：${x.error}`) }, preview: [], ready: 0 });
    try { await S.load({ force: true }); } catch (e) { }
    this.setData({ busy: '' });
  },
  openMatch(e) { const id = e.currentTarget.dataset.id; if (S.matchById(id)) wx.navigateTo({ url: `/pages/match/match?id=${id}` }); },
});
