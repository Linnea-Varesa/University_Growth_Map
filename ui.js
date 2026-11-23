/* 智体校园 · 界面层：单页内部路由 + 组间休息引擎状态机。
   计时一律用绝对时间戳；小游戏与倒计时并行。无 console 调试输出。 */
'use strict';

function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function $(sel, root){ return (root||document).querySelector(sel); }
function $all(sel, root){ return Array.prototype.slice.call((root||document).querySelectorAll(sel)); }

var toastTimer = null;
function toast(msg){
  var t = $('#toast');
  t.textContent = msg; t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.hidden = true; }, 2600);
}
function saveOrWarn(){
  if (!Store.save()) toast('本地存储不可用（可能处于隐私模式），本次改动未持久化');
}

/* 状态标记 */
function mark(status){
  if (status==='ok') return '<span class="mark ok">可用</span>';
  if (status==='plan') return '<span class="mark plan">规划</span>';
  return '<span class="mark est">估算</span>';
}

/* ===================== 组间休息引擎 ===================== */
var Engine = (function(){
  var S = {
    phase:'idle', endAt:0, plannedSec:0, startedAt:0,
    attempt:0, validTimes:[], falseStarts:0, gState:'idle', greenAt:0,
    waitTimer:null, greenTimer:null, betweenTimer:null, lastMs:null, lastInvalid:false,
    rpe:null, rt:null
  };
  var Suggest = {restOverride:null, weightOverride:null, bar:null};
  var RING_C = 2*Math.PI*52;

  function clearTimers(){
    if (S.waitTimer) clearTimeout(S.waitTimer);
    if (S.greenTimer) clearTimeout(S.greenTimer);
    if (S.betweenTimer) clearTimeout(S.betweenTimer);
    S.waitTimer=S.greenTimer=S.betweenTimer=null;
  }
  function remainingSec(){ return Math.max(0, (S.endAt - Date.now())/1000); }

  function startRest(sec){
    var st = Store.get();
    Training.ensureSession();
    S.phase='resting';
    S.plannedSec=sec; S.startedAt=Date.now(); S.endAt=Date.now()+sec*1000;
    S.attempt=0; S.validTimes=[]; S.falseStarts=0; S.lastMs=null; S.lastInvalid=false;
    S.rpe=null; S.rt=null;
    mount();
    nextAttempt();
  }
  function nextAttempt(){
    S.attempt++;
    if (S.attempt>5) { finishGame(); return; }
    S.gState='waiting'; S.lastInvalid=false;
    paintGame();
    var wait = 800 + Math.random()*1400;
    S.waitTimer = setTimeout(turnGreen, wait);
  }
  function turnGreen(){
    if (S.phase!=='resting') return;
    S.gState='green'; S.greenAt=performance.now();
    paintGame();
    S.greenTimer = setTimeout(function(){ registerInvalid('超时'); }, 2000);
  }
  function registerInvalid(reason){
    if (S.greenTimer) clearTimeout(S.greenTimer);
    S.falseStarts++; S.lastInvalid=true; S.lastMs=null;
    S.gState='between';
    paintGame(reason==='超时'?'超时，这一轮不计':'抢跑了，这一轮不计');
    S.betweenTimer = setTimeout(nextAttempt, 650);
  }
  function onZone(){
    if (S.phase!=='resting') return;
    if (S.gState==='waiting') {
      if (S.waitTimer) clearTimeout(S.waitTimer);
      registerInvalid('抢跑');
    } else if (S.gState==='green') {
      if (S.greenTimer) clearTimeout(S.greenTimer);
      var ms = Math.round(performance.now()-S.greenAt);
      S.validTimes.push(ms); S.lastMs=ms; S.lastInvalid=false;
      S.gState='between';
      paintGame();
      S.betweenTimer = setTimeout(nextAttempt, 500);
    }
  }
  function finishGame(){
    clearTimers();
    if (S.validTimes.length>0) {
      var sum=S.validTimes.reduce(function(a,b){return a+b;},0);
      S.rt = {avg:sum/S.validTimes.length, min:Math.min.apply(null,S.validTimes),
              valid:S.validTimes.length, falseStarts:S.falseStarts, rounds:S.validTimes.slice()};
    } else {
      S.rt = {avg:null, min:null, valid:0, falseStarts:S.falseStarts, rounds:[]};
    }
    S.gState='done'; S.phase='eval';
    mount();
  }
  function abortGame(){
    clearTimers();
    S.rt = {avg:null, min:null, valid:0, falseStarts:S.falseStarts, rounds:[], aborted:true};
    S.gState='done'; S.phase='eval';
    mount();
  }
  function addTime(){ S.endAt += 30000; S.plannedSec += 30; paintCountdown(); }
  function skipRest(){
    clearTimers();
    var elapsed = S.phase==='idle' ? 0 : Math.round((Date.now()-S.startedAt)/1000);
    Training.addRest({id:uid(), at:Date.now(), plannedSec:S.plannedSec||Store.get().profile.restSec,
      actualSec:elapsed, skipped:true, rt:null, rpe:null, score:null, tier:null});
    saveOrWarn();
    S.phase='idle'; Suggest.bar=null;
    mount();
    toast('已记为跳过休息（不计入平均休息时长）');
    renderTrainBody();
  }
  function submitEval(){
    if (S.rpe==null) { toast('请先选择主观疲劳度 RPE'); return; }
    var avg = (S.rt && S.rt.valid>0) ? S.rt.avg : null;
    var baseline = Training.baselineHistory();
    var res = recoveryScore(avg, S.rpe, baseline);
    var elapsed = Math.round((Date.now()-S.startedAt)/1000);
    var rec = {id:uid(), at:Date.now(), plannedSec:S.plannedSec, actualSec:elapsed,
      skipped:false, rt:S.rt, rpe:S.rpe, score:res.score, tier:res.tier,
      baselineUsed:res.baselineUsed, baseline:res.baseline, slowVsBaseline:res.slowVsBaseline};
    Training.addRest(rec);
    buildSuggestion(res, avg);
    saveOrWarn();
    clearTimers();
    S.phase='idle';
    mount();
    renderTrainBody();
    toast('已保存恢复自评：'+res.tier);
  }
  function buildSuggestion(res, avg){
    var st = Store.get();
    Suggest.bar=null; Suggest.restOverride=null; Suggest.weightOverride=null;
    if (res.tier==='偏低') {
      var sec = st.profile.restSec + 30;
      Suggest.bar = {type:'rest', sec:sec,
        text:'建议下一组休息 '+sec+' 秒（默认 '+st.profile.restSec+' 秒）'};
    } else if (res.tier==='一般' && res.slowVsBaseline) {
      var lastW = lastSetWeight();
      if (lastW>0) {
        var nw = Math.round(lastW*0.92*2)/2;
        Suggest.bar = {type:'weight', weight:nw, lastWeight:lastW,
          text:'建议下一组降重 5%–10%（下一组默认 '+nw+' kg，较上一组 −8%）'};
      }
    }
  }
  function adoptSuggestion(){
    if (!Suggest.bar) return;
    var st = Store.get();
    if (Suggest.bar.type==='rest') {
      if (!st.settings.suggestAdjust) { toast('设置中已关闭「按自评调整休息时长」，仅显示建议'); return; }
      Suggest.restOverride = Suggest.bar.sec;
      toast('已采用：下一组休息 '+Suggest.bar.sec+' 秒（仅生效一次）');
    } else {
      Suggest.weightOverride = Suggest.bar.weight;
      toast('已采用：下一组默认重量 '+Suggest.bar.weight+' kg，可手动改回');
    }
    Suggest.bar.adopted=true;
    mount();
  }
  function lastSetWeight(){
    var d = Store.get().draft;
    if (d && d.sets.length) return d.sets[d.sets.length-1].weight;
    var ss = Training.allSessions();
    for (var i=ss.length-1;i>=0;i--){ var s=ss[i]; if(s.sets.length) return s.sets[s.sets.length-1].weight; }
    return 0;
  }
  function consumeRestOverride(){
    var v = Suggest.restOverride; Suggest.restOverride=null; return v;
  }
  function consumeWeightOverride(){
    var v = Suggest.weightOverride; Suggest.weightOverride=null; return v;
  }

  /* ---- 渲染 ---- */
  function ringHTML(){
    return '<div class="ring-box"><svg width="118" height="118" viewBox="0 0 118 118">'
      + '<circle cx="59" cy="59" r="52" fill="none" stroke="#2b3547" stroke-width="9"/>'
      + '<circle id="cd-ring" cx="59" cy="59" r="52" fill="none" stroke="#a3e635" stroke-width="9" '
      + 'stroke-linecap="round" stroke-dasharray="'+RING_C+'" stroke-dashoffset="0"/>'
      + '</svg><div class="ring-txt"><div class="t num" id="cd-time">--</div>'
      + '<div class="p num" id="cd-plan"></div></div></div>';
  }
  function paintCountdown(){
    var timeEl=$('#cd-time'), ringEl=$('#cd-ring'), planEl=$('#cd-plan');
    if (!timeEl) return;
    var rem = remainingSec();
    timeEl.textContent = fmtClock(rem);
    if (planEl) planEl.textContent = '计划 '+S.plannedSec+' 秒';
    if (ringEl) {
      var frac = S.plannedSec>0 ? clamp(rem/S.plannedSec,0,1) : 0;
      ringEl.setAttribute('stroke-dashoffset', String(RING_C*(1-frac)));
      ringEl.setAttribute('stroke', rem<=10 ? '#f87171' : '#a3e635');
    }
  }
  function dotsHTML(){
    var h='<div class="dots">';
    for (var i=1;i<=5;i++){
      var cls='';
      if (i<S.attempt || (i===S.attempt && S.gState==='between')) {
        cls = S.validTimes.length>=i ? 'done' : 'bad';
      } else if (i===S.attempt && S.gState!=='done') cls='cur';
      h+='<i class="'+cls+'"></i>';
    }
    return h+'</div>';
  }
  function paintGame(msg){
    var z=$('#game-zone'); if(!z) return;
    z.className='game-zone '+(S.gState==='waiting'?'wait':S.gState==='green'?'go':'');
    var main, sub='';
    if (S.gState==='waiting') main='等待变绿…';
    else if (S.gState==='green') main='现在点击！';
    else if (S.gState==='between') main = msg || (S.lastMs!=null ? S.lastMs+' ms' : '这一轮不计');
    else main='';
    var meta='第 '+Math.min(S.attempt,5)+' / 5 轮 · 抢跑 '+S.falseStarts+' 次'
      + (S.lastMs!=null?' · 上一轮 '+S.lastMs+' ms':'');
    z.innerHTML = '<div class="gz-main">'+esc(main)+'</div>'
      + (S.gState==='green'?'<div class="gz-ms num">点击</div>':'')
      + '<div class="aux">'+esc(meta)+'</div>'+dotsHTML();
  }
  function limitationHTML(){
    return '<div class="limit">反应时不是生理恢复的可靠测量，只反映注意力与神经唤醒的粗略状态，且受设备影响，仅供参考，你可以不采纳。</div>';
  }

  function mount(){
    var box=$('#engine-box'); if(!box) return;
    var st=Store.get();
    if (S.phase==='idle') {
      var last=Training.lastEval();
      var sec = Suggest.restOverride || st.profile.restSec;
      var h='<h2>组间休息引擎</h2>';
      if (Suggest.bar && !Suggest.bar.adopted) {
        h+='<div class="suggest"><div class="s-txt">'+esc(Suggest.bar.text)+'</div>'
          + '<div class="row mt"><button class="btn small primary" id="adopt-btn" type="button">采用</button>'
          + '<span class="aux">仅生效一次，不自动改你的配置</span></div></div>';
      }
      h+='<button class="btn primary big" id="start-rest" type="button">开始 '+sec+' 秒休息</button>'
        + '<div class="row mt"><button class="btn ghost small" id="skip-rest" type="button">跳过休息</button>'
        + '<span class="aux">跳过会被单独统计，不计入平均休息时长</span></div>';
      if (last) {
        h+='<div class="mt aux">上次提示：档位「'+esc(last.tier)+'」'
          + (last.rt&&last.rt.valid>0?'，平均反应时 '+Math.round(last.rt.avg)+' ms':'，无反应时数据')
          + '，RPE '+last.rpe+'</div>'+limitationHTML();
      }
      box.innerHTML=h;
      $('#start-rest').onclick=function(){ var s=consumeRestOverride()||st.profile.restSec; startRest(s); };
      $('#skip-rest').onclick=skipRest;
      var ab=$('#adopt-btn'); if(ab) ab.onclick=adoptSuggestion;
      return;
    }
    if (S.phase==='resting') {
      box.innerHTML='<h2>休息中 · 倒计时与小游戏并行</h2>'
        + '<div class="rest-wrap">'+ringHTML()
        + '<div class="aux">倒计时归零前完成 5 轮反应时测试。<br>整块区域可点，手机不用瞄准。</div></div>'
        + '<div id="game-zone" class="game-zone wait"></div>'
        + '<div class="row mt"><button class="btn small" id="add-time" type="button">+30 秒</button>'
        + '<button class="btn small ghost" id="abort-game" type="button">中止小游戏</button>'
        + '<button class="btn small ghost" id="skip-rest" type="button">跳过休息</button></div>'
        + limitationHTML();
      $('#game-zone').onclick=onZone;
      $('#add-time').onclick=addTime;
      $('#abort-game').onclick=abortGame;
      $('#skip-rest').onclick=skipRest;
      paintCountdown(); paintGame();
      return;
    }
    if (S.phase==='eval') {
      var rt=S.rt, hasRT = rt && rt.valid>0;
      var h2='<h2>恢复自评</h2><div class="rest-wrap">'+ringHTML()
        + '<div class="aux">倒计时仍在走，可继续等，也可直接开始下一组。</div></div>';
      if (hasRT) {
        h2+='<div class="grid two mt">'
          + '<div class="card stat"><div class="v num">'+Math.round(rt.avg)+'</div><div class="k">平均反应时 ms</div></div>'
          + '<div class="card stat"><div class="v num">'+rt.min+'</div><div class="k">最快 ms</div></div>'
          + '<div class="card stat"><div class="v num">'+rt.valid+'</div><div class="k">有效轮数</div></div>'
          + '<div class="card stat"><div class="v num">'+rt.falseStarts+'</div><div class="k">抢跑次数</div></div></div>';
      } else {
        h2+='<div class="note-blue mt">本次没有有效反应时数据，只能记录主观疲劳'+(rt&&rt.aborted?'（已中止小游戏）':'')+'。分数只反映主观疲劳，不参与基线更新。</div>';
      }
      h2+='<div class="field mt"><label>主观疲劳度 RPE（6 = 还能再做两个）</label><div class="seg" id="rpe-seg">'
        + [4,5,6,7,8,9].map(function(n){ return '<button type="button" data-rpe="'+n+'" class="num">'+n+'</button>'; }).join('')
        + '</div></div>'
        + '<button class="btn primary big" id="submit-eval" type="button">生成恢复自评并保存</button>'
        + '<div class="row mt"><button class="btn ghost small" id="next-set" type="button">不评了，开始下一组</button>'
        + '<button class="btn ghost small" id="skip-rest" type="button">跳过休息</button></div>'
        + limitationHTML();
      box.innerHTML=h2;
      $all('#rpe-seg button').forEach(function(b){
        b.onclick=function(){ S.rpe=parseInt(b.getAttribute('data-rpe'),10);
          $all('#rpe-seg button').forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); };
      });
      $('#submit-eval').onclick=submitEval;
      $('#next-set').onclick=function(){ clearTimers(); S.phase='idle'; mount(); };
      $('#skip-rest').onclick=skipRest;
      paintCountdown();
      return;
    }
  }
  function tick(){ if (S.phase==='resting'||S.phase==='eval') paintCountdown(); }
  function getSuggest(){ return Suggest; }
  function getPhase(){ return S.phase; }
  return {mount:mount, tick:tick, startRest:startRest, getSuggest:getSuggest, getPhase:getPhase,
          consumeWeightOverride:consumeWeightOverride, skipRest:skipRest};
})();

/* ===================== 页面 ===================== */
var currentPage='today';
var entryOpenedAt=Date.now();
var chatLog=[];
var recipeResult=null, recipeSeed=1;

function go(page){
  currentPage=page;
  $all('.tab').forEach(function(t){ t.classList.toggle('on', t.getAttribute('data-page')===page); });
  $('#btn-settings').classList.toggle('on', page==='settings');
  render();
  window.scrollTo(0,0);
}
function render(){
  Training.checkAutoArchive();
  var p=$('#page');
  if (currentPage==='today') p.innerHTML=viewToday();
  else if (currentPage==='train') { p.innerHTML=viewTrain(); entryOpenedAt=Date.now(); Engine.mount(); bindTrain(); }
  else if (currentPage==='diet') { p.innerHTML=viewDiet(); bindDiet(); }
  else if (currentPage==='recipe') { p.innerHTML=viewRecipe(); bindRecipe(); }
  else if (currentPage==='ask') { p.innerHTML=viewAsk(); bindAsk(); }
  else if (currentPage==='about') p.innerHTML=viewAbout();
  else if (currentPage==='settings') { p.innerHTML=viewSettings(); bindSettings(); }
}

/* ---- 今天 ---- */
function viewToday(){
  var s7=Training.last7Stats();
  var meals=Diet.todayMeals(); var cons=Diet.consumed(meals);
  var list=todayChecklist();
  var plans=CAPABILITIES.filter(function(c){return c.status==='plan';}).slice(0,3);
  var h='<div class="hero"><div class="claim">健身应用都在争夺你训练的那一小时。<br>真正被浪费的，是这一小时里的<em>空白</em>。</div>'
    + '<div class="why">每两组之间那六十到一百二十秒，你拿起手机，注意力被信息流带走，下一组往后推了三五分钟。这段时间不留下任何东西。</div>'
    + '<button class="btn primary big mt" id="hero-start" type="button">开始一次训练</button></div>';
  h+='<div class="grid">'
    + '<div class="card stat"><div class="v num">'+s7.trainCount+'</div><div class="k">近 7 天训练次数</div></div>'
    + '<div class="card stat"><div class="v num">'+s7.restCount+'</div><div class="k">休息次数（跳过 '+s7.skipped+'）</div></div>'
    + '<div class="card stat"><div class="v num">'+(s7.avgRestSec!=null?s7.avgRestSec+'s':'—')+'</div><div class="k">平均休息时长</div></div>'
    + '<div class="card stat"><div class="v num kcal-line" style="font-size:20px">'+(meals.length?Math.round(cons.kcal.min)+'–'+Math.round(cons.kcal.max):'—')+'</div><div class="k">今日饮食 kcal（估算）</div></div>'
    + '</div>';
  h+='<div class="card mt"><h2>今天四件事</h2>'
    + list.map(function(it){ return '<div class="check'+(it.done?' done':'')+'"><span class="box">'+(it.done?'✓':'')+'</span><span class="lbl">'+esc(it.label)+'</span><span class="pill '+(it.done?'ok':'')+'">'+(it.done?'已完成':'未完成')+'</span></div>'; }).join('')
    + '</div>';
  h+='<div class="card"><h2>能力状态摘要</h2>'
    + plans.map(function(c){ return '<div class="list-item row spread"><span>'+esc(c.name)+'</span>'+mark('plan')+'</div>'; }).join('')
    + '<div class="aux mt">全部 14 项见说明页。可用=绿圆点，规划=蓝菱点，估算=琥珀方点。</div>'
    + '<button class="btn small ghost mt" id="goto-about" type="button">查看说明页</button></div>';
  return h;
}

/* ---- 训练 ---- */
function viewTrain(){
  return '<div class="card" id="engine-box"></div>'
    + '<div class="card" id="entry-box"></div>'
    + '<div class="card" id="session-box"></div>'
    + '<div class="card" id="history-box"></div>';
}
function renderTrainBody(){ renderEntry(); renderSession(); renderHistory(); }
function bindTrain(){ renderTrainBody(); }

function renderEntry(){
  var box=$('#entry-box'); if(!box) return;
  var st=Store.get(); var d=st.draft;
  var last = d&&d.sets.length ? d.sets[d.sets.length-1] : null;
  var wOverride = Engine.getSuggest().weightOverride;
  var defW = wOverride!=null ? wOverride : (last?last.weight:EXERCISES[0].defWeight);
  var defEx = last?last.exercise:EXERCISES[0].id;
  var defReps = last?last.reps:8;
  var defRpe = last?last.rpe:6;
  var h='<h2>本次训练录入</h2><div class="aux">默认重复上一组，只需改一个数字。重量填 0 = 只记组数不记重量。</div>'
    + (wOverride!=null?'<div class="note-blue">已按建议降重：默认 '+wOverride+' kg（较上一组 −8%），可手动改回。</div>':'')
    + '<div class="field mt"><label>动作</label><select class="inp" id="ex-sel">'
    + EXERCISES.map(function(e){ return '<option value="'+e.id+'"'+(e.id===defEx?' selected':'')+'>'+esc(e.name)+'</option>'; }).join('')+'</select></div>'
    + '<div class="grid two"><div class="field"><label>重量 kg</label><input class="inp num" id="w-inp" type="number" inputmode="decimal" min="0" step="0.5" value="'+defW+'"></div>'
    + '<div class="field"><label>次数</label><input class="inp num" id="r-inp" type="number" inputmode="numeric" min="1" value="'+defReps+'"></div></div>'
    + '<div class="field"><label>主观疲劳 RPE</label><div class="seg" id="entry-rpe">'
    + [4,5,6,7,8,9].map(function(n){ return '<button type="button" data-r="'+n+'" class="num'+(n===defRpe?' on':'')+'">'+n+'</button>'; }).join('')+'</div></div>'
    + '<div class="row spread"><button class="btn primary" id="save-set" type="button">记一组</button>'
    + '<span class="aux num" id="entry-timer">已用 0 秒</span></div>'
    + '<div class="aux mt" id="entry-hint" hidden>我们把默认值都填好了，改一个数字就能记。</div>';
  box.innerHTML=h;
  var rpe=defRpe;
  $all('#entry-rpe button').forEach(function(b){
    b.onclick=function(){ rpe=parseInt(b.getAttribute('data-r'),10);
      $all('#entry-rpe button').forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); };
  });
  $('#save-set').onclick=function(){
    var ex=$('#ex-sel').value;
    var w=parseFloat($('#w-inp').value); if(isNaN(w)||w<0) w=0;
    var reps=parseInt($('#r-inp').value,10); if(isNaN(reps)||reps<1) reps=1;
    Training.addSet(ex, w, reps, rpe);
    Engine.consumeWeightOverride();
    saveOrWarn();
    entryOpenedAt=Date.now();
    toast('已记录一组');
    renderTrainBody();
  };
}
function renderSession(){
  var box=$('#session-box'); if(!box) return;
  var d=Store.get().draft;
  var h='<div class="row spread"><h2>本次训练</h2>'
    + (d&&d.sets.length?'<button class="btn small danger" id="end-session" type="button">结束训练</button>':'')+'</div>';
  if (!d || (d.sets.length===0&&d.rests.length===0)) {
    h+='<div class="aux">还没有记录。记一组或点上方「开始休息」即自动建立本次训练。</div>';
  } else {
    h+='<div class="aux">'+esc(d.date)+' · '+d.sets.length+' 组 · 休息 '+d.rests.filter(function(r){return !r.skipped;}).length+' 次</div>';
    d.sets.slice().reverse().forEach(function(x){
      var e=exerciseById(x.exercise);
      h+='<div class="list-item row spread"><span>'+esc(e?e.name:x.exercise)+'</span>'
        + '<span class="num">'+(x.weight>0?x.weight+' kg × '+x.reps:'只记组数 × '+x.reps)+' · RPE '+x.rpe+'</span></div>';
    });
  }
  box.innerHTML=h;
  var eb=$('#end-session');
  if (eb) eb.onclick=function(){
    var arc=Training.archiveDraft('manual'); saveOrWarn();
    toast(arc?'已结束并归档本次训练':'没有可归档的内容');
    renderTrainBody();
  };
}
function renderHistory(){
  var box=$('#history-box'); if(!box) return;
  var ss=Store.get().sessions.slice().reverse();
  var h='<h2>历史记录</h2>';
  if (!ss.length) h+='<div class="aux">暂无归档训练。结束训练或 40 分钟无操作会自动归档。</div>';
  ss.slice(0,20).forEach(function(s){
    var vol=0; s.sets.forEach(function(x){ if(x.weight>0) vol+=x.weight*x.reps; });
    var rests=s.rests.filter(function(r){return !r.skipped;}).length;
    var skip=s.rests.filter(function(r){return r.skipped;}).length;
    h+='<details><summary class="num">'+esc(s.date)+' · '+s.sets.length+' 组 · 容量 '+vol+' kg · 休息 '+rests+(skip?' · 跳过 '+skip:'')+'</summary>'
      + s.sets.map(function(x){ var e=exerciseById(x.exercise);
        return '<div class="list-item aux">'+esc(e?e.name:x.exercise)+' '+(x.weight>0?x.weight+' kg × '+x.reps:'× '+x.reps)+' RPE '+x.rpe+'</div>'; }).join('')
      + '</details>';
  });
  box.innerHTML=h;
}

/* ---- 饮食 ---- */
var dietQuery='', dietPortion=1, dietSlot='午';
function viewDiet(){
  var st=Store.get(), t=computeTargets(st.profile);
  var h='';
  if (st.profile.isDemo && !st.settings.demoBannerDismissed) {
    h+='<div class="banner"><span>当前使用演示档案（男 / 20 岁 / 175cm / 65kg / 轻度 / 维持），点此修改</span>'
      + '<span><button id="demo-edit" type="button">修改</button><button class="x" id="demo-x" type="button">×</button></span></div>';
  }
  h+='<div class="aux">热量与食谱是组间休息的输出侧延伸。</div>';
  h+='<div class="card mt"><h2>目标热量带 '+mark('est')+'</h2>'
    + '<div class="list-item row spread"><span>基础代谢 BMR</span><span class="num kcal-line">'+fmtRange(t.bmr,'kcal')+'</span></div>'
    + '<div class="list-item row spread"><span>每日消耗 TDEE</span><span class="num kcal-line">'+fmtRange(t.tdee,'kcal')+'</span></div>'
    + '<div class="list-item row spread"><span>目标摄入带（'+esc(st.profile.goal)+'）</span><span class="num kcal-line">'+fmtRange(t.band,'kcal')+'</span></div>'
    + '<div class="list-item row spread"><span>蛋白目标</span><span class="num kcal-line">'+fmtRange(t.protein,'g')+'</span></div>'
    + (t.floorApplied?'<div class="note-blue">目标带下限已被基础代谢下限约束。</div>':'')
    + '<div class="aux mt">Mifflin-St Jeor 公式 ±8% 区间，所有数字为估算。</div></div>';
  h+='<div class="card"><h2>记一餐</h2>'
    + '<div class="field"><label>搜索食物（名称 / 标签）</label><input class="inp" id="food-q" type="text" placeholder="如：米饭 / 盖饭 / 高蛋白" value="'+esc(dietQuery)+'"></div>'
    + '<div class="field"><label>餐次</label><div class="seg" id="slot-seg">'
    + ['早','午','晚'].map(function(s){ return '<button type="button" data-s="'+s+'"'+(s===dietSlot?' class="on"':'')+'>'+s+'</button>'; }).join('')+'</div></div>'
    + '<div class="field"><label>份量（离散档位，不填克数）</label><div class="seg" id="portion-seg">'
    + [[0.5,'半份'],[1,'一份'],[1.5,'一份半'],[2,'两份']].map(function(p){ return '<button type="button" data-p="'+p[0]+'"'+(p[0]===dietPortion?' class="on"':'')+'>'+p[1]+'</button>'; }).join('')+'</div></div>'
    + '<div id="food-list"></div></div>';
  h+='<div class="card" id="today-meals"></div>';
  return h;
}
function bindDiet(){
  var st=Store.get();
  var de=$('#demo-edit'); if(de) de.onclick=function(){ go('settings'); };
  var dx=$('#demo-x'); if(dx) dx.onclick=function(){ st.settings.demoBannerDismissed=true; saveOrWarn(); render(); };
  $('#food-q').oninput=function(){ dietQuery=this.value; renderFoodList(); };
  $all('#slot-seg button').forEach(function(b){ b.onclick=function(){ dietSlot=b.getAttribute('data-s');
    $all('#slot-seg button').forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); }; });
  $all('#portion-seg button').forEach(function(b){ b.onclick=function(){ dietPortion=parseFloat(b.getAttribute('data-p'));
    $all('#portion-seg button').forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); renderFoodList(); }; });
  renderFoodList(); renderTodayMeals();
}
function renderFoodList(){
  var box=$('#food-list'); if(!box) return;
  var q=dietQuery.trim().toLowerCase();
  var list=FOODS.filter(function(f){
    if (!q) return true;
    return f.name.toLowerCase().indexOf(q)>=0 || f.tags.join(' ').toLowerCase().indexOf(q)>=0;
  }).slice(0,12);
  if (!list.length) { box.innerHTML='<div class="aux">没有匹配条目。</div>'; return; }
  box.innerHTML=list.map(function(f){
    var r=Diet.mealRange(f,dietPortion);
    return '<div class="food-item"><div class="row spread"><strong>'+esc(f.name)+'</strong>'
      + '<button class="btn small primary" data-add="'+f.id+'" type="button">记录</button></div>'
      + '<div class="aux">'+esc(f.portionAnchor)+' · '+esc(f.unitLabel)+'</div>'
      + '<div class="num kcal-line">'+fmtRange(r.kcal,'kcal')+' · 蛋白 '+fmtRange(r.protein,'g')+' · '+fmtRange(r.cost,'元')+'</div>'
      + '<div class="aux">'+esc(f.errorNote)+'</div></div>';
  }).join('');
  $all('[data-add]',box).forEach(function(b){
    b.onclick=function(){ Diet.addMeal(b.getAttribute('data-add'), dietPortion, dietSlot); saveOrWarn();
      toast('已记录一餐'); renderTodayMeals(); };
  });
}
function renderTodayMeals(){
  var box=$('#today-meals'); if(!box) return;
  var st=Store.get(), t=computeTargets(st.profile);
  var meals=Diet.todayMeals(); var cons=Diet.consumed(meals); var rem=Diet.remaining(t.band,cons.kcal);
  var h='<h2>今日记录与差额 '+mark('est')+'</h2>';
  if (!meals.length) h+='<div class="aux">今天还没记录。</div>';
  meals.forEach(function(m){
    var f=foodById(m.foodId); if(!f) return;
    var r=Diet.mealRange(f,m.portion);
    h+='<div class="list-item row spread"><span>'+esc(m.slot)+' · '+esc(f.name)+' × '+m.portion+'</span>'
      + '<span class="row"><span class="num kcal-line">'+fmtRange(r.kcal,'kcal')+'</span>'
      + '<button class="btn small ghost" data-del="'+m.id+'" type="button">删</button></span></div>';
  });
  h+='<div class="list-item row spread"><span>已摄入</span><span class="num kcal-line">'+fmtRange(cons.kcal,'kcal')+'</span></div>'
    + '<div class="list-item row spread"><span>蛋白</span><span class="num kcal-line">'+fmtRange(cons.protein,'g')+'</span></div>';
  if (rem.max<0) h+='<div class="list-item row spread"><span>已超出目标带</span><span class="num neg">'+fmtRange({min:-rem.max,max:-rem.min},'kcal')+'</span></div>';
  else h+='<div class="list-item row spread"><span>还能吃</span><span class="num kcal-line">'+fmtRange({min:Math.max(0,rem.min),max:rem.max},'kcal')+'</span></div>';
  box.innerHTML=h;
  $all('[data-del]',box).forEach(function(b){ b.onclick=function(){ Diet.removeMeal(b.getAttribute('data-del')); saveOrWarn(); renderTodayMeals(); }; });
}

/* ---- 食谱 ---- */
function viewRecipe(){
  var st=Store.get(), pf=st.recipePrefs;
  var h='<div class="aux">热量与食谱是组间休息的输出侧延伸。先筛选、后打散，随机只出现在最后一步。</div>'
    + '<div class="card mt"><h2>约束</h2>'
    + '<div class="field"><label>就餐场景（必须先声明）</label><div class="seg" id="scene-seg">'
    + ['canteen','dorm','takeout'].map(function(s){ return '<button type="button" data-sc="'+s+'"'+(pf.scene===s?' class="on"':'')+'>'+SCENE_LABEL[s]+'</button>'; }).join('')+'</div></div>'
    + '<div class="field"><label>预算（元 / 天）</label><input class="inp num" id="budget-inp" type="number" inputmode="numeric" min="5" value="'+pf.budget+'"></div>'
    + '<div class="field"><label>忌口（永不放宽；选「素食」= 只推荐蛋奶素可食）</label><div class="seg" id="avoid-seg">'
    + ALLERGEN_OPTS.map(function(a){ return '<button type="button" data-a="'+a+'"'+(pf.avoid.indexOf(a)>=0?' class="on"':'')+'>'+a+'</button>'; }).join('')+'</div></div>'
    + '<button class="btn primary big" id="gen-recipe" type="button">生成三餐</button>'
    + '<div id="recipe-err"></div></div>'
    + '<div id="recipe-result"></div>';
  return h;
}
function bindRecipe(){
  var st=Store.get(), pf=st.recipePrefs;
  $all('#scene-seg button').forEach(function(b){ b.onclick=function(){
    pf.scene=b.getAttribute('data-sc'); st.askScene=pf.scene; saveOrWarn();
    $all('#scene-seg button').forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); }; });
  $('#budget-inp').onchange=function(){ var v=parseInt(this.value,10); pf.budget=(isNaN(v)||v<5)?5:v; saveOrWarn(); };
  $all('#avoid-seg button').forEach(function(b){ b.onclick=function(){
    var a=b.getAttribute('data-a'); var i=pf.avoid.indexOf(a);
    if (i>=0) pf.avoid.splice(i,1); else pf.avoid.push(a);
    b.classList.toggle('on'); saveOrWarn(); }; });
  $('#gen-recipe').onclick=function(){ recipeSeed=1; genRecipe(); };
  if (recipeResult) paintRecipeResult();
}
function genRecipe(){
  var st=Store.get(), t=computeTargets(st.profile);
  var res=Recipe.generate({scene:st.recipePrefs.scene, budget:st.recipePrefs.budget,
    avoid:st.recipePrefs.avoid, targets:t, seed:recipeSeed});
  var err=$('#recipe-err');
  if (!res.ok) { recipeResult=null; err.innerHTML='<div class="note-blue mt">'+esc(res.error)+'</div>';
    $('#recipe-result').innerHTML=''; return; }
  err.innerHTML='';
  recipeResult=res;
  Recipe.savePlan(res); saveOrWarn();
  paintRecipeResult();
}
function paintRecipeResult(){
  var box=$('#recipe-result'); if(!box||!recipeResult) return;
  var r=recipeResult; var v=Recipe.view(r, r.index);
  var h='<div class="card"><div class="row spread"><h2>这套三餐</h2>'
    + '<button class="btn small" id="swap-recipe" type="button">换一套</button></div>'
    + '<div class="aux">场景：'+SCENE_LABEL[r.scene]+' · 候选池 '+r.poolSize+' 组 · 第 '+(r.index+1)+' 组</div>';
  ['早','午','晚'].forEach(function(sl){
    var f=v.items[sl];
    h+='<div class="list-item"><div class="row spread"><strong>'+sl+' · '+esc(f.name)+'</strong>'
      + '<span class="num kcal-line">'+fmtRange(f.kcal,'kcal')+'</span></div>'
      + '<div class="aux">'+esc(f.portionAnchor)+' · 蛋白 '+fmtRange(f.protein,'g')+' · '+fmtRange(f.costYuan,'元')+'</div></div>';
  });
  h+='<div class="list-item row spread"><span>合计热量</span><span class="num kcal-line">'+fmtRange(v.kcal,'kcal')+'</span></div>'
    + '<div class="list-item row spread"><span>合计蛋白</span><span class="num kcal-line">'+fmtRange(v.protein,'g')+'</span></div>'
    + '<div class="list-item row spread"><span>合计成本</span><span class="num kcal-line">'+fmtRange(v.cost,'元')+'</span></div>';
  if (r.notes.length) h+='<div class="note-blue">'+r.notes.map(esc).join('<br>')+'</div>';
  h+='</div>';
  h+='<div class="card"><h2>为什么是这一套</h2>'
    + '<div class="score-line"><span>蛋白密度 '+v.scores.p.toFixed(2)+'</span><span class="aux">三餐蛋白约 '+Math.round(mid(v.protein))+'g，密度 '+v.scores.density.toFixed(1)+'g/100kcal</span></div>'
    + '<div class="score-line"><span>成本项 '+v.scores.c.toFixed(2)+'</span><span class="aux">总价中值占预算比例越低分越高</span></div>'
    + '<div class="score-line"><span>热量贴合 '+v.scores.f.toFixed(2)+'</span><span class="aux">三餐热量中值越接近目标带中值分越高</span></div>'
    + '<div class="score-line"><span>总分 '+v.scores.total.toFixed(2)+'</span><span class="aux">0.5×蛋白 + 0.3×成本 + 0.2×贴合</span></div>'
    + '<div class="aux mt">三项均归一化到 0–1 再加权。随机只在同分候选池里打散取一组，不参与筛选。</div></div>';
  box.innerHTML=h;
  $('#swap-recipe').onclick=function(){
    if (r.poolSize<=1) { toast('该约束下只有这一套'); return; }
    r.index=(r.index+1)%r.poolSize; paintRecipeResult();
  };
}

/* ---- 问询 ---- */
function viewAsk(){
  var st=Store.get();
  var h='<div class="card"><h2>本地问询 · 规则引擎</h2>'
    + '<div class="aux">纯前端计算，不接入任何外部模型。只会算四类问题，回答均为估算区间。涉及症状、疼痛、用药、诊断等医学问题一律硬拦截，建议就医。</div>'
    + '<div class="field mt"><label>就餐场景（与食谱页同步，「吃什么」类问题必须先选）</label><div class="seg" id="ask-scene">'
    + ['canteen','dorm','takeout'].map(function(s){ return '<button type="button" data-sc="'+s+'"'+(st.recipePrefs.scene===s?' class="on"':'')+'>'+SCENE_LABEL[s]+'</button>'; }).join('')+'</div></div></div>'
    + '<div class="card"><div class="chat" id="chat"></div>'
    + '<div class="row"><input class="inp" id="ask-inp" type="text" placeholder="输入问题…" style="flex:1">'
    + '<button class="btn primary" id="ask-send" type="button">发送</button></div>'
    + '<div class="seg mt" id="ask-examples">'
    + ['今天还能吃多少','本周练了几次','下一组怎么调','今天吃什么搭配'].map(function(q){ return '<button type="button" data-q="'+esc(q)+'">'+esc(q)+'</button>'; }).join('')
    + '</div></div>'
    + '<div class="card"><h2>它只会算这几类</h2>'
    + '<div class="aux">1. 今天/本周还能吃多少（引用已记录餐次，给区间与差额）<br>2. 本周练了几次、总组数、总容量（引用日期与动作）<br>3. 下一组怎么调（引用最近一次恢复自评）<br>4. 今天吃什么搭配（按场景与忌口筛选）<br><br>拍照识别热量、姿态识别、语音、第三方手环直连等均为「规划」，见说明页。</div></div>';
  return h;
}
function bindAsk(){
  var st=Store.get();
  $all('#ask-scene button').forEach(function(b){ b.onclick=function(){
    st.recipePrefs.scene=b.getAttribute('data-sc'); st.askScene=st.recipePrefs.scene; saveOrWarn();
    $all('#ask-scene button').forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); }; });
  function send(){
    var inp=$('#ask-inp'); var q=inp.value.trim(); if(!q) return;
    chatLog.push({who:'user', text:q});
    var res=Ask.answer(q, {scene:st.recipePrefs.scene});
    chatLog.push({who:'bot', text:res.text, kind:res.kind});
    inp.value=''; paintChat();
  }
  $('#ask-send').onclick=send;
  $('#ask-inp').onkeydown=function(e){ if(e.key==='Enter') send(); };
  $all('#ask-examples button').forEach(function(b){ b.onclick=function(){ $('#ask-inp').value=b.getAttribute('data-q'); send(); }; });
  paintChat();
}
function paintChat(){
  var box=$('#chat'); if(!box) return;
  if (!chatLog.length) { box.innerHTML='<div class="aux">问一个可算的问题，或点下方示例。</div>'; return; }
  box.innerHTML=chatLog.map(function(m){
    return '<div class="msg '+m.who+(m.kind==='block'?' block':'')+'">'+esc(m.text)+'</div>';
  }).join('');
  box.scrollTop=box.scrollHeight;
}

/* ---- 说明 ---- */
function viewAbout(){
  var h='<div class="card"><h2>能力状态表（全站唯一来源）</h2>'
    + '<div class="aux mb">可用=绿圆点 · 规划=蓝菱点 · 估算=琥珀方点。首页与各页引用同一张表。</div>'
    + '<table class="cap">';
  CAPABILITIES.forEach(function(c){
    h+='<tr><td>'+esc(c.name)+(c.why?'<div class="aux">'+esc(c.why)+'</div>':'')+'</td><td class="st">'+mark(c.status)+'</td></tr>';
  });
  h+='</table></div>';
  h+='<div class="card"><h2>边界与自我约束</h2><div class="aux">'
    + '· 不接入外部模型，前端不持有任何密钥，无任何网络请求。<br>'
    + '· 医学问题（症状/疼痛/受伤/用药/剂量/诊断/能否运动）一律硬拦截，只回就医建议，不给倾向性结论，回复不含药物名。<br>'
    + '· 热量/消耗/缺口/蛋白/成本一律区间估算；组数/次数/重量/RPE/倒计时/反应时/休息时长为实测量，精确显示。<br>'
    + '· 食谱先筛选后打散，忌口与场景永不放宽；无解时明确终态，不偷偷回退别的场景。<br>'
    + '· 未实现能力如实标「规划」，不声称已打通/已接入/已直连。</div></div>';
  h+='<div class="card"><h2>公式与来源</h2><div class="aux">'
    + '· BMR：Mifflin-St Jeor，男 10×体重+6.25×身高−5×年龄+5，女 −161；±8% 区间。<br>'
    + '· 活动系数：久坐 1.2 / 轻度 1.375 / 中等 1.55 / 高 1.725。<br>'
    + '· 目标带：减脂 TDEE×0.80–0.90，维持 ×0.95–1.05，增肌 ×1.05–1.15；下限不低于 BMR 下限。<br>'
    + '· 蛋白：减脂 1.6–2.0 / 维持 1.2–1.6 / 增肌 1.6–2.2 g/kg。<br>'
    + '· 恢复自评：score=clamp(60+反应时项+疲劳项,0,100)；反应时项=clamp((基线−本次均值)/基线×40,−25,20)；疲劳项=(6−RPE)×4，RPE 中性点为 6。基线为每次完整休息的一个平均反应时，需≥3 次历史才启用，本次不计入基线。基线不足时 score=60+疲劳项，只作参考。<br>'
    + '· 小游戏：变绿前随机等待 800–2200ms；点击超时 2000ms 记无效并计抢跑；抢跑不计入均值与最快。5 轮全无效则只按疲劳项算分，不参与基线。<br>'
    + '· 食谱评分：蛋白密度=min(1,密度/12)、成本=1−min(1,总价/预算)、热量贴合=1−|中值差|/半宽，均 clamp 0–1；总分=0.5×蛋白+0.3×成本+0.2×贴合。取前 6 组候选池按种子打散。<br>'
    + '· 食物条目：自建，量级参考《中国食物成分表（第 6 版）》，不复制原书数值；单一食材约±15%、家常菜约±25%、中式混合菜约±30% 以上。</div></div>';
  h+='<div class="card"><h2>已知局限</h2><div class="aux">'
    + '· 反应时不是生理恢复的可靠测量，只反映注意力与神经唤醒的粗略状态，受设备影响，仅供参考。<br>'
    + '· 热量链条「目测份量→条目营养×份数」三环节都在漏，所有数字是估算区间。<br>'
    + '· 搬运码只解决「同一份记录在两台设备保持一致」，不是自动采集运动数据。<br>'
    + '· 演示档案只为打开即用，不是假装知道你的身体数据，可在设置页修改。</div></div>';
  h+='<div class="card"><h2>合规说明</h2><div class="aux">'
    + '本作品不涉及诊疗行为，不采集身份信息，不上传可识别个人的资料。所有数据仅存于本机 localStorage。科普参考，不替代专业诊疗。</div></div>';
  return h;
}

/* ---- 设置 ---- */
function viewSettings(){
  var st=Store.get(), p=st.profile;
  function seg(name, opts, cur){
    return '<div class="seg" data-field="'+name+'">'+opts.map(function(o){
      return '<button type="button" data-v="'+o+'"'+(String(cur)===String(o)?' class="on"':'')+'>'+o+'</button>'; }).join('')+'</div>';
  }
  var h='<div class="card"><h2>用户档案</h2><div class="aux">改完立刻影响所有计算。演示档案只为打开即用。</div>'
    + '<div class="field mt"><label>性别（影响 BMR 常数）</label>'+seg('sex',['男','女'],p.sex)+'</div>'
    + '<div class="grid two"><div class="field"><label>年龄（14–80）</label><input class="inp num" id="set-age" type="number" inputmode="numeric" value="'+p.age+'"></div>'
    + '<div class="field"><label>身高 cm（120–230）</label><input class="inp num" id="set-height" type="number" inputmode="numeric" value="'+p.height+'"></div></div>'
    + '<div class="grid two"><div class="field"><label>体重 kg（30–200，整数）</label><input class="inp num" id="set-weight" type="number" inputmode="numeric" value="'+p.weight+'"></div>'
    + '<div class="field"><label>默认组间休息 秒（30–300）</label><input class="inp num" id="set-rest" type="number" inputmode="numeric" value="'+p.restSec+'"></div></div>'
    + '<div class="field"><label>活动水平</label>'+seg('activity',['久坐','轻度','中等','高'],p.activity)+'</div>'
    + '<div class="field"><label>目标</label>'+seg('goal',['减脂','维持','增肌'],p.goal)+'</div>'
    + '<button class="btn primary big" id="save-profile" type="button">保存档案</button></div>';
  h+='<div class="card"><h2>按自评建议调整休息时长</h2>'
    + '<div class="row spread"><span class="aux">开：自评判「偏低」时点「采用」，本次倒计时改为默认+30 秒，仅生效一次。<br>关：只显示建议文字，永远不改倒计时。</span>'
    + '<button class="btn small'+(st.settings.suggestAdjust?' primary':'')+'" id="toggle-suggest" type="button">'+(st.settings.suggestAdjust?'已开':'已关')+'</button></div></div>';
  h+='<div class="card"><h2>数据</h2>'
    + '<div class="row"><button class="btn small" id="export-json" type="button">导出 JSON</button>'
    + '<button class="btn small" id="gen-code" type="button">生成搬运码</button>'
    + '<button class="btn small danger" id="clear-data" type="button">清空本地记录</button></div>'
    + '<div class="field mt"><label>导入 JSON（粘贴）</label><textarea class="inp" id="import-json" placeholder="粘贴导出的 JSON…"></textarea>'
    + '<button class="btn small mt" id="do-import-json" type="button">导入 JSON</button></div>'
    + '<div class="field"><label>搬运码（生成 / 粘贴）</label><textarea class="inp num" id="sync-code" placeholder="点「生成搬运码」显示，或粘贴 ZTXY1. 开头的搬运码"></textarea>'
    + '<div class="row mt"><button class="btn small" id="copy-code" type="button">复制</button>'
    + '<button class="btn small" id="do-import-code" type="button">导入搬运码</button></div>'
    + '<div class="aux mt">搬运码只解决同一份记录在两台设备保持一致，不是自动采集运动数据。导入失败绝不写入部分数据、绝不清空已有记录。</div></div>'
    + '<div id="settings-msg"></div>';
  return h;
}
function bindSettings(){
  var st=Store.get(), p=st.profile;
  $all('.seg[data-field] button').forEach(function(b){
    b.onclick=function(){ var f=b.parentNode.getAttribute('data-field');
      p[f]=b.getAttribute('data-v');
      $all('button',b.parentNode).forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); };
  });
  $('#save-profile').onclick=function(){
    function num(id,lo,hi,def){ var v=parseInt($(id).value,10); return (isNaN(v)||v<lo||v>hi)?def:v; }
    p.age=num('#set-age',14,80,p.age); p.height=num('#set-height',120,230,p.height);
    p.weight=num('#set-weight',30,200,p.weight); p.restSec=num('#set-rest',30,300,p.restSec);
    p.isDemo=false;
    saveOrWarn(); toast('档案已保存，所有计算已更新');
  };
  $('#toggle-suggest').onclick=function(){ st.settings.suggestAdjust=!st.settings.suggestAdjust; saveOrWarn();
    this.textContent=st.settings.suggestAdjust?'已开':'已关'; this.classList.toggle('primary',st.settings.suggestAdjust); };
  $('#export-json').onclick=function(){
    var json=Sync.exportJSON();
    try {
      var blob=new Blob([json],{type:'application/json'});
      var url=URL.createObjectURL(blob); var a=document.createElement('a');
      a.href=url; a.download='zhitixiaoyuan-'+todayStr()+'.json'; a.click();
      setTimeout(function(){ URL.revokeObjectURL(url); },1000);
      setMsg('已导出 JSON 文件');
    } catch(e){ $('#sync-code').value=json; setMsg('下载不可用，已把 JSON 放入文本框，请手动复制'); }
  };
  $('#gen-code').onclick=function(){ $('#sync-code').value=Sync.encode(); setMsg('已生成搬运码，可复制后在另一台设备粘贴导入'); };
  $('#copy-code').onclick=function(){
    var ta=$('#sync-code'); var text=ta.value;
    if (!text) { setMsg('请先生成搬运码'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function(){ setMsg('已复制到剪贴板'); },
        function(){ ta.select(); setMsg('浏览器未允许自动复制，请手动选中文本框复制'); });
    } else { ta.select(); setMsg('请手动选中文本框复制'); }
  };
  $('#do-import-json').onclick=function(){
    var pld=Sync.parseJSON($('#import-json').value);
    if (!pld) { setMsg('JSON 不完整或格式不符，未导入'); return; }
    Store.replace(pld) ? setMsg('导入成功') : setMsg('导入成功但本地存储不可用');
    render();
  };
  $('#do-import-code').onclick=function(){
    var pld=Sync.decode($('#sync-code').value);
    if (!pld) { setMsg(Sync.FAIL_MSG); return; }
    Store.replace(pld) ? setMsg('搬运码导入成功') : setMsg('导入成功但本地存储不可用');
    render();
  };
  var clearBtn=$('#clear-data'), armed=false;
  clearBtn.onclick=function(){
    if (!armed) { armed=true; clearBtn.textContent='再次点击确认清空';
      setMsg('将清空本机所有记录。导出过的文件不受影响。再次点击确认。'); return; }
    Store.reset(); armed=false; clearBtn.textContent='清空本地记录';
    setMsg('已清空本地记录'); render();
  };
}
function setMsg(t){ var m=$('#settings-msg'); if(m) m.innerHTML='<div class="note-blue">'+esc(t)+'</div>'; }

/* ===================== 全局计时器 ===================== */
var lastArchiveCheck=0;
setInterval(function(){
  Engine.tick();
  var et=$('#entry-timer');
  if (et && currentPage==='train') {
    var sec=Math.floor((Date.now()-entryOpenedAt)/1000);
    et.textContent='已用 '+sec+' 秒';
    var hint=$('#entry-hint'); if(hint) hint.hidden = sec<=8;
  }
  if (Date.now()-lastArchiveCheck>30000) {
    lastArchiveCheck=Date.now();
    var arc=Training.checkAutoArchive();
    if (arc) { saveOrWarn(); toast('40 分钟无操作，已自动归档当前训练'); if(currentPage==='train') renderTrainBody(); }
  }
}, 250);

document.addEventListener('visibilitychange', function(){
  if (!document.hidden) { Engine.tick(); Training.checkAutoArchive(); }
});

/* ===================== 启动 ===================== */
(function init(){
  Store.load();
  Training.checkAutoArchive();
  $all('.tab').forEach(function(t){ t.onclick=function(){ go(t.getAttribute('data-page')); }; });
  $('#btn-settings').onclick=function(){ go('settings'); };
  document.addEventListener('click', function(e){
    if (e.target && e.target.id==='hero-start') go('train');
    if (e.target && e.target.id==='goto-about') go('about');
  });
  go('today');
})();