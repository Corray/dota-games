// 把仓库根目录的 core.js（网页与小程序共用的计算核心）复制进小程序目录。小程序不能 require 自己目录以外的文件。
// node mp/sync-core.js          复制
// node mp/sync-core.js --check  只检查是否一致（不一致退出码 1）
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', 'core.js');
const dst = path.join(__dirname, 'miniprogram', 'utils', 'core.js');
const banner = '// ⚠ 自动生成，请改仓库根目录的 core.js，再运行 node mp/sync-core.js\n';
const want = banner + fs.readFileSync(src, 'utf8');
const have = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
if (process.argv.includes('--check')) { if (have !== want) { console.error('mp/miniprogram/utils/core.js 与根目录 core.js 不一致，运行 node mp/sync-core.js'); process.exit(1); } console.log('core.js 一致'); }
else if (have !== want) { fs.writeFileSync(dst, want); console.log('已同步 core.js →', path.relative(process.cwd(), dst)); }
else console.log('core.js 已是最新');
