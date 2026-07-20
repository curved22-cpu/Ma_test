'use strict';

const SAVE_KEY = 'courier_save_v2';
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

const VEHICLES = [
  { id: 'bike', name: 'Велосипед', speedKmh: 15, price: 0 },
  { id: 'ebike', name: 'Велосипед с мотором', speedKmh: 25, price: 400 },
  { id: 'moped', name: 'Мопед', speedKmh: 45, price: 1200 },
];

const BREAKDOWN_TYPES = [
  { id: 'flat_tire', label: 'Спустило колесо', severity: 'minor', selfFixCost: 20, selfFixMinutes: 15, ignorePenalty: 1.15 },
  { id: 'chain', label: 'Слетела цепь', severity: 'minor', selfFixCost: 10, selfFixMinutes: 8, ignorePenalty: 1.1 },
  { id: 'wheel_bent', label: 'Погнулось колесо', severity: 'severe', towCost: 60, towMinutes: 40 },
  { id: 'frame_crack', label: 'Треснула рама', severity: 'severe', towCost: 120, towMinutes: 70 },
];

const FATIGUE_RATE_MOVING = 0.35; // per game-minute
const HUNGER_RATE_MOVING = 0.18;
const HUNGER_RATE_IDLE = 0.12;
const HUNGER_RATE_RESTING = 0.08;
const HUNGER_RATE_STUCK = 0.06;
const REST_DURATION = 240;
const EAT_COST_CAFE = 15;
const EAT_DURATION = 20;
const AUTO_REST_THRESHOLD = 90;
const AUTO_EAT_THRESHOLD = 90;
const WEAR_PER_KM = 0.5;
const WORKSHOP_REPAIR_COST = 20;
const UPGRADE_COST = 150;

function rand(min, max) { return min + Math.random() * (max - min); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pointById(id) { return CITY_POINTS.find(p => p.id === id); }
function segDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) * 0.4; }

function buildGraph() {
  const g = {};
  CITY_POINTS.forEach(p => { g[p.id] = []; });
  ROAD_EDGES.forEach(([a, b]) => {
    const d = segDist(pointById(a), pointById(b));
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
  for (let i = 0; i < path.length - 1; i++) total += segDist(pointById(path[i]), pointById(path[i + 1]));
  return total;
}

function positionAlongPath(path, fracKm, totalKm) {
  if (path.length === 1) { const p = pointById(path[0]); return { x: p.x, y: p.y }; }
  let remaining = clamp(fracKm, 0, totalKm);
  for (let i = 0; i < path.length - 1; i++) {
    const a = pointById(path[i]), b = pointById(path[i + 1]);
    const segLen = segDist(a, b);
    if (remaining <= segLen || i === path.length - 2) {
      const t = segLen === 0 ? 0 : clamp(remaining / segLen, 0, 1);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= segLen;
  }
  const last = pointById(path[path.length - 1]);
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

function newGameState() {
  return {
    money: 300,
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
  const payout = Math.round(60 + distanceKm * 12 + rand(-10, 20));
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

function startTravel(targetId, purpose, job) {
  const p = state.player;
  if (p.positionId === targetId) { onArrive(purpose, job, targetId); return; }
  const path = shortestPath(p.positionId, targetId);
  const totalKm = pathDistanceKm(path);
  p.status = 'moving';
  p.activity = {
    purpose, job: job || null, path, targetId,
    totalMinutes: (totalKm / p.vehicle.speedKmh) * 60,
    elapsedMinutes: 0,
    totalKm,
    breakdownAt: Math.random() < 0.18 ? rand(0.25, 0.85) : null,
    breakdownTriggered: false,
    problemPending: false,
    problem: null,
  };
}

function onArrive(purpose, job, targetId) {
  const p = state.player;
  p.positionId = targetId;
  p.status = 'idle';
  p.activity = null;
  if (purpose === 'pickup') {
    log(`Забрал заказ: ${pointById(job.fromId).name} → ${pointById(job.toId).name}`);
    startTravel(job.toId, 'dropoff', job);
  } else if (purpose === 'dropoff') {
    state.money += job.payout;
    state.stats.jobsCompleted++;
    state.stats.totalEarned += job.payout;
    log(`Доставил заказ, получил ${job.payout} ₽`);
  } else if (purpose === 'eat') {
    const atHome = p.positionId === 'home';
    const cost = atHome ? 0 : EAT_COST_CAFE;
    state.money -= cost;
    p.status = 'eating';
    p.eatElapsed = 0;
    log(atHome ? 'Поел дома' : `Перекусил в кафе за ${cost} ₽`, { silent: true });
  } else if (purpose === 'sleep') {
    p.status = 'resting';
    p.restElapsed = 0;
    log('Лёг спать дома', { silent: true });
  } else if (purpose === 'shop' || purpose === 'workshop') {
    log(purpose === 'shop' ? 'Приехал в магазин техники' : 'Приехал в мастерскую', { silent: true });
  }
}

function takeJob(jobId) {
  if (state.player.status !== 'idle') return;
  const idx = state.availableJobs.findIndex(j => j.id === jobId);
  if (idx === -1) return;
  const job = state.availableJobs.splice(idx, 1)[0];
  startTravel(job.fromId, 'pickup', job);
}

function nearestPointOfType(type) {
  const candidates = CITY_POINTS.filter(p => p.type === type);
  const from = pointById(state.player.positionId);
  let best = candidates[0], bestD = Infinity;
  candidates.forEach(c => {
    const d = pathDistanceKm(shortestPath(from.id, c.id));
    if (d < bestD) { bestD = d; best = c; }
  });
  return best.id;
}

function requestEat() {
  if (state.player.status !== 'idle') return;
  const p = state.player;
  if (p.positionId === 'home' || pointById(p.positionId).type === 'cafe') { onArrive('eat', null, p.positionId); return; }
  startTravel(nearestPointOfType('cafe'), 'eat', null);
}

function requestSleep() {
  if (state.player.status !== 'idle') return;
  startTravel('home', 'sleep', null);
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
    state.player.fatigue = 40;
    state.player.hunger = clamp(state.player.hunger - 20, 0, 100);
    activity.totalMinutes += 60;
    log('Отдохнул на обочине, силы немного вернулись');
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
        onArrive(a.purpose, a.job, a.targetId);
      }
    }
  } else if (p.status === 'resting') {
    p.restElapsed += dt;
    p.hunger = clamp(p.hunger + HUNGER_RATE_RESTING * dt, 0, 100);
    if (p.restElapsed >= REST_DURATION) { p.fatigue = 0; p.status = 'idle'; log('Проснулся отдохнувшим'); }
  } else if (p.status === 'eating') {
    p.eatElapsed += dt;
    if (p.eatElapsed >= EAT_DURATION) { p.hunger = 0; p.status = 'idle'; log('Перекусил'); }
  } else {
    p.hunger = clamp(p.hunger + HUNGER_RATE_IDLE * dt, 0, 100);
    if (p.hunger >= AUTO_EAT_THRESHOLD) requestEat();
    else if (p.fatigue >= AUTO_REST_THRESHOLD) requestSleep();
  }

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

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawMap() {
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  ctx.clearRect(0, 0, w, h);
  const toPx = (x, y) => [w * (x / 100), h * (y / 100)];

  ctx.fillStyle = 'rgba(90, 140, 90, 0.12)';
  ctx.beginPath(); ctx.arc(...toPx(15, 82), 60, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(140, 120, 90, 0.10)';
  ctx.beginPath(); ctx.arc(...toPx(75, 45), 70, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = '#333c4a';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ROAD_EDGES.forEach(([aId, bId]) => {
    const a = pointById(aId), b = pointById(bId);
    ctx.beginPath(); ctx.moveTo(...toPx(a.x, a.y)); ctx.lineTo(...toPx(b.x, b.y)); ctx.stroke();
  });
  ctx.strokeStyle = '#4a5568';
  ctx.lineWidth = 1;
  ROAD_EDGES.forEach(([aId, bId]) => {
    const a = pointById(aId), b = pointById(bId);
    ctx.beginPath(); ctx.moveTo(...toPx(a.x, a.y)); ctx.lineTo(...toPx(b.x, b.y)); ctx.stroke();
  });

  lastPointPixels = {};
  CITY_POINTS.forEach(pnt => {
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

canvas.addEventListener('click', (e) => {
  if (!state || state.player.status !== 'idle') { uiSelectedPointId = null; renderPointPanel(); return; }
  const rect = canvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left, clickY = e.clientY - rect.top;
  let found = null;
  for (const id in lastPointPixels) {
    const pos = lastPointPixels[id];
    if (Math.hypot(pos.x - clickX, pos.y - clickY) < 16) { found = id; break; }
  }
  uiSelectedPointId = found;
  renderPointPanel();
});

const TRAVEL_PURPOSE_BY_TYPE = { home: 'sleep', cafe: 'eat', shop: 'shop', workshop: 'workshop', delivery: 'visit' };

let lastPointPanelSignature = null;
function renderPointPanel() {
  const panel = el('point-panel');
  const visible = uiSelectedPointId && state && state.player.status === 'idle';
  const signature = visible ? `${uiSelectedPointId}|${state.player.positionId}` : 'hidden';
  if (signature === lastPointPanelSignature) return;
  lastPointPanelSignature = signature;

  if (!visible) { panel.classList.add('hidden'); return; }
  const point = pointById(uiSelectedPointId);
  const here = state.player.positionId === uiSelectedPointId;
  panel.classList.remove('hidden');
  panel.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = point.name + (here ? ' (ты тут)' : '');
  panel.appendChild(label);

  let btnText = null, onClick = null;
  if (!here) {
    btnText = 'Поехать';
    onClick = () => { startTravel(point.id, TRAVEL_PURPOSE_BY_TYPE[point.type]); uiSelectedPointId = null; renderAll(); };
  } else if (point.type === 'shop') {
    btnText = 'Открыть магазин';
    onClick = () => openShop();
  } else if (point.type === 'workshop') {
    btnText = 'Открыть мастерскую';
    onClick = () => openWorkshop();
  } else if (point.type === 'cafe') {
    btnText = 'Перекусить';
    onClick = () => { requestEat(); uiSelectedPointId = null; renderAll(); };
  } else if (point.type === 'home') {
    btnText = 'Лечь спать';
    onClick = () => { requestSleep(); uiSelectedPointId = null; renderAll(); };
  }

  if (btnText) {
    const btn = document.createElement('button');
    btn.textContent = btnText;
    btn.onclick = onClick;
    panel.appendChild(btn);
  }
}

let lastJobsSignature = null;
function renderJobList() {
  const canTake = state.player.status === 'idle';
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
  const p = state.player;
  const panel = el('status-panel');
  let text;
  if (p.status === 'idle') text = 'Стоит на месте, готов к заказу';
  else if (p.status === 'resting') text = 'Спит дома';
  else if (p.status === 'eating') text = 'Перекусывает';
  else if (p.status === 'moving') {
    const a = p.activity;
    const pct = Math.round(clamp(a.totalMinutes > 0 ? a.elapsedMinutes / a.totalMinutes : 1, 0, 1) * 100);
    const labels = { pickup: 'Едет за заказом', dropoff: 'Везёт заказ', eat: 'Едет перекусить', sleep: 'Едет домой', shop: 'Едет в магазин', workshop: 'Едет в мастерскую', visit: 'В пути' };
    text = `${labels[a.purpose] || 'В пути'} (${pct}%)`;
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
  const idle = state.player.status === 'idle';
  el('btn-eat').disabled = !idle;
  el('btn-sleep').disabled = !idle;
  renderStatusPanel();
  renderPendingActions();
  renderPointPanel();
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
  el('btn-workshop-repair').disabled = state.money < WORKSHOP_REPAIR_COST;
  const upgraded = state.player.vehicle.upgraded;
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
  uiSelectedPointId = null;
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

el('btn-eat').onclick = () => { requestEat(); renderAll(); };
el('btn-sleep').onclick = () => { requestSleep(); renderAll(); };
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
el('btn-menu').onclick = () => { saveGame(); showMenuScreen(); };
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
