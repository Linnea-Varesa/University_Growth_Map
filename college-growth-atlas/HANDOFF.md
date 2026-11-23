# 交接说明 · 大学成长地图

面向在校大学生的大学四年记录与规划工作台。单页 HTML + 6 张数据表，数据在线存储、双向同步。

本文件写给**接手开发的人**。`README.md` 是产品说明，本文件讲工程怎么跑、怎么改、哪里有坑。

---

## 0. 先读这段：最大的坑

**`index.html` 已经完全不调用 `server.mjs` 的接口。**

上一版（`tools/legacy/index-server-mode.html`）通过 `/api/db/*` + SSE 和后端通信；
现版改为直接调用 WorkBuddy 资料库注入的 `window.__SMART_PAGE__.database`。

后果：

| 你以为 | 实际 |
|---|---|
| 跑 `start.cmd` → 改数据 → 看 `data/db.json` 变化 | 页面检测不到 SDK，**降级到浏览器 localStorage**；`db.json` 纹丝不动 |
| `server.mjs` 的 6 表 REST/SSE 是页面后端 | 它只是静态托管 + 一套**没有消费者**的 API |
| 本地改代码就能看到线上真实数据 | 本地只能看到 localStorage 里的数据（初始为空） |

所以接手后**第一件事是想清楚走哪条路**，别急着改代码。

---

## 1. 两条运行路径

### 路径 A：线上资料库模式（当前生产形态）

页面跑在 WorkBuddy 资料库宿主的 iframe 里，平台注入 SDK，数据存云端数据表。

- 需要：WorkBuddy 账号 + 自己的资料库空间
- 交付形态：一个 `workbuddy.link` 链接 + `workbuddy.cn/space/d/...` 编辑链接
- **限制**：`DB_IDS` 里 6 个 `databaseId` 属于原作者的空间。你必须在自己的空间重建 6 张表，
  拿到新 id 替换掉，否则页面读不到数据（建表步骤见 §4）
- 优点：多设备同步、改完即用、无需运维

### 路径 B：本地开发模式（改代码/调样式用）

- 直接双击 `index.html` → localStorage 模式，功能完整但数据在本地
- 或 `npm start`（= `node server.mjs`）→ 起本地服务 + 完整 REST/SSE 后端，
  但**当前 `index.html` 不会用这个后端**，只有 `tools/legacy/index-server-mode.html` 会用

> 想两边统一，看 §7 的第一条 TODO：写个 50 行的本地 SDK 桥接，本地开发就能完全复刻线上行为。

---

## 2. 包内结构

```
college-growth-atlas/
├── README.md                    产品说明（功能、视图、示例数据规则）
├── HANDOFF.md                   本文件
├── package.json                 零依赖，仅声明 node>=18 与 start 脚本
├── .gitignore                   忽略 db.json / node_modules / 备份
├── index.html                   生产版页面（资料库 SDK 模式，141 KB 单文件）
├── schema.json                  6 表结构 + 真实 databaseId + 资料库字段 id
├── server.mjs                   本地 REST + SSE 服务端（零依赖，Node 18+）
├── start.cmd                    Windows 双击启动本地服务
├── data/
│   └── seed.json               90 条示例数据（建表回填 + 本地初始化都用它）
├── assets/                     8 个手绘 SVG 源文件（已内联进 index.html，改插画时用）
└── tools/
    ├── table-schemas/          6 个纯净建表 payload，直接喂给 create_database
    │   ├── 01-profile.json     个人档案   8 字段
    │   ├── 02-experiences.json 大学经历   9 字段
    │   ├── 03-major.json       专业探索   7 字段
    │   ├── 04-opportunities.json 个人机会 12 字段
    │   ├── 05-directions.json  发展方向   7 字段
    │   └── 06-experiments.json 方向体验卡 7 字段
    └── legacy/
        └── index-server-mode.html   改造前版本（对接 server.mjs，仅作参考）
```

**未包含**（原工程里有但故意剔除）：

- `_recon/`（68 MB）：参考页逆向产物、61 MB 截图、旧调试脚本。含第三方页面源码，
  不应随工程流转；且结论已被现方案推翻，留着会误导。
- `data/db.json`：本地服务运行时自动生成，属产物不入库。
- 原 `index.html.bak-server`：已重命名为 `tools/legacy/index-server-mode.html`，
  避免根目录出现两个 index 造成误覆盖。

---

## 3. 数据契约（改代码必看）

### 3.1 表 → 页面（读）

`db.query` 返回 `{ results, nextCursor, hasMore }`，每条记录是扁平对象。与页面内部结构的差异：

| 项 | 数据表返回 | 页面内部 | 处理点 |
|---|---|---|---|
| 主键 | `record_id` | `_id` | `decodeRow()` L994 |
| 日期 | `"2025-05-10T00:00:00Z"` | `"2025-05-10"` | `decodeRow()` 截断前 10 位 |
| url | `[{link, text}]` **数组** | `{link, text}` 对象 | `decodeRow()` 压平 + `linkOf()` 兜底 |
| multi_select | `["研究分析","写作表达"]` | 同左（文本数组） | 直接用 |
| 空值 | `null` | 字段缺省 | `decodeRow()` 跳过 |
| select | 选项**文本** | 同左 | 直接用 |

`url` 返回数组这点最容易翻车 —— 直接 `v.link` 会拿到 `undefined`。

### 3.2 页面 → 表（写）

统一走 `encodeProps()` / `encodeValue()`（L961 / L984），按 `getSchema` 拿到的字段类型编码：

| 字段类型 | 写入格式 |
|---|---|
| text | `{text: "..."}` |
| select | `{select: "<optionId>"}` ← 用建表返回的 option id，不用文本 |
| multi_select | `{multi_select: ["<id1>", "<id2>"]}` |
| date | `{date: "YYYY-MM-DD"}` |
| url | `{url: {text: "...", link: "https://..."}}` |

空值在 `encodeProps` 里被剔除 —— 避免 `updateRecord` 时把字段误清空。

### 3.3 分页

`db.query` **单次只返回一页**（`pageSize` 默认 50，上限 200）。`loadAll()`（L1033）做串行翻页，
带三重熔断：最多 100 页 / 游标必须推进 / 本页非空才继续。

任何人接手后加"全量统计"功能时，别直接 `query` 一把梭，会静默丢数据。

### 3.4 并发限制

- 页面层 20 QPS，单表 30 QPS
- 所以批量操作（批量删、批量改状态）在代码里都是**串行**的：
  `dbBulkDelete()` L1177、`bulkPatch()`（`bind()` 内）
- 别改成 `Promise.all`，会撞 50001

---

## 4. 重建资料库 6 张表（路径 A 必需）

假设 `<LIB>` 是 WorkBuddy 资料库 skill 所在目录（形如
`<WorkBuddy>/resources/.../skills/library`）。

### 步骤 1：建表

```bash
for f in tools/table-schemas/*.json; do
  python3 "$LIB/database/create_database.py" --schema "$(cat "$f")"
done
```

每条命令输出 `{"database_id": "...", ...}`，记下 6 个 id。
同时输出里带 `url` 与完整 `properties`（含服务端生成的字段 id 与 option id）。

### 步骤 2：回填 90 条示例数据

`data/seed.json` 是**页面内部格式**，写入前必须转成 PropertyValue（规则见 §3.2）。
关键转换：`select` 需把文本映射到新表的 option id、`url` 需包成 `{text,link}`、
日期截断到 10 位、`_id` / `_official` 这类下划线字段要丢掉（表里没有）。

用 `batch_add_database_records.py`，每批 ≤100 条（seed 共 90 条，一次可完）。

> `个人机会.类型` 曾有一个选项缺失：`seed.json` 有「社会实践」，但原工程 schema 没有，
> 导致该条记录的类型写不进去（静默跳过，不报错）。**本包已在 `04-opportunities.json` 与
> `schema.json` 两处补齐，无需处理。** 若你后续改字段，注意保持这两处一致。

### 步骤 3：替换页面里的 databaseId

`index.html` L820 `DB_IDS`，6 个值全部换成新 id。**这一处改完才算绑定成功。**

### 步骤 4：上传并绑定

```bash
python3 "$LIB/page/import_html.py" index.html \
  --file-name "大学成长地图 · 在线工作台.html" \
  --databases '[{"id":"<新id1>"},...,{"id":"<新id6>"}]'
```

`--databases` 会建立页面↔表的关系（六条 relation）。

### 步骤 5：发布

```bash
python3 "$LIB/page/publish_page.py" --node-id "<nodeId>"
```

---

## 5. 已知坑（都踩过）

### 5.1 `import_html.py` 会静默失败

现象：`{"error": "文件上传到 COS 失败"}`，但用同样 URL 裸 `urllib` PUT 返回 200。

原因：脚本 `_put_to_cos()` 里 `except Exception: return False` 吞掉了真实异常。
本机实测把异常打出来后是 `ConnectionResetError [WinError 10054]`。

两个附带事实：

- 预签名 URL **一次性**。对同一 URL 重复 PUT 必然连接重置 —— 排查时别误判成网络问题。
- 绕过方式：`import` 该模块，用带 trace 的版本替换 `_put_to_cos` 再调 `main()`；
  或自己 `urllib.request` PUT 成功（2xx）后继续走后续接口。

### 5.2 `lint_database_sdk_usage.py` 本机跑不完

3 分钟以上无输出，`exit=124`。脚本是纯本地的（无网络），但在这台机器上就是卡住。
不要把它当交付门禁，改用 §6 的自建 harness 验证。

### 5.3 `space_api.py` 没有删除节点接口

只有 `create-space / list-* / move-node / node-info / rename-node`。
传错测试页只能 `unlink` 解绑 + `rename-node` 标记废弃，删不掉。

### 5.4 中文文件名进 zip

Windows 下 `Compress-Archive` 打中文名，接收方解压可能乱码。
本包刻意全用 ASCII 文件名与目录名，保持这个约定。

### 5.5 改插画要改两处

`assets/*.svg` 是源文件，但 `index.html` 里已经**内联成 base64 data URI**（3 处：
`pattern-campus` / `illus-campus` / `illus-mountain`）。改了 SVG 必须重新内联，
否则页面不变。其余 5 个 SVG 当前未被引用。

---

## 6. 怎么验证没改坏

生产版依赖宿主注入的 SDK，本地无法直接跑。做法是**用 mock SDK 在 Node 里跑页面脚本**：

1. 从 `index.html` 抽出 `<script>` 内容
2. 造一个假的 `window.__SMART_PAGE__.database`（实现 getSchema / query / addRecord /
   updateRecord / deleteRecord / onUpdated，数据来自 `data/seed.json`）
3. 桩掉 DOM（`document.querySelector` 返回空元素即可）
4. 执行后用 `window.__APP_STATE__()` 检查：应返回
   `{online:true, backend:'library', schema:true, counts:{...6 表 90 条}}`
5. 检查 `console.error` 无输出、`window.__APP_ERROR__` 为空

`window.__APP_STATE__` / `window.__APP_READY__` 是页面内置的自检钩子（启动段末尾），
也可以直接在浏览器控制台调。

冒烟清单（沿用专家规范铁律 10）：

- [ ] 函数调用链无环（渲染函数之间不互调，统一走 `renderAll()` L2430）
- [ ] 初始化链路：`loadInitial()` → `bind()` → `renderAll()` → `subscribe()` 顺序正确
- [ ] DOM 元素齐全（`bind()` 里所有 `$('#...')` 都能命中）
- [ ] 空数据不崩（6 表全空时各视图有空态）
- [ ] 跨月/跨年日期正确（`CAL` 的月切换、`daysUntil`）
- [ ] 事件绑定在渲染后（`bind()` 在首个 `renderAll()` 之前调用，靠事件委托兜住重绘）
- [ ] 无全局命名冲突（整体在 IIFE 内）

---

## 7. 待办 / 建议改动

按价值排序：

1. **本地 SDK 桥接（建议优先做）**
   `server.mjs` 的 REST 契约与 `__SMART_PAGE__.database` 本来就是同形的
   （这正是当初的设计意图）。写个 50 行 adapter：本地启动时把
   `window.__SMART_PAGE__ = {database: fetch 版实现}` 注入页面，
   本地开发就能完全复刻线上行为，`db.json` 也重新变成真实数据源。
   这是当前"本地改了看不到线上效果"的唯一解法。

2. **示例数据一键清理**
   README 提到示例记录带「示例（请替换）」标记且统计自动剔除，但页面里没有"清空所有示例"
   的入口，只能去数据表里手动删。加个批量删除按钮（记得串行）。

3. **移动端表格**
   机会库 12 列在窄屏是横向滚动。若要更好的手感，改成卡片列表。

4. **无账号体系**
   多人协作靠资料库空间的权限继承。若要做"一人一份数据"，需要引入 `db.getUserInfo()`
   并给记录加 owner 字段 —— 但那会触发登录跳转，谨慎。

5. **发布链接的隐私边界**
   发布态 `workbuddy.link` 是公开可访问的（任何拿到链接的人都能打开）。
   页面里是示例数据没问题，但**别把真实隐私数据预填进去**。

---

## 8. 版本与回退

| 版本 | 文件 | 数据后端 |
|---|---|---|
| 现版 | `index.html` | 资料库 SDK（`__SMART_PAGE__.database`） |
| 旧版 | `tools/legacy/index-server-mode.html` | 本地 `server.mjs`（`/api/db/*` + SSE） |

回退方式：把 legacy 版覆盖成 `index.html` 即可，但要同步放弃资料库绑定关系
（页面里没有 SDK 调用时，绑定的 6 张表就成了孤儿）。

两版的 CSS/DOM 结构一致，差异集中在数据层：
`SDK` 判定、`encodeValue/encodeProps`、`decodeRow`、`loadSchema`、`loadAll`、
`subscribe`、`db*` 六个写函数、`reload`、以及 ICS 导出（旧版走服务端 `/api/calendar.ics`，
新版纯前端 `buildCalendarICS`）。

---

## 9. 环境

- Node.js ≥ 18（`server.mjs` 用了 `node:` 前缀 ESM，零第三方依赖）
- Python 3（仅重建数据表 / 上传页面时需要，页面本身不依赖）
- 浏览器：Chrome / Edge / Safari 现代版本（用了 `TextEncoder`、`Intl` 无）；
  注意 `TextEncoder` 在 IE 不存在，ICS 折行会失效 —— 目标环境是现代浏览器，可接受

编码统一 UTF-8。Windows 下用 `start.cmd` 启动，别用 GBK 终端直接跑。
