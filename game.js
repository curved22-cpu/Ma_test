'use strict';

const SAVE_KEY = 'courier_save_v1';
const TIME_SCALE = 100; // game runs 100x faster than real life (testing value)
const GAME_MIN_PER_REAL_SEC = TIME_SCALE / 60;
const DAY_START_OFFSET = 8 * 60; // game clock begins at Day 1, 08:00
const MAX_OFFLINE_MS = 60 * 24 * 3600 * 1000; // cap catch-up at 60 real days

const CITY_POINTS = [
  { id: 'wh', name: 'Склад', x: 50, y: 50 },
  { id: 'mall', name: 'ТЦ Горизонт', x: 20, y: 20 },
  { id: 'bus', name: 'Автовокзал', x: 82, y: 15 },
  { id: 'park', name: 'Парк Победы', x: 15, y: 80 },
  { id: 'district', name: 'Спальный район', x: 85, y: 85 },
  { id: 'hospital', name: 'Больница №1', x: 62, y: 10 },
  { id: 'market', name: 'Рынок', x: 28, y: 62 },
];

const BIKE_SPEED_KMH = 15;
const FATIGUE_RATE_DELIVERING = 0.35; // per game-minute
const HUNGER_RATE_DELIVERING = 0.18;
const HUNGER_RATE_IDLE = 0.12;
const HUNGER_RATE_RESTING = 0.08;
const REST_COST = 30;
const REST_DURATION = 240;
const EAT_COST = 15;
const EAT_DURATION = 20;
const AUTO_REST_THRESHOLD = 85;
const AUTO_EAT_THRESHOLD = 85;

function rand(min, max) { return min + Math.random() * (max - min); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function pointById(id) { return CITY_POINTS.find(p => p.id === id); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) * 0.4; }

let state = null;
let jobIdSeq = 1;
let lastFrameTs = null;
let autosaveAccum = 0;

function newGameState() {
  return {
    money: 300,
    gameTime: 0,
    lastRealTimestamp: Date.now(),
    player: {
      positionId: 'wh',
      status: 'idle', // idle | delivering | resting | eating
      fatigue: 15,
      hunger: 15,
      vehicle: { type: 'bike', speedKmh: BIKE_SPEED_KMH, condition: 100 },
      restElapsed: 0,
      eatElapsed: 0,
    },
    activeJob: null,
    availableJobs: [],
    eventLog: [],
    stats: { jobsCompleted: 0, totalEarned: 0 },
  };
}

function log(text) {
  state.eventLog.unshift({ t: formatTime(state.gameTime), text });
  if (state.eventLog.length > 60) state.eventLog.length = 60;
}

function formatTime(gameMinutes) {
  const total = Math.floor(gameMinutes) + DAY_START_OFFSET;
  const day = Math.floor(total / 1440) + 1;
  const mins = total % 1440;
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `День ${day}, ${hh}:${mm}`;
}

function generateJob() {
  const fromPoint = pick2(CITY_POINTS);
  let to = pick2(CITY_POINTS);
  while (to.id === fromPoint.id) to = pick2(CITY_POINTS);
  const distanceKm = dist(fromPoint, to);
  const durationMin = (distanceKm / BIKE_SPEED_KMH) * 60;
  const payout = Math.round(60 + distanceKm * 12 + rand(-10, 20));
  const breakdownRoll = Math.random();
  return {
    id: jobIdSeq++,
    fromId: fromPoint.id,
    toId: to.id,
    distanceKm: Math.round(distanceKm * 10) / 10,
    totalMinutes: durationMin,
    elapsedMinutes: 0,
    payout,
    breakdownAt: breakdownRoll < 0.18 ? rand(0.25, 0.75) : null,
    breakdownTriggered: false,
    problemPending: false,
    problemType: null,
  };
}

function pick2(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function maintainJobPool() {
  while (state.availableJobs.length < 4) {
    state.availableJobs.push(generateJob());
  }
}

function takeJob(jobId) {
  if (state.player.status !== 'idle') return;
  const idx = state.availableJobs.findIndex(j => j.id === jobId);
  if (idx === -1) return;
  const job = state.availableJobs.splice(idx, 1)[0];
  state.activeJob = job;
  state.player.status = 'delivering';
  log(`Взял заказ: ${pointById(job.fromId).name} → ${pointById(job.toId).name} (${job.distanceKm} км)`);
}

function resolveProblem(action) {
  const job = state.activeJob;
  if (!job || !job.problemPending) return;
  if (job.problemType === 'breakdown') {
    if (action === 'repair') {
      const cost = Math.round(25 + (100 - state.player.vehicle.condition) * 0.3);
      state.money -= cost;
      state.player.vehicle.condition = 100;
      log(`Починил велосипед за ${cost} ₽`);
    } else {
      job.totalMinutes *= 1.2;
      log('Поехал дальше на честном слове, велосипед барахлит');
    }
  } else if (job.problemType === 'exhausted') {
    state.player.fatigue = 40;
    job.totalMinutes += 60;
    log('Прилёг отдохнуть прямо у обочины');
  }
  job.problemPending = false;
  job.problemType = null;
}

function startRest() {
  if (state.player.status !== 'idle') return;
  state.money -= REST_COST;
  state.player.status = 'resting';
  state.player.restElapsed = 0;
  log('Лёг отдохнуть в ночлежке');
}

function startEat() {
  if (state.player.status !== 'idle') return;
  state.money -= EAT_COST;
  state.player.status = 'eating';
  state.player.eatElapsed = 0;
  log('Присел перекусить');
}

function simulateTick(dt, summary) {
  const p = state.player;
  if (p.status === 'delivering') {
    const job = state.activeJob;
    if (!job.problemPending) {
      job.elapsedMinutes += dt;
      p.fatigue = clamp(p.fatigue + FATIGUE_RATE_DELIVERING * dt, 0, 100);
      p.hunger = clamp(p.hunger + HUNGER_RATE_DELIVERING * dt, 0, 100);

      const progress = job.elapsedMinutes / job.totalMinutes;
      if (!job.breakdownTriggered && job.breakdownAt !== null && progress >= job.breakdownAt) {
        job.breakdownTriggered = true;
        job.problemPending = true;
        job.problemType = 'breakdown';
        log('Поломка в пути: спустило колесо');
        if (summary) summary.incidents++;
      } else if (p.fatigue >= 100 || p.hunger >= 100) {
        job.problemPending = true;
        job.problemType = 'exhausted';
        log('Силы кончились прямо в пути');
        if (summary) summary.incidents++;
      } else if (job.elapsedMinutes >= job.totalMinutes) {
        state.money += job.payout;
        state.stats.jobsCompleted++;
        state.stats.totalEarned += job.payout;
        p.vehicle.condition = clamp(p.vehicle.condition - job.distanceKm * 0.5, 0, 100);
        p.positionId = job.toId;
        log(`Доставил заказ, получил ${job.payout} ₽`);
        if (summary) { summary.jobsCompleted++; summary.moneyEarned += job.payout; }
        state.activeJob = null;
        p.status = 'idle';
      }
    }
  } else if (p.status === 'resting') {
    p.restElapsed += dt;
    p.hunger = clamp(p.hunger + HUNGER_RATE_RESTING * dt, 0, 100);
    if (p.restElapsed >= REST_DURATION) {
      p.fatigue = 0;
      p.status = 'idle';
      log('Проснулся отдохнувшим');
    }
  } else if (p.status === 'eating') {
    p.eatElapsed += dt;
    if (p.eatElapsed >= EAT_DURATION) {
      p.hunger = 0;
      p.status = 'idle';
      log('Перекусил');
    }
  } else {
    p.hunger = clamp(p.hunger + HUNGER_RATE_IDLE * dt, 0, 100);
    if (p.hunger >= AUTO_EAT_THRESHOLD && p.status === 'idle') startEat();
    else if (p.fatigue >= AUTO_REST_THRESHOLD && p.status === 'idle') startRest();
  }

  if (Math.random() < dt * 0.01) maintainJobPool();
  state.gameTime += dt;
}

function runOfflineCatchup() {
  const now = Date.now();
  let elapsedMs = now - state.lastRealTimestamp;
  if (elapsedMs <= 0) { state.lastRealTimestamp = now; return null; }
  if (elapsedMs > MAX_OFFLINE_MS) elapsedMs = MAX_OFFLINE_MS;
  const totalGameMinutes = (elapsedMs / 1000) * GAME_MIN_PER_REAL_SEC;
  const summary = { jobsCompleted: 0, moneyEarned: 0, incidents: 0, moneyBefore: state.money };
  let remaining = totalGameMinutes;
  const step = 20;
  while (remaining > 0) {
    const dt = Math.min(step, remaining);
    simulateTick(dt, summary);
    remaining -= dt;
  }
  summary.netMoneyChange = Math.round(state.money - summary.moneyBefore);
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

function hasSave() {
  return !!localStorage.getItem(SAVE_KEY);
}

// ---------- rendering ----------

const el = id => document.getElementById(id);
const menuScreen = el('menu-screen');
const gameScreen = el('game-screen');
const canvas = el('map-canvas');
const ctx = canvas.getContext('2d');

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

  ctx.strokeStyle = '#2a3240';
  ctx.lineWidth = 1;
  CITY_POINTS.forEach(a => {
    CITY_POINTS.forEach(b => {
      if (a.id >= b.id) return;
      const [ax, ay] = toPx(a.x, a.y);
      const [bx, by] = toPx(b.x, b.y);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    });
  });

  CITY_POINTS.forEach(pnt => {
    const [x, y] = toPx(pnt.x, pnt.y);
    ctx.fillStyle = '#4a9dd1';
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#9aa4b2';
    ctx.font = '10px system-ui';
    ctx.fillText(pnt.name, x + 8, y + 3);
  });

  let courierX, courierY;
  const p = state.player;
  if (p.status === 'delivering' && state.activeJob) {
    const job = state.activeJob;
    const from = pointById(job.fromId), to = pointById(job.toId);
    const frac = job.problemPending ? job.elapsedMinutes / job.totalMinutes : clamp(job.elapsedMinutes / job.totalMinutes, 0, 1);
    const [fx, fy] = toPx(from.x, from.y);
    const [tx, ty] = toPx(to.x, to.y);
    courierX = fx + (tx - fx) * frac;
    courierY = fy + (ty - fy) * frac;
  } else {
    const cur = pointById(p.positionId);
    [courierX, courierY] = toPx(cur.x, cur.y);
  }
  ctx.fillStyle = p.status === 'delivering' && state.activeJob && state.activeJob.problemPending ? '#d9534f' : '#7fd17f';
  ctx.beginPath(); ctx.arc(courierX, courierY, 7, 0, Math.PI * 2); ctx.fill();
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

let lastLogLength = null;
function renderEventLog() {
  if (state.eventLog.length === lastLogLength) return;
  lastLogLength = state.eventLog.length;

  const ul = el('event-log');
  ul.innerHTML = '';
  state.eventLog.slice(0, 20).forEach(e => {
    const li = document.createElement('li');
    li.textContent = `[${e.t}] ${e.text}`;
    ul.appendChild(li);
  });
}

function renderStatusPanel() {
  const p = state.player;
  const panel = el('status-panel');
  const texts = {
    idle: 'Стоит на месте, готов к заказу',
    delivering: 'В пути',
    resting: 'Отдыхает в ночлежке',
    eating: 'Перекусывает',
  };
  let text = texts[p.status] || p.status;
  if (p.status === 'delivering' && state.activeJob) {
    const job = state.activeJob;
    const pct = Math.round(clamp(job.elapsedMinutes / job.totalMinutes, 0, 1) * 100);
    text += ` (${pct}%)`;
  }
  panel.textContent = text;

  const problemPanel = el('problem-panel');
  const job = state.activeJob;
  if (job && job.problemPending) {
    problemPanel.classList.remove('hidden');
    el('problem-text').textContent = job.problemType === 'breakdown'
      ? 'Поломка в пути. Починить сейчас или рискнуть ехать дальше?'
      : 'Силы на нуле, нужно отдохнуть прямо тут.';
    el('btn-repair').classList.toggle('hidden', job.problemType !== 'breakdown');
    el('btn-ignore').textContent = job.problemType === 'breakdown' ? 'Ехать так' : 'Отдохнуть тут';
  } else {
    problemPanel.classList.add('hidden');
  }
}

function renderAll() {
  el('hud-money').textContent = `${Math.round(state.money)} ₽`;
  el('hud-time').textContent = formatTime(state.gameTime);
  el('bar-fatigue').style.width = `${state.player.fatigue}%`;
  el('bar-hunger').style.width = `${state.player.hunger}%`;
  el('bar-condition').style.width = `${state.player.vehicle.condition}%`;
  const idle = state.player.status === 'idle';
  el('btn-rest').disabled = !idle;
  el('btn-eat').disabled = !idle;
  renderStatusPanel();
  renderJobList();
  renderEventLog();
  drawMap();
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
  lastLogLength = null;
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
  if (summary.jobsCompleted === 0 && summary.incidents === 0 && summary.netMoneyChange === 0) return;
  const sign = summary.netMoneyChange > 0 ? '+' : '';
  el('offline-summary').textContent =
    `Доставлено заказов: ${summary.jobsCompleted}. Происшествий: ${summary.incidents}. Баланс изменился: ${sign}${summary.netMoneyChange} ₽.`;
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

el('btn-rest').onclick = () => { startRest(); renderAll(); };
el('btn-eat').onclick = () => { startEat(); renderAll(); };
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
el('btn-repair').onclick = () => { resolveProblem('repair'); renderAll(); };
el('btn-ignore').onclick = () => { resolveProblem('ignore'); renderAll(); };
el('btn-offline-ok').onclick = () => el('offline-modal').classList.add('hidden');

window.addEventListener('beforeunload', () => { if (state) saveGame(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state) saveGame();
});
window.addEventListener('resize', () => { if (!gameScreen.classList.contains('hidden')) resizeCanvas(); });

showMenuScreen();
