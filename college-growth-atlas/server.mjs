/**
 * 大学成长地图 · 在线工作台服务端
 *
 * 职责：
 *   1. 6 张数据表落地到磁盘（data/db.json），原子写 + 写队列串行化；
 *   2. 对外暴露与 WorkBuddy 资料库 `__SMART_PAGE__.database` 同形的读写契约
 *      （getSchema / query / addRecord / updateRecord / deleteRecord）；
 *   3. 通过 SSE（/api/events）把任意一端的写入广播给所有其它端，
 *      实现「数据在线存储 + 双向同步」。
 *
 * 零依赖，仅使用 Node 内置模块。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const SCHEMA_FILE = path.join(ROOT, 'schema.json');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const SAMPLE_MARKER = '示例（请替换）';

/* ============================ 状态 ============================ */

const schemaDoc = JSON.parse(await fsp.readFile(SCHEMA_FILE, 'utf8'));
const TABLES = schemaDoc.tables;
const TABLE_KEYS = TABLES.map((t) => t.key);
const KEY2TABLE = new Map(TABLES.map((t) => [t.key, t]));
const DBID2KEY = new Map(TABLES.map((t) => [t.databaseId, t.key]));

/** 内存中的权威数据：{ rev, tables: { key: [record, ...] } } */
let state = null;
let writeChain = Promise.resolve();

/** SSE 订阅者 */
const subscribers = new Set();

/* ============================ 工具 ============================ */

const nowISO = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { code: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** 与资料库 adapter 同形的取值解码：把 {text|select|multi_select|date|url} 拉平成标量 */
function optionsOf(tableKey, fieldName) {
  const table = KEY2TABLE.get(tableKey);
  const prop = table?.properties.find((p) => p.name === fieldName);
  return prop?.config?.options || null;
}

function decodeValue(tableKey, fieldName, pv) {
  if (pv === null || pv === undefined) return '';
  if (typeof pv !== 'object') return pv;
  if (Array.isArray(pv)) return pv;

  if (Object.prototype.hasOwnProperty.call(pv, 'text')) {
    return pv.text === null || pv.text === undefined ? '' : String(pv.text);
  }
  if (Object.prototype.hasOwnProperty.call(pv, 'select')) {
    if (!pv.select) return '';
    const opts = optionsOf(tableKey, fieldName) || [];
    const hit = opts.find((o) => o === pv.select || o?.id === pv.select || o?.text === pv.select);
    return typeof hit === 'string' ? hit : hit?.text ?? pv.select;
  }
  if (Object.prototype.hasOwnProperty.call(pv, 'multi_select')) {
    const opts = optionsOf(tableKey, fieldName) || [];
    return (pv.multi_select || []).map((v) => {
      const hit = opts.find((o) => o === v || o?.id === v || o?.text === v);
      return typeof hit === 'string' ? hit : hit?.text ?? v;
    });
  }
  if (Object.prototype.hasOwnProperty.call(pv, 'date')) return pv.date || '';
  if (Object.prototype.hasOwnProperty.call(pv, 'url')) {
    if (!pv.url) return null;
    return { link: pv.url.link, text: pv.url.text || pv.url.link };
  }
  return pv;
}

function decodeProperties(tableKey, properties) {
  const out = {};
  for (const [field, value] of Object.entries(properties || {})) {
    out[field] = decodeValue(tableKey, field, value);
  }
  return out;
}

/** 是否被标记为示例记录（统计中需要剔除） */
function isSampleRecord(rec) {
  return JSON.stringify(rec).includes(SAMPLE_MARKER);
}

/** 是否为内置公开日程 */
function isOfficialRecord(rec) {
  return String(rec?.来源标识 || '').startsWith('official:');
}

/* ============================ 持久化 ============================ */

async function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

function normalizeState(raw) {
  const tables = {};
  for (const key of TABLE_KEYS) {
    const rows = Array.isArray(raw?.tables?.[key]) ? raw.tables[key] : [];
    tables[key] = rows.map((r) => ({
      ...r,
      _id: r._id || newId('rec'),
      _rev: Number.isInteger(r._rev) ? r._rev : 1,
      _createdAt: r._createdAt || nowISO(),
      _updatedAt: r._updatedAt || nowISO(),
    }));
  }
  return { rev: Number.isInteger(raw?.rev) ? raw.rev : 0, savedAt: raw?.savedAt || nowISO(), tables };
}

async function loadState() {
  try {
    const raw = JSON.parse(await fsp.readFile(DB_FILE, 'utf8'));
    state = normalizeState(raw);
    const total = TABLE_KEYS.reduce((n, k) => n + state.tables[k].length, 0);
    log(`已加载已有数据：${total} 条，rev=${state.rev}`);
  } catch {
    const seed = JSON.parse(await fsp.readFile(SEED_FILE, 'utf8'));
    state = normalizeState({ rev: 0, tables: seed });
    const total = TABLE_KEYS.reduce((n, k) => n + state.tables[k].length, 0);
    log(`首次启动：已从 seed 初始化 ${total} 条示例数据`);
    await persist({ tables: TABLE_KEYS, origin: 'seed' }, { broadcast: false });
  }
}

/** 串行化落盘 + 广播 */
function persist(change, { broadcast = true } = {}) {
  const run = writeChain.then(async () => {
    state.rev += 1;
    state.savedAt = nowISO();
    await atomicWrite(DB_FILE, JSON.stringify(state, null, 1));
    if (broadcast) broadcastChange(change);
    return state.rev;
  });
  writeChain = run.catch(() => {});
  return run;
}

function broadcastChange(change) {
  const payload = JSON.stringify({
    rev: state.rev,
    tables: change.tables || [],
    origin: change.origin || 'server',
    at: nowISO(),
  });
  for (const res of subscribers) {
    try {
      res.write(`event: change\ndata: ${payload}\n\n`);
    } catch {
      subscribers.delete(res);
    }
  }
}

/* ============================ 表操作 ============================ */

function tableOf(key) {
  const table = KEY2TABLE.get(key);
  if (!table) throw Object.assign(new Error(`unknown table: ${key}`), { code: 404 });
  return table;
}

function queryTable(key) {
  tableOf(key);
  return state.tables[key];
}

function addRecord(key, properties) {
  tableOf(key);
  const flat = decodeProperties(key, properties);
  const rec = {
    ...flat,
    _id: newId(key.slice(0, 2)),
    _rev: 1,
    _createdAt: nowISO(),
    _updatedAt: nowISO(),
  };
  state.tables[key].push(rec);
  return rec;
}

function updateRecord(key, id, properties, ifRev) {
  tableOf(key);
  const rec = state.tables[key].find((r) => r._id === id);
  if (!rec) throw Object.assign(new Error(`record not found: ${id}`), { code: 404 });
  if (Number.isInteger(ifRev) && ifRev !== rec._rev) {
    throw Object.assign(new Error('版本冲突：记录已被其它端修改'), { code: 409, server: rec });
  }
  Object.assign(rec, decodeProperties(key, properties));
  rec._rev += 1;
  rec._updatedAt = nowISO();
  return rec;
}

function deleteRecord(key, id) {
  tableOf(key);
  const list = state.tables[key];
  const idx = list.findIndex((r) => r._id === id);
  if (idx === -1) throw Object.assign(new Error(`record not found: ${id}`), { code: 404 });
  const [rec] = list.splice(idx, 1);
  return rec;
}

/* ============================ ICS ============================ */

function icsEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545：按 UTF-8 字节 75 折行 */
function foldCalendarLine(line) {
  const encoder = new TextEncoder();
  const lines = [];
  let part = '';
  let length = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (length + size > 75) {
      lines.push(part);
      part = ' ';
      length = 1;
    }
    part += ch;
    length += size;
  }
  lines.push(part);
  return lines.join('\r\n');
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function plusOneDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function stableUid(input) {
  return createHash('sha1').update(String(input)).digest('hex').slice(0, 24);
}

/**
 * 生成 ICS。
 * 同一条机会若既有「截止时间」又有「活动日期」，会展开成两个 VEVENT：
 *   - 截止节点：单日活动，落在截止当天；
 *   - 活动日程：活动日期 → 活动结束日期。
 * 这样手机日历里不会出现横跨数月的长条。
 * reminder: 'both' | 'week' | 'day' | 'none'
 */
function buildCalendarICS(rows, reminder = 'both') {
  const stamp = nowISO().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//College Growth Atlas//Calendar//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:大学成长地图',
    'X-WR-TIMEZONE:Asia/Shanghai',
  ];

  const alarms = reminder === 'both' ? [7, 1] : reminder === 'week' ? [7] : reminder === 'day' ? [1] : [];
  const linkOf = (r) => (r['链接'] && typeof r['链接'] === 'object' ? r['链接'].link : r['链接']);
  // 赛期过长的活动（如校级→省级→国家级三级赛程）在手机日历里会变成横跨数月的长条，
  // 因此只落一个「开始」全天事件，结束日期写进描述。
  const MAX_SPAN_DAYS = 21;
  const spanDays = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

  const pushEvent = (r, { kind, start, end, uidSeed, note }) => {
    const link = linkOf(r);
    const descParts = [kind, note, r['类型'], r['来源'], r['活动信息'], r['说明'], link].filter(Boolean);
    out.push(
      'BEGIN:VEVENT',
      `UID:${stableUid(uidSeed)}@college-growth-atlas`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${plusOneDay(end).replace(/-/g, '')}`,
      'TRANSP:TRANSPARENT',
      `SUMMARY:${icsEscape(r['名称'] || '未命名机会')}${kind === '报名截止' ? '（报名截止）' : ''}`,
      `DESCRIPTION:${icsEscape(descParts.join(' · ').replace(/\r/g, ''))}`,
      ...(link ? [`URL:${link}`] : []),
    );
    for (const days of alarms) {
      out.push(
        'BEGIN:VALARM',
        `TRIGGER:-P${days}D`,
        'ACTION:DISPLAY',
        `DESCRIPTION:距离${kind}还有 ${days} 天`,
        'END:VALARM',
      );
    }
    out.push('END:VEVENT');
  };

  for (const r of rows) {
    const due = String(r['截止时间'] || '').slice(0, 10);
    const actStart = String(r['活动日期'] || '').slice(0, 10);
    const actEnd = String(r['活动结束日期'] || '').slice(0, 10);
    const baseUid = r['来源标识'] || r._id || [r['名称'], r['来源']].join('|');

    if (isDate(due)) {
      // 截止节点：单日
      pushEvent(r, { kind: '报名截止', start: due, end: due, uidSeed: `${baseUid}-due` });
    }
    if (isDate(r._endDate) || isDate(actStart)) {
      const s = isDate(actStart) ? actStart : due;
      let e = isDate(r._endDate) ? r._endDate : isDate(actEnd) ? actEnd : s;
      // 活动日期缺失时，其信息已由截止节点承载
      if (isDate(s) && s !== due) {
        let note = '';
        if (e !== s && spanDays(s, e) > MAX_SPAN_DAYS) {
          note = `赛期 ${s} 至 ${e}`;
          e = s;
        } else if (e !== s) {
          note = `赛期 ${s} 至 ${e}`;
        }
        pushEvent(r, { kind: '活动日程', start: s, end: e, uidSeed: `${baseUid}-event`, note });
      }
    } else if (!isDate(due)) {
      const s = String(r._endDate || '').slice(0, 10);
      if (isDate(s)) pushEvent(r, { kind: '活动日程', start: s, end: s, uidSeed: `${baseUid}-event` });
    }
  }

  out.push('END:VCALENDAR');
  return out.map(foldCalendarLine).join('\r\n') + '\r\n';
}

/** 导出候选：未过期、且未标记「已参加 / 已放弃」的机会 */
function calendarExportRows({ includePast = false, officialOnly = false, mineOnly = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return state.tables.opportunities.filter((r) => {
    if (officialOnly && !isOfficialRecord(r)) return false;
    if (mineOnly && isOfficialRecord(r)) return false;
    if (r['状态'] === '已参加' || r['状态'] === '已放弃') return false;
    const date = String(r['截止时间'] || r['活动日期'] || '').slice(0, 10);
    const end = String(r['活动结束日期'] || date).slice(0, 10);
    if (!includePast && end && end < today) return false;
    return true;
  });
}

/* ============================ 静态资源 ============================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(ROOT, '.' + rel);
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
    return json(res, 403, { error: 'forbidden' });
  }
  // 数据文件与内部脚本不对外暴露
  const blocked = [DB_FILE, SEED_FILE, path.join(ROOT, 'server.mjs'), path.join(ROOT, 'schema.json')];
  if (blocked.includes(target) || target.startsWith(DATA_DIR + path.sep) || target.startsWith(path.join(ROOT, '_recon') + path.sep)) {
    return json(res, 403, { error: 'forbidden' });
  }
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) return json(res, 404, { error: 'not found' });
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    const body = await fsp.readFile(target);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

/* ============================ 路由 ============================ */

const server = http.createServer(async (req, res) => {
  const urlPath = req.url || '/';
  const pathname = urlPath.split('?')[0];
  const query = new URL(urlPath, `http://${req.headers.host || HOST}`).searchParams;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    /* ---- 健康检查 ---- */
    if (pathname === '/api/health') {
      const counts = Object.fromEntries(TABLE_KEYS.map((k) => [k, state.tables[k].length]));
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return json(res, 200, {
        ok: true,
        rev: state.rev,
        savedAt: state.savedAt,
        total,
        counts,
        subscribers: subscribers.size,
        storage: path.relative(ROOT, DB_FILE),
      });
    }

    /* ---- schema ---- */
    if (pathname === '/api/schema') {
      return json(res, 200, { tables: TABLES, sampleMarker: SAMPLE_MARKER, degreeStages: schemaDoc.degreeStages });
    }

    /* ---- 全量快照（含 rev，供客户端初次同步） ---- */
    if (pathname === '/api/snapshot') {
      return json(res, 200, {
        rev: state.rev,
        savedAt: state.savedAt,
        tables: state.tables,
        counts: Object.fromEntries(TABLE_KEYS.map((k) => [k, state.tables[k].length])),
      });
    }

    /* ---- SSE：双向同步推送 ---- */
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`retry: 3000\n\n`);
      res.write(`event: hello\ndata: ${JSON.stringify({ rev: state.rev, at: nowISO() })}\n\n`);
      subscribers.add(res);
      // 心跳，防止中间层掐断
      const beat = setInterval(() => {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch {
          clearInterval(beat);
        }
      }, 20000);
      req.on('close', () => {
        clearInterval(beat);
        subscribers.delete(res);
      });
      return;
    }

    /* ---- 轮询兜底：/api/changes?since=rev ---- */
    if (pathname === '/api/changes') {
      const since = Number(query.get('since') || 0);
      return json(res, 200, { rev: state.rev, changed: state.rev !== since, savedAt: state.savedAt });
    }

    /* ---- ICS 导出 ---- */
    if (pathname === '/api/calendar.ics') {
      const reminder = query.get('reminder') || 'both';
      const rows = calendarExportRows({
        officialOnly: query.get('officialOnly') === '1',
        mineOnly: query.get('mineOnly') === '1',
      });
      const ics = buildCalendarICS(rows, reminder);
      const name = encodeURIComponent('大学成长地图-考试竞赛日历.ics');
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="growth-atlas.ics"; filename*=UTF-8''${name}`,
        'Content-Length': Buffer.byteLength(ics),
        'Cache-Control': 'no-store',
      });
      return res.end(ics);
    }

    /* ---- 公开日程清单 ---- */
    if (pathname === '/api/official-calendar') {
      return json(res, 200, {
        count: state.tables.opportunities.filter(isOfficialRecord).length,
        rows: state.tables.opportunities.filter(isOfficialRecord),
      });
    }

    /* ---- 全量重置为示例数据 ---- */
    if (pathname === '/api/reset' && req.method === 'POST') {
      const seed = JSON.parse(await fsp.readFile(SEED_FILE, 'utf8'));
      state = normalizeState({ rev: state.rev, tables: seed });
      const rev = await persist({ tables: TABLE_KEYS, origin: 'reset' });
      return json(res, 200, { ok: true, rev });
    }

    /* ---- 数据表 REST ---- */
    const m = pathname.match(/^\/api\/db\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (m) {
      const rawKey = decodeURIComponent(m[1]);
      const key = DBID2KEY.get(rawKey) || rawKey;
      const seg1 = m[2];
      const seg2 = m[3];

      // getSchema
      if (seg1 === 'schema' && req.method === 'GET') {
        const table = tableOf(key);
        return json(res, 200, { databaseId: table.databaseId, properties: table.properties });
      }

      // query
      if (seg1 === 'query' && req.method === 'GET') {
        const rows = queryTable(key);
        return json(res, 200, { results: rows, nextCursor: null, hasMore: false, rev: state.rev });
      }

      // addRecord  POST /api/db/:key/records
      if (seg1 === 'records' && !seg2 && req.method === 'POST') {
        const body = await readBody(req);
        const rec = addRecord(key, body.properties || body);
        const rev = await persist({ tables: [key], origin: body.origin });
        return json(res, 200, { id: rec._id, record: rec, rev });
      }

      // updateRecord  PATCH /api/db/:key/records/:id
      if (seg1 === 'records' && seg2 && (req.method === 'PATCH' || req.method === 'PUT')) {
        const body = await readBody(req);
        const rec = updateRecord(key, decodeURIComponent(seg2), body.properties || body, body.ifRev);
        const rev = await persist({ tables: [key], origin: body.origin });
        return json(res, 200, { record: rec, rev });
      }

      // deleteRecord  DELETE /api/db/:key/records/:id
      if (seg1 === 'records' && seg2 && req.method === 'DELETE') {
        const rec = deleteRecord(key, decodeURIComponent(seg2));
        const rev = await persist({ tables: [key], origin: 'delete' });
        return json(res, 200, { record: rec, rev });
      }

      // 批量删除（供「批量删除 + 撤销恢复」）
      if (seg1 === 'bulk-delete' && req.method === 'POST') {
        const body = await readBody(req);
        const ids = new Set((body.ids || []).map(String));
        const list = state.tables[key];
        const removed = [];
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (ids.has(String(list[i]._id))) removed.unshift(list.splice(i, 1)[0]);
        }
        const rev = await persist({ tables: [key], origin: body.origin });
        return json(res, 200, { removed, deleted: removed.length, rev });
      }

      // 撤销恢复：把已删除记录写回
      if (seg1 === 'restore' && req.method === 'POST') {
        const body = await readBody(req);
        const list = state.tables[key];
        const existing = new Set(list.map((r) => String(r._id)));
        let restored = 0;
        for (const rec of body.records || []) {
          if (!rec || existing.has(String(rec._id))) continue;
          list.push({ ...rec, _rev: (rec._rev || 1) + 1, _updatedAt: nowISO() });
          restored += 1;
        }
        const rev = await persist({ tables: [key], origin: body.origin });
        return json(res, 200, { restored, rev });
      }

      // 批量新增
      if (seg1 === 'batch' && req.method === 'POST') {
        const body = await readBody(req);
        const added = (body.add || []).map((p) => addRecord(key, p));
        const updated = [];
        for (const item of body.update || []) {
          try {
            updated.push(updateRecord(key, item.id, item.properties || {}));
          } catch {
            /* 忽略单条失败，保持批量语义 */
          }
        }
        let deleted = 0;
        for (const id of body.delete || []) {
          try {
            deleteRecord(key, id);
            deleted += 1;
          } catch {
            /* ignore */
          }
        }
        const rev = await persist({ tables: [key], origin: body.origin });
        return json(res, 200, { added, updated, deleted, rev });
      }

      return json(res, 404, { error: 'unknown endpoint' });
    }

    /* ---- 静态资源 ---- */
    if (req.method === 'GET' || req.method === 'HEAD') {
      return await serveStatic(req, res, pathname);
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    const code = err?.code && Number.isInteger(err.code) ? err.code : 500;
    log('请求失败', req.method, pathname, err?.message);
    json(res, code, { error: err?.message || 'internal error', server: err?.server });
  }
});

/* ============================ 启动 ============================ */

await fsp.mkdir(DATA_DIR, { recursive: true });
await loadState();

server.listen(PORT, HOST, () => {
  const counts = Object.fromEntries(TABLE_KEYS.map((k) => [k, state.tables[k].length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  log(`大学成长地图工作台已启动 → http://${HOST}:${PORT}/`);
  log(`6 张数据表：${TABLE_KEYS.join(', ')}`);
  log(`当前数据：${total} 条 ${JSON.stringify(counts)}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('正在关闭…');
    for (const res of subscribers) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
