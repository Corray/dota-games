// 天梯资料（对应网页「查看天梯资料」弹窗）：云函数代查 OpenDota 四个接口
const S = require('../../utils/store.js');
const C = S.core;
const pct = C.pct;
const HERO_LIMIT = 15;
const HSORTS = [{ k: 'games', t: '场次' }, { k: 'win', t: '胜' }, { k: 'wr', t: '胜率' }, { k: 'last', t: '最近使用' }, { k: 'withwr', t: '队友选时' }, { k: 'againstwr', t: '对阵时' }, { k: 'name', t: '英雄' }];
const fmtAgo = ts => { if (!ts) return '-'; const s = Date.now() / 1000 - ts; if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} 分钟前`; if (s < 86400) return `${Math.floor(s / 3600)} 小时前`; if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`; if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)} 个月前`; return `${Math.floor(s / 86400 / 365)} 年前`; };
const fmtDur = sec => sec ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '-';
const tierTxt = tier => { const r = C.rankFromTier(tier); return r ? r.rank + (r.stars ? ' ' + r.stars : '') : '-'; };
const heroName = id => C.HERO_BY_ID[id] || `英雄#${id}`;

Page({
  data: { loading: true, err: '', hsorts: HSORTS, hsort: 'games', hdir: -1, allHeroes: false, openDist: '' },

  onLoad(o) { this.pid = o.pid; return this.fetch(false); },
  onPullDownRefresh() { this.fetch(true).then(() => wx.stopPullDownRefresh()); },

  async fetch(force) {
    this.setData({ loading: true, err: '' });
    try {
      if (!S.data) await S.load();
      const p = S.data.P.get(this.pid);
      this.p = p;
      wx.setNavigationBarTitle({ title: (p ? p.name : '') + ' · 天梯资料' });
      const d = await S.ladder(this.pid, force);
      if (d.noAccount) { this.setData({ loading: false, err: '这名选手没有登记 Steam ID，网页「选手名单 → 编辑」里填上才能查' }); return; }
      this.d = d; this.render();
    } catch (e) { this.setData({ err: '拉取失败：' + e.message }); }
    this.setData({ loading: false });
  },

  render() {
    const d = this.d, p = this.p || {};
    const pr = d.profile && d.profile.profile || {};
    const heroes = Array.isArray(d.heroes) ? d.heroes : null, recent = Array.isArray(d.recent) ? d.recent : null;
    const counts = d.counts && typeof d.counts === 'object' ? d.counts : null;
    const countsEmpty = !counts || !Object.values(counts).some(v => v && Object.keys(v).length);
    const empty = (!heroes || !heroes.length) && (!recent || !recent.length) && countsEmpty;
    const out = {
      name: p.name || '', rank: p.rank ? p.rank + (p.stars ? ' ' + p.stars : '') : '', acc: d.accountId,
      avatar: pr.avatarmedium || '', persona: pr.personaname || '-', plus: !!pr.plus,
      ladderRank: d.profile && d.profile.rank_tier ? tierTxt(d.profile.rank_tier) : '未定级 / 未公开',
      board: d.profile && d.profile.leaderboard_rank ? '#' + d.profile.leaderboard_rank : '',
      when: `${Date.now() - d.at > 5000 ? '缓存于' : '更新于'} ${new Date(d.at).toTimeString().slice(0, 5)}`,
      errs: d.errs || [], empty: empty && !(d.errs || []).length,
    };
    // ---- 统计（counts）----
    if (counts && !countsEmpty) {
      const sum = key => Object.values(counts[key] || {}).reduce((a, v) => ({ g: a.g + (v.games || 0), w: a.w + (v.win || 0) }), { g: 0, w: 0 });
      const total = sum('is_radiant').g ? sum('is_radiant') : sum('lobby_type');
      const rad = (counts.is_radiant || {})['1'] || { games: 0, win: 0 }, dire = (counts.is_radiant || {})['0'] || { games: 0, win: 0 };
      const ranked = ['5', '6', '7'].reduce((a, k) => { const v = (counts.lobby_type || {})[k]; return v ? { g: a.g + v.games, w: a.w + v.win } : a; }, { g: 0, w: 0 });
      const leave = Object.entries(counts.leaver_status || {}).filter(([k]) => Number(k) >= 2).reduce((n, [, v]) => n + v.games, 0);
      out.ctiles = [
        { k: '总场次', v: total.g, s: `${total.w} 胜 ${total.g - total.w} 负` },
        { k: '总胜率', v: pct(total.w, total.g), s: `天梯 ${pct(ranked.w, ranked.g)}（${ranked.g} 场）` },
        { k: '逃跑 / 断线', v: leave, s: total.g ? (leave / total.g * 100).toFixed(1) + '% 的比赛' : '-' },
        { k: '天辉', v: pct(rad.win, rad.games), s: `${rad.win}/${rad.games}` },
        { k: '夜魇', v: pct(dire.win, dire.games), s: `${dire.win}/${dire.games}` },
      ];
      const dist = (key, title, names, fmtKey) => ({ key, title, rows: Object.entries(counts[key] || {}).filter(([, v]) => v.games > 0).sort((a, b) => b[1].games - a[1].games)
        .map(([k, v]) => ({ k: names[k] != null ? names[k] : fmtKey(k), g: v.games, wr: pct(v.win, v.games) })) });
      out.dists = [
        dist('lobby_type', '大厅类型', C.LOBBY_NAME, k => `类型 ${k}`), dist('game_mode', '游戏模式', C.GAME_MODE_NAME, k => `模式 ${k}`),
        dist('lane_role', '分路', C.LANE_ROLE_NAME, k => `分路 ${k}`), dist('region', '服务器', C.REGION_NAME, k => k === 'NaN' ? '未知' : `服务器 ${k}`),
        dist('patch', '游戏版本', C.PATCH_NAME, k => `版本 #${k}`), dist('leaver_status', '离开状态', C.LEAVER_NAME, k => `状态 ${k}`),
      ].filter(x => x.rows.length);
    } else { out.ctiles = []; out.dists = []; }
    // ---- 近期比赛 ----
    if (recent && recent.length) {
      const won = m => (m.player_slot < 128) === !!m.radiant_win;
      const w = recent.filter(won).length;
      const avg = f => recent.reduce((a, m) => a + (f(m) || 0), 0) / recent.length;
      const ranks = recent.filter(m => m.average_rank);
      const avgTier = ranks.length ? Math.round(ranks.reduce((a, m) => a + m.average_rank, 0) / ranks.length) : 0;
      const known = new Set(S.data.matches.map(m => m.id));
      out.rtiles = [
        { k: `近 ${recent.length} 场`, v: `${w} 胜 ${recent.length - w} 负`, s: '' },
        { k: '场均 KDA', v: ((avg(m => m.kills) + avg(m => m.assists)) / Math.max(1, avg(m => m.deaths))).toFixed(2), s: `${avg(m => m.kills).toFixed(1)} / ${avg(m => m.deaths).toFixed(1)} / ${avg(m => m.assists).toFixed(1)}` },
        { k: '场均 GPM / XPM', v: `${Math.round(avg(m => m.gold_per_min))} / ${Math.round(avg(m => m.xp_per_min))}`, s: `场均时长 ${fmtDur(Math.round(avg(m => m.duration)))}` },
        { k: '对局平均段位', v: avgTier ? tierTxt(avgTier) : '-', s: `${ranks.length} 场有段位数据` },
      ];
      out.strip = recent.map(m => won(m) ? 'w' : 'l');
      out.recent = recent.map(m => { const rad = m.player_slot < 128, id = String(m.match_id); return {
        id, ago: fmtAgo(m.start_time), hero: heroName(m.hero_id), side: rad ? '天辉' : '夜魇', scls: rad ? 'radiant' : 'dire', won: won(m),
        kda: `${m.kills}/${m.deaths}/${m.assists}`, gx: `${m.gold_per_min || 0} / ${m.xp_per_min || 0}`, lh: m.last_hits != null ? m.last_hits : '-', dur: fmtDur(m.duration),
        mode: (C.GAME_MODE_NAME[m.game_mode] != null ? C.GAME_MODE_NAME[m.game_mode] : `模式 ${m.game_mode}`) + ' · ' + (C.LOBBY_NAME[m.lobby_type] != null ? C.LOBBY_NAME[m.lobby_type] : `类型 ${m.lobby_type}`) + (m.party_size ? ` · ${m.party_size} 人组` : ''),
        tier: tierTxt(m.average_rank), known: known.has(id) }; });
    } else { out.rtiles = []; out.recent = recent ? [] : null; out.strip = []; }
    out.heroTotal = heroes ? heroes.length : 0;
    this.setData(out);
    this.renderHeroes();
  },

  renderHeroes() {
    const heroes = Array.isArray(this.d.heroes) ? this.d.heroes : [];
    const mine = new Set((this.p && this.p.heroes) || []);
    const wr = (w, g) => g ? w / g : -1;
    const val = { name: h => heroName(h.hero_id), games: h => h.games, win: h => h.win, wr: h => wr(h.win, h.games), last: h => h.last_played || 0, withwr: h => wr(h.with_win, h.with_games), againstwr: h => wr(h.against_win, h.against_games) };
    const { hsort: key, hdir: dir } = this.data; const f = val[key] || val.games;
    const list = [...heroes].sort((a, b) => { const x = f(a), y = f(b); const c = typeof x === 'string' ? x.localeCompare(y, 'zh') : x - y; return c ? c * dir : b.games - a.games; });
    const shown = this.data.allHeroes ? list : list.slice(0, HERO_LIMIT);
    this.setData({ heroRows: shown.map(h => { const n = heroName(h.hero_id); return { id: h.hero_id, n, mine: mine.has(n), g: h.games, w: h.win, wr: pct(h.win, h.games), last: fmtAgo(h.last_played),
      with: h.with_games ? `${pct(h.with_win, h.with_games)}/${h.with_games}` : '-', against: h.against_games ? `${pct(h.against_win, h.against_games)}/${h.against_games}` : '-' }; }) });
  },
  onHSort(e) { const k = e.currentTarget.dataset.k; const hdir = this.data.hsort === k ? -this.data.hdir : (k === 'name' ? 1 : -1); this.setData({ hsort: k, hdir }); this.renderHeroes(); },
  toggleAllHeroes() { this.setData({ allHeroes: !this.data.allHeroes }); this.renderHeroes(); },
  toggleDist(e) { const k = e.currentTarget.dataset.k; this.setData({ openDist: this.data.openDist === k ? '' : k }); },
  openMatch(e) { const id = e.currentTarget.dataset.id; if (S.matchById(id)) wx.navigateTo({ url: `/pages/match/match?id=${id}` }); else wx.setClipboardData({ data: id, success: () => wx.showToast({ title: '内战里没有这场，已复制比赛 ID', icon: 'none' }) }); },
});
