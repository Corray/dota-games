# Dota 内战记录 · 微信小程序

第一期只读：选手排行、比赛列表、选手详情，按联赛筛选。数据和网页版是同一份（百度云 MySQL 的 `dota_state` 表），
统计用仓库根目录的 `core.js` 计算，和网页口径一致。

```
mp/
├── project.config.json        appid、目录配置
├── miniprogram/               小程序代码
│   ├── utils/core.js          ⚠ 自动生成：根目录 core.js 的副本（node mp/sync-core.js）
│   ├── utils/store.js         数据层：云函数取数 + 本机缓存（按版本号判断要不要重拉）
│   └── pages/rank | matches | player
├── cloudfunctions/api/        云函数：读 MySQL，分页返回；连接信息走云函数环境变量
├── deploy.js                  部署脚本（miniprogram-ci）
└── sync-core.js               同步计算核心
```

## 前置条件

1. 小程序后台 → 开发管理 → 开发设置 → 小程序代码上传：下载上传密钥，放在 `../../private.<appid>.key`（仓库外），
   **IP 白名单**加上运行脚本的机器出口 IP（家宽 IP 会变，嫌麻烦可以选不限制）。
2. 开通云开发：微信开发者工具 → 云开发 → 开通，记下环境 ID。
3. `server/.env` 里有 `MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE`。

## 部署

```bash
cd mp && npm install
node deploy.js envs                 # 看云开发环境
node deploy.js func                 # 部署云函数 api（只有一个环境时自动选；多个时 node deploy.js func <envId>）
node deploy.js preview              # 生成 mp/preview.png，开发者扫码预览
node deploy.js upload 1.0.0 "说明"   # 上传体验版，再到后台「版本管理」提交审核
```

改了根目录 `core.js` 后，`preview` / `upload` 会自动同步；也可以手动 `node sync-core.js`，`node sync-core.js --check` 只检查。

## 已知取舍

- 评分用默认权重（段位 40 / Elo 30 / KDA 20 / 英雄 10）。网页上改过的权重只存在那台浏览器，小程序看不到。
- 联赛只显示 ID，网页上给联赛起的名字只存在那台浏览器。
- 写入（录比赛）放第二期，打算用微信身份白名单鉴权，不再用编辑口令。
