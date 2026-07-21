'use strict';

const SAVE_KEY = 'courier_save_v3';
const TIME_SCALE = 100; // game runs 100x faster than real life (testing value)
const GAME_MIN_PER_REAL_SEC = TIME_SCALE / 60;
const DAY_START_OFFSET = 8 * 60; // game clock begins at Day 1, 08:00
const MAX_OFFLINE_MS = 60 * 24 * 3600 * 1000; // cap catch-up at 60 real days
const TOAST_DURATION_MS = 10000;

const POINT_STYLES = {
  home: { color: '#e2a63b', glyph: '🏠' },
  cafe: { color: '#d98a3d', glyph: '☕' },
  shop: { color: '#8a63d2', glyph: '🛵' },
  workshop: { color: '#5c8fd6', glyph: '🔧' },
  delivery: { color: '#4a9dd1', glyph: '📦' },
};

// ---------- home city (Ривное) — the only playable city ----------

const CITY_POINTS = [
  { id: 'home', name: 'Дом', type: 'home', x: 12, y: 50 },
  { id: 'cafe', name: 'Кафе «Уют»', type: 'cafe', x: 35, y: 40 },
  { id: 'shop', name: 'Магазин техники «Скорость»', type: 'shop', x: 70, y: 28 },
  { id: 'workshop', name: 'Мастерская «Гайка»', type: 'workshop', x: 78, y: 55 },
  { id: 'warehouse', name: 'Склад «Логист»', type: 'delivery', x: 50, y: 50 },
  { id: 'mall', name: 'ТЦ Горизонт', type: 'delivery', x: 22, y: 15 },
  { id: 'bus', name: 'Автовокзал', type: 'delivery', x: 85, y: 15 },
  { id: 'hospital', name: 'Больница №1', type: 'delivery', x: 60, y: 8 },
  { id: 'market', name: 'Рынок', type: 'delivery', x: 28, y: 66 },
  { id: 'district', name: 'Спальный район', type: 'delivery', x: 85, y: 85 },
  { id: 'park', name: 'Парк Победы', type: 'delivery', x: 15, y: 82 },
];

const ROAD_EDGES = [
  ['home', 'park'], ['home', 'cafe'],
  ['cafe', 'mall'], ['cafe', 'market'], ['cafe', 'shop'], ['cafe', 'warehouse'],
  ['mall', 'bus'], ['mall', 'hospital'], ['mall', 'warehouse'],
  ['bus', 'hospital'], ['bus', 'shop'],
  ['shop', 'workshop'], ['shop', 'hospital'], ['shop', 'warehouse'],
  ['workshop', 'district'],
  ['market', 'park'], ['market', 'district'], ['market', 'warehouse'],
  ['park', 'district'],
];

// ---------- country map — Ривное is one of several cities ----------

const COUNTRY_NAME = 'Залесье';

const COUNTRY_CITIES = [
  { id: 'rivnoe', name: 'Ривное', x: 26, y: 58, playable: true },
  { id: 'zarechye', name: 'Заречье', x: 54, y: 30 },
  { id: 'sosnovka', name: 'Сосновка', x: 78, y: 60 },
  { id: 'gorki', name: 'Горки', x: 18, y: 22 },
  { id: 'lugovoe', name: 'Луговое', x: 48, y: 84 },
  { id: 'berezovo', name: 'Берёзово', x: 86, y: 22 },
  { id: 'kamensk', name: 'Каменск', x: 62, y: 68 },
];

const COUNTRY_ROAD_EDGES = [
  ['rivnoe', 'zarechye'], ['rivnoe', 'gorki'], ['rivnoe', 'lugovoe'],
  ['zarechye', 'gorki'], ['zarechye', 'berezovo'], ['zarechye', 'sosnovka'],
  ['sosnovka', 'berezovo'], ['sosnovka', 'kamensk'], ['sosnovka', 'lugovoe'],
  ['kamensk', 'lugovoe'],
];

function cityById(id) { return COUNTRY_CITIES.find(c => c.id === id); }

const CITY_LAYOUT_CACHE = {};
function getCityLayout(cityId) {
  if (cityId === 'rivnoe') return { points: CITY_POINTS, edges: ROAD_EDGES };
  if (CITY_LAYOUT_CACHE[cityId]) return CITY_LAYOUT_CACHE[cityId];
  const rng = seededRandom(hashStr('layout:' + cityId));
  const count = 6 + Math.floor(rng() * 4);
  const types = ['cafe', 'shop', 'workshop', 'delivery', 'delivery', 'delivery'];
  const points = [];
  for (let i = 0; i < count; i++) {
    points.push({
      id: `${cityId}_p${i}`,
      name: i === 0 ? 'Центр' : `Точка ${i}`,
      type: i === 0 ? 'delivery' : types[Math.floor(rng() * types.length)],
      x: 14 + rng() * 72,
      y: 14 + rng() * 72,
    });
  }
  const edges = [];
  for (let i = 1; i < points.length; i++) {
    const j = Math.floor(rng() * i);
    edges.push([points[i].id, points[j].id]);
  }
  const extra = Math.floor(rng() * 3);
  for (let i = 0; i < extra; i++) {
    const a = points[Math.floor(rng() * points.length)];
    const b = points[Math.floor(rng() * points.length)];
    if (a.id !== b.id) edges.push([a.id, b.id]);
  }
  const layout = { points, edges };
  CITY_LAYOUT_CACHE[cityId] = layout;
  return layout;
}

const VEHICLES = [
  { id: 'bike', name: 'Велосипед', speedKmh: 15, price: 0 },
  { id: 'ebike', name: 'Электровелосипед', speedKmh: 25, price: 25000 },
  { id: 'moped', name: 'Мопед', speedKmh: 45, price: 90000 },
];

const BREAKDOWN_TYPES = [
  { id: 'flat_tire', label: 'Спустило колесо', severity: 'minor', selfFixCost: 250, selfFixMinutes: 15, ignorePenalty: 1.15 },
  { id: 'chain', label: 'Слетела цепь', severity: 'minor', selfFixCost: 150, selfFixMinutes: 8, ignorePenalty: 1.1 },
  { id: 'wheel_bent', label: 'Погнулось колесо', severity: 'severe', towCost: 2000, towMinutes: 40 },
  { id: 'frame_crack', label: 'Треснула рама', severity: 'severe', towCost: 4000, towMinutes: 70 },
];

const FATIGUE_RATE_MOVING = 0.35; // per game-minute
const HUNGER_RATE_MOVING = 0.18;
const HUNGER_RATE_IDLE = 0.12;
const HUNGER_RATE_RESTING = 0.08;
const HUNGER_RATE_STUCK = 0.06;
const WEAR_PER_KM = 0.5;
const WORKSHOP_REPAIR_COST = 600;
const UPGRADE_COST = 4000;

const EAT_OPTIONS = [
  { id: 'snack', label: 'Перекусить', minutes: 15, hungerRelief: 45 },
  { id: 'meal', label: 'Плотно поесть', minutes: 35, hungerRelief: 100 },
];
const EAT_PRICE_CAFE = { snack: 150, meal: 350 };

const SLEEP_OPTIONS = [
  { id: 'nap', label: 'Вздремнуть (1 ч)', minutes: 60, fatigueRelief: 30 },
  { id: 'sleep4', label: 'Поспать (4 ч)', minutes: 240, fatigueRelief: 70 },
  { id: 'sleep8', label: 'Выспаться (8 ч)', minutes: 480, fatigueRelief: 100 },
];
const IDLE_HOME_OPTION = { id: 'breathe', label: 'Просто отдохнуть, не ложась', minutes: 20, fatigueRelief: 10 };

const START_MONEY = 500;

function rand(min, max) { return min + Math.random() * (max - min); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pointById(id) { return CITY_POINTS.find(p => p.id === id); }

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

// ---------- winding roads: cached jittered polylines ----------

const POLYLINE_CACHE = {};
function windingPolyline(key, a, b, segments, maxOffset) {
  if (POLYLINE_CACHE[key]) return POLYLINE_CACHE[key];
  const rng = seededRandom(hashStr(key));
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const pts = [{ x: a.x, y: a.y }];
  let prev = 0;
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const target = (rng() * 2 - 1) * maxOffset;
    const off = prev * 0.4 + target * 0.6;
    prev = off;
    pts.push({ x: a.x + dx * t + nx * off, y: a.y + dy * t + ny * off });
  }
  pts.push({ x: b.x, y: b.y });
  POLYLINE_CACHE[key] = pts;
  return pts;
}
function polylineLengthUnits(pts) {
  let d = 0;
  for (let i = 0; i < pts.length - 1; i++) d += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  return d;
}
function pointOnPolyline(poly, t) {
  t = clamp(t, 0, 1);
  const totalLen = polylineLengthUnits(poly);
  let target = t * totalLen;
  for (let i = 0; i < poly.length - 1; i++) {
    const segLen = Math.hypot(poly[i + 1].x - poly[i].x, poly[i + 1].y - poly[i].y);
    if (target <= segLen || i === poly.length - 2) {
      const tt = segLen === 0 ? 0 : clamp(target / segLen, 0, 1);
      return { x: poly[i].x + (poly[i + 1].x - poly[i].x) * tt, y: poly[i].y + (poly[i + 1].y - poly[i].y) * tt };
    }
    target -= segLen;
  }
  return poly[poly.length - 1];
}
function getEdgePolyline(mapKey, aId, bId, aPoint, bPoint, segments, maxOffset) {
  const sorted = [aId, bId].slice().sort();
  const key = `${mapKey}:${sorted[0]}-${sorted[1]}`;
  const sortedA = sorted[0] === aId ? aPoint : bPoint;
  const sortedB = sorted[0] === aId ? bPoint : aPoint;
  const base = windingPolyline(key, sortedA, sortedB, segments, maxOffset);
  return sorted[0] === aId ? base : base.slice().reverse();
}

const DECOR_CACHE = {};
function getMapDecor(mapKey) {
  if (DECOR_CACHE[mapKey]) return DECOR_CACHE[mapKey];
  const rng = seededRandom(hashStr('decor:' + mapKey));
  const forests = [];
  const forestCount = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < forestCount; i++) forests.push({ x: 5 + rng() * 90, y: 5 + rng() * 90, r: 7 + rng() * 12 });
  const rivers = [];
  const riverCount = rng() < 0.7 ? 1 : 2;
  for (let i = 0; i < riverCount; i++) {
    const vertical = rng() < 0.5;
    const a = vertical ? { x: rng() * 100, y: 0 } : { x: 0, y: rng() * 100 };
    const b = vertical ? { x: rng() * 100, y: 100 } : { x: 100, y: rng() * 100 };
    rivers.push(windingPolyline(`${mapKey}:river${i}`, a, b, 9, 13));
  }
  const decor = { forests, rivers };
  DECOR_CACHE[mapKey] = decor;
  return decor;
}

// ---------- home-city road graph (with winding-road distances) ----------

function segDist(aId, bId) {
  const a = pointById(aId), b = pointById(bId);
  const poly = getEdgePolyline('rivnoe', aId, bId, a, b, 5, 5);
  return polylineLengthUnits(poly) * 0.4;
}

// A waypoint is either a node id (string, looked up via pointById) or a plain
// {x,y} coordinate — used for the courier's exact live position when a route
// is redirected mid-trip, so the remaining distance is charged honestly
// instead of snapping for free to the nearest graph node.
function waypointCoord(wp) { return typeof wp === 'string' ? pointById(wp) : wp; }
function waypointDist(wpA, wpB) {
  if (typeof wpA === 'string' && typeof wpB === 'string') return segDist(wpA, wpB);
  const a = waypointCoord(wpA), b = waypointCoord(wpB);
  return Math.hypot(a.x - b.x, a.y - b.y) * 0.4;
}

function buildGraph() {
  const g = {};
  CITY_POINTS.forEach(p => { g[p.id] = []; });
  ROAD_EDGES.forEach(([a, b]) => {
    const d = segDist(a, b);
    g[a].push({ to: b, d });
    g[b].push({ to: a, d });
  });
  return g;
}
const GRAPH = buildGraph();

function shortestPath(fromId, toId) {
  if (fromId === toId) return [fromId];
  const dist = {}, prev = {}, visited = new Set();
  CITY_POINTS.forEach(p => { dist[p.id] = Infinity; });
  dist[fromId] = 0;
  while (true) {
    let u = null, best = Infinity;
    for (const id in dist) {
      if (!visited.has(id) && dist[id] < best) { best = dist[id]; u = id; }
    }
    if (u === null) break;
    if (u === toId) break;
    visited.add(u);
    GRAPH[u].forEach(edge => {
      const nd = dist[u] + edge.d;
      if (nd < dist[edge.to]) { dist[edge.to] = nd; prev[edge.to] = u; }
    });
  }
  if (dist[toId] === Infinity) return [fromId];
  const path = [toId];
  let cur = toId;
  while (cur !== fromId) { cur = prev[cur]; path.unshift(cur); }
  return path;
}

function pathDistanceKm(path) {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) total += waypointDist(path[i], path[i + 1]);
  return total;
}

function positionAlongPath(path, fracKm, totalKm) {
  if (path.length === 1) { const p = waypointCoord(path[0]); return { x: p.x, y: p.y }; }
  let remaining = clamp(fracKm, 0, totalKm);
  for (let i = 0; i < path.length - 1; i++) {
    const wpA = path[i], wpB = path[i + 1];
    const bothNodes = typeof wpA === 'string' && typeof wpB === 'string';
    let segLen, poly = null;
    if (bothNodes) {
      const a = pointById(wpA), b = pointById(wpB);
      poly = getEdgePolyline('rivnoe', wpA, wpB, a, b, 5, 5);
      segLen = polylineLengthUnits(poly) * 0.4;
    } else {
      segLen = waypointDist(wpA, wpB);
    }
    if (remaining <= segLen || i === path.length - 2) {
      if (poly) return pointOnPolyline(poly, segLen === 0 ? 0 : remaining / segLen);
      const a = waypointCoord(wpA), b = waypointCoord(wpB);
      const t = segLen === 0 ? 0 : clamp(remaining / segLen, 0, 1);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= segLen;
  }
  const last = waypointCoord(path[path.length - 1]);
  return { x: last.x, y: last.y };
}

let state = null;
let jobIdSeq = 1;
let actionIdSeq = 1;
let lastFrameTs = null;
let autosaveAccum = 0;
let toasts = [];
let uiSelectedPointId = null;
let catchupBuffer = null;
let mapView = 'city'; // 'city' | 'country'
let mapCityId = 'rivnoe';

function newGameState() {
  return {
    money: START_MONEY,
    gameTime: 0,
    lastRealTimestamp: Date.now(),
    player: {
      positionId: 'home',
      status: 'idle', // idle | moving | resting | eating
      activity: null,
      fatigue: 15,
      hunger: 15,
      vehicle: { type: 'bike', speedKmh: 15, condition: 100, upgraded: false },
      restElapsed: 0,
      eatElapsed: 0,
      restPlan: null,
      eatPlan: null,
      job: null, // { id, fromId, toId, distanceKm, payout, pickedUp }
      warnedHunger: false,
      warnedFatigue: false,
    },
    availableJobs: [],
    eventLog: [],
    pendingActions: [],
    stats: { jobsCompleted: 0, totalEarned: 0 },
  };
}

function log(text, opts) {
  const silent = opts && opts.silent;
  const entry = { t: formatTime(state.gameTime), text };
  state.eventLog.unshift(entry);
  if (state.eventLog.length > 300) state.eventLog.length = 300;
  if (catchupBuffer) catchupBuffer.unshift(entry);
  else if (!silent) toast(text);
}

function toast(text) {
  toasts.push({ id: actionIdSeq++, text, expiresAt: Date.now() + TOAST_DURATION_MS });
}

function formatTime(gameMinutes) {
  const total = Math.floor(gameMinutes) + DAY_START_OFFSET;
  const day = Math.floor(total / 1440) + 1;
  const mins = total % 1440;
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `День ${day}, ${hh}:${mm}`;
}

const DELIVERY_POINT_IDS = CITY_POINTS.filter(p => p.type === 'delivery').map(p => p.id);

function generateJob() {
  const fromId = pick(DELIVERY_POINT_IDS);
  let toId = pick(DELIVERY_POINT_IDS);
  while (toId === fromId) toId = pick(DELIVERY_POINT_IDS);
  const distanceKm = pathDistanceKm(shortestPath(fromId, toId));
  const payout = Math.round(150 + distanceKm * 22 + rand(-20, 35));
  return { id: jobIdSeq++, fromId, toId, distanceKm: Math.round(distanceKm * 10) / 10, payout };
}

function maintainJobPool() {
  while (state.availableJobs.length < 4) state.availableJobs.push(generateJob());
}

function pushPendingAction(item) {
  item.id = actionIdSeq++;
  state.pendingActions.push(item);
  return item;
}

function cancelCurrentAction() {
  const p = state.player;
  if (p.status === 'resting' || p.status === 'eating') {
    p.status = 'idle'; p.restPlan = null; p.eatPlan = null; p.restElapsed = 0; p.eatElapsed = 0;
  }
}

// Which real-world edge the courier is currently on, and how far along it —
// used to cost a mid-trip redirect honestly instead of snapping for free.
function currentEdgeState() {
  const p = state.player;
  const a = p.activity;
  if (!a) return null;
  const progress = a.totalMinutes > 0 ? clamp(a.elapsedMinutes / a.totalMinutes, 0, 1) : 1;
  let remaining = progress * a.totalKm;
  for (let i = 0; i < a.path.length - 1; i++) {
    const wpA = a.path[i], wpB = a.path[i + 1];
    const segLen = waypointDist(wpA, wpB);
    if (remaining <= segLen || i === a.path.length - 2) {
      return {
        aId: typeof wpA === 'string' ? wpA : null,
        bId: typeof wpB === 'string' ? wpB : null,
        travelledOnEdge: clamp(remaining, 0, segLen),
        remainingOnEdge: clamp(segLen - remaining, 0, segLen),
      };
    }
    remaining -= segLen;
  }
  return null;
}

function beginTravelFromWaypoints(path) {
  const p = state.player;
  const targetId = path[path.length - 1];
  const totalKm = pathDistanceKm(path);
  if (totalKm <= 0.0001) { onArrive(targetId); return; }
  p.status = 'moving';
  p.activity = {
    path, targetId,
    totalMinutes: (totalKm / p.vehicle.speedKmh) * 60,
    elapsedMinutes: 0,
    totalKm,
    breakdownAt: Math.random() < 0.18 ? rand(0.25, 0.85) : null,
    breakdownTriggered: false,
    problemPending: false,
    problem: null,
  };
}

function startTravel(targetId) {
  const p = state.player;
  if (p.status === 'moving' && p.activity) {
    if (p.activity.problemPending) { toast('Сначала реши проблему в пути'); return; }
    const edge = currentEdgeState();
    const curFrac = p.activity.totalMinutes > 0 ? clamp(p.activity.elapsedMinutes / p.activity.totalMinutes, 0, 1) : 1;
    const currentPoint = positionAlongPath(p.activity.path, curFrac * p.activity.totalKm, p.activity.totalKm);
    if (!edge) return;
    if (edge.aId === null) {
      // Still on the straight-line first leg of an earlier redirect: the only
      // honest option is to keep going to the upcoming real node, then onward.
      const tail = shortestPath(edge.bId, targetId);
      beginTravelFromWaypoints([currentPoint, edge.bId, ...tail.slice(1)]);
      return;
    }
    const tailViaA = shortestPath(edge.aId, targetId);
    const tailViaB = shortestPath(edge.bId, targetId);
    const costViaA = edge.travelledOnEdge + pathDistanceKm(tailViaA);
    const costViaB = edge.remainingOnEdge + pathDistanceKm(tailViaB);
    const path = costViaA <= costViaB
      ? [currentPoint, edge.aId, ...tailViaA.slice(1)]
      : [currentPoint, edge.bId, ...tailViaB.slice(1)];
    beginTravelFromWaypoints(path);
    return;
  }
  cancelCurrentAction();
  if (p.positionId === targetId) { onArrive(targetId); return; }
  beginTravelFromWaypoints(shortestPath(p.positionId, targetId));
}

function onArrive(targetId) {
  const p = state.player;
  p.positionId = targetId;
  p.status = 'idle';
  p.activity = null;
}

function pickUpJob() {
  const p = state.player;
  if (!p.job || p.job.pickedUp) return;
  if (p.status !== 'idle' || p.positionId !== p.job.fromId) return;
  p.job.pickedUp = true;
  log(`Забрал заказ: ${pointById(p.job.fromId).name} → ${pointById(p.job.toId).name}`);
}

function deliverJob() {
  const p = state.player;
  if (!p.job || !p.job.pickedUp) return;
  if (p.status !== 'idle' || p.positionId !== p.job.toId) return;
  state.money += p.job.payout;
  state.stats.jobsCompleted++;
  state.stats.totalEarned += p.job.payout;
  log(`Доставил заказ, получил ${p.job.payout} ₽`);
  p.job = null;
}

function takeJob(jobId) {
  if (state.player.job) return;
  const idx = state.availableJobs.findIndex(j => j.id === jobId);
  if (idx === -1) return;
  const job = state.availableJobs.splice(idx, 1)[0];
  job.pickedUp = false;
  state.player.job = job;
  log(`Взял заказ: ${pointById(job.fromId).name} → ${pointById(job.toId).name}, ${job.payout} ₽`);
}

function startEating(optionId) {
  const p = state.player;
  if (p.status !== 'idle') return;
  const point = pointById(p.positionId);
  const atHome = p.positionId === 'home';
  const atCafe = point && point.type === 'cafe';
  if (!atHome && !atCafe) return;
  const opt = EAT_OPTIONS.find(o => o.id === optionId);
  const cost = atHome ? 0 : EAT_PRICE_CAFE[optionId];
  if (state.money < cost) { toast('Не хватает денег'); return; }
  state.money -= cost;
  p.status = 'eating';
  p.eatElapsed = 0;
  p.eatPlan = { totalMinutes: opt.minutes, hungerRelief: opt.hungerRelief, label: opt.label };
  log(atHome ? `Ест дома (${opt.label})` : `Ест в кафе: ${opt.label} (${cost} ₽)`, { silent: true });
}

function startSleeping(optionId) {
  const p = state.player;
  if (p.status !== 'idle' || p.positionId !== 'home') return;
  const opt = SLEEP_OPTIONS.find(o => o.id === optionId);
  p.status = 'resting';
  p.restElapsed = 0;
  p.restPlan = { totalMinutes: opt.minutes, fatigueRelief: opt.fatigueRelief, label: opt.label };
  log(`Лёг спать дома: ${opt.label}`, { silent: true });
}

function startIdleHome() {
  const p = state.player;
  if (p.status !== 'idle' || p.positionId !== 'home') return;
  p.status = 'resting';
  p.restElapsed = 0;
  p.restPlan = { totalMinutes: IDLE_HOME_OPTION.minutes, fatigueRelief: IDLE_HOME_OPTION.fatigueRelief, label: IDLE_HOME_OPTION.label };
  log('Немного отдохнул дома, не ложась', { silent: true });
}

function interruptRest() {
  const p = state.player;
  if (p.status === 'resting' || p.status === 'eating') {
    cancelCurrentAction();
    log('Прервал отдых', { silent: true });
  }
}

function triggerBreakdown(activity) {
  const p = state.player;
  const conditionFactor = (100 - p.vehicle.condition) / 100;
  const severeChance = 0.15 + conditionFactor * 0.5;
  const pool = Math.random() < severeChance
    ? BREAKDOWN_TYPES.filter(b => b.severity === 'severe')
    : BREAKDOWN_TYPES.filter(b => b.severity === 'minor');
  const type = pick(pool);
  activity.problemPending = true;
  activity.problem = { kind: 'breakdown', typeId: type.id };
  log(`Поломка в пути: ${type.label}`, { silent: true });
  pushPendingAction({
    kind: 'breakdown',
    typeId: type.id,
    title: type.label,
    text: type.severity === 'minor'
      ? `${type.label}. Можно починить на месте или ехать так, рискуя доломать технику.`
      : `${type.label}. Своими силами не починить — нужно вызывать эвакуатор до мастерской.`,
  });
}

function triggerExhausted(activity) {
  activity.problemPending = true;
  activity.problem = { kind: 'exhausted' };
  log('Силы кончились прямо в пути', { silent: true });
  pushPendingAction({
    kind: 'exhausted',
    title: 'Не осталось сил',
    text: 'Совсем без сил, дальше ехать нельзя. Нужно отдохнуть прямо тут, на обочине.',
  });
}

function resolvePendingAction(actionId, choice) {
  const idx = state.pendingActions.findIndex(a => a.id === actionId);
  if (idx === -1) return;
  const action = state.pendingActions[idx];
  const activity = state.player.activity;
  if (!activity || !activity.problemPending) { state.pendingActions.splice(idx, 1); return; }

  if (action.kind === 'breakdown') {
    const type = BREAKDOWN_TYPES.find(t => t.id === action.typeId);
    if (choice === 'selfFix') {
      state.money -= type.selfFixCost;
      state.player.vehicle.condition = clamp(state.player.vehicle.condition + 30, 0, 100);
      activity.elapsedMinutes += type.selfFixMinutes;
      log(`Починил на месте: ${type.label} (${type.selfFixCost} ₽)`);
    } else if (choice === 'ignore') {
      activity.totalMinutes *= type.ignorePenalty;
      log(`Поехал дальше, несмотря на «${type.label}»`);
    } else if (choice === 'tow') {
      state.money -= type.towCost;
      activity.totalMinutes += type.towMinutes;
      state.player.vehicle.condition = 100;
      log(`Вызвал эвакуатор, починили в мастерской за ${type.towCost} ₽`);
    }
  } else if (action.kind === 'exhausted') {
    // Roadside rest only relieves fatigue a little — it does NOT feed the courier.
    state.player.fatigue = 40;
    activity.totalMinutes += 60;
    log('Отдохнул на обочине, силы немного вернулись, но есть по-прежнему хочется');
  }

  activity.problemPending = false;
  activity.problem = null;
  state.pendingActions.splice(idx, 1);
}

function buyVehicle(vehicleId) {
  const v = VEHICLES.find(x => x.id === vehicleId);
  if (!v || state.player.status !== 'idle' || state.player.positionId !== 'shop') return;
  if (state.player.vehicle.type === vehicleId) return;
  if (state.money < v.price) return;
  state.money -= v.price;
  state.player.vehicle = { type: v.id, speedKmh: v.speedKmh, condition: 100, upgraded: false };
  log(`Купил технику: ${v.name}`);
}

function workshopRepair() {
  const p = state.player;
  if (p.status !== 'idle' || p.positionId !== 'workshop') return;
  if (state.money < WORKSHOP_REPAIR_COST) return;
  state.money -= WORKSHOP_REPAIR_COST;
  p.vehicle.condition = 100;
  log('Сделал полный ремонт в мастерской');
}

function workshopUpgrade() {
  const p = state.player;
  if (p.status !== 'idle' || p.positionId !== 'workshop') return;
  if (p.vehicle.upgraded || state.money < UPGRADE_COST) return;
  state.money -= UPGRADE_COST;
  p.vehicle.upgraded = true;
  log('Укрепил подвеску — поломки реже');
}

function simulateTick(dt, summary) {
  const p = state.player;
  if (p.status === 'moving') {
    const a = p.activity;
    if (a.problemPending) {
      p.hunger = clamp(p.hunger + HUNGER_RATE_STUCK * dt, 0, 100);
    } else {
      a.elapsedMinutes += dt;
      p.fatigue = clamp(p.fatigue + FATIGUE_RATE_MOVING * dt, 0, 100);
      p.hunger = clamp(p.hunger + HUNGER_RATE_MOVING * dt, 0, 100);
      p.vehicle.condition = clamp(p.vehicle.condition - (dt / a.totalMinutes) * a.totalKm * WEAR_PER_KM, 0, 100);

      const progress = a.totalMinutes > 0 ? a.elapsedMinutes / a.totalMinutes : 1;
      const breakdownChanceMod = p.vehicle.upgraded ? 0.5 : 1;
      if (!a.breakdownTriggered && a.breakdownAt !== null && progress >= a.breakdownAt) {
        a.breakdownTriggered = true;
        if (Math.random() < breakdownChanceMod) {
          triggerBreakdown(a);
          if (summary) summary.incidents++;
        }
      } else if (p.fatigue >= 100 || p.hunger >= 100) {
        triggerExhausted(a);
        if (summary) summary.incidents++;
      } else if (a.elapsedMinutes >= a.totalMinutes) {
        onArrive(a.targetId);
      }
    }
  } else if (p.status === 'resting') {
    p.restElapsed += dt;
    p.hunger = clamp(p.hunger + HUNGER_RATE_RESTING * dt, 0, 100);
    if (p.restElapsed >= p.restPlan.totalMinutes) {
      p.fatigue = clamp(p.fatigue - p.restPlan.fatigueRelief, 0, 100);
      log(`Отдохнул: ${p.restPlan.label}`);
      p.status = 'idle'; p.restPlan = null;
    }
  } else if (p.status === 'eating') {
    p.eatElapsed += dt;
    if (p.eatElapsed >= p.eatPlan.totalMinutes) {
      p.hunger = clamp(p.hunger - p.eatPlan.hungerRelief, 0, 100);
      log(`Поел: ${p.eatPlan.label}`);
      p.status = 'idle'; p.eatPlan = null;
    }
  } else {
    p.hunger = clamp(p.hunger + HUNGER_RATE_IDLE * dt, 0, 100);
  }

  if (p.hunger >= 90 && !p.warnedHunger) { p.warnedHunger = true; toast('Курьер сильно голоден — пора поесть'); }
  if (p.hunger < 80) p.warnedHunger = false;
  if (p.fatigue >= 90 && !p.warnedFatigue) { p.warnedFatigue = true; toast('Курьер сильно устал — пора отдохнуть'); }
  if (p.fatigue < 80) p.warnedFatigue = false;

  if (Math.random() < dt * 0.01) maintainJobPool();
  state.gameTime += dt;

  if (summary && state.money !== summary.lastMoney) {
    summary.lastMoney = state.money;
  }
}

function runOfflineCatchup() {
  const now = Date.now();
  let elapsedMs = now - state.lastRealTimestamp;
  if (elapsedMs <= 0) { state.lastRealTimestamp = now; return null; }
  if (elapsedMs > MAX_OFFLINE_MS) elapsedMs = MAX_OFFLINE_MS;
  const totalGameMinutes = (elapsedMs / 1000) * GAME_MIN_PER_REAL_SEC;
  catchupBuffer = [];
  const summary = { jobsCompleted: 0, incidents: 0, moneyBefore: state.money };
  let remaining = totalGameMinutes;
  const step = 20;
  while (remaining > 0) {
    const dt = Math.min(step, remaining);
    const before = state.stats.jobsCompleted;
    simulateTick(dt, summary);
    if (state.stats.jobsCompleted > before) summary.jobsCompleted++;
    remaining -= dt;
  }
  summary.netMoneyChange = Math.round(state.money - summary.moneyBefore);
  summary.entries = catchupBuffer;
  catchupBuffer = null;
  state.lastRealTimestamp = now;
  maintainJobPool();
  return summary;
}

function saveGame() {
  state.lastRealTimestamp = Date.now();
  localStorage.setItem(SAVE_KEY, JSON.stringify(state));
}

function loadGame() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return false;
  state = JSON.parse(raw);
  return true;
}

function hasSave() { return !!localStorage.getItem(SAVE_KEY); }

// ---------- rendering ----------

const el = id => document.getElementById(id);
const menuScreen = el('menu-screen');
const gameScreen = el('game-screen');
const canvas = el('map-canvas');
const ctx = canvas.getContext('2d');
let lastPointPixels = {};
let lastCountryPixels = {};

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function strokePolyline(poly, toPx) {
  if (poly.length < 2) return;
  ctx.beginPath();
  const [x0, y0] = toPx(poly[0].x, poly[0].y);
  ctx.moveTo(x0, y0);
  for (let i = 1; i < poly.length - 1; i++) {
    const [cx, cy] = toPx(poly[i].x, poly[i].y);
    const [mx, my] = toPx((poly[i].x + poly[i + 1].x) / 2, (poly[i].y + poly[i + 1].y) / 2);
    ctx.quadraticCurveTo(cx, cy, mx, my);
  }
  const last = poly[poly.length - 1];
  const [xl, yl] = toPx(last.x, last.y);
  ctx.lineTo(xl, yl);
  ctx.stroke();
}

function drawDecor(decor, toPx, w) {
  const scale = w / 100;
  decor.forests.forEach(f => {
    ctx.fillStyle = 'rgba(70,130,70,0.16)';
    const blobs = [[0, 0], [0.5, 0.3], [-0.4, 0.35], [0.2, -0.4]];
    blobs.forEach(([dx, dy]) => {
      const [x, y] = toPx(f.x + dx * f.r * 0.5, f.y + dy * f.r * 0.5);
      ctx.beginPath(); ctx.arc(x, y, f.r * 0.6 * scale, 0, Math.PI * 2); ctx.fill();
    });
  });
  decor.rivers.forEach(river => {
    ctx.strokeStyle = 'rgba(70,120,190,0.35)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    strokePolyline(river, toPx);
    ctx.strokeStyle = 'rgba(100,150,210,0.45)';
    ctx.lineWidth = 2.5;
    strokePolyline(river, toPx);
  });
}

function drawRoads(mapKey, points, edges, toPx) {
  const byId = id => points.find(p => p.id === id);
  ctx.strokeStyle = '#333c4a';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  edges.forEach(([aId, bId]) => {
    const a = byId(aId), b = byId(bId);
    const poly = getEdgePolyline(mapKey, aId, bId, a, b, 5, 5);
    strokePolyline(poly, toPx);
  });
  ctx.strokeStyle = '#4a5568';
  ctx.lineWidth = 1;
  edges.forEach(([aId, bId]) => {
    const a = byId(aId), b = byId(bId);
    const poly = getEdgePolyline(mapKey, aId, bId, a, b, 5, 5);
    strokePolyline(poly, toPx);
  });
}

function drawCityMap() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  const toPx = (x, y) => [w * (x / 100), h * (y / 100)];
  const layout = getCityLayout(mapCityId);
  const isHome = mapCityId === 'rivnoe';

  drawDecor(getMapDecor('city:' + mapCityId), toPx, w);
  drawRoads(mapCityId, layout.points, layout.edges, toPx);

  lastPointPixels = {};
  layout.points.forEach(pnt => {
    const [x, y] = toPx(pnt.x, pnt.y);
    lastPointPixels[pnt.id] = { x, y };
    const style = POINT_STYLES[pnt.type];
    ctx.fillStyle = style.color;
    ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill();
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.glyph, x, y);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#9aa4b2';
    ctx.font = '9px system-ui';
    ctx.fillText(pnt.name, x + 14, y + 3);
  });

  if (!isHome) return;

  const p = state.player;
  let cx, cy;
  if (p.status === 'moving' && p.activity) {
    const a = p.activity;
    const fracKm = a.totalMinutes > 0 ? (a.elapsedMinutes / a.totalMinutes) * a.totalKm : a.totalKm;
    const pos = positionAlongPath(a.path, fracKm, a.totalKm);
    [cx, cy] = toPx(pos.x, pos.y);
  } else {
    const cur = pointById(p.positionId);
    [cx, cy] = toPx(cur.x, cur.y);
  }
  ctx.fillStyle = p.status === 'moving' && p.activity && p.activity.problemPending ? '#d9534f' : '#7fd17f';
  ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill();
  ctx.font = '11px system-ui';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🚴', cx, cy);
  ctx.textAlign = 'left';
}

function drawCountryMap() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  const toPx = (x, y) => [w * (x / 100), h * (y / 100)];

  drawDecor(getMapDecor('country'), toPx, w);

  ctx.strokeStyle = '#333c4a';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  COUNTRY_ROAD_EDGES.forEach(([aId, bId]) => {
    const a = cityById(aId), b = cityById(bId);
    const poly = getEdgePolyline('country', aId, bId, a, b, 7, 7);
    strokePolyline(poly, toPx);
  });
  ctx.strokeStyle = '#4a5568';
  ctx.lineWidth = 1.5;
  COUNTRY_ROAD_EDGES.forEach(([aId, bId]) => {
    const a = cityById(aId), b = cityById(bId);
    const poly = getEdgePolyline('country', aId, bId, a, b, 7, 7);
    strokePolyline(poly, toPx);
  });

  lastCountryPixels = {};
  COUNTRY_CITIES.forEach(c => {
    const [x, y] = toPx(c.x, c.y);
    lastCountryPixels[c.id] = { x, y };
    ctx.fillStyle = c.playable ? '#7fd17f' : '#e2a63b';
    ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill();
    ctx.font = '15px system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🏙', x, y);
    ctx.font = 'bold 11px system-ui';
    ctx.fillStyle = '#eee';
    ctx.fillText(c.name, x, y + 22);
    ctx.textAlign = 'left';
  });
}

function drawMap() {
  if (!state) return;
  if (mapView === 'country') drawCountryMap();
  else drawCityMap();
}

function showCityView(cityId) {
  mapView = 'city';
  mapCityId = cityId;
  uiSelectedPointId = null;
  lastPointPanelSignature = null;
  lastJobsSignature = null;
}
function showCountryView() {
  mapView = 'country';
  uiSelectedPointId = null;
  lastPointPanelSignature = null;
}

canvas.addEventListener('click', (e) => {
  if (!state) return;
  const rect = canvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left, clickY = e.clientY - rect.top;

  if (mapView === 'country') {
    for (const c of COUNTRY_CITIES) {
      const pos = lastCountryPixels[c.id];
      if (pos && Math.hypot(pos.x - clickX, pos.y - clickY) < 20) {
        showCityView(c.id);
        renderAll();
        return;
      }
    }
    return;
  }

  if (mapCityId !== 'rivnoe') return; // other cities are look-only for now
  let found = null;
  for (const id in lastPointPixels) {
    const pos = lastPointPixels[id];
    if (Math.hypot(pos.x - clickX, pos.y - clickY) < 16) { found = id; break; }
  }
  uiSelectedPointId = found;
  lastPointPanelSignature = null;
  renderPointPanel();
});

function touchDist(touches) { return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY); }
let pinchStartDist = null;
canvas.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinchStartDist = touchDist(e.touches); });
canvas.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinchStartDist !== null) {
    const d = touchDist(e.touches);
    const delta = d - pinchStartDist;
    if (delta < -40 && mapView === 'city') { pinchStartDist = null; showCountryView(); renderAll(); }
    else if (delta > 40 && mapView === 'country') {
      const rect = canvas.getBoundingClientRect();
      const mx = ((e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left) / rect.width * 100;
      const my = ((e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top) / rect.height * 100;
      let nearest = null, bestD = Infinity;
      COUNTRY_CITIES.forEach(c => { const dd = Math.hypot(c.x - mx, c.y - my); if (dd < bestD) { bestD = dd; nearest = c; } });
      if (nearest && bestD < 30) { pinchStartDist = null; showCityView(nearest.id); renderAll(); }
    }
  }
}, { passive: true });
canvas.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinchStartDist = null; });

canvas.addEventListener('wheel', (e) => {
  if (!state) return;
  e.preventDefault();
  if (mapView === 'city' && e.deltaY > 0) { showCountryView(); renderAll(); return; }
  if (mapView === 'country' && e.deltaY < 0) {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width * 100;
    const my = (e.clientY - rect.top) / rect.height * 100;
    let nearest = null, bestD = Infinity;
    COUNTRY_CITIES.forEach(c => { const dd = Math.hypot(c.x - mx, c.y - my); if (dd < bestD) { bestD = dd; nearest = c; } });
    if (nearest && bestD < 25) { showCityView(nearest.id); renderAll(); }
  }
}, { passive: false });

function renderMapToggleButton() {
  const btn = el('btn-map-toggle');
  if (mapView === 'country') btn.textContent = '🏙 В город';
  else btn.textContent = '🗺 Карта страны';
}

let lastPointPanelSignature = null;
function renderPointPanel() {
  const panel = el('point-panel');
  const visible = mapView === 'city' && mapCityId === 'rivnoe' && uiSelectedPointId && state;
  const signature = visible ? `${uiSelectedPointId}|${state.player.positionId}|${state.player.status}` : 'hidden';
  if (signature === lastPointPanelSignature) return;
  lastPointPanelSignature = signature;

  if (!visible) { panel.classList.add('hidden'); return; }
  const point = pointById(uiSelectedPointId);
  const p = state.player;
  const here = p.status !== 'moving' && p.positionId === uiSelectedPointId;
  panel.classList.remove('hidden');
  panel.innerHTML = '';
  const label = document.createElement('div');
  label.textContent = point.name + (here ? ' (ты тут)' : '');
  panel.appendChild(label);

  const buttons = document.createElement('div');
  buttons.className = 'point-panel-buttons';
  panel.appendChild(buttons);

  const addBtn = (text, onClick, disabled) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.disabled = !!disabled;
    b.onclick = onClick;
    buttons.appendChild(b);
  };

  if (!here) {
    addBtn('Поехать сюда', () => { startTravel(point.id); uiSelectedPointId = null; renderAll(); });
    return;
  }

  if (p.status === 'resting' || p.status === 'eating') {
    const planLabel = (p.restPlan || p.eatPlan || {}).label || '';
    label.textContent += ` — ${planLabel}...`;
    addBtn('Прервать', () => { interruptRest(); renderAll(); });
    return;
  }

  if (point.type === 'shop') { addBtn('Открыть магазин', () => openShop()); return; }
  if (point.type === 'workshop') { addBtn('Открыть мастерскую', () => openWorkshop()); return; }

  if (point.type === 'cafe') {
    EAT_OPTIONS.forEach(opt => {
      const cost = EAT_PRICE_CAFE[opt.id];
      addBtn(`${opt.label} — ${cost} ₽`, () => { startEating(opt.id); renderAll(); }, state.money < cost);
    });
    return;
  }

  if (point.type === 'home') {
    EAT_OPTIONS.forEach(opt => addBtn(`${opt.label} (бесплатно)`, () => { startEating(opt.id); renderAll(); }));
    SLEEP_OPTIONS.forEach(opt => addBtn(opt.label, () => { startSleeping(opt.id); renderAll(); }));
    addBtn(IDLE_HOME_OPTION.label, () => { startIdleHome(); renderAll(); });
  }
}

let lastJobPanelSignature = null;
function renderCurrentJobPanel() {
  const box = el('current-job-panel');
  const p = state.player;
  const job = p.job;
  const signature = job ? `${job.id}|${job.pickedUp}|${p.status}|${p.positionId}` : 'hidden';
  if (signature === lastJobPanelSignature) return;
  lastJobPanelSignature = signature;

  if (!job) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = '';

  const text = document.createElement('div');
  const status = job.pickedUp ? 'везёшь' : 'нужно забрать';
  text.textContent = `Заказ: ${pointById(job.fromId).name} → ${pointById(job.toId).name} · ${job.payout} ₽ (${status})`;
  box.appendChild(text);

  const btn = document.createElement('button');
  if (!job.pickedUp) {
    const canPickup = p.status === 'idle' && p.positionId === job.fromId;
    btn.textContent = canPickup ? '📦 Забрать заказ' : `📦 Забрать заказ (нужно доехать до «${pointById(job.fromId).name}»)`;
    btn.disabled = !canPickup;
    btn.onclick = () => { pickUpJob(); renderAll(); };
  } else {
    const canDeliver = p.status === 'idle' && p.positionId === job.toId;
    btn.textContent = canDeliver ? '✅ Сдать заказ' : `✅ Сдать заказ (нужно доехать до «${pointById(job.toId).name}»)`;
    btn.disabled = !canDeliver;
    btn.onclick = () => { deliverJob(); renderAll(); };
  }
  box.appendChild(btn);
}

let lastJobsSignature = null;
function renderJobList() {
  const wrap = el('job-list-wrap');
  if (mapView !== 'city' || mapCityId !== 'rivnoe') { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');

  const canTake = !state.player.job;
  const signature = canTake + '|' + state.availableJobs.map(j => j.id).join(',');
  if (signature === lastJobsSignature) return;
  lastJobsSignature = signature;

  const ul = el('job-list');
  ul.innerHTML = '';
  state.availableJobs.forEach(job => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'job-info';
    info.textContent = `${pointById(job.fromId).name} → ${pointById(job.toId).name} · ${job.distanceKm} км`;
    const pay = document.createElement('span');
    pay.className = 'job-pay';
    pay.textContent = `${job.payout} ₽`;
    const btn = document.createElement('button');
    btn.textContent = 'Взять';
    btn.disabled = !canTake;
    btn.onclick = () => { takeJob(job.id); renderAll(); };
    li.append(info, pay, btn);
    ul.appendChild(li);
  });
}

function renderStatusPanel() {
  const panel = el('status-panel');
  if (mapView !== 'city' || mapCityId !== 'rivnoe') {
    panel.textContent = 'Курьер пока работает только в Ривном. Другие города можно осмотреть, но принять заказ там нельзя.';
    return;
  }
  const p = state.player;
  let text;
  if (p.status === 'idle') text = 'Стоит на месте, готов ехать';
  else if (p.status === 'resting') text = `Отдыхает: ${p.restPlan ? p.restPlan.label : ''}`;
  else if (p.status === 'eating') text = `Ест: ${p.eatPlan ? p.eatPlan.label : ''}`;
  else if (p.status === 'moving') {
    const a = p.activity;
    const pct = Math.round(clamp(a.totalMinutes > 0 ? a.elapsedMinutes / a.totalMinutes : 1, 0, 1) * 100);
    let label;
    if (p.job && !p.job.pickedUp && a.targetId === p.job.fromId) label = 'Едет забрать заказ';
    else if (p.job && p.job.pickedUp && a.targetId === p.job.toId) label = 'Везёт заказ';
    else label = `Едет к: ${pointById(a.targetId).name}`;
    text = `${label} (${pct}%)`;
    if (a.problemPending) text += ' — стоит';
  }
  panel.textContent = text;
}

let lastActionsSignature = null;
function renderPendingActions() {
  const signature = state.pendingActions.map(a => a.id).join(',');
  if (signature === lastActionsSignature) return;
  lastActionsSignature = signature;

  const box = el('actions-notify');
  box.innerHTML = '';
  state.pendingActions.forEach(action => {
    const card = document.createElement('div');
    card.className = 'notify-card';
    const text = document.createElement('span');
    text.className = 'notify-text';
    text.textContent = action.title;
    const btn = document.createElement('button');
    btn.textContent = 'Что делать?';
    btn.onclick = () => openProblemModal(action);
    card.append(text, btn);
    box.appendChild(card);
  });
}

function openProblemModal(action) {
  el('problem-title').textContent = action.title;
  el('problem-text').textContent = action.text;
  const actionsBox = el('problem-actions');
  actionsBox.innerHTML = '';
  const addBtn = (label, choice) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { resolvePendingAction(action.id, choice); el('problem-modal').classList.add('hidden'); renderAll(); };
    actionsBox.appendChild(b);
  };
  if (action.kind === 'breakdown') {
    const type = BREAKDOWN_TYPES.find(t => t.id === action.typeId);
    if (type.severity === 'minor') {
      addBtn(`Починить на месте — ${type.selfFixCost} ₽`, 'selfFix');
      addBtn('Ехать так, рискуя', 'ignore');
    } else {
      addBtn(`Вызвать эвакуатор — ${type.towCost} ₽`, 'tow');
    }
  } else if (action.kind === 'exhausted') {
    addBtn('Отдохнуть на обочине', 'ignore');
  }
  el('problem-modal').classList.remove('hidden');
}

function renderToasts() {
  const now = Date.now();
  toasts = toasts.filter(t => t.expiresAt > now);
  const area = el('toast-area');
  area.innerHTML = '';
  toasts.forEach(t => {
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = t.text;
    area.appendChild(div);
  });
}

function renderDiaryList(container, entries) {
  container.innerHTML = '';
  entries.forEach(e => {
    const li = document.createElement('li');
    li.textContent = `[${e.t}] ${e.text}`;
    container.appendChild(li);
  });
}

function renderAll() {
  el('hud-money').textContent = `${Math.round(state.money)} ₽`;
  el('hud-time').textContent = formatTime(state.gameTime);
  el('bar-fatigue').style.width = `${state.player.fatigue}%`;
  el('bar-hunger').style.width = `${state.player.hunger}%`;
  el('bar-condition').style.width = `${state.player.vehicle.condition}%`;
  renderMapToggleButton();
  renderStatusPanel();
  renderPendingActions();
  renderPointPanel();
  renderCurrentJobPanel();
  renderJobList();
  renderToasts();
  drawMap();
}

// ---------- shop / workshop modals ----------

function openShop() {
  const list = el('shop-list');
  list.innerHTML = '';
  VEHICLES.forEach(v => {
    const li = document.createElement('li');
    const owned = state.player.vehicle.type === v.id;
    const info = document.createElement('div');
    info.textContent = `${v.name} · ${v.speedKmh} км/ч${v.price > 0 ? ' · ' + v.price + ' ₽' : ''}`;
    const btn = document.createElement('button');
    btn.textContent = owned ? 'Используется' : 'Купить';
    btn.disabled = owned || state.money < v.price;
    btn.onclick = () => { buyVehicle(v.id); openShop(); renderAll(); };
    li.append(info, btn);
    list.appendChild(li);
  });
  el('shop-modal').classList.remove('hidden');
}

function openWorkshop() {
  el('workshop-condition').textContent = `Состояние техники: ${Math.round(state.player.vehicle.condition)}%`;
  el('btn-workshop-repair').textContent = `Полный ремонт — ${WORKSHOP_REPAIR_COST} ₽`;
  el('btn-workshop-repair').disabled = state.money < WORKSHOP_REPAIR_COST;
  const upgraded = state.player.vehicle.upgraded;
  el('btn-workshop-upgrade').textContent = `Укрепить подвеску — ${UPGRADE_COST} ₽`;
  el('btn-workshop-upgrade').disabled = upgraded || state.money < UPGRADE_COST;
  el('workshop-upgrade-hint').textContent = upgraded ? 'Подвеска уже укреплена' : 'Снижает шанс серьёзных поломок';
  el('workshop-modal').classList.remove('hidden');
}

// ---------- main loop ----------

function frame(ts) {
  if (lastFrameTs === null) lastFrameTs = ts;
  const dtRealSec = (ts - lastFrameTs) / 1000;
  lastFrameTs = ts;
  const dtGameMin = dtRealSec * GAME_MIN_PER_REAL_SEC;
  if (dtGameMin > 0 && dtGameMin < 1000) simulateTick(dtGameMin, null);

  autosaveAccum += dtRealSec;
  if (autosaveAccum > 5) { autosaveAccum = 0; saveGame(); }

  renderAll();
  requestAnimationFrame(frame);
}

// ---------- screen wiring ----------

function showGameScreen() {
  menuScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  resizeCanvas();
  maintainJobPool();
  lastFrameTs = null;
  lastJobsSignature = null;
  lastActionsSignature = null;
  lastPointPanelSignature = null;
  lastJobPanelSignature = null;
  uiSelectedPointId = null;
  mapView = 'city';
  mapCityId = 'rivnoe';
  toasts = [];
  requestAnimationFrame(frame);
}

function showMenuScreen() {
  gameScreen.classList.add('hidden');
  menuScreen.classList.remove('hidden');
  el('menu-hint').textContent = hasSave() ? 'Есть сохранённая игра' : '';
  el('btn-continue').disabled = !hasSave();
}

function showOfflineSummary(summary) {
  if (!summary) return;
  if (summary.entries.length === 0 && summary.netMoneyChange === 0) return;
  const sign = summary.netMoneyChange > 0 ? '+' : '';
  el('offline-header').textContent =
    `Доставлено заказов: ${summary.jobsCompleted}. Происшествий: ${summary.incidents}. Баланс изменился: ${sign}${summary.netMoneyChange} ₽.`;
  renderDiaryList(el('offline-list'), summary.entries.slice(0, 60));
  el('offline-modal').classList.remove('hidden');
}

el('btn-new-game').onclick = () => {
  state = newGameState();
  jobIdSeq = 1;
  saveGame();
  showGameScreen();
};

el('btn-continue').onclick = () => {
  if (!loadGame()) return;
  const summary = runOfflineCatchup();
  saveGame();
  showGameScreen();
  showOfflineSummary(summary);
};

el('btn-import').onclick = () => el('import-file').click();
el('import-file').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state = JSON.parse(reader.result);
      const summary = runOfflineCatchup();
      saveGame();
      showGameScreen();
      showOfflineSummary(summary);
    } catch (err) {
      el('menu-hint').textContent = 'Не удалось прочитать файл сохранения';
    }
  };
  reader.readAsText(file);
};

el('btn-map-toggle').onclick = () => {
  if (mapView === 'country') showCityView('rivnoe');
  else showCountryView();
  renderAll();
};

el('btn-open-menu').onclick = () => el('menu-modal').classList.remove('hidden');
el('btn-menu-close').onclick = () => el('menu-modal').classList.add('hidden');
el('btn-save').onclick = () => { saveGame(); };
el('btn-export').onclick = () => {
  saveGame();
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'courier-save.json';
  a.click();
  URL.revokeObjectURL(url);
};
el('btn-menu').onclick = () => { saveGame(); el('menu-modal').classList.add('hidden'); showMenuScreen(); };
el('btn-offline-ok').onclick = () => el('offline-modal').classList.add('hidden');

el('btn-diary').onclick = () => {
  renderDiaryList(el('diary-list-full'), state.eventLog);
  el('diary-modal').classList.remove('hidden');
};
el('btn-diary-close').onclick = () => el('diary-modal').classList.add('hidden');

el('btn-shop-close').onclick = () => el('shop-modal').classList.add('hidden');
el('btn-workshop-close').onclick = () => el('workshop-modal').classList.add('hidden');
el('btn-workshop-repair').onclick = () => { workshopRepair(); openWorkshop(); renderAll(); };
el('btn-workshop-upgrade').onclick = () => { workshopUpgrade(); openWorkshop(); renderAll(); };

window.addEventListener('beforeunload', () => { if (state) saveGame(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && state) saveGame(); });
window.addEventListener('resize', () => { if (!gameScreen.classList.contains('hidden')) resizeCanvas(); });

showMenuScreen();
