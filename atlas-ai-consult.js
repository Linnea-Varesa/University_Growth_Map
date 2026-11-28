/* ══════════════════════════════════════════════════════════════════════════
 * 大学成长地图 · AI 咨询模块（atlas-ai-consult.js）v1.1.5
 * v1.1.5：去掉底栏「看清楚要发什么」按钮（对使用者没用），相关样式与预览渲染一并移除。
 * v1.1.4：输入框移出滚动区、固定在面板底部（不再被长回答顶走）；
 *         对话记录关闭面板/刷新页面后保留（只存本机 localStorage），并加了「清空对话」。
 * v1.1.3：输入框随内容自动长高（上限 240px 或面板高度 32%），并加了滚动条；
 *         发送后自动清空输入框，不用手动删上一条问题。
 * v1.1.2：Qoder Sites 部署会注入右下角徽标，检测到就把悬浮按钮与面板抬高让位。
 * v1.1.1：首次未配 Key 时点「问AI」，预填问题不再丢失（等输入框出现后补填）。
 * 基于队友交付的 v1.0.0 适配：校园绿 × 液态玻璃外观（消费主站设计变量，
 * 自动跟随昼夜主题），并加入 Qoder 账号登录状态行。
 *
 * 设计原则
 *   1. 不碰主站代码：单文件 IIFE，注入自己的 DOM 与样式，前缀全部 atlas-ai-
 *   2. 不用后端：Key 存本地，浏览器直连阿里云（百炼已允许跨域）
 *   3. 读你的数据：把「本地工作台」压成一份摘要给模型，让建议有据可依
 *   4. 只发摘要：数据先压成摘要再发，原始备份、作品链接不会整包上传
 *
 * 用法
 *   1) 单独引入：本文件作为外链脚本加载后调 AtlasAI.mount()
 *   2) 本项目实际用法：由 tools/inline-ai.py 内联进两份单文件页面，
 *      页面的 bindAI() 负责设置 window.AtlasAIProvider 并 mount
 *      （单文件发布不会带上同目录的 JS，所以必须内联，见 HANDOFF §10）
 *
 *   想让它精确读到主站数据，二选一：
 *   a) 主站暴露一个函数：
 *        window.AtlasAIProvider = () => ({ experiences:[...], directions:[...], ... })
 *   b) 什么都不做：模块会自动扫描 localStorage，按结构猜出主要数据集
 * ══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';
  if (window.AtlasAI) return;

  // ── 常量 ────────────────────────────────────────────────────────────────
  const STORE = 'atlas.ai.v1';
  const REGIONS = [
    { id: 'cn-beijing', label: '华北2（北京）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { id: 'ap-southeast-1', label: '新加坡', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    { id: 'us-east-1', label: '美国（弗吉尼亚）', base: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1' },
    { id: 'cn-hongkong', label: '中国（港澳）', base: 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1' },
  ];
  const PLANS = [
    { id: 'tokenPlan', label: 'Token Plan（新加坡）', base: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' },
    { id: 'codingPlan', label: 'Coding Plan（新加坡）', base: 'https://coding-intl.dashscope.aliyuncs.com/v1' },
  ];
  const PROBE_MODELS = ['qwen-turbo', 'qwen-plus', 'qwen-max'];
  const DIGEST_BUDGET = 6000;   // 摘要最多多少字符
  const MAX_HISTORY = 8;        // 带多少轮历史

  const SYSTEM_PROMPT = [
    '你是「大学成长地图」里的成长顾问，服务对象是中国的大学生。',
    '你会收到一份 JSON 摘要，来自这个学生自己填在本地工作台里的数据：经历、能力标签、方向意向、体验卡进度、机会与报名截止、专业探索。',
    '',
    '工作原则：',
    '1. 只依据给定数据说话。数据里没有的，明确说「你还没记录」，不要编造经历的细节。',
    '2. 具体到可执行：给出「接下来 1～2 周做什么」，不要停留在「多尝试、多积累」这类空话。',
    '3. 有数据就引用数据：指出是哪个方向、哪段经历、哪条截止日期支撑了你的判断。',
    '4. 学生常犯的错是「方向太多、动作太少」。如果数据显示方向多但体验卡没推进，直接点出来。',
    '5. 用中文，简洁，可以用短列表。不要客套开场白。',
    '6. 涉及报名截止时，把「还剩几天」算清楚，紧急的放最前面。',
  ].join('\n');

  // ── 咨询卡：这是本模块的核心，不是聊天框 ──────────────────────────────
  const CARDS = [
    {
      id: 'focus',
      label: '本周聚焦',
      title: '这周该做什么？',
      desc: '结合进行中的体验卡和最近的报名截止',
      prompt:
        '看我的数据，告诉我这一周最该做的一件事是什么，以及为什么。如果有 7 天内截止的事项，优先考虑。给出 3 条以内的具体动作。',
    },
    {
      id: 'gap',
      label: '能力缺口',
      title: '我和想去的方向差什么？',
      desc: '对比方向所需能力与我的能力标签',
      prompt:
        '对比我的能力画像和意向最强的方向所需要的能力，指出最关键的 2～3 个缺口。每个缺口给出一个本学期可以完成的补足方式（具体到比赛、课程、项目或体验卡）。',
    },
    {
      id: 'evidence',
      label: '经历提炼',
      title: '把我的经历写成能力证据',
      desc: '挑一段经历，改写成 STAR 式证据',
      prompt:
        '从我记录的经历里挑出「最能证明能力、但目前写得最含糊」的那一段，用 STAR（情境-任务-行动-结果）重写，并提炼出 3 个可以用在简历上的能力标签。如果结果部分缺量化，指出该补什么数据。',
    },
    {
      id: 'rank',
      label: '方向排序',
      title: '几个方向先试哪个？',
      desc: '按意向、已有基础与推进成本排序',
      prompt:
        '我有若干方向。按「值得先投入的程度」排序，并说明排序依据（意向强度、已有基础、试错成本、与现有经历的复用度）。第一名给出本周就能启动的最小验证动作。',
    },
    {
      id: 'opportunity',
      label: '机会取舍',
      title: '这学期该报哪些？',
      desc: '按截止时间与含金量做取舍',
      prompt:
        '基于我的机会库和方向，判断这学期应该重点投入哪些机会、放弃哪些，说明理由。注意报名截止时间，把临近的先说。不要贪多，最多推荐 3 个。',
    },
    {
      id: 'major',
      label: '专业探索',
      title: '这个专业值得深入了解吗？',
      desc: '结合相关职业与我已有的方向',
      prompt:
        '结合我正在进行的方向和经历，评价我记录的专业探索项：哪些值得深入、哪些可以先放一边，以及判断一个专业是否适合自己最该看的 2 个信号是什么。',
    },
  ];

  // ── 状态 ────────────────────────────────────────────────────────────────
  const HIST_KEY = 'atlas.ai.history.v1';   // 对话记录（只在本机，跟随浏览器）
  const MAX_STORED = 40;                    // 最多保留多少条，防止 localStorage 涨爆
  let conf = null;               // { key, base, regionLabel, model }
  let digest = null;             // 摘要对象
  let history = loadHistory();   // { role, content, label }
  let pendingQuestion = '';      // 面板还没建出输入框时先记住要预填的问题
  let busy = false;
  let acct = { status: 'idle', name: '' };  // Qoder 登录状态
  const root = {};

  // 对话记录：关面板、刷新页面都还在；只存本机，不经过任何服务器
  function loadHistory() {
    try {
      const raw = localStorage.getItem(HIST_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-MAX_STORED);
    } catch (_) {
      return [];
    }
  }
  function saveHistory() {
    try {
      const trimmed = history.slice(-MAX_STORED).map((m) => ({
        role: m.role,
        content: String(m.content).slice(0, 12000),
        label: m.label,
      }));
      localStorage.setItem(HIST_KEY, JSON.stringify(trimmed));
    } catch (_) {}
  }

  // ══════════════════════════════════════════════════════════════════════
  // 1. 数据桥：把本地数据压成一份摘要
  // ══════════════════════════════════════════════════════════════════════

  // 主站若暴露了 Provider 就用它；否则扫 localStorage
  function readSource() {
    if (typeof window.AtlasAIProvider === 'function') {
      try {
        const d = window.AtlasAIProvider();
        if (d && typeof d === 'object') return { data: d, from: 'window.AtlasAIProvider()' };
      } catch (_) {}
    }
    // 遍历 localStorage，挑能解析成对象/数组的
    const found = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k);
      if (!v || v.length > 2e6) continue;
      if (!/^[[{]/.test(v.trim())) continue;
      try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === 'object') found.push({ key: k, value: parsed });
      } catch (_) {}
    }
    if (!found.length) return { data: null, from: null };
    // 挑「看起来最像主数据集」的那个：包含数组项最多的
    let best = found[0];
    let bestScore = -1;
    for (const f of found) {
      const score = arrayScore(f.value);
      if (score > bestScore) { bestScore = score; best = f; }
    }
    return { data: best.value, from: 'localStorage["' + best.key + '"]' };
  }

  function arrayScore(v, depth) {
    depth = depth || 0;
    if (depth > 3 || !v) return 0;
    if (Array.isArray(v)) return v.length + v.slice(0, 5).reduce((s, x) => s + arrayScore(x, depth + 1), 0);
    if (typeof v !== 'object') return 0;
    return Object.values(v).reduce((s, x) => s + arrayScore(x, depth + 1), 0);
  }

  // 通用压缩：任何结构都能变成一份「可读且省 token」的摘要
  // 策略：数组只留前若干项；字符串截断；剔除 base64/dataURL；按预算截流
  function compact(value, budget) {
    let used = 0;
    const seen = new Set();

    function walk(v, depth) {
      if (used >= budget) return undefined;
      if (v === null || v === undefined) return v;
      if (typeof v === 'string') {
        let s = v.replace(/\s+/g, ' ').trim();
        if (/^data:/.test(s) || s.length > 400) s = s.slice(0, 120) + '…';
        else if (s.length > 120) s = s.slice(0, 120) + '…';
        used += s.length;
        return s;
      }
      if (typeof v === 'number' || typeof v === 'boolean') { used += 6; return v; }
      if (Array.isArray(v)) {
        if (depth > 4) return '[' + v.length + ' 项]';
        const keep = depth === 0 ? 60 : 12;
        const out = [];
        for (const item of v.slice(0, keep)) {
          const w = walk(item, depth + 1);
          if (w !== undefined) out.push(w);
          if (used >= budget) break;
        }
        if (v.length > keep) out.push('…另有 ' + (v.length - keep) + ' 项');
        return out;
      }
      if (typeof v === 'object') {
        if (seen.has(v)) return '[循环]';
        seen.add(v);
        const out = {};
        for (const [k, val] of Object.entries(v)) {
          if (/^(id|_id|createdAt|updatedAt|__)/.test(k)) continue;
          const w = walk(val, depth + 1);
          if (w !== undefined) out[k] = w;
          if (used >= budget) break;
        }
        return out;
      }
      return String(v);
    }

    return walk(value, 0);
  }

  function buildDigest() {
    const src = readSource();
    if (!src.data) return { ok: false, reason: '没找到你的数据。先在主站里记录一点内容，再来问。' };
    return {
      ok: true,
      from: src.from,
      profile: compact(src.data, DIGEST_BUDGET),
      today: new Date().toISOString().slice(0, 10),
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 2. 网络：校验 / 探测地域 / 流式对话（浏览器直连百炼）
  // ══════════════════════════════════════════════════════════════════════

  function classify(status, body) {
    const low = String(body || '').toLowerCase();
    if (status === 401 || low.includes('invalid_api_key') || low.includes('invalid api-key')) {
      return { title: 'Key 无效，或已经被删除了', action: '确认完整复制了 Key。百炼的 Key 只在创建成功的弹窗里显示一次。' };
    }
    if (status === 403 && low.includes('ip access denied')) {
      return { title: '这个 Key 限制了来源 IP', action: '去百炼控制台把该 Key 的 IP 白名单改成 0.0.0.0/0。' };
    }
    if (low.includes('arrearage') || low.includes('overdue')) {
      return { title: '账号未开通百炼，或已欠费', action: '去控制台确认服务已开通、余额正常。' };
    }
    if (low.includes('model not exist') || low.includes('invalid model')) {
      return { title: '当前地域没有这个模型', action: '换一个模型再试。' };
    }
    if (status === 429) {
      const quota = /allocationquota|insufficient_quota|freetier|quota/.test(low);
      return quota
        ? { title: '额度不足', action: '免费额度可能用完了，去控制台看一下。' }
        : { title: '被限流了', action: '等十几秒再试。' };
    }
    return { title: '调用失败（HTTP ' + (status || '—') + '）', action: String(body || '').slice(0, 200) };
  }

  async function probeOne(key, base) {
    for (const model of PROBE_MODELS) {
      let res;
      try {
        res = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
          body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
          signal: AbortSignal.timeout(15000),
        });
      } catch (e) {
        return { ok: false, status: 0, title: '连不上百炼（网络或代理问题）', action: e.message };
      }
      if (res.ok) return { ok: true, status: res.status };
      const text = await res.text();
      // 429 = 鉴权通过但被限流，对「这个地域能不能用」答案是「能」
      if (res.status === 429) {
        const c = classify(res.status, text);
        return { ok: true, status: 429, warning: c };
      }
      const c = classify(res.status, text);
      if (c.title.indexOf('没有这个模型') >= 0) continue;
      return { ok: false, status: res.status, title: c.title, action: c.action };
    }
    return { ok: false, status: 400, title: '没有可用的模型名', action: '' };
  }

  async function detectRegion(key) {
    const list = key.startsWith('sk-sp-') ? PLANS.slice() : REGIONS.slice();
    const attempts = [];
    for (const cand of list) {
      const r = await probeOne(key, cand.base);
      attempts.push({ label: cand.label, status: r.status, ok: r.ok, title: r.ok ? (r.warning ? '鉴权通过，但' + r.warning.title : '可用') : r.title });
      if (r.ok) return { chosen: cand, warning: r.warning || null, attempts };
    }
    return { chosen: null, attempts };
  }

  async function streamChat(userText) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (digest && digest.ok) {
      messages.push({
        role: 'system',
        content: '以下是这个学生本地工作台的数据摘要（JSON，日期 ' + digest.today + '）：\n' + JSON.stringify(digest.profile),
      });
    }
    for (const h of history.slice(-MAX_HISTORY)) messages.push(h);
    messages.push({ role: 'user', content: userText });

    const res = await fetch(conf.base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + conf.key },
      body: JSON.stringify({
        model: conf.model,
        messages,
        max_tokens: 1600,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      const c = classify(res.status, t);
      throw new Error(c.title + '：' + c.action);
    }
    return res;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 3. UI（校园绿 × 液态玻璃：全部消费主站设计变量，自动跟随昼夜主题）
  // ══════════════════════════════════════════════════════════════════════

  const CSS = `
  .atlas-ai-fab{position:fixed;right:22px;bottom:22px;z-index:9998;display:flex;align-items:center;gap:8px;
    padding:11px 17px;border:0;border-radius:999px;cursor:pointer;font:inherit;font-size:14px;font-weight:600;
    color:var(--site-on-accent,#fff);background:linear-gradient(150deg,var(--light,#7fae94),var(--green,#3f7d5a));
    box-shadow:0 6px 20px -6px color-mix(in srgb,var(--site-accent,#3f7d5a) 65%,transparent),inset 0 1px 0 rgba(255,255,255,.35);
    transition:transform .22s cubic-bezier(.3,1.5,.45,1),box-shadow .22s}
  .atlas-ai-fab:hover{transform:translateY(-2px) scale(1.03);box-shadow:0 12px 28px -8px color-mix(in srgb,var(--site-accent,#3f7d5a) 75%,transparent),inset 0 1px 0 rgba(255,255,255,.35)}
  .atlas-ai-fab:active{transform:scale(.93)}
  /* Qoder Sites 部署时会往右下角注入「Made with Qoder」徽标，正好压住按钮：整体让位 */
  body.atlas-ai-with-badge .atlas-ai-fab,html:has(#qoder-sites-watermark) body .atlas-ai-fab{bottom:76px}
  body.atlas-ai-with-badge .atlas-ai-panel,html:has(#qoder-sites-watermark) body .atlas-ai-panel{padding-bottom:56px}
  .atlas-ai-fab svg{width:16px;height:16px}

  .atlas-ai-mask{position:fixed;inset:0;background:rgba(8,18,12,.4);z-index:9999;backdrop-filter:blur(3px);
    animation:atlasAiFade .25s ease-out}
  @keyframes atlasAiFade{from{opacity:0}}
  .atlas-ai-panel{position:fixed;z-index:10000;top:0;right:0;bottom:0;width:min(460px,100vw);
    display:flex;flex-direction:column;
    background:color-mix(in srgb,var(--site-bg,#eef6f0) 90%,var(--mix-base,#fff));
    backdrop-filter:blur(24px) saturate(1.4);-webkit-backdrop-filter:blur(24px) saturate(1.4);
    border-left:1px solid var(--glass-edge,rgba(255,255,255,.72));
    box-shadow:-18px 0 50px rgba(8,20,14,.28);
    font:15px/1.7 var(--sans,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);
    color:var(--ink,#1f3a2e);animation:atlasAiIn .34s cubic-bezier(.22,1.35,.36,1)}
  @keyframes atlasAiIn{from{transform:translateX(46px);opacity:0}}
  .atlas-ai-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;
    padding:16px 18px 12px;border-bottom:1px solid var(--line,rgba(31,58,46,.1))}
  .atlas-ai-head h3{margin:0;font-size:16px;font-weight:700;letter-spacing:.3px;color:var(--ink,#1f3a2e)}
  .atlas-ai-head .sub{font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:var(--light,#6aa37f);font-weight:700}
  .atlas-ai-x{border:0;background:transparent;font-size:17px;color:var(--ink-3,#64806f);cursor:pointer;padding:2px 8px;border-radius:8px;transition:.15s}
  .atlas-ai-x:hover{background:rgba(var(--hi,255,255,255),.8);color:var(--ink,#1f3a2e)}

  .atlas-ai-body{flex:1;overflow-y:auto;padding:16px 18px 8px;
    scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--site-accent,#3f7d5a) 42%,transparent) transparent}
  .atlas-ai-body::-webkit-scrollbar{width:8px}
  .atlas-ai-body::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--site-accent,#3f7d5a) 34%,transparent);border-radius:99px}

  .atlas-ai-acct{display:flex;align-items:center;gap:8px;padding:8px 12px;margin-bottom:12px;
    border:1px solid var(--glass-edge,rgba(255,255,255,.72));border-radius:11px;
    background:rgba(var(--hi,255,255,255),.45);font-size:12px;color:var(--ink-2,#3c5a4b)}
  .atlas-ai-acct .st{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .atlas-ai-acct button{border:0;background:transparent;color:var(--deep,#2c5a41);cursor:pointer;
    font:inherit;font-size:12px;font-weight:600;padding:0;text-decoration:underline;flex:none}

  .atlas-ai-cards{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:16px}
  .atlas-ai-card{text-align:left;padding:11px 12px;border:1px solid var(--glass-edge,rgba(255,255,255,.72));
    border-radius:var(--radius-s,12px);background:rgba(var(--hi,255,255,255),.55);cursor:pointer;font:inherit;
    transition:transform .2s cubic-bezier(.3,1.5,.45,1),border-color .15s,background .15s,box-shadow .2s}
  .atlas-ai-card:hover{border-color:var(--light,#6aa37f);background:rgba(var(--hi,255,255,255),.85);
    transform:translateY(-2px);box-shadow:0 8px 20px -12px color-mix(in srgb,var(--site-accent,#3f7d5a) 55%,transparent)}
  .atlas-ai-card:active{transform:scale(.96)}
  .atlas-ai-card .lb{font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:var(--light,#6aa37f);display:block;margin-bottom:3px;font-weight:700}
  .atlas-ai-card .tt{font-size:13.5px;color:var(--ink,#1f3a2e);line-height:1.45;display:block;font-weight:600}
  .atlas-ai-card .ds{font-size:11.5px;color:var(--ink-3,#64806f);line-height:1.5;display:block;margin-top:3px}

  .atlas-ai-msg{margin-bottom:16px}
  .atlas-ai-msg .who{font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:var(--ink-3,#64806f);margin-bottom:4px;font-weight:700}
  .atlas-ai-msg .tx{white-space:pre-wrap;word-break:break-word;color:var(--ink,#1f3a2e);font-size:14px}
  .atlas-ai-msg.me .tx{color:var(--deep,#2c5a41)}
  .atlas-ai-msg.err .tx{color:var(--coral,#c05a44)}
  .atlas-ai-cur::after{content:"";display:inline-block;width:5px;height:13px;margin-left:2px;
    background:var(--green,#3f7d5a);vertical-align:-2px;animation:atlasAiBlink 1s steps(2,start) infinite}
  @keyframes atlasAiBlink{to{visibility:hidden}}

  .atlas-ai-foot{flex:none;padding:10px 18px 16px;border-top:1px solid var(--line,rgba(31,58,46,.1))}
  .atlas-ai-in{display:flex;gap:8px;align-items:flex-end}
  .atlas-ai-in textarea{flex:1;min-height:44px;max-height:240px;resize:none;font:inherit;font-size:13.5px;
    line-height:1.5;overflow-y:auto;
    padding:9px 11px;border:1px solid var(--glass-edge,rgba(255,255,255,.72));border-radius:11px;outline:none;
    background:rgba(var(--hi,255,255,255),.7);color:var(--ink,#1f3a2e);transition:border-color .15s,box-shadow .15s}
  .atlas-ai-in textarea:focus{border-color:var(--light,#6aa37f);box-shadow:0 0 0 3px color-mix(in srgb,var(--site-accent,#3f7d5a) 18%,transparent)}
  .atlas-ai-send{border:0;border-radius:11px;padding:11px 16px;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;
    background:linear-gradient(150deg,var(--light,#7fae94),var(--green,#3f7d5a));color:var(--site-on-accent,#fff);
    transition:transform .18s cubic-bezier(.3,1.5,.45,1),filter .15s}
  .atlas-ai-send:hover{filter:brightness(1.06)}
  .atlas-ai-send:active{transform:scale(.93)}
  .atlas-ai-send:disabled{opacity:.5;cursor:not-allowed}
  .atlas-ai-meta{display:flex;align-items:center;gap:10px;margin-top:7px;font-size:11.5px;color:var(--ink-3,#64806f)}
  .atlas-ai-meta button{border:0;background:transparent;color:var(--deep,#2c5a41);cursor:pointer;font:inherit;font-size:11.5px;padding:0;text-decoration:underline}

  .atlas-ai-setup{padding:2px 0 8px}
  .atlas-ai-setup h4{margin:0 0 4px;font-size:15px;color:var(--ink,#1f3a2e)}
  .atlas-ai-setup p{margin:0 0 14px;font-size:12.5px;color:var(--ink-3,#64806f);line-height:1.7}
  .atlas-ai-setup ol{margin:0 0 14px;padding-left:18px;font-size:12.5px;color:var(--ink-3,#64806f);line-height:1.9}
  .atlas-ai-setup b{color:var(--ink,#1f3a2e)}
  .atlas-ai-row{display:flex;gap:8px;margin-bottom:9px}
  .atlas-ai-row input{flex:1;min-width:0;font:inherit;font-size:13px;padding:9px 11px;
    border:1px solid var(--glass-edge,rgba(255,255,255,.72));border-radius:10px;outline:none;
    background:rgba(var(--hi,255,255,255),.7);color:var(--ink,#1f3a2e)}
  .atlas-ai-row input:focus{border-color:var(--light,#6aa37f)}
  .atlas-ai-btn{border:1px solid var(--glass-edge,rgba(255,255,255,.72));background:rgba(var(--hi,255,255,255),.6);
    border-radius:10px;padding:6px 12px;font:inherit;font-size:12.5px;color:var(--ink-2,#3c5a4b);cursor:pointer;transition:.15s}
  .atlas-ai-btn:hover{background:rgba(var(--hi,255,255,255),.9)}
  .atlas-ai-btn.pri{background:linear-gradient(150deg,var(--light,#7fae94),var(--green,#3f7d5a));
    color:var(--site-on-accent,#fff);border-color:transparent;width:100%;padding:10px;font-size:13.5px;font-weight:600}
  .atlas-ai-btn.pri:disabled{opacity:.55}
  .atlas-ai-err{margin-top:10px;font-size:12px;color:color-mix(in srgb,var(--coral,#d9806a) 72%,var(--site-fg,#1f3a2e));
    background:color-mix(in srgb,var(--coral,#d9806a) 12%,transparent);
    border:1px solid color-mix(in srgb,var(--coral,#d9806a) 35%,transparent);
    border-radius:9px;padding:8px 10px}
  .atlas-ai-err b{display:block;margin-bottom:2px}
  .atlas-ai-att{margin-top:7px;border-top:1px dashed var(--line,rgba(31,58,46,.1));padding-top:6px;font-size:11px;
    font-family:ui-monospace,Consolas,monospace;color:var(--ink-3,#64806f)}
  .atlas-ai-att div{display:flex;gap:6px}
  .atlas-ai-att .l{flex:none;width:6.4em;color:var(--ink-2,#3c5a4b)}
  .atlas-ai-att .s{flex:none;width:2.4em;color:var(--coral,#c05a44)}
  .atlas-ai-att .s.g{color:var(--green,#3f7d5a)}
  .atlas-ai-att .m{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  @media(max-width:520px){
    .atlas-ai-cards{grid-template-columns:1fr}
    .atlas-ai-fab{right:14px;bottom:14px;padding:10px 15px;font-size:13px}
  }
  @media(prefers-reduced-motion:reduce){
    .atlas-ai-panel,.atlas-ai-mask{animation:none}
    .atlas-ai-fab,.atlas-ai-card,.atlas-ai-send{transition:none}
  }`;

  function h(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    if (children) for (const c of [].concat(children)) if (c) e.append(c);
    return e;
  }

  function injectStyle() {
    if (document.getElementById('atlas-ai-style')) return;
    const s = document.createElement('style');
    s.id = 'atlas-ai-style';
    s.textContent = CSS;
    document.head.append(s);
  }

  function loadConf() {
    try {
      const raw = localStorage.getItem(STORE);
      const c = raw ? JSON.parse(raw) : null;
      return c && c.key && c.base ? c : null;
    } catch (_) { return null; }
  }
  function saveConf(c) {
    try { localStorage.setItem(STORE, JSON.stringify(c)); } catch (_) {}
  }

  // ── Qoder 账号登录状态（部署到 Qoder Sites 后可用） ─────────────────────
  async function loadAccount() {
    try {
      const res = await fetch('/__qoder_auth/me', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) { acct = { status: 'local', name: '' }; return; }
      if (res.ok) {
        const j = await res.json();
        if (j && j.user_id) { acct = { status: 'in', name: j.name || 'Qoder 用户' }; return; }
      }
      acct = { status: 'out', name: '' };
    } catch (_) {
      acct = { status: 'local', name: '' };
    }
  }

  function renderAccount() {
    const row = h('div', { class: 'atlas-ai-acct' });
    const st = h('span', { class: 'st' });
    if (acct.status === 'in') {
      st.textContent = 'Qoder 已登录：' + acct.name;
      row.append(st);
    } else if (acct.status === 'out') {
      st.textContent = '未登录 Qoder 账号';
      row.append(st, h('button', {
        text: '登录',
        onclick: () => {
          location.href = '/__qoder_auth/start?return_path=' + encodeURIComponent(location.pathname + location.search);
        },
      }));
    } else if (acct.status === 'local') {
      st.textContent = 'Qoder 登录在站点部署后可用';
      row.append(st);
    } else {
      st.textContent = '正在检查 Qoder 登录状态…';
      row.append(st);
    }
    return row;
  }

  function updateAccount() {
    if (!root.body) return;
    const old = root.body.querySelector('.atlas-ai-acct');
    if (old) old.replaceWith(renderAccount());
  }

  // ── 悬浮按钮 ────────────────────────────────────────────────────────────
  function mountFab() {
    const fab = h('button', {
      class: 'atlas-ai-fab',
      title: '基于你本地记录给出建议',
      onclick: () => openPanel(),
    });
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg>' +
      '<span>AI 咨询</span>';
    document.body.append(fab);
    root.fab = fab;
    avoidBadge();
    // 徽标由部署平台在 DOMContentLoaded 时注入，而且挂在 <html> 上（不是 body），
    // 所以观察 documentElement，再补一个延时兜底
    try {
      new MutationObserver(avoidBadge).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['id']
      });
      setTimeout(avoidBadge, 0);
      setTimeout(avoidBadge, 250);
      setTimeout(avoidBadge, 2000);
    } catch (_) {}
  }

  // 右下角有平台徽标时给按钮和面板让位，避免叠在一起
  function avoidBadge() {
    if (document.body.classList.contains('atlas-ai-with-badge')) return;
    if (!document.getElementById('qoder-sites-watermark')) return;
    document.body.classList.add('atlas-ai-with-badge');
  }

  // ── 面板 ────────────────────────────────────────────────────────────────
  function openPanel(prefill) {
    if (root.panel) { if (prefill) setInput(prefill); return; }
    if (prefill) pendingQuestion = prefill;
    const mask = h('div', { class: 'atlas-ai-mask', onclick: closePanel });
    const body = h('div', { class: 'atlas-ai-body' });
    const panel = h('aside', { class: 'atlas-ai-panel' }, [
      h('div', { class: 'atlas-ai-head' }, [
        h('div', {}, [h('div', { class: 'sub', text: 'growth advisor' }), h('h3', { text: 'AI 咨询' })]),
        h('button', { class: 'atlas-ai-x', text: '✕', onclick: closePanel }),
      ]),
      body,
    ]);
    document.body.append(mask, panel);
    root.mask = mask;
    root.panel = panel;
    root.body = body;
    refreshPanel();
    loadAccount().then(updateAccount);
    if (prefill) setInput(prefill);
  }

  function closePanel() {
    if (root.panel) root.panel.remove();
    if (root.mask) root.mask.remove();
    root.panel = root.mask = root.body = root.msgs = root.foot = null;
    // 历史保留：关掉再打开还能接着看（并已落到 localStorage）
  }

  function setInput(t) {
    if (root.input) { root.input.value = t; root.input.focus(); }
    else pendingQuestion = t;   // 还在配 Key 阶段，先记住，输入框出现时再填
  }

  function refreshPanel() {
    if (!root.body) return;
    conf = conf || loadConf();
    digest = buildDigest();
    root.body.replaceChildren();
    root.body.append(renderAccount());

    if (!conf) {
      if (root.foot) { root.foot.remove(); root.foot = null; }
      root.msgs = null;
      root.body.append(renderSetup());
      return;
    }

    root.body.append(renderCards());
    // 消息单独放一个容器：输入框在它外面（固定在面板底部），不会再被内容顶走
    root.msgs = h('div', { class: 'atlas-ai-msgs' });
    root.msgs.append(renderMessages());
    root.body.append(root.msgs);

    if (root.foot) root.foot.remove();
    root.foot = renderFoot();
    root.panel.append(root.foot);
    root.body.scrollTop = root.body.scrollHeight;
  }

  // ── 首次配置 ────────────────────────────────────────────────────────────
  function renderSetup() {
    const box = h('div', { class: 'atlas-ai-setup' });
    box.append(
      h('h4', { text: '先填一个你自己的 API Key' }),
      h('p', {
        text:
          '这个面板没有后端：Key 只存在你这台电脑的浏览器里，请求由浏览器直接发往阿里云百炼，' +
          '消耗的是你自己账号的额度。你的成长数据不会经过任何第三方服务器。',
      }),
      h('ol', {})
    );
    const ol = box.querySelector('ol');
    [
      '打开百炼控制台（点下面的链接），左侧菜单进 API-KEY。',
      '点「创建 API Key」，创建成功后立刻复制——关掉弹窗就看不到了。',
      '回来粘贴到下面，点校验。地域会自动探测，你不用选。',
    ].forEach((t) => ol.append(h('li', { text: t })));

    const link = h('a', {
      class: 'atlas-ai-btn',
      href: 'https://bailian.console.aliyun.com/',
      target: '_blank',
      rel: 'noopener',
      text: '去百炼获取 API Key ↗',
      style: 'display:block;text-align:center;text-decoration:none;margin-bottom:14px',
    });

    const input = h('input', { type: 'password', placeholder: 'sk- 开头的 Key', autocomplete: 'off', spellcheck: 'false' });
    const reveal = h('button', {
      class: 'atlas-ai-btn', text: '显示',
      onclick: () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        reveal.textContent = show ? '隐藏' : '显示';
      },
    });
    const modelSel = h('select', {
      class: 'atlas-ai-btn',
      style: 'width:100%;margin-bottom:12px;padding:9px',
    });
    [
      ['qwen-plus', 'qwen-plus · 均衡（推荐）'],
      ['qwen-turbo', 'qwen-turbo · 最快最省'],
      ['qwen-max', 'qwen-max · 最强'],
    ].forEach(([v, t]) => modelSel.append(h('option', { value: v, text: t })));

    const errBox = h('div', { class: 'atlas-ai-err', hidden: 'hidden' });
    const saveBtn = h('button', { class: 'atlas-ai-btn pri', text: '校验并保存' });

    saveBtn.onclick = async () => {
      const raw = (input.value || '').trim().replace(/\s+/g, '');
      errBox.hidden = true;
      if (!raw) return showSetupErr(errBox, { title: '还没有填 Key', action: '把 sk- 开头的那一串粘贴进来。' });
      // 只拦协议层面发不出去的东西，不预判百炼的格式（长度、字符集由它决定）
      if (!raw.startsWith('sk-')) return showSetupErr(errBox, { title: '格式不对', action: '百炼 API Key 必须以 sk- 开头。' });
      if (/[^\x21-\x7e]/.test(raw)) return showSetupErr(errBox, { title: '格式不对', action: '里面有非 ASCII 字符（比如全角空格），删掉再试。' });
      if (raw.length < 20) return showSetupErr(errBox, { title: '格式不对', action: '只有 ' + raw.length + ' 个字符，太短了，可能没复制全。' });

      saveBtn.disabled = true;
      saveBtn.textContent = '正在逐个地域校验…';
      const r = await detectRegion(raw);
      saveBtn.disabled = false;
      saveBtn.textContent = '校验并保存';

      if (!r.chosen) {
        const inf = r.attempts.find((a) => !a.ok && a.title.indexOf('Key 无效') < 0);
        showSetupErr(errBox, {
          title: inf ? inf.title : '百炼不认这个 Key',
          action: '我把所有地域都试了一遍。看下面的记录；如果全是 401，说明 Key 本身无效。',
          attempts: r.attempts,
        });
        return;
      }
      conf = { key: raw, base: r.chosen.base, regionLabel: r.chosen.label, model: modelSel.value };
      saveConf(conf);
      refreshPanel();
    };

    box.append(link, h('div', { class: 'atlas-ai-row' }, [input, reveal]), modelSel, errBox, saveBtn);
    return box;
  }

  function showSetupErr(box, { title, action, attempts }) {
    box.hidden = false;
    box.replaceChildren();
    box.append(h('b', { text: title }), document.createTextNode(action || ''));
    if (attempts && attempts.length) {
      const att = h('div', { class: 'atlas-ai-att' });
      attempts.forEach((a) => {
        att.append(h('div', {}, [
          h('span', { class: 'l', text: a.label }),
          h('span', { class: 's' + (a.ok ? ' g' : ''), text: a.ok ? 'OK' : String(a.status || '—') }),
          h('span', { class: 'm', text: a.title || '' }),
        ]));
      });
      box.append(att);
    }
  }

  // ── 咨询卡 + 消息 + 输入区 ──────────────────────────────────────────────
  function renderCards() {
    const wrap = h('div', {});
    const status = h('div', { class: 'atlas-ai-meta', style: 'margin:0 0 10px' });
    if (digest && digest.ok) {
      status.append(h('span', { text: '已读取你的数据（' + digest.from + '）' }));
    } else {
      status.append(h('span', { text: '⚠ ' + (digest ? digest.reason : '没读到数据') }));
    }
    wrap.append(status);

    const grid = h('div', { class: 'atlas-ai-cards' });
    CARDS.forEach((c) => {
      grid.append(
        h('button', {
          class: 'atlas-ai-card',
          onclick: () => ask(c.prompt, c.title),
        }, [
          h('span', { class: 'lb', text: c.label }),
          h('span', { class: 'tt', text: c.title }),
          h('span', { class: 'ds', text: c.desc }),
        ])
      );
    });
    wrap.append(grid);
    return wrap;
  }

  function renderMessages() {
    const wrap = h('div', {});
    if (!history.length) {
      wrap.append(
        h('div', { class: 'atlas-ai-msg' }, [
          h('div', { class: 'who', text: '说明' }),
          h('div', {
            class: 'tx',
            text:
              '上面六个是最常用的咨询。也可以直接在下面提问，我会基于你记录的经历、方向和截止日期回答。' +
              '每次只把数据的摘要发给你自己的模型，原始记录和作品链接不会上传。',
          }),
        ])
      );
      return wrap;
    }
    history.forEach((m) => {
      // 点卡片时，history 里存的是给模型的完整指令；
      // 展示给用户时用 label（比如「本周聚焦」），不要把那一长串指令糊在屏幕上。
      const shown = m.role === 'user' ? m.label || m.content : m.content;
      wrap.append(
        h('div', { class: 'atlas-ai-msg' + (m.role === 'user' ? ' me' : '') }, [
          h('div', { class: 'who', text: m.role === 'user' ? '你' : '顾问' }),
          h('div', { class: 'tx', text: shown }),
        ])
      );
    });
    return wrap;
  }

  function clearDialogBtn() {
    const b = h('button', { text: '清空对话' });
    b.setAttribute('data-clear', '1');
    b.onclick = () => {
      if (!window.confirm('清空这段对话记录？本机存档会一起删除。')) return;
      window.AtlasAI.reset();
    };
    return b;
  }
  // 第一条消息发出后把「清空对话」补进底栏，不用重开面板
  function ensureClearBtn() {
    const meta = root.foot && root.foot.querySelector('.atlas-ai-meta');
    if (!meta || meta.querySelector('[data-clear]')) return;
    const keyBtn = Array.from(meta.children).find((el) => el.textContent === '换 Key');
    meta.insertBefore(clearDialogBtn(), keyBtn || null);
  }

  function renderFoot() {    const ta = h('textarea', {
      rows: '1',
      placeholder: '就你的经历或方向提问…（Enter 发送）',
    });
    const send = h('button', { class: 'atlas-ai-send', text: '发送' });
    root.input = ta;

    // 高度跟着内容走：上限取 240px 与面板高度的 32% 里的小者，超过才出滚动条
    const maxH = () => Math.min(240, Math.max(96, Math.round(window.innerHeight * 0.32)));
    const grow = () => {
      ta.style.height = 'auto';
      // textarea 是 border-box：scrollHeight 含 padding 不含 border，补上 border 再作为总高
      const extra = ta.offsetHeight - ta.clientHeight;
      const limit = maxH();
      const need = (ta.scrollHeight || 44) + extra;
      ta.style.height = Math.min(need, limit) + 'px';
      ta.style.overflowY = need > limit ? 'auto' : 'hidden';
    };
    const resetInput = () => {
      ta.value = '';
      ta.style.height = '44px';
      grow();
      root.body.scrollTop = root.body.scrollHeight;
    };

    // 首次配 Key 之前点过「问AI」：问题存在 pendingQuestion 里，等布局完再补填并撑开
    if (pendingQuestion) {
      ta.value = pendingQuestion;
      pendingQuestion = '';
      (window.requestAnimationFrame || setTimeout)(grow);
    }

    const askFree = () => {
      const t = ta.value.trim();
      if (!t || busy) return;
      ask(t, null);
      resetInput();   // 发完立刻清空，下一条直接输入，不用手动删
      ta.focus();
    };
    send.onclick = askFree;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); askFree(); }
    });

    const meta = h('div', { class: 'atlas-ai-meta' });
    const resetBtn = h('button', { text: '换 Key' });
    resetBtn.onclick = () => { localStorage.removeItem(STORE); conf = null; refreshPanel(); };
    meta.append(h('span', { text: conf.regionLabel || '' }));
    if (history.length) meta.append(clearDialogBtn());
    meta.append(resetBtn);

    const foot = h('div', { class: 'atlas-ai-foot' }, [h('div', { class: 'atlas-ai-in' }, [ta, send]), meta]);

    // 输入框随内容长高
    ta.addEventListener('input', grow);
    return foot;
  }

  // ── 提问主流程 ──────────────────────────────────────────────────────────
  async function ask(text, cardTitle) {
    if (busy) return;
    if (!conf) { refreshPanel(); return; }
    busy = true;

    const userMsg = text;
    history.push({ role: 'user', content: userMsg, label: cardTitle ? '「' + cardTitle + '」' : userMsg });
    saveHistory();

    const feed = root.msgs || root.body;
    feed.append(
      h('div', { class: 'atlas-ai-msg me' }, [
        h('div', { class: 'who', text: '你' }),
        h('div', { class: 'tx', text: cardTitle ? '「' + cardTitle + '」' : userMsg }),
      ])
    );

    const msgWrap = h('div', { class: 'atlas-ai-msg' }, [
      h('div', { class: 'who', text: cardTitle ? '咨询 · ' + cardTitle : '顾问' }),
      h('div', { class: 'tx atlas-ai-cur', text: '' }),
    ]);
    const tx = msgWrap.querySelector('.tx');
    feed.append(msgWrap);
    root.body.scrollTop = root.body.scrollHeight;

    const sendBtn = root.panel.querySelector('.atlas-ai-send');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '…'; }

    let acc = '';
    try {
      const res = await streamChat(userMsg);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const p = line.slice(5).trim();
            if (!p || p === '[DONE]') continue;
            let j;
            try { j = JSON.parse(p); } catch (_) { continue; }
            const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (d) { acc += d; tx.textContent = acc; root.body.scrollTop = root.body.scrollHeight; }
          }
        }
      }
      tx.classList.remove('atlas-ai-cur');
      history.push({ role: 'assistant', content: acc || '（空回复）' });
      saveHistory();
      ensureClearBtn();
    } catch (e) {
      tx.classList.remove('atlas-ai-cur');
      msgWrap.classList.add('err');
      tx.textContent = '出错了：' + e.message;
      history.pop();
      saveHistory();
    } finally {
      busy = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '发送'; }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 4. 对外接口
  // ══════════════════════════════════════════════════════════════════════
  window.AtlasAI = {
    mount() {
      injectStyle();
      mountFab();
      return this;
    },
    /** 打开面板并预填一个问题（给主站的「问 AI」按钮用） */
    open(question) { openPanel(question || ''); },
    /** 主站可以直接推数据进来，比自动扫描更准 */
    setProvider(fn) { window.AtlasAIProvider = fn; digest = null; },
    /** 清掉对话（含本地存档），保留 Key */
    reset() {
      history = [];
      saveHistory();
      if (root.body) refreshPanel();
    },
    version: '1.1.5',
  };
})();