# 云同步接口 · MySQL / MongoDB 版

和 `worker/`（Cloudflare Worker + KV）提供的 `/data` 接口完全一致，只是存储换成 MySQL 或 MongoDB Atlas，按环境变量二选一。
用途：`*.workers.dev` 在国内直连不了时，把这个服务部署到国内能直连的地方，页面「☁ 云端 → 云同步地址」填它的地址即可，
中转（比赛查询 / 联赛导入）仍走 Worker，互不影响。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 健康检查：`db` 为 `ok` 表示连上了 Atlas |
| GET | `/data` | `{ ok, version, updatedAt, data }` |
| GET | `/data/meta` | 只返回版本号，页面切回前台时轻量探测 |
| GET | `/data?strip=1` | 脱敏快照（去 Steam ID / 备注 / 赛事），`?share=cloud` 只读分享页用 |
| PUT | `/data` | 整份覆盖写入；头 `X-Edit-Token` = 编辑口令，`X-Base-Version` = 读到的版本号，不一致返回 409 |

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `EDIT_TOKEN` | 否 | 编辑口令。不设则只读 |
| `MYSQL_HOST` | 二选一 | 设了就用 MySQL，优先于 MongoDB |
| `MYSQL_PORT` `MYSQL_USER` `MYSQL_PASSWORD` `MYSQL_DATABASE` | MySQL 时 | 账号要有该库的建表和读写权限，首次请求自动建表 `dota_state` |
| `MONGODB_URI` | 二选一 | Atlas 连接串 `mongodb+srv://用户:密码@cluster0.xxx.mongodb.net` |
| `MONGODB_DB` | 否 | MongoDB 库名，默认 `dota` |
| `PORT` | 否 | 默认 8787；阿里云函数计算注入的 `FC_SERVER_PORT` 优先 |
| `DNS_SERVERS` | 否 | 运营商 DNS 解析不了 Atlas 的 SRV/TXT 记录时填 `223.5.5.5,119.29.29.29` |

数据库侧要先做：**白名单允许 `0.0.0.0/0`**（函数计算出口 IP 不固定；Atlas 在 Network Access，百度云 GaiaDB 在集群白名单），账号要有读写权限。

如果接口和 MySQL 部署在同一家云的同一地域（如百度云北京），白名单可以只放内网网段，更安全。

## 本地跑

```bash
cd server && npm install
cp .env.example .env   # 填好
set -a; source .env; set +a; node index.js
curl http://127.0.0.1:8787/
```

## 从旧云端搬数据

`migrate.mjs` 把现有云端（Cloudflare KV）的数据原样搬进数据库，版本号和更新时间一起搬：

```bash
# workers.dev 要代理才能访问时，先用 curl 下载（curl 走 HTTPS_PROXY，Node 的 fetch 不走）
curl -s https://dota-match-proxy.corray.workers.dev/data -o dump.json
set -a; source .env; set +a
node migrate.mjs --file dump.json          # 库为空或库里更旧时才写；要覆盖加 --force
```

写完会回读核对，打印「与源数据完全一致」才算成功。

## 页面怎么切到数据库

- 单台设备：☁ → 云同步地址 → 填接口地址。
- 所有设备一起切：把地址填进 `app.js` 的 `DEFAULT_DATA_URL` 并发布页面。
- 切换时本地没有未同步的改动 → 直接采用数据库的数据，不弹窗；有未同步改动 → 弹冲突窗让你选。

## 部署到阿里云函数计算 FC 3.0（自定义运行时）

1. 控制台 → 函数计算 3.0 → 创建函数 → **Web 函数** → 运行环境选 Node.js 20（自定义运行时）。
2. 代码：把本目录（含 `node_modules`，先 `npm install --omit=dev`）打成 zip 上传，或用控制台在线编辑后执行 `npm install`。
3. 启动命令 `node index.js`，监听端口填 9000（FC 会把它注入 `FC_SERVER_PORT`）。
4. 环境变量：`MONGODB_URI`、`EDIT_TOKEN`。
5. 触发器：HTTP 触发器，认证方式「无需认证」，方法 GET / PUT / OPTIONS。创建后得到 `https://xxx.fcapp.run` 这类地址。
6. 浏览器打开 `https://xxx.fcapp.run/`，看到 `"db":"ok"` 即成功。
7. 页面：☁ 云端 → 云同步地址 → 填这个地址 → 输入编辑口令。

默认域名返回 HTML 会被强制下载，返回 JSON 不受影响，本服务只返回 JSON。
免费额度与默认域名是否免备案以阿里云当前页面为准，部署前先用手机流量不开代理访问一次 `/`。

## 部署到任意一台能跑 Node 的机器

```bash
npm install --omit=dev
MONGODB_URI=... EDIT_TOKEN=... PORT=8787 node index.js    # 用 pm2 / systemd 守护
```
前面套 Nginx / Caddy 做 HTTPS（页面是 https 时浏览器不允许请求 http 接口）。

## 限制

- 统一按 15MB 拦截（MongoDB 单文档上限 16MB）；当前全量数据 1MB 量级。
- MySQL 只存一行 `id = 'state'`，乐观锁是 `UPDATE … WHERE version = ?`，首次写入是 `INSERT IGNORE`。
- 整份覆盖 + 版本号乐观锁，跟 Worker 版一样不做逐条合并。
