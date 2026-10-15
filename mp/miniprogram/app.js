App({
  onLaunch() {
    // 云开发环境（上海）；换环境时同时改这里和 node mp/deploy.js func <envId>
    wx.cloud.init({ env: 'dotamatch-d9g0fq3mx01ad9040', traceUser: false });
  },
  globalData: {},
});
