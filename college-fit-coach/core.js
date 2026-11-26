/* 智体校园 · 核心层：存储、营养计算、恢复自评、食谱引擎、规则问询、搬运码。
   纯前端计算，数据存 localStorage，无任何网络请求。 */
'use strict';

var Store = (function(){
  var KEY = 'ztxy.v1';
  var state = null;

  function demoProfile(){
    return {sex:'男', age:20, height:175, weight:65, activity:'轻度', goal:'维持', restSec:90, isDemo:true};
  }
  function defaultState(){
    return {
      profile: demoProfile(),
      settings: {suggestAdjust:true, demoBannerDismissed:false},
      sessions: [], meals: [], plans: [],
      draft: null,
      recipePrefs: {scene:null, budget:30, avoid:[]},
      askScene: null
    };
  }
  function load(){
    if (state) return state;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.profile && Array.isArray(parsed.sessions)) {
          state = parsed;
          if (!state.settings) state.settings = {suggestAdjust:true, demoBannerDismissed:false};
          if (!state.recipePrefs) state.recipePrefs = {scene:null, budget:30, avoid:[]};
          if (!Array.isArray(state.meals)) state.meals = [];
          if (!Array.isArray(state.plans)) state.plans = [];
          return state;
        }
      }
    } catch(e) { /* 损坏数据回退到默认，不抛异常 */ }
    state = defaultState();
    return state;
  }
  function save(){
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch(e) { return false; }
  }
  function get(){ return load(); }
  function reset(){
    state = defaultState();
    save();
    return state;
  }
  function replace(payload){
    state = {
      profile: payload.profile,
      settings: payload.settings || {suggestAdjust:true, demoBannerDismissed:false},
      sessions: payload.sessions, meals: payload.meals, plans: payload.plans || [],
      draft: payload.draft || null,
      recipePrefs: payload.recipePrefs || {scene:null, budget:30, avoid:[]},
      askScene: payload.askScene || null
    };
    return save();
  }
  return {get:get, save:save, load:load, reset:reset, replace:replace, demoProfile:demoProfile};
})();

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function pad2(n){ return (n<10?'0':'')+n; }
function dateStr(ts){ var d=new Date(ts); return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function todayStr(){ return dateStr(Date.now()); }
function fmtClock(sec){ sec=Math.max(0,Math.ceil(sec)); var m=Math.floor(sec/60), s=sec%60; return m>0 ? m+':'+pad2(s) : ''+s; }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function mid(r){ return (r.min+r.max)/2; }
function addRange(a,b){ return {min:a.min+b.min, max:a.max+b.max}; }
function scaleRange(r,k){ return {min:r.min*k, max:r.max*k}; }
function fmtRange(r,unit){ return '约 '+Math.round(r.min)+'–'+Math.round(r.max)+' '+unit; }

/* ---------- 训练会话 ---------- */
var Training = (function(){
  var AUTO_ARCHIVE_MS = 40*60*1000;

  function ensureSession(){
    var st = Store.get();
    if (!st.draft) {
      st.draft = {id:uid(), date:todayStr(), startedAt:Date.now(), updatedAt:Date.now(), sets:[], rests:[], auto:false};
      Store.save();
    }
    return st.draft;
  }
  function touch(){
    var st = Store.get();
    if (st.draft) { st.draft.updatedAt = Date.now(); st.draft.date = st.draft.date || todayStr(); }
  }
  function addSet(exerciseId, weight, reps, rpe){
    var s = ensureSession();
    s.sets.push({id:uid(), at:Date.now(), exercise:exerciseId, weight:weight, reps:reps, rpe:rpe});
    s.updatedAt = Date.now();
    Store.save();
  }
  function addRest(rec){
    var s = ensureSession();
    s.rests.push(rec);
    s.updatedAt = Date.now();
    Store.save();
  }
  function archiveDraft(reason){
    var st = Store.get();
    if (!st.draft) return null;
    var d = st.draft;
    st.draft = null;
    if (d.sets.length===0 && d.rests.length===0) { Store.save(); return null; }
    d.archived = true;
    d.endedAt = Date.now();
    d.archiveReason = reason || 'manual';
    st.sessions.push(d);
    Store.save();
    return d;
  }
  function checkAutoArchive(){
    var st = Store.get();
    if (st.draft && Date.now() - (st.draft.updatedAt||st.draft.startedAt) > AUTO_ARCHIVE_MS) {
      return archiveDraft('auto40');
    }
    return null;
  }
  function allSessions(){
    var st = Store.get();
    var list = st.sessions.slice();
    if (st.draft && (st.draft.sets.length>0 || st.draft.rests.length>0)) list.push(st.draft);
    return list;
  }
  function sessionsSince(ts){
    return allSessions().filter(function(s){
      var t = s.startedAt || new Date(s.date+'T00:00:00').getTime();
      return t >= ts;
    });
  }
  function weekStartTs(){
    var d = new Date(); d.setHours(0,0,0,0);
    var day = (d.getDay()+6)%7;
    d.setDate(d.getDate()-day);
    return d.getTime();
  }
  function stats(list){
    var trainCount=0, totalSets=0, volume=0, restCount=0, restSecSum=0, skipped=0;
    list.forEach(function(s){
      if (s.sets.length>0 || s.rests.length>0) trainCount++;
      totalSets += s.sets.length;
      s.sets.forEach(function(x){ if (x.weight>0) volume += x.weight*x.reps; });
      s.rests.forEach(function(r){
        if (r.skipped) { skipped++; return; }
        restCount++; restSecSum += r.actualSec||0;
      });
    });
    return {
      trainCount:trainCount, totalSets:totalSets, volume:volume,
      restCount:restCount, avgRestSec: restCount>0 ? Math.round(restSecSum/restCount) : null,
      skipped:skipped
    };
  }
  function weekStats(){ return stats(sessionsSince(weekStartTs())); }
  function last7Stats(){ return stats(sessionsSince(Date.now()-7*86400000)); }
  function todaySessions(){ return sessionsSince(new Date(todayStr()+'T00:00:00').getTime()); }

  /* 基线：每次完整休息产生的一个平均反应时；跳过与无反应时数据的不入库 */
  function baselineHistory(excludeRestId){
    var arr = [];
    allSessions().forEach(function(s){
      s.rests.forEach(function(r){
        if (r.skipped || !r.rt || r.rt.valid===0) return;
        if (excludeRestId && r.id===excludeRestId) return;
        arr.push(r.rt.avg);
      });
    });
    return arr;
  }
  function lastEval(){
    var all = [];
    allSessions().forEach(function(s){ s.rests.forEach(function(r){ if(!r.skipped && r.rpe) all.push(r); }); });
    all.sort(function(a,b){ return b.at-a.at; });
    return all[0] || null;
  }
  return {
    ensureSession:ensureSession, touch:touch, addSet:addSet, addRest:addRest,
    archiveDraft:archiveDraft, checkAutoArchive:checkAutoArchive,
    allSessions:allSessions, weekStats:weekStats, last7Stats:last7Stats, todaySessions:todaySessions,
    baselineHistory:baselineHistory, lastEval:lastEval, stats:stats
  };
})();

/* ---------- 恢复自评 ---------- */
function recoveryScore(avgRT, rpe, baselineArr){
  var fatTerm = (6 - rpe) * 4;
  var hasBaseline = baselineArr && baselineArr.length >= 3 && avgRT != null;
  var rtTerm = 0, baseline = null;
  if (hasBaseline) {
    baseline = baselineArr.reduce(function(a,b){return a+b;},0) / baselineArr.length;
    rtTerm = clamp((baseline - avgRT) / baseline * 40, -25, 20);
  }
  var score = clamp(Math.round(60 + rtTerm + fatTerm), 0, 100);
  var tier = score >= 75 ? '良好' : (score >= 55 ? '一般' : '偏低');
  return {
    score:score, tier:tier, rtTerm:rtTerm, fatTerm:fatTerm,
    baselineUsed:hasBaseline, baseline: baseline ? Math.round(baseline) : null,
    slowVsBaseline: hasBaseline ? (avgRT > baseline*1.12) : false
  };
}

/* ---------- 营养目标 ---------- */
var ACTIVITY = {'久坐':1.2, '轻度':1.375, '中等':1.55, '高':1.725};
var GOAL_BAND = {'减脂':[0.80,0.90], '维持':[0.95,1.05], '增肌':[1.05,1.15]};
var GOAL_PROTEIN = {'减脂':[1.6,2.0], '维持':[1.2,1.6], '增肌':[1.6,2.2]};

function computeTargets(p){
  var base = 10*p.weight + 6.25*p.height - 5*p.age + (p.sex==='男' ? 5 : -161);
  var bmr = {min:Math.round(base*0.92), max:Math.round(base*1.08)};
  var coef = ACTIVITY[p.activity] || 1.375;
  var tdeeBase = base*coef;
  var tdee = {min:Math.round(bmr.min*coef), max:Math.round(bmr.max*coef)};
  var gb = GOAL_BAND[p.goal] || GOAL_BAND['维持'];
  var band = {min:Math.round(tdeeBase*gb[0]), max:Math.round(tdeeBase*gb[1])};
  var floorApplied = false;
  if (band.min < bmr.min) { band.min = bmr.min; floorApplied = true; }
  var gp = GOAL_PROTEIN[p.goal] || GOAL_PROTEIN['维持'];
  var protein = {min:Math.round(gp[0]*p.weight), max:Math.round(gp[1]*p.weight)};
  return {bmr:bmr, tdee:tdee, tdeeBase:Math.round(tdeeBase), band:band, floorApplied:floorApplied, protein:protein, coef:coef};
}

/* ---------- 饮食记录 ---------- */
var Diet = (function(){
  function mealRange(food, portion){
    return {
      kcal: scaleRange(food.kcal, portion),
      protein: scaleRange(food.protein, portion),
      cost: scaleRange(food.costYuan, portion)
    };
  }
  function addMeal(foodId, portion, slot){
    var st = Store.get();
    st.meals.push({id:uid(), at:Date.now(), date:todayStr(), foodId:foodId, portion:portion, slot:slot});
    Store.save();
  }
  function removeMeal(id){
    var st = Store.get();
    st.meals = st.meals.filter(function(m){ return m.id!==id; });
    Store.save();
  }
  function todayMeals(){
    var st = Store.get(), t = todayStr();
    return st.meals.filter(function(m){ return m.date===t; });
  }
  function consumed(meals){
    var sum = {kcal:{min:0,max:0}, protein:{min:0,max:0}, cost:{min:0,max:0}};
    meals.forEach(function(m){
      var f = foodById(m.foodId);
      if (!f) return;
      var r = mealRange(f, m.portion);
      sum.kcal = addRange(sum.kcal, r.kcal);
      sum.protein = addRange(sum.protein, r.protein);
      sum.cost = addRange(sum.cost, r.cost);
    });
    return sum;
  }
  function remaining(band, consumedKcal){
    return {min: band.min - consumedKcal.max, max: band.max - consumedKcal.min};
  }
  function recentFoodIds(days){
    var st = Store.get(), cutoff = Date.now() - days*86400000;
    var ids = {};
    st.meals.forEach(function(m){ if (m.at >= cutoff) ids[m.foodId] = true; });
    return ids;
  }
  return {mealRange:mealRange, addMeal:addMeal, removeMeal:removeMeal, todayMeals:todayMeals,
          consumed:consumed, remaining:remaining, recentFoodIds:recentFoodIds};
})();

function foodById(id){
  for (var i=0;i<FOODS.length;i++) if (FOODS[i].id===id) return FOODS[i];
  return null;
}
function exerciseById(id){
  for (var i=0;i<EXERCISES.length;i++) if (EXERCISES[i].id===id) return EXERCISES[i];
  return null;
}

/* ---------- 食谱引擎：先筛选、后打散 ---------- */
var Recipe = (function(){
  function mulberry32(seed){
    var a = seed >>> 0;
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function filterItems(scene, avoid){
    var out = [];
    FOODS.forEach(function(f){
      if (f.scene.indexOf(scene) < 0) return;
      if (avoid.indexOf('素食') >= 0 && f.allergenTags.indexOf('素食') < 0) return;
      for (var i=0;i<avoid.length;i++){
        var a = avoid[i];
        if (a!=='素食' && f.allergenTags.indexOf(a) >= 0) return;
      }
      out.push(f);
    });
    return out;
  }
  function combosFrom(items, effBudget){
    /* 粗筛只用宽松绝对上限；真正的预算约束在三餐总价判断上 */
    var cap = Math.max(15, effBudget*0.6);
    var bySlot = {'早':[], '午':[], '晚':[]};
    items.forEach(function(f){
      if (f.costYuan.min > cap) return;
      f.slot.forEach(function(s){ bySlot[s].push(f); });
    });
    var combos = [];
    bySlot['早'].forEach(function(a){
      bySlot['午'].forEach(function(b){
        if (b.id===a.id) return;
        bySlot['晚'].forEach(function(c){
          if (c.id===a.id || c.id===b.id) return;
          combos.push({
            items:{'早':a, '午':b, '晚':c},
            kcal: addRange(addRange(a.kcal,b.kcal),c.kcal),
            protein: addRange(addRange(a.protein,b.protein),c.protein),
            cost: addRange(addRange(a.costYuan,b.costYuan),c.costYuan)
          });
        });
      });
    });
    return combos;
  }
  function feasible(combos, effBudget, band, proteinMin){
    return combos.filter(function(c){
      return c.kcal.min <= band.max && c.kcal.max >= band.min &&
             c.protein.min >= proteinMin &&
             c.cost.max <= effBudget;
    });
  }
  function scoreCombo(c, effBudget, band){
    var km = mid(c.kcal), pm = mid(c.protein), cm = mid(c.cost);
    var density = pm / km * 100;
    var p = Math.min(1, density/12);
    var cost = 1 - Math.min(1, cm/effBudget);
    var half = (band.max - band.min)/2 || 1;
    var fit = clamp(1 - Math.abs(km - (band.min+band.max)/2)/half, 0, 1);
    return {p:p, c:cost, f:fit, total:0.5*p + 0.3*cost + 0.2*fit, density:density};
  }

  function generate(opts){
    var scene = opts.scene, budget = opts.budget, avoid = opts.avoid || [];
    var targets = opts.targets, seed = opts.seed || 1;
    if (!scene) return {ok:false, error:'请先选择就餐场景（食堂 / 宿舍 / 外卖）'};
    var sceneName = SCENE_LABEL[scene];
    var items = filterItems(scene, avoid);
    var slots = {'早':[], '午':[], '晚':[]};
    items.forEach(function(f){ f.slot.forEach(function(s){ slots[s].push(f); }); });
    for (var i=0;i<SLOT_LABEL.length;i++){
      var sl = SLOT_LABEL[i];
      if (slots[sl].length===0) {
        return {ok:false, emptySlot:sl,
          error: sceneName+'的'+sl+'餐在你的忌口下没有可用选项'+(avoid.length?'（当前忌口：'+avoid.join('、')+'）':'')+'，请调整忌口或换个场景。'};
      }
    }
    var band = {min:targets.band.min, max:targets.band.max};
    var proteinMin = targets.protein.min;
    var effBudget = budget;
    var notes = [];
    var pool = feasible(combosFrom(items, effBudget), effBudget, band, proteinMin);

    var steps = [
      function(){ effBudget = Math.round(budget*1.2); notes.push('已放宽：预算上浮 20%'); },
      function(){ effBudget = Math.round(budget*1.5); notes.push('已放宽：预算上浮 50%'); },
      function(){ band = {min:Math.round(band.min*0.85), max:Math.round(band.max*1.15)}; notes.push('已放宽：热量带左右各扩 15%'); },
      function(){ proteinMin = Math.round(proteinMin*0.85); notes.push('已放宽：蛋白下限降至 0.85 倍'); }
    ];
    for (var s=0; s<steps.length && pool.length===0; s++){
      steps[s]();
      pool = feasible(combosFrom(items, effBudget), effBudget, band, proteinMin);
    }
    if (pool.length===0) {
      /* 自适应：按该场景满足热量与蛋白约束的最低可行成本放宽预算 */
      var all = combosFrom(items, 1e9).filter(function(c){
        return c.kcal.min <= band.max && c.kcal.max >= band.min && c.protein.min >= proteinMin;
      });
      if (all.length>0) {
        var minCost = Math.min.apply(null, all.map(function(c){ return c.cost.max; }));
        if (minCost > effBudget) {
          var newB = Math.ceil(minCost);
          notes.push('已放宽：预算从 '+Math.round(effBudget)+' 元放宽到 '+newB+' 元（'+sceneName+'三餐最低可行成本约 '+newB+' 元）');
          effBudget = newB;
          pool = feasible(combosFrom(items, effBudget), effBudget, band, proteinMin);
        }
      }
    }
    if (pool.length===0) {
      return {ok:false,
        error:'在【'+sceneName+'】+【当前忌口：'+(avoid.length?avoid.join('、'):'无')+'】下没有可用组合，请放宽忌口或换个场景。'};
    }
    /* 近三天去重：只作候选池排序偏好，不做硬排除 */
    var recent = Diet.recentFoodIds(3);
    pool.forEach(function(c){
      c.overlap = ['早','午','晚'].filter(function(sl){ return recent[c.items[sl].id]; }).length;
      c.sc = scoreCombo(c, effBudget, band);
    });
    pool.sort(function(a,b){ return b.sc.total - a.sc.total || a.overlap - b.overlap; });
    var candidates = pool.slice(0,6);
    if (candidates.every(function(c){ return c.overlap>0; })) {
      notes.push('近三天已把可用组合用完，这一轮允许复现');
    }
    /* 用种子打散候选池顺序，再按索引轮转取一组：
       保证「换一套」相邻两次必不同（池≥3 三次互异，池 2 交替，池 1 恒定） */
    var rnd = mulberry32(seed);
    for (var k=candidates.length-1;k>0;k--){
      var j=Math.floor(rnd()*(k+1)); var tmp=candidates[k]; candidates[k]=candidates[j]; candidates[j]=tmp;
    }
    if (candidates.length===1) notes.push('该约束下只有这一套');
    return {
      ok:true, candidates:candidates, index:0, notes:notes, poolSize:candidates.length, seed:seed,
      effBudget:effBudget, band:band, proteinMin:proteinMin, scene:scene
    };
  }
  /* 取候选池中第 index 组的展示字段 */
  function view(res, index){
    var c = res.candidates[index % res.candidates.length];
    return {items:c.items, kcal:c.kcal, protein:c.protein, cost:c.cost, scores:c.sc};
  }
  function savePlan(res){
    var st = Store.get();
    var v = view(res, res.index||0);
    st.plans.push({id:uid(), at:Date.now(), date:todayStr(), scene:res.scene,
      items:[v.items['早'].id, v.items['午'].id, v.items['晚'].id]});
    Store.save();
  }
  return {generate:generate, view:view, savePlan:savePlan, mulberry32:mulberry32};
})();

/* ---------- 本地问询：规则引擎，硬边界 ---------- */
var Ask = (function(){
  var BLOCK_REPLY = '这属于医学判断，建议就医。本工具只做训练与饮食的记录和估算，不提供诊断、用药、康复或能否运动的结论。';
  var UNIMPL_REPLY = '这个能力当前未实现，能力状态为「规划」。具体原因见说明页的能力状态表。本工具现在只做记录、区间估算与约束式食谱，不假装具备未实现的能力。';
  var FALLBACK = '这个问题我答不出。我只会算以下四类（均为估算，以区间表述）：\n1. 今天/本周还能吃多少\n2. 本周练了几次、总组数、总容量\n3. 下一组怎么调\n4. 今天吃什么搭配（需先选就餐场景）';

  function hit(q, words){
    for (var i=0;i<words.length;i++) if (q.indexOf(words[i])>=0) return words[i];
    return null;
  }
  function answer(q, ctx){
    q = (q||'').trim();
    if (!q) return {text:'请输入问题。'+FALLBACK, kind:'fallback'};
    if (hit(q, MEDICAL_WORDS)) return {text:BLOCK_REPLY, kind:'block'};
    if (hit(q, UNIMPL_WORDS)) return {text:UNIMPL_REPLY, kind:'unimpl'};

    var st = Store.get(), t = computeTargets(st.profile);

    if (/下一组|怎么调|降重|加重|休息多久|恢复/.test(q)) {
      var ev = Training.lastEval();
      if (!ev) return {text:'还没有恢复自评记录。先在训练页完成一轮组间休息并生成自评，我才能引用它给出下一组建议。以上为估算口径。', kind:'ok'};
      var lines = ['最近一次恢复自评（'+dateStr(ev.at)+'）：档位「'+ev.tier+'」。'];
      if (ev.rt && ev.rt.valid>0) {
        lines.push('依据：本人平均反应时 '+Math.round(ev.rt.avg)+' ms'+(ev.baselineUsed?'，本人近期基线 '+ev.baseline+' ms':'（历史不足 3 次，未与基线比较）')+'；主观疲劳 RPE '+ev.rpe+'。');
      } else {
        lines.push('依据：该次没有反应时数据，仅主观疲劳 RPE '+ev.rpe+'。');
      }
      if (ev.tier==='偏低') lines.push('建议：下一组休息 '+(st.profile.restSec+30)+' 秒（默认 '+st.profile.restSec+' 秒）。是否采用由你决定。');
      else if (ev.tier==='一般' && ev.slowVsBaseline) lines.push('建议：下一组降重 5%–10%（上一组重量 × 0.92）。是否采用由你决定。');
      else lines.push('建议：维持当前计划即可。');
      lines.push('反应时不是生理恢复的可靠测量，只反映注意力与神经唤醒的粗略状态，且受设备影响，仅供参考，你可以不采纳。');
      return {text:lines.join('\n'), kind:'ok'};
    }

    if (/吃什么|搭配|食谱|推荐吃/.test(q)) {
      if (!ctx.scene) return {text:'先选就餐场景（食堂 / 宿舍 / 外卖），我才能按场景筛搭配。场景必须由你声明，我不会替你默认。', kind:'needScene'};
      var res = Recipe.generate({scene:ctx.scene, budget:st.recipePrefs.budget||30, avoid:st.recipePrefs.avoid||[], targets:t, seed:Date.now()%100000});
      if (!res.ok) return {text:res.error, kind:'ok'};
      var rv = Recipe.view(res, 0);
      var l = ['按【'+SCENE_LABEL[ctx.scene]+'】+ 预算 '+(st.recipePrefs.budget||30)+' 元 + 忌口（'+((st.recipePrefs.avoid||[]).join('、')||'无')+'）筛选，先约束后打散：'];
      ['早','午','晚'].forEach(function(sl){ l.push(sl+'餐：'+rv.items[sl].name+'（'+fmtRange(rv.items[sl].kcal,'kcal')+'）'); });
      l.push('三餐合计 '+fmtRange(rv.kcal,'kcal')+'，蛋白 '+fmtRange(rv.protein,'g')+'，成本 '+fmtRange(rv.cost,'元')+'。');
      if (res.notes.length) l.push(res.notes.join('；')+'。');
      l.push('以上为估算区间，不是精确测量。');
      return {text:l.join('\n'), kind:'ok'};
    }

    if (/练了几次|训练几次|总组数|容量|本周练|练了多少|训练记录/.test(q)) {
      var ws = Training.weekStats();
      var ss = Training.allSessions().filter(function(s){ return s.startedAt >= (function(){var d=new Date();d.setHours(0,0,0,0);var day=(d.getDay()+6)%7;d.setDate(d.getDate()-day);return d.getTime();})(); });
      var l2 = ['本周（周一起）训练 '+ws.trainCount+' 次，总组数 '+ws.totalSets+' 组，总容量 '+ws.volume+' kg（重量×次数之和，重量为 0 的组只计组数）。'];
      ss.slice(-5).forEach(function(s){
        var names = {};
        s.sets.forEach(function(x){ var e=exerciseById(x.exercise); if(e) names[e.name]=(names[e.name]||0)+1; });
        var parts = Object.keys(names).map(function(n){ return n+' '+names[n]+' 组'; });
        l2.push(dateStr(s.startedAt)+'：'+(parts.length?parts.join('、'):'仅休息记录')+'；休息 '+s.rests.filter(function(r){return !r.skipped;}).length+' 次'+(s.rests.filter(function(r){return r.skipped;}).length?'，跳过 '+s.rests.filter(function(r){return r.skipped;}).length+' 次':'')+'。');
      });
      if (ws.avgRestSec!=null) l2.push('平均休息时长 '+ws.avgRestSec+' 秒（跳过不计入）。');
      l2.push('组数、容量、休息时长为实测量；如有热量相关均为估算区间。');
      return {text:l2.join('\n'), kind:'ok'};
    }

    if (/还能吃|能吃多少|热量|缺口|今天吃|本周吃|吃了多少/.test(q)) {
      var meals = Diet.todayMeals();
      var cons = Diet.consumed(meals);
      var rem = Diet.remaining(t.band, cons.kcal);
      var l3 = ['今日目标带 '+fmtRange(t.band,'kcal')+'（估算）。'];
      if (meals.length===0) l3.push('今天还没有记录任何一餐。');
      else {
        var names = meals.map(function(m){ var f=foodById(m.foodId); return m.slot+'餐 '+(f?f.name:'未知条目')+'×'+m.portion; });
        l3.push('已记录：'+names.join('；')+'。');
        l3.push('已摄入 '+fmtRange(cons.kcal,'kcal')+'，蛋白 '+fmtRange(cons.protein,'g')+'。');
      }
      if (rem.max < 0) l3.push('已超出目标带上限 '+fmtRange({min:-rem.max,max:-rem.min},'kcal')+'。');
      else if (rem.min < 0) l3.push('剩余空间约 0–'+Math.round(rem.max)+' kcal（区间跨零，按下限口径已接近目标）。');
      else l3.push('今天还能吃 '+fmtRange(rem,'kcal')+'。');
      l3.push('蛋白目标 '+fmtRange(t.protein,'g')+'。所有数字为估算区间，不是精确测量。');
      return {text:l3.join('\n'), kind:'ok'};
    }

    return {text:FALLBACK, kind:'fallback'};
  }
  return {answer:answer, BLOCK_REPLY:BLOCK_REPLY};
})();

/* ---------- 搬运码与 JSON：UTF-8 安全 base64，两层校验 ---------- */
var Sync = (function(){
  var PREFIX = 'ZTXY1.';
  function bytesToB64(bytes){
    var bin = '';
    for (var i=0;i<bytes.length;i+=8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i+8192));
    return btoa(bin);
  }
  function b64ToBytes(b64){
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function payloadFrom(st){
    return {v:1, exportedAt:Date.now(), profile:st.profile, settings:st.settings,
            sessions:st.sessions, meals:st.meals, plans:st.plans, draft:st.draft,
            recipePrefs:st.recipePrefs, askScene:st.askScene};
  }
  function validPayload(p){
    if (!p || typeof p!=='object') return false;
    if (!p.profile || typeof p.profile.weight!=='number' || typeof p.profile.restSec!=='number') return false;
    if (!Array.isArray(p.sessions) || !Array.isArray(p.meals)) return false;
    for (var i=0;i<p.sessions.length;i++){
      var s = p.sessions[i];
      if (!s || !Array.isArray(s.sets) || !Array.isArray(s.rests)) return false;
    }
    for (var j=0;j<p.meals.length;j++){
      var m = p.meals[j];
      if (!m || typeof m.foodId!=='string' || typeof m.portion!=='number') return false;
    }
    return true;
  }
  function encode(){
    var json = JSON.stringify(payloadFrom(Store.get()));
    return PREFIX + bytesToB64(new TextEncoder().encode(json));
  }
  function decode(code){
    try {
      code = (code||'').trim();
      if (code.indexOf(PREFIX)!==0) return null;
      var json = new TextDecoder().decode(b64ToBytes(code.slice(PREFIX.length)));
      var p = JSON.parse(json);
      return validPayload(p) ? p : null;
    } catch(e) { return null; }
  }
  function exportJSON(){ return JSON.stringify(payloadFrom(Store.get()), null, 2); }
  function parseJSON(text){
    try { var p = JSON.parse(text); return validPayload(p) ? p : null; }
    catch(e){ return null; }
  }
  var FAIL_MSG = '这段搬运码不完整或版本不符，未导入';
  return {encode:encode, decode:decode, exportJSON:exportJSON, parseJSON:parseJSON, FAIL_MSG:FAIL_MSG, PREFIX:PREFIX};
})();

/* ---------- 今日四件事 ---------- */
function todayChecklist(){
  var ts = Training.todaySessions();
  var st = Store.get(), t = todayStr();
  var trainDone = ts.some(function(s){ return s.sets.length>0; });
  var restDone = ts.some(function(s){ return s.rests.some(function(r){ return !r.skipped && r.rpe; }); });
  var mealDone = st.meals.some(function(m){ return m.date===t; });
  var planDone = st.plans.some(function(p){ return p.date===t; });
  return [
    {label:'完成一次训练', done:trainDone},
    {label:'完成一轮组间休息并生成自评', done:restDone},
    {label:'记录一餐', done:mealDone},
    {label:'生成一套食谱', done:planDone}
  ];
}