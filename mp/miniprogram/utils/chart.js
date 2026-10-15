/**
 * 折线图（canvas 2d）：series = [{ v: [数值或 null], color }]，横轴等分。返回绘图参数，供点击换算第几个点。
 * 用法：<canvas type="2d" id="xx" style="width:100%;height:440rpx" bindtouchstart="onTap"></canvas>
 */
const COLORS = ['#e0a83a', '#7fb135', '#d0463b', '#4ea1e0', '#b07be0', '#e07bb0', '#5fcfc0', '#c9c04a'];

function draw(page, id, series, { yFmt = v => String(Math.round(v)), mark = -1, zero = false, x0 = 1 } = {}) {
  return new Promise(resolve => {
    if (typeof wx.createSelectorQuery !== 'function') return resolve(null);
    wx.createSelectorQuery().in(page).select('#' + id).fields({ node: true, size: true }).exec(res => {
      const c = res && res[0]; if (!c || !c.node) return resolve(null);
      const canvas = c.node, ctx = canvas.getContext('2d');
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const dpr = info.pixelRatio || 2, W = c.width, H = c.height;
      canvas.width = W * dpr; canvas.height = H * dpr; ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, W, H);
      const n = Math.max(0, ...series.map(s => s.v.length));
      const vals = series.flatMap(s => s.v).filter(v => v != null);
      if (n < 2 || !vals.length) { ctx.fillStyle = '#8b93a1'; ctx.font = '12px sans-serif'; ctx.fillText('至少要有 2 场比赛', 8, 20); return resolve(null); }
      let lo = Math.min(...vals), hi = Math.max(...vals);
      if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      if (hi - lo < 1) { lo -= 10; hi += 10; }
      const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
      const L = 40, R = 8, T = 8, B = 18;
      const x = i => L + (W - L - R) * (n === 1 ? 0 : i / (n - 1));
      const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
      // 网格 + 纵轴刻度
      ctx.strokeStyle = '#2a313c'; ctx.lineWidth = 1; ctx.fillStyle = '#8b93a1'; ctx.font = '10px sans-serif';
      for (let k = 0; k <= 3; k++) { const v = lo + (hi - lo) * k / 3, yy = y(v); ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(W - R, yy); ctx.stroke(); ctx.fillText(yFmt(v), 2, yy + 3); }
      ctx.fillText(String(x0), L, H - 4); const last = String(n - 1 + x0); ctx.fillText(last, W - R - ctx.measureText(last).width, H - 4);
      if (zero && lo < 0 && hi > 0) { ctx.strokeStyle = '#5a6270'; ctx.beginPath(); ctx.moveTo(L, y(0)); ctx.lineTo(W - R, y(0)); ctx.stroke(); }
      // 折线
      for (const s of series) {
        ctx.strokeStyle = s.color; ctx.lineWidth = 1.6; ctx.beginPath(); let on = false;
        s.v.forEach((v, i) => { if (v == null) { on = false; return; } if (!on) { ctx.moveTo(x(i), y(v)); on = true; } else ctx.lineTo(x(i), y(v)); });
        ctx.stroke();
      }
      if (mark >= 0 && mark < n) { ctx.strokeStyle = '#e6e9ef'; ctx.setLineDash && ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x(mark), T); ctx.lineTo(x(mark), H - B); ctx.stroke(); ctx.setLineDash && ctx.setLineDash([]); }
      resolve({ L, R, W, n });
    });
  });
}
// 触摸点 → 第几个数据点
const indexAt = (geo, touchX) => geo ? Math.max(0, Math.min(geo.n - 1, Math.round((touchX - geo.L) / ((geo.W - geo.L - geo.R) / (geo.n - 1))))) : -1;

module.exports = { draw, indexAt, COLORS };
