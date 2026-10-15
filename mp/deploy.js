/**
 * 小程序部署脚本（miniprogram-ci）
 *   node mp/deploy.js envs                 列出这个小程序的云开发环境
 *   node mp/deploy.js func [envId]         部署云函数 api（Node 16，数据库连接信息取 server/.env 里的 MYSQL_*，设成云函数环境变量）
 *   node mp/deploy.js preview              生成预览二维码 mp/preview.png（开发者扫码）
 *   node mp/deploy.js upload [版本] [说明]  上传为体验版，后台「版本管理」里可提交审核
 * 需要：小程序代码上传密钥（默认 ../../private.<appid>.key，可用 MP_KEY 指定），后台「开发设置 → 小程序代码上传」的 IP 白名单放行本机。
 * envId 不传时：只有一个环境就用它，有多个就报错让你指定（也可设 MP_ENV）。
 */
const path = require('path'), fs = require('fs');
const ci = require('miniprogram-ci');
const capi = require('miniprogram-ci/dist/ci/cloud/cloudapi');
const cloudAPI = require('miniprogram-ci/dist/common/cloud-api');

const APPID = 'wxebdbfa7bf41143c2';
const ROOT = __dirname;
const KEY = process.env.MP_KEY || path.join(ROOT, '..', '..', `private.${APPID}.key`);
const FN = 'api', RUNTIME = 'Nodejs16.13';
// 建空函数用的最小代码包（与 miniprogram-ci 内置的相同），真正的代码随后由 uploadFunction 覆盖
const HELLO_ZIP = (() => { const t = fs.readFileSync(require.resolve('miniprogram-ci/dist/ci/cloud/uploadFunction.js'), 'utf8'); return /HelloWordCode="([^"]+)"/.exec(t)[1]; })();

const project = new ci.Project({
  appid: APPID, type: 'miniProgram', projectPath: ROOT, privateKeyPath: KEY,
  ignores: ['node_modules/**/*', 'deploy.js', 'sync-core.js', 'package.json', 'package-lock.json', 'preview.png', 'README.md', 'cloudfunctions/**/*'],
});
const topts = () => ({ request: capi.boundTransactRequest(project), transactType: cloudAPI.TransactType.IDE });

function readEnvFile() {
  const f = path.join(ROOT, '..', 'server', '.env');
  if (!fs.existsSync(f)) throw new Error('缺少 server/.env（里面要有 MYSQL_HOST / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE）');
  return Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

async function envs() {
  capi.initCloudAPI(APPID);
  const { envList } = await cloudAPI.tcbGetEnvironments({}, topts());
  return envList;
}
async function pickEnv(want) {
  const list = await envs();
  if (!list.length) throw new Error('这个小程序还没有云开发环境：微信开发者工具 → 云开发 → 开通');
  if (want) { const e = list.find(x => x.envId === want); if (!e) throw new Error(`没有环境 ${want}，现有：${list.map(x => x.envId).join(', ')}`); return e; }
  if (list.length > 1) throw new Error(`有多个云开发环境，请指定：${list.map(x => x.envId).join(', ')}`);
  return list[0];
}

async function waitActive(env, region, codeSecret) {
  for (let i = 0; i < 60; i++) {
    const f = await cloudAPI.scfGetFunctionInfo({ namespace: env, region, functionName: FN, codeSecret }, topts());
    if (f.status === 'Active') return f;
    if (/Failed/.test(f.status)) throw new Error('云函数状态 ' + f.status + ' ' + JSON.stringify(f.statusReasons || f.statusDesc || ''));
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('等待云函数就绪超时');
}

async function func(envId) {
  const env = await pickEnv(envId || process.env.MP_ENV);
  const region = env.functions[0].region;
  const codeSecret = await capi.get3rdCloudCodeSecret(project);
  const vars = readEnvFile();
  const variables = ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'].filter(k => vars[k]).map(k => ({ key: k, value: vars[k] }));
  let exists = true;
  try { await cloudAPI.scfGetFunctionInfo({ namespace: env.envId, region, functionName: FN, codeSecret }, topts()); }
  catch (e) { if (e.code !== 'ResourceNotFound.Function' && !/ResourceNotFound/.test(String(e.message))) throw e; exists = false; }
  if (!exists) {
    // miniprogram-ci 自己创建会用 Nodejs8.9，跑不了现在的代码，所以先按 Node 16 建好空函数
    console.log(`创建云函数 ${FN}（${RUNTIME}）…`);
    await cloudAPI.scfCreateFunction({ functionName: FN, code: { zipFile: HELLO_ZIP }, handler: 'index.main', description: 'Dota 内战记录数据接口',
      memorySize: 256, timeout: 20, environment: { variables }, role: 'TCB_QcsRole', runtime: RUNTIME, namespace: env.envId, region,
      stamp: 'MINI_QCBASE', installDependency: true, codeSecret }, topts());
    await waitActive(env.envId, region, codeSecret);
  }
  console.log(`上传云函数代码到 ${env.envId}（云端安装依赖）…`);
  await ci.cloud.uploadFunction({ project, env: env.envId, name: FN, path: path.join(ROOT, 'cloudfunctions', FN), remoteNpmInstall: true });
  await waitActive(env.envId, region, codeSecret);
  await cloudAPI.scfUpdateFunctionInfo({ namespace: env.envId, region, functionName: FN, memorySize: 256, timeout: 40, environment: { variables } }, topts());
  await waitActive(env.envId, region, codeSecret);
  console.log('云函数已部署，环境变量：' + variables.map(v => v.key).join(', '));
  try {
    const r = await cloudAPI.scfInvokeFunction({ namespace: env.envId, region, functionName: FN, data: JSON.stringify({ action: 'meta' }), codeSecret }, topts());
    console.log('试调用 meta：', r.retMsg || JSON.stringify(r).slice(0, 300));
  } catch (e) { console.log('试调用失败（不影响部署）：', e.message); }
}

const setting = { es6: true, enhance: true, minify: true, minifyJS: true, minifyWXML: true, minifyWXSS: true, autoPrefixWXSS: true };

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd !== 'envs' && cmd !== 'func') require('./sync-core.js');
  if (cmd === 'envs') { const l = await envs(); console.log(l.length ? l.map(e => `${e.envId}  ${e.alias || ''}  ${e.status || ''}  ${e.functions?.[0]?.region || ''}`).join('\n') : '（没有云开发环境）'); }
  else if (cmd === 'func') await func(a1);
  else if (cmd === 'preview') {
    await ci.preview({ project, desc: '预览', setting, qrcodeFormat: 'image', qrcodeOutputDest: path.join(ROOT, 'preview.png'), onProgressUpdate: () => {} });
    console.log('预览二维码已保存到 mp/preview.png，用微信扫码（需要是这个小程序的开发者或体验成员）');
  } else if (cmd === 'upload') {
    const version = a1 || new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    await ci.upload({ project, version, desc: a2 || '自动上传', setting, onProgressUpdate: () => {} });
    console.log(`已上传体验版 ${version}。后台「版本管理」里设为体验版 / 提交审核`);
  } else { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(1); }
}
main().catch(e => { console.error('失败：' + (e.message || e)); process.exit(1); });
