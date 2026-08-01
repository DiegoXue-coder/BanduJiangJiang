// 阶段十二：知识图谱 v1——替换"关联主题"扁平列表。
//
// 2026-07-30五次重做：react-native-svg + reanimated这条路线（球面投影、
// 恒星行星展开、居中数学……这些设计本身都保留）在真机上反复出现"一拖拽
// 就黑屏、零报错"——排查过计算量、触摸系统冲突、babel插件版本，逐一
// 修过一轮都没解决，最后一次真机复测确认是纯黑屏+零JS报错，说明问题
// 很可能出在reanimated worklet跑的那条独立UI线程被拖死了、连错误都
// 报不出来，不是某一行代码写错。查过资料确认"D3这类力导向图/复杂
// 可视化直接放WebView里用Canvas画，比用原生组件硬翻译一遍更靠谱"这个
// 做法在业内是有真实产品验证过的（不是取巧），而且这个App本身已经在
// 大量用react-native-webview（EPUB阅读器），不是新增技术栈。
//
// 这次把整个图谱的渲染+手势判定都搬进一个WebView，用纯Canvas 2D+原生
// JS事件（不经过react-native-svg，也不经过reanimated的UI线程worklet），
// 从根上避开了这一整类问题。球面投影/连通分量分级/恒星行星环绕展开/
// 居中数学，这些逻辑照抄自决策层之前在独立HTML效果图里反复验证过的
// 版本，不是重新设计。真正的原生交互只剩两件事：单击/双击命中测试后
// 通过postMessage把"点中了什么"告诉React Native，原生这边再弹出跟
// 之前完全一样的详情卡片（NodeDetailModal/EdgeDetailModal，未改动，
// 卡片本身的完整来源数据只在原生这层查，不会进WebView）。
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, TouchableOpacity,
  Pressable, ScrollView,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useFocusEffect } from '@react-navigation/native';
import { getConceptGraph } from '../lib/api';
import { useTheme } from '../theme';
import { FONTS } from '../fonts';

// 深色星空感背景是图谱区域自己固定的视觉风格，不跟随App的亮色/暗色主题
// 切换——星空氛围本身就该是暗的，跟着切成亮色反而破坏设计意图。
const SPACE_BG = '#12141F';

function escapeForScriptTag(json) {
  // 防御性转义：JSON字符串里如果恰好出现"</script"这个子串（哪怕概率
  // 极低，比如某条概念标签literal包含这几个字符），会提前把внешний
  // <script>标签截断，把后面本该是JS代码的内容当成HTML解析。
  return json.replace(/<\/script/gi, '<\\/script');
}

// 生成知识图谱这个页面完整的独立HTML——球面投影/恒星行星分级/展开环/
// 居中数学，全部照抄决策层验证过的HTML效果图版本，只做了三处改动：
// 1) 数据从写死的两份对比数据集，换成真实从API拉到的nodes/edges
// 2) 去掉效果图专用的手机边框/背景纸张/模式切换/数据集切换这些对比
//    demo才需要的UI外壳，只留图谱本体，铺满整个WebView
// 3) 单击命中节点/连线之后，不再在HTML里自己画一张卡片，改成
//    postMessage告诉原生"点中了谁"，弹窗交给原生的Modal组件处理
function buildGraphHtml(nodes, edges) {
  const nodesJson = escapeForScriptTag(JSON.stringify(nodes));
  const edgesJson = escapeForScriptTag(JSON.stringify(edges));
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body { margin:0; padding:0; width:100%; height:100%; background:${SPACE_BG}; overflow:hidden;
    -webkit-user-select:none; user-select:none; touch-action:none; }
  #screen { position:relative; width:100%; height:100%; }
  canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
  .hint { position:absolute; top:10px; left:0; right:0; text-align:center; font-size:11px;
    color:rgba(255,255,255,.5); letter-spacing:.02em; pointer-events:none;
    font-family:-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
</style>
</head>
<body>
<div id="screen">
  <canvas id="cv"></canvas>
  <div class="hint" id="hint"></div>
</div>
<script>
(function(){
  var NODES_RAW = ${nodesJson};
  var EDGES_RAW = ${edgesJson};
  var CAT_COLOR = { "儒家":"#e0b15c", "道家":"#7fc9b8", "墨家":"#a48fd1", "其他":"#8b96ac" };
  var STAR_COLOR = 'rgba(255,255,255,0.18)';

  var screenEl = document.getElementById('screen');
  var cv = document.getElementById('cv');
  var ctx = cv.getContext('2d');
  var hintEl = document.getElementById('hint');
  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var W, H;

  function resize(){
    var r = screenEl.getBoundingClientRect();
    W = r.width; H = r.height;
    cv.width = W * DPR; cv.height = H * DPR;
    ctx.setTransform(DPR,0,0,DPR,0,0);
  }
  resize();
  window.addEventListener('resize', resize);

  function post(msg){
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }

  var nodeRadius = function(n){ return 10 + Math.min(n.size, 8) * 2.5; };

  var stars = [];
  for (var i=0;i<70;i++){ stars.push({x:Math.random(), y:Math.random(), r:0.5+Math.random()}); }

  // ---------- 恒星/行星分级：用真实关联边算连通分量，每个分量里连接
  // 数最多的当"恒星"，其余是它的"行星"（零关联的孤立节点自己就是没
  // 有行星的恒星）----------
  var byId = {};
  NODES_RAW.forEach(function(n){ byId[n.id]=n; });

  var N = NODES_RAW.length;
  var golden = Math.PI * (3 - Math.sqrt(5));
  NODES_RAW.forEach(function(n, i){
    var y = N>1 ? 1 - (i / (N - 1)) * 2 : 0;
    var rY = Math.sqrt(Math.max(0, 1 - y*y));
    var theta = golden * i;
    n.ux = Math.cos(theta) * rY; n.uy = y; n.uz = Math.sin(theta) * rY;
  });

  var parent = {}; NODES_RAW.forEach(function(n){ parent[n.id]=n.id; });
  function find(x){ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; }
  function union(a,b){ var ra=find(a), rb=find(b); if(ra!==rb) parent[ra]=rb; }
  var degree = {}; NODES_RAW.forEach(function(n){ degree[n.id]=0; });
  EDGES_RAW = EDGES_RAW.filter(function(e){ return byId[e.source] && byId[e.target]; });
  EDGES_RAW.forEach(function(e){
    union(e.source, e.target);
    degree[e.source]=(degree[e.source]||0)+1; degree[e.target]=(degree[e.target]||0)+1;
  });
  var componentMembers = {};
  NODES_RAW.forEach(function(n){ var r=find(n.id); (componentMembers[r]=componentMembers[r]||[]).push(n.id); });
  Object.keys(componentMembers).forEach(function(root){
    var members = componentMembers[root];
    var hub = members.reduce(function(best,id){
      if (best===null) return id;
      if (degree[id] > degree[best]) return id;
      if (degree[id] === degree[best] && byId[id].size > byId[best].size) return id;
      return best;
    }, null);
    members.forEach(function(id){ byId[id].starId = hub; byId[id].isStar = (id===hub); });
  });
  function hasPlanets(n){ return n.isStar && componentMembers[find(n.id)].length > 1; }

  // ---------- 交互状态 ----------
  var globe = { rotY:0.4, rotX:-0.25, zoom:1, velY:0, velX:0 };
  var dragging = false, lastX=0, lastY=0, moved=false;
  var moveHistory = []; // 最近~120ms内的滑动采样，抬手时用它算真实的"甩"速度
  var pointers = {};
  var pinchStartDist = 0, pinchStartZoom = 1;
  var pendingSingle = null; // 单击延迟触发的定时器状态，等一小段时间看有没有第二下跟上再决定是单击还是双击
  var DOUBLE_TAP_MS = 300;
  var focusedStarId = null;

  hintEl.textContent = '拖动旋转星球 · 双指缩放 · 单击看含义 · 双击展开/聚焦';

  // ---------- 展开态：把行星摆到恒星旁边的固定环上 ----------
  function applyOrbitOverride(all){
    if (!focusedStarId) return;
    var star = byId[focusedStarId];
    if (!star || star._sx===undefined) return;
    var planets = all.filter(function(n){ return !n.isStar && n.starId===focusedStarId; });
    var n = planets.length;
    planets.forEach(function(p, i){
      var angle = (i/n)*Math.PI*2 - Math.PI/2;
      // 展开环半径跟着globe.zoom缩放：之前是固定像素值，双击聚焦后哪怕
      // 用户再用双指继续放大，行星和恒星之间的连线间距完全不会变化，
      // 挤在一起很难精确点中某一条线。改成跟zoom挂钩后，放大能真正把
      // 行星之间的连线拉开，用户可以自己缩放到方便点击的程度。
      var radius = (star._sr + 46) * globe.zoom;
      p._sx = star._sx + Math.cos(angle)*radius;
      p._sy = star._sy + Math.sin(angle)*radius*0.9;
      p._sr = Math.max(9, nodeRadius(p)*0.5);
      p._op = 1; p._depth = 1; p._ambient = false;
    });
  }

  function drawStars(){
    ctx.fillStyle = STAR_COLOR;
    stars.forEach(function(s){
      ctx.beginPath(); ctx.arc(s.x*W, s.y*H, s.r, 0, Math.PI*2); ctx.fill();
    });
  }

  function hexToRgba(hex, a){
    var r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
    return 'rgba('+r+','+g+','+b+','+a+')';
  }

  function draw(){
    ctx.clearRect(0,0,W,H);
    drawStars();
    var cx=W/2, cy=H/2;
    var R = Math.min(W,H)*0.34*globe.zoom;
    var cosY=Math.cos(globe.rotY), sinY=Math.sin(globe.rotY);
    var cosX=Math.cos(globe.rotX), sinX=Math.sin(globe.rotX);

    var projected = NODES_RAW.map(function(n){
      var x1 = n.ux*cosY + n.uz*sinY;
      var z1 = -n.ux*sinY + n.uz*cosY;
      var y2 = n.uy*cosX - z1*sinX;
      var z2 = n.uy*sinX + z1*cosX;
      var depth = z2;
      var ambient = !n.isStar && n.starId!==focusedStarId;
      var s = (0.32 + 0.78 * ((depth+1)/2)) * (ambient ? 0.4 : 1);
      var op = (0.12 + 0.85 * ((depth+1)/2)) * (ambient ? 0.4 : 1);
      var sx = cx + x1*R, sy = cy + y2*R;
      var sr = nodeRadius(n) * s * 0.62;
      n._sx=sx; n._sy=sy; n._sr=sr; n._depth=depth; n._op=op; n._ambient=ambient;
      return n;
    });
    applyOrbitOverride(projected);
    projected.sort(function(a,b){ return a._depth - b._depth; });

    ctx.lineWidth = 1;
    EDGES_RAW.forEach(function(e){
      var a=byId[e.source], b=byId[e.target];
      if(!a||!b) return;
      var avgDepth = (a._depth+b._depth)/2;
      if (avgDepth < -0.6) return;
      var bright = a.id===focusedStarId || b.id===focusedStarId;
      var alpha = Math.max(0, (bright?0.42:0.12) * ((avgDepth+1)/2));
      ctx.strokeStyle = 'rgba(200,195,220,' + alpha + ')';
      ctx.lineWidth = bright ? 1.4 : 0.8;
      ctx.beginPath(); ctx.moveTo(a._sx,a._sy); ctx.lineTo(b._sx,b._sy); ctx.stroke();
    });

    projected.forEach(function(n){
      if (hasPlanets(n) && n.id!==focusedStarId){
        ctx.beginPath();
        ctx.strokeStyle = hexToRgba(CAT_COLOR[n.category]||CAT_COLOR['其他'], n._op*0.55);
        ctx.lineWidth = 1.5;
        ctx.arc(n._sx, n._sy, Math.max(1.5,n._sr)+4, 0, Math.PI*2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.fillStyle = hexToRgba(CAT_COLOR[n.category]||CAT_COLOR['其他'], n._op);
      ctx.arc(n._sx, n._sy, Math.max(1,n._sr), 0, Math.PI*2);
      ctx.fill();
      if (n._depth > 0.55 && !n._ambient){
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,' + Math.min(0.9,n._op+0.1) + ')';
        ctx.textAlign = 'center';
        ctx.fillText(n.label, n._sx, n._sy + n._sr + 12);
      }
    });
  }

  function tick(){
    if (!dragging){
      if (Math.abs(globe.velY) > 0.0002 || Math.abs(globe.velX) > 0.0002){
        globe.rotY += globe.velY;
        globe.rotX += globe.velX;
        globe.velY *= 0.985; globe.velX *= 0.985;
      }
    }
    draw();
    requestAnimationFrame(tick);
  }
  draw();
  requestAnimationFrame(tick);

  // ---------- 命中测试：先测节点，没点中节点再测连线（点到线段距离） ----------
  function hitTestNode(px, py){
    var best=null, bestD=Infinity;
    NODES_RAW.forEach(function(n){
      if (n._depth < -0.15 && n._depth !== 1) return;
      var dx=px-n._sx, dy=py-n._sy;
      var d = Math.sqrt(dx*dx+dy*dy);
      var hitR = Math.max(14,n._sr)+6;
      if (d < hitR && d < bestD){ bestD=d; best=n; }
    });
    return best;
  }
  function distToSegment(px, py, x1, y1, x2, y2){
    var dx=x2-x1, dy=y2-y1;
    var lenSq = dx*dx+dy*dy;
    var t = lenSq > 0 ? ((px-x1)*dx + (py-y1)*dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    var cx=x1+t*dx, cy=y1+t*dy;
    var ddx=px-cx, ddy=py-cy;
    return Math.sqrt(ddx*ddx+ddy*ddy);
  }
  function hitTestEdge(px, py){
    // 防误触：没有恒星被双击展开时，连线一律不可点——一条边两端节点
    // 必然属于同一个恒星（并查集分组决定的），所以这条限制不会导致
    // 任何一条边永远点不到，只是要求用户先双击展开它所属的那个恒星。
    if (!focusedStarId) return null;
    var best=null, bestD=Infinity;
    EDGES_RAW.forEach(function(e){
      var a=byId[e.source], b=byId[e.target];
      if(!a||!b) return;
      if (a.starId!==focusedStarId) return;
      var d = distToSegment(px, py, a._sx, a._sy, b._sx, b._sy);
      if (d < 22 && d < bestD){ bestD=d; best=e; }
    });
    return best;
  }

  function focusNode(n){
    var mag = Math.sqrt(n.ux*n.ux + n.uz*n.uz) || 0.0001;
    var targetRotY = Math.atan2(-n.ux, n.uz);
    var targetRotX = Math.atan2(n.uy, mag);
    var deltaY = normalizeAngle(targetRotY - globe.rotY);
    animateVal(function(v){ globe.rotY=v; }, globe.rotY, globe.rotY+deltaY, 420);
    animateVal(function(v){ globe.rotX=v; }, globe.rotX, targetRotX, 420);
    animateVal(function(v){ globe.zoom=v; }, globe.zoom, 2.6, 420);
  }
  function collapseToOverview(){
    focusedStarId = null;
    animateVal(function(v){ globe.zoom=v; }, globe.zoom, 1, 380);
  }
  function normalizeAngle(a){ while(a>Math.PI) a-=Math.PI*2; while(a<-Math.PI) a+=Math.PI*2; return a; }
  function animateVal(setter, from, to, dur){
    var start=performance.now();
    function step(now){
      var p = Math.min(1, (now-start)/dur);
      var e = 1 - Math.pow(1-p, 3);
      setter(from + (to-from)*e);
      if (p<1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function dist(p1,p2){ var dx=p1.x-p2.x, dy=p1.y-p2.y; return Math.sqrt(dx*dx+dy*dy); }

  screenEl.addEventListener('pointerdown', function(e){
    try { screenEl.setPointerCapture(e.pointerId); } catch(err) {}
    var rect = screenEl.getBoundingClientRect();
    pointers[e.pointerId] = { x:e.clientX-rect.left, y:e.clientY-rect.top };
    var ids = Object.keys(pointers);
    if (ids.length===1){
      dragging=true; moved=false;
      lastX=pointers[e.pointerId].x; lastY=pointers[e.pointerId].y;
      globe.velY=0; globe.velX=0;
      moveHistory = [{x:lastX, y:lastY, t:performance.now()}];
    } else if (ids.length===2){
      var p1=pointers[ids[0]], p2=pointers[ids[1]];
      pinchStartDist = dist(p1,p2);
      pinchStartZoom = globe.zoom;
    }
  });

  screenEl.addEventListener('pointermove', function(e){
    if (!pointers[e.pointerId]) return;
    var rect = screenEl.getBoundingClientRect();
    var nx = e.clientX-rect.left, ny = e.clientY-rect.top;
    var ids = Object.keys(pointers);

    if (ids.length===2){
      pointers[e.pointerId] = {x:nx,y:ny};
      var p1=pointers[ids[0]], p2=pointers[ids[1]];
      var d = dist(p1,p2);
      var ratio = d / Math.max(1,pinchStartDist);
      globe.zoom = Math.max(0.6, Math.min(3.2, pinchStartZoom*ratio));
      return;
    }

    pointers[e.pointerId] = {x:nx,y:ny};
    if (!dragging) return;
    var dx = nx-lastX, dy = ny-lastY;
    if (Math.abs(dx)+Math.abs(dy) > 3) moved = true;
    globe.rotY += dx*0.008;
    globe.rotX -= dy*0.008; // 竖直方向不再夹角度限制，跟水平一样能整圈转
    lastX=nx; lastY=ny;
    var now = performance.now();
    moveHistory.push({x:nx, y:ny, t:now});
    var cutoff = now - 120;
    while (moveHistory.length>1 && moveHistory[0].t < cutoff) moveHistory.shift();
  });

  function cancelPendingSingle(){
    if (pendingSingle){ clearTimeout(pendingSingle.timer); pendingSingle = null; }
  }

  function fireSingleTap(hitNode, hitEdge){
    if (hitNode) post({ type:'node', id: hitNode.id });
    else if (hitEdge) post({ type:'edge', source: hitEdge.source, target: hitEdge.target });
    else post({ type:'close' });
  }

  function fireDoubleTap(hitNode){
    if (!hitNode){
      collapseToOverview();
    } else if (hasPlanets(hitNode)){
      if (focusedStarId===hitNode.id){ collapseToOverview(); }
      else { focusedStarId=hitNode.id; focusNode(hitNode); }
    } else {
      focusNode(hitNode);
    }
    draw();
  }

  function endPointer(e){
    delete pointers[e.pointerId];
    var ids = Object.keys(pointers);
    if (ids.length < 2) { pinchStartDist = 0; }
    if (dragging && ids.length===0){
      dragging=false;
      if (moved && moveHistory.length>=2){
        // 用抬手前最近~120ms的采样算真实的"轻扫"速度，而不是只看最后
        // 一帧的位移（抬手前经常已经在减速，导致惯性起不来）。上限
        // MAX_SPIN 保证甩得再用力也不会转特别快，配合tick()里更慢的
        // 衰减率，做出"太空中失重缓慢漂"的手感，而不是快速转完就停。
        var latest = moveHistory[moveHistory.length-1];
        var earliest = moveHistory[0];
        var dt = Math.max(1, latest.t-earliest.t);
        var vx = (latest.x-earliest.x)/dt;
        var vy = (latest.y-earliest.y)/dt;
        var MAX_SPIN = 0.014;
        globe.velY = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, vx*0.02));
        globe.velX = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, -vy*0.02));
      }
      if (!moved){
        var hitNode = hitTestNode(lastX,lastY);
        var hitEdge = hitNode ? null : hitTestEdge(lastX,lastY);

        // 单击不立刻触发：先等 DOUBLE_TAP_MS 看有没有第二下点在同一个
        // 目标上跟上来。没跟上，超时后才真正当作单击弹卡片；跟上了，
        // 说明是双击，取消这次单击、直接走双击逻辑（聚焦/展开/收起），
        // 避免双击的第一下就已经把解释卡片弹出来的问题。
        if (pendingSingle && pendingSingle.hitNode===hitNode && pendingSingle.hitEdge===hitEdge){
          cancelPendingSingle();
          fireDoubleTap(hitNode);
        } else {
          cancelPendingSingle();
          pendingSingle = {
            hitNode: hitNode,
            hitEdge: hitEdge,
            timer: setTimeout(function(){
              fireSingleTap(hitNode, hitEdge);
              pendingSingle = null;
            }, DOUBLE_TAP_MS),
          };
        }
      }
    }
  }
  screenEl.addEventListener('pointerup', endPointer);
  screenEl.addEventListener('pointercancel', endPointer);
})();
</script>
</body>
</html>`;
}

function NodeDetailModal({ node, theme, onClose }) {
  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.55)' }]} onPress={onClose} />
      <View pointerEvents="box-none" style={styles.modalWrap}>
        <View style={[styles.modalCard, { backgroundColor: theme.cardBg, borderRadius: theme.radius, borderColor: theme.cardBorder }]}>
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: theme.text }]} numberOfLines={1}>{node.label}</Text>
            <TouchableOpacity onPress={onClose} style={styles.modalCloseBtn}>
              <Text style={[styles.modalCloseText, { color: theme.textSecondary }]}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modalBody} showsVerticalScrollIndicator={false}>
            {(node.sources || []).map((s, i) => (
              <View
                key={i}
                style={[styles.sourceItem, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.cardBorder }]}
              >
                <Text style={[styles.sourceBook, { color: theme.accent }]}>{s.book_title}</Text>
                <Text style={[styles.sourceExcerpt, { color: theme.text }]}>"{s.excerpt}"</Text>
                {!!s.explanation && (
                  <Text style={[styles.sourceExplain, { color: theme.textSecondary }]}>{s.explanation}</Text>
                )}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </View>
  );
}

function EdgeDetailModal({ edge, nodeA, nodeB, theme, onClose }) {
  const sideCard = (node, explanation) => (
    <View style={[styles.mindmapCard, { backgroundColor: theme.bg, borderColor: theme.cardBorder, borderRadius: theme.radius }]}>
      <Text style={[styles.mindmapLabel, { color: theme.text }]} numberOfLines={1}>{node?.label || ''}</Text>
      <Text style={[styles.mindmapExplain, { color: theme.textSecondary }]}>{explanation}</Text>
      {!!node?.sources?.length && (
        <Text style={[styles.mindmapSource, { color: theme.textMuted }]} numberOfLines={2}>
          {node.sources[0].book_title} · "{node.sources[0].excerpt}"
        </Text>
      )}
    </View>
  );

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.55)' }]} onPress={onClose} />
      <View pointerEvents="box-none" style={styles.modalWrap}>
        <View style={[styles.modalCard, { backgroundColor: theme.cardBg, borderRadius: theme.radius, borderColor: theme.cardBorder }]}>
          <TouchableOpacity onPress={onClose} style={styles.modalCloseBtnAbs}>
            <Text style={[styles.modalCloseText, { color: theme.textSecondary }]}>✕</Text>
          </TouchableOpacity>
          <View style={[styles.commonPointBox, { backgroundColor: theme.accentSoft, borderRadius: theme.radius }]}>
            <Text style={[styles.commonPointText, { color: theme.accent }]}>{edge.common_point}</Text>
          </View>
          <View style={styles.mindmapRow}>
            {sideCard(nodeA, edge.explanation_a)}
            {sideCard(nodeB, edge.explanation_b)}
          </View>
        </View>
      </View>
    </View>
  );
}

export default function ConceptGraph() {
  const theme = useTheme();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await getConceptGraph();
      setData(d);
    } catch (e) {
      setError(e.message || '加载失败');
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // fullById留着完整来源数据（node.sources），点击弹窗要用；WebView里那份
  // 只带投影/分级要用的精简字段，两份数据分开，完整来源文本不会被塞进
  // WebView的HTML字符串里增加体积。
  const fullById = useMemo(() => {
    const m = {};
    (data?.nodes || []).forEach((n) => { m[n.id] = n; });
    return m;
  }, [data]);

  const html = useMemo(() => {
    if (!data || data.nodes.length === 0) return null;
    const liteNodes = data.nodes.map((n) => ({ id: n.id, label: n.label, size: n.size, category: n.category }));
    return buildGraphHtml(liteNodes, data.edges);
  }, [data]);

  const onWebViewMessage = useCallback((event) => {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); } catch (e) { return; }
    if (msg.type === 'node') {
      setSelectedEdge(null);
      setSelectedNode(fullById[msg.id] || null);
    } else if (msg.type === 'edge') {
      const edge = (data?.edges || []).find((e) => e.source === msg.source && e.target === msg.target);
      setSelectedNode(null);
      setSelectedEdge(edge || null);
    } else if (msg.type === 'close') {
      setSelectedNode(null);
      setSelectedEdge(null);
    }
  }, [fullById, data]);

  if (data === null && !error) {
    return (
      <View style={[styles.centerBox, { backgroundColor: SPACE_BG }]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.centerBox, { backgroundColor: SPACE_BG }]}>
        <Text style={[styles.errorText, { color: '#E39B90' }]}>加载失败：{error}</Text>
        <TouchableOpacity style={[styles.retryBtn, { backgroundColor: theme.accent, borderRadius: theme.radius }]} onPress={load}>
          <Text style={{ color: theme.textOnAccent, fontWeight: '600' }}>重试</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (data.nodes.length === 0) {
    return (
      <View style={[styles.centerBox, { backgroundColor: SPACE_BG }]}>
        <Text style={styles.emptyText}>
          暂时还没有提炼出概念{'\n'}多划线、多提问，AI 会帮你梳理出思想脉络
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: SPACE_BG }]}>
      {html && (
        <WebView
          key={data.nodes.length + '-' + data.edges.length}
          style={{ flex: 1, backgroundColor: SPACE_BG }}
          originWhitelist={['*']}
          source={{ html }}
          onMessage={onWebViewMessage}
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        />
      )}

      {selectedNode && (
        <NodeDetailModal node={selectedNode} theme={theme} onClose={() => setSelectedNode(null)} />
      )}
      {selectedEdge && (
        <EdgeDetailModal
          edge={selectedEdge}
          nodeA={fullById[selectedEdge.source]}
          nodeB={fullById[selectedEdge.target]}
          theme={theme}
          onClose={() => setSelectedEdge(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, width: '100%' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 12 },
  emptyText: { color: 'rgba(255,255,255,0.55)', fontSize: 14, textAlign: 'center', lineHeight: 22 },
  errorText: { fontSize: 14, textAlign: 'center' },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 10 },

  backdrop: { ...StyleSheet.absoluteFillObject },
  modalWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: {
    width: '100%', maxHeight: '80%', borderWidth: 1,
    padding: 16,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  modalTitle: { fontSize: 17, fontWeight: '700', flex: 1 },
  modalCloseBtn: { padding: 4, marginLeft: 8 },
  modalCloseBtnAbs: { position: 'absolute', top: 10, right: 10, padding: 6, zIndex: 1 },
  modalCloseText: { fontSize: 16 },
  modalBody: { maxHeight: 360 },

  sourceItem: { paddingVertical: 10 },
  sourceBook: { fontSize: 12, fontWeight: '700', marginBottom: 4 },
  sourceExcerpt: { fontSize: 14, lineHeight: 21, fontStyle: 'italic', fontFamily: FONTS.serifRegular, marginBottom: 4 },
  sourceExplain: { fontSize: 12, lineHeight: 18 },

  commonPointBox: { padding: 12, marginBottom: 14, marginTop: 8 },
  commonPointText: { fontSize: 14, fontWeight: '700', textAlign: 'center', lineHeight: 20 },
  mindmapRow: { flexDirection: 'row', gap: 10 },
  mindmapCard: { flex: 1, borderWidth: 1, padding: 10 },
  mindmapLabel: { fontSize: 13, fontWeight: '700', marginBottom: 6 },
  mindmapExplain: { fontSize: 12, lineHeight: 18, marginBottom: 6 },
  mindmapSource: { fontSize: 10, lineHeight: 14, fontFamily: FONTS.serifRegular },
});
