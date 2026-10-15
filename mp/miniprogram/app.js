App({
  onLaunch() {
    // 不指定 env = 用小程序的默认云开发环境（第一个创建的）；mp/deploy.js 部署时会核对
    wx.cloud.init({ traceUser: false });
  },
  globalData: {},
});
