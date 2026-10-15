/**
 * 存储层：MySQL / MongoDB 二选一（MYSQL_HOST 优先，其次 MONGODB_URI）。index.js 和 migrate.mjs 共用。
 *   readMeta() / read() / write(base, data) → 新 meta | null（版本冲突） / overwrite(version, updatedAt, data) 迁移专用，无条件覆盖
 */
const EMPTY_META = { version: 0, updatedAt: null };

// ---------- 存储层：readMeta() / read() / write(base, data) → 新 meta | null（版本冲突） ----------

// 懒连接 + 复用；连不上时清掉，下次请求再试
const lazy = open => { let p = null; return () => (p ??= open().catch(e => { p = null; throw e; })); };

function mysqlStore() {
  const get = lazy(async () => {
    const mysql = (await import('mysql2/promise')).default;
    const pool = mysql.createPool({
      host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
      connectionLimit: 3, connectTimeout: 15000, charset: 'utf8mb4',
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS dota_state (
      id VARCHAR(16) PRIMARY KEY,
      version INT NOT NULL,
      updated_at VARCHAR(32) NULL,
      data LONGTEXT NULL
    ) DEFAULT CHARSET = utf8mb4`);
    return pool;
  });
  return {
    name: 'mysql',
    async ping() { await (await get()).query('SELECT 1'); },
    async readMeta() {
      const [[r]] = await (await get()).query("SELECT version, updated_at FROM dota_state WHERE id = 'state'");
      return r ? { version: r.version, updatedAt: r.updated_at } : EMPTY_META;
    },
    async read() {
      const [[r]] = await (await get()).query("SELECT version, updated_at, data FROM dota_state WHERE id = 'state'");
      return r ? { meta: { version: r.version, updatedAt: r.updated_at }, data: r.data ? JSON.parse(r.data) : null } : { meta: EMPTY_META, data: null };
    },
    async write(base, data) {
      const pool = await get();
      const updatedAt = new Date().toISOString(), text = JSON.stringify(data);
      // base 0 = 首次写入：INSERT IGNORE，行已存在则 affectedRows = 0 → 冲突
      const [r] = base === 0
        ? await pool.query("INSERT IGNORE INTO dota_state (id, version, updated_at, data) VALUES ('state', 1, ?, ?)", [updatedAt, text])
        : await pool.query("UPDATE dota_state SET version = version + 1, updated_at = ?, data = ? WHERE id = 'state' AND version = ?", [updatedAt, text, base]);
      return r.affectedRows === 1 ? { version: base + 1, updatedAt } : null;
    },
    async overwrite(version, updatedAt, data) {
      await (await get()).query(
        "INSERT INTO dota_state (id, version, updated_at, data) VALUES ('state', ?, ?, ?) ON DUPLICATE KEY UPDATE version = VALUES(version), updated_at = VALUES(updated_at), data = VALUES(data)",
        [version, updatedAt, JSON.stringify(data)]);
    },
    async close() { try { await (await get()).end(); } catch { } },
  };
}

function mongoStore() {
  let client = null;
  const get = lazy(async () => {
    const { MongoClient } = await import('mongodb');
    const c = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, maxPoolSize: 5 });
    await c.connect(); client = c;
    return c.db(process.env.MONGODB_DB || 'dota').collection('state');
  });
  return {
    name: 'mongodb',
    async ping() { await (await get()).estimatedDocumentCount(); },
    async readMeta() {
      const m = await (await get()).findOne({ _id: 'state' }, { projection: { data: 0 } });
      return m && typeof m.version === 'number' ? { version: m.version, updatedAt: m.updatedAt || null } : EMPTY_META;
    },
    async read() {
      const d = await (await get()).findOne({ _id: 'state' });
      return d ? { meta: { version: d.version, updatedAt: d.updatedAt || null }, data: d.data || null } : { meta: EMPTY_META, data: null };
    },
    async write(base, data) {
      const updatedAt = new Date().toISOString();
      try {
        const r = await (await get()).findOneAndUpdate(
          { _id: 'state', version: base },
          { $set: { data, updatedAt }, $inc: { version: 1 } },
          { upsert: base === 0, returnDocument: 'after', projection: { data: 0 } },
        );
        return r ? { version: r.version, updatedAt: r.updatedAt } : null;
      } catch (e) { if (e.code === 11000) return null; throw e; }   // upsert 撞上已存在的文档 = 别人已经写过第一版
    },
    async overwrite(version, updatedAt, data) {
      await (await get()).replaceOne({ _id: 'state' }, { version, updatedAt, data }, { upsert: true });
    },
    async close() { await client?.close(); },
  };
}

export const createStore = () => (process.env.MYSQL_HOST ? mysqlStore() : process.env.MONGODB_URI ? mongoStore() : null);
