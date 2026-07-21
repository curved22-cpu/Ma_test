'use strict';

const SAVE_KEY = 'courier_save_v5';
const TIME_SCALE = 100; // game runs 100x faster than real life (testing value)
const GAME_MIN_PER_REAL_SEC = TIME_SCALE / 60;
const DAY_START_OFFSET = 8 * 60; // game clock begins at Day 1, 08:00
const MAX_OFFLINE_MS = 60 * 24 * 3600 * 1000; // cap catch-up at 60 real days
const TOAST_DURATION_MS = 10000;
const CITY_KM_PER_UNIT = 0.08;   // city-local map scale (a walkable town, not a 50km sprawl)
const COUNTRY_KM_PER_UNIT = 3;   // country map scale (cross-country distances)
const NIGHT_START_MIN = 22 * 60;
const NIGHT_END_MIN = 6 * 60;
const NIGHT_SPEED_MULT = 0.7;
const WEAR_PER_KM = 0.5;
const WORKSHOP_REPAIR_COST = 600;
const UPGRADE_COST = 4000;
const VEHICLE_RESALE_MAX_RATE = 0.55; // resale share of price at 100% condition
const VEHICLE_RESALE_MIN_RATE = 0.15; // resale share of price at 0% condition (still has scrap/parts value)
const VEHICLE_RESALE_UPGRADE_BONUS_RATE = 0.5; // upgraded suspension adds this share of UPGRADE_COST to resale value
const UPGRADE_RESALE_RATE = 0.5; // selling just the upgrade refunds half of UPGRADE_COST
const MAX_PENDING_JOBS = 3;
const LIVING_COST_PER_DAY = 150;   // food/rent regardless of activity
const VEHICLE_UPKEEP_RATE = 0.00015; // fraction of vehicle price, per day
const BANKRUPTCY_DEBT_LIMIT = -3000;
const LATE_PENALTY_PER_DAY = 0.10; // fraction of payout lost per full day late
const LATE_PENALTY_MAX = 0.9; // never lose more than 90% of the payout
const REFUSE_PENALTY_SAME_LOCATION = 0.5; // returned right back where it was picked up
const REFUSE_PENALTY_OTHER_LOCATION = 0.7; // dumped anywhere else
const START_MONEY = 500;

function rand(min, max) { return min + Math.random() * (max - min); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
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
function pickSeeded(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

// ---------- vehicles ----------
// cat: foot | scooter | bike | moped | motorcycle | car | van | truck
// fuel: legs | electric | gasoline | diesel   (legs/electric never "run out" mid-trip in a blocking way handled below)
// draw: how the animated marker is rendered — 'foot' | 'twowheel' | 'car' | 'truck'

const VEHICLES = [
  { id: 'foot', name: 'Пешком', cat: 'foot', draw: 'foot', speed: 5, price: 0, kg: 5, l: 10, fat: 3.0, trip: 8, fuel: 'legs', tank: Infinity },

  { id: 'scoot_manual1', name: 'Самокат простой', cat: 'scooter', draw: 'twowheel', speed: 10, price: 1200, kg: 3, l: 5, fat: 2.4, trip: 4, fuel: 'legs', tank: Infinity },
  { id: 'scoot_manual2', name: 'Самокат спортивный', cat: 'scooter', draw: 'twowheel', speed: 13, price: 3200, kg: 4, l: 6, fat: 2.1, trip: 5, fuel: 'legs', tank: Infinity },
  { id: 'scoot_e1', name: 'Электросамокат бюджетный', cat: 'scooter', draw: 'twowheel', speed: 20, price: 12000, kg: 5, l: 8, fat: 0.5, trip: 15, fuel: 'electric', tank: 20 },
  { id: 'scoot_e2', name: 'Электросамокат городской', cat: 'scooter', draw: 'twowheel', speed: 25, price: 20000, kg: 6, l: 10, fat: 0.4, trip: 20, fuel: 'electric', tank: 30 },
  { id: 'scoot_e3', name: 'Электросамокат мощный', cat: 'scooter', draw: 'twowheel', speed: 32, price: 35000, kg: 8, l: 12, fat: 0.35, trip: 25, fuel: 'electric', tank: 40 },
  { id: 'scoot_e4', name: 'Электросамокат внедорожный', cat: 'scooter', draw: 'twowheel', speed: 38, price: 55000, kg: 10, l: 15, fat: 0.3, trip: 35, fuel: 'electric', tank: 50 },

  { id: 'bike_city', name: 'Городской велосипед', cat: 'bike', draw: 'twowheel', speed: 15, price: 6000, kg: 8, l: 15, fat: 1.8, trip: 12, fuel: 'legs', tank: Infinity },
  { id: 'bike_fold', name: 'Складной велосипед', cat: 'bike', draw: 'twowheel', speed: 14, price: 8000, kg: 7, l: 12, fat: 1.9, trip: 10, fuel: 'legs', tank: Infinity },
  { id: 'bike_road', name: 'Шоссейный велосипед', cat: 'bike', draw: 'twowheel', speed: 22, price: 15000, kg: 6, l: 10, fat: 1.6, trip: 18, fuel: 'legs', tank: Infinity },
  { id: 'bike_cargo', name: 'Грузовой велосипед (карго-байк)', cat: 'bike', draw: 'twowheel', speed: 16, price: 25000, kg: 40, l: 80, fat: 2.0, trip: 15, fuel: 'legs', tank: Infinity },
  { id: 'bike_e1', name: 'Электровелосипед бюджетный', cat: 'bike', draw: 'twowheel', speed: 22, price: 30000, kg: 15, l: 25, fat: 0.5, trip: 30, fuel: 'electric', tank: 40 },
  { id: 'bike_e2', name: 'Электровелосипед городской', cat: 'bike', draw: 'twowheel', speed: 27, price: 45000, kg: 18, l: 30, fat: 0.45, trip: 40, fuel: 'electric', tank: 55 },
  { id: 'bike_e_cargo', name: 'Электрокарго-байк', cat: 'bike', draw: 'twowheel', speed: 24, price: 70000, kg: 60, l: 120, fat: 0.5, trip: 35, fuel: 'electric', tank: 50 },
  { id: 'bike_e3', name: 'Электровелосипед мощный', cat: 'bike', draw: 'twowheel', speed: 32, price: 95000, kg: 20, l: 35, fat: 0.4, trip: 50, fuel: 'electric', tank: 70 },

  { id: 'moped_50', name: 'Мопед 50 куб.см', cat: 'moped', draw: 'twowheel', speed: 45, price: 60000, kg: 15, l: 25, fat: 0.35, trip: 60, fuel: 'gasoline', tank: 90 },
  { id: 'moped_cargo', name: 'Мопед грузовой', cat: 'moped', draw: 'twowheel', speed: 50, price: 110000, kg: 50, l: 90, fat: 0.35, trip: 70, fuel: 'gasoline', tank: 100 },
  { id: 'scooter_city', name: 'Скутер городской', cat: 'moped', draw: 'twowheel', speed: 55, price: 85000, kg: 20, l: 35, fat: 0.3, trip: 80, fuel: 'gasoline', tank: 120 },
  { id: 'scooter_tour', name: 'Скутер туристический', cat: 'moped', draw: 'twowheel', speed: 65, price: 120000, kg: 25, l: 40, fat: 0.3, trip: 100, fuel: 'gasoline', tank: 150 },
  { id: 'escooter_moto', name: 'Электроскутер', cat: 'moped', draw: 'twowheel', speed: 60, price: 140000, kg: 25, l: 40, fat: 0.25, trip: 90, fuel: 'electric', tank: 110 },
  { id: 'scooter_prem', name: 'Скутер премиум', cat: 'moped', draw: 'twowheel', speed: 70, price: 180000, kg: 28, l: 45, fat: 0.25, trip: 110, fuel: 'gasoline', tank: 160 },
  { id: 'escooter_long', name: 'Электроскутер дальнобойный', cat: 'moped', draw: 'twowheel', speed: 65, price: 220000, kg: 30, l: 45, fat: 0.2, trip: 130, fuel: 'electric', tank: 160 },
  { id: 'scooter_sport', name: 'Скутер спорт', cat: 'moped', draw: 'twowheel', speed: 80, price: 260000, kg: 20, l: 30, fat: 0.25, trip: 120, fuel: 'gasoline', tank: 150 },

  { id: 'moto_125', name: 'Мотоцикл лёгкий 125cc', cat: 'motorcycle', draw: 'twowheel', speed: 90, price: 180000, kg: 20, l: 30, fat: 0.2, trip: 150, fuel: 'gasoline', tank: 200 },
  { id: 'moto_enduro', name: 'Мотоцикл эндуро', cat: 'motorcycle', draw: 'twowheel', speed: 100, price: 320000, kg: 25, l: 35, fat: 0.2, trip: 180, fuel: 'gasoline', tank: 250 },
  { id: 'moto_400', name: 'Мотоцикл городской 400cc', cat: 'motorcycle', draw: 'twowheel', speed: 110, price: 450000, kg: 25, l: 40, fat: 0.18, trip: 220, fuel: 'gasoline', tank: 300 },
  { id: 'moto_tourer', name: 'Мотоцикл-турер', cat: 'motorcycle', draw: 'twowheel', speed: 120, price: 650000, kg: 35, l: 60, fat: 0.15, trip: 280, fuel: 'gasoline', tank: 380 },
  { id: 'moto_sport', name: 'Мотоцикл спортивный', cat: 'motorcycle', draw: 'twowheel', speed: 140, price: 900000, kg: 15, l: 20, fat: 0.2, trip: 250, fuel: 'gasoline', tank: 320 },
  { id: 'moto_prem', name: 'Мотоцикл премиум-турер', cat: 'motorcycle', draw: 'twowheel', speed: 130, price: 1400000, kg: 45, l: 80, fat: 0.13, trip: 350, fuel: 'gasoline', tank: 450 },

  { id: 'car_sedan_used', name: 'Подержанный седан', cat: 'car', draw: 'car', speed: 90, price: 450000, kg: 300, l: 400, fat: 0.15, trip: 400, fuel: 'gasoline', tank: 500 },
  { id: 'car_hatch', name: 'Компактный хэтчбек', cat: 'car', draw: 'car', speed: 100, price: 650000, kg: 320, l: 420, fat: 0.13, trip: 450, fuel: 'gasoline', tank: 550 },
  { id: 'car_wagon', name: 'Универсал', cat: 'car', draw: 'car', speed: 100, price: 900000, kg: 400, l: 600, fat: 0.13, trip: 500, fuel: 'gasoline', tank: 600 },
  { id: 'car_crossover', name: 'Кроссовер', cat: 'car', draw: 'car', speed: 110, price: 1300000, kg: 450, l: 650, fat: 0.12, trip: 550, fuel: 'gasoline', tank: 650 },
  { id: 'car_business', name: 'Бизнес-седан', cat: 'car', draw: 'car', speed: 120, price: 1800000, kg: 400, l: 550, fat: 0.1, trip: 600, fuel: 'gasoline', tank: 700 },
  { id: 'car_ev_city', name: 'Электромобиль городской', cat: 'car', draw: 'car', speed: 110, price: 2200000, kg: 400, l: 550, fat: 0.1, trip: 350, fuel: 'electric', tank: 400 },
  { id: 'car_suv', name: 'Внедорожник', cat: 'car', draw: 'car', speed: 115, price: 2800000, kg: 600, l: 900, fat: 0.1, trip: 650, fuel: 'gasoline', tank: 800 },
  { id: 'car_prem_sedan', name: 'Премиум седан', cat: 'car', draw: 'car', speed: 130, price: 3800000, kg: 400, l: 550, fat: 0.08, trip: 700, fuel: 'gasoline', tank: 850 },
  { id: 'car_ev_prem', name: 'Электромобиль премиум', cat: 'car', draw: 'car', speed: 130, price: 5500000, kg: 500, l: 700, fat: 0.08, trip: 500, fuel: 'electric', tank: 550 },
  { id: 'car_sport', name: 'Спорткар', cat: 'car', draw: 'car', speed: 150, price: 7000000, kg: 150, l: 200, fat: 0.1, trip: 600, fuel: 'gasoline', tank: 750 },

  { id: 'van_small', name: 'Малый фургон', cat: 'van', draw: 'truck', speed: 90, price: 1200000, kg: 800, l: 2500, fat: 0.1, trip: 500, fuel: 'gasoline', tank: 700 },
  { id: 'van_mid', name: 'Фургон средний', cat: 'van', draw: 'truck', speed: 90, price: 2200000, kg: 1500, l: 5000, fat: 0.1, trip: 600, fuel: 'gasoline', tank: 850 },
  { id: 'van_fridge', name: 'Рефрижератор малый', cat: 'van', draw: 'truck', speed: 85, price: 3200000, kg: 1200, l: 4000, fat: 0.1, trip: 550, fuel: 'diesel', tank: 800, fridge: true },
  { id: 'truck_mid', name: 'Грузовик среднетоннажный', cat: 'truck', draw: 'truck', speed: 80, price: 4500000, kg: 3500, l: 12000, fat: 0.08, trip: 700, fuel: 'diesel', tank: 1000 },
  { id: 'truck_semi', name: 'Фура (полуприцеп)', cat: 'truck', draw: 'truck', speed: 85, price: 9000000, kg: 20000, l: 60000, fat: 0.06, trip: 1200, fuel: 'diesel', tank: 1800 },
  { id: 'truck_semi_fridge', name: 'Рефрижератор-фура', cat: 'truck', draw: 'truck', speed: 85, price: 12000000, kg: 18000, l: 55000, fat: 0.06, trip: 1200, fuel: 'diesel', tank: 1800, fridge: true },
  { id: 'truck_mega', name: 'Мега-фура премиум', cat: 'truck', draw: 'truck', speed: 90, price: 18000000, kg: 24000, l: 70000, fat: 0.05, trip: 1500, fuel: 'diesel', tank: 2200 },
];
const VEHICLE_BY_ID = {};
VEHICLES.forEach(v => { VEHICLE_BY_ID[v.id] = v; });

const CAT_GLYPH = { foot: '🚶', scooter: '🛴', bike: '🚲', moped: '🛵', motorcycle: '🏍️', car: '🚗', van: '🚐', truck: '🚚' };
const CAT_LABEL = { foot: 'Пешком', scooter: 'Самокаты', bike: 'Велосипеды', moped: 'Мопеды и скутеры', motorcycle: 'Мотоциклы', car: 'Автомобили', van: 'Фургоны', truck: 'Грузовики' };
const VEHICLE_CATS_ORDER = ['foot', 'scooter', 'bike', 'moped', 'motorcycle', 'car', 'van', 'truck'];

const FUEL_COST_PER_KM_RANGE = { gasoline: 2.6, diesel: 2.2, electric: 1.1, legs: 0 };

const BREAKDOWN_TYPES_TWOWHEEL = [
  { id: 'flat_tire', label: 'Спустило колесо', severity: 'minor', selfFixCost: 250, selfFixMinutes: 15, ignorePenalty: 1.15 },
  { id: 'chain', label: 'Слетела цепь', severity: 'minor', selfFixCost: 150, selfFixMinutes: 8, ignorePenalty: 1.1 },
  { id: 'wheel_bent', label: 'Погнулось колесо', severity: 'severe', towCost: 2000, towMinutes: 40 },
  { id: 'frame_crack', label: 'Треснула рама', severity: 'severe', towCost: 4000, towMinutes: 70 },
];
const BREAKDOWN_TYPES_MOTOR = [
  { id: 'flat_tire_m', label: 'Прокол колеса', severity: 'minor', selfFixCost: 900, selfFixMinutes: 20, ignorePenalty: 1.1 },
  { id: 'engine_trouble', label: 'Мелкая неисправность двигателя', severity: 'minor', selfFixCost: 1500, selfFixMinutes: 25, ignorePenalty: 1.15 },
  { id: 'wheel_bent_m', label: 'Погнуло диск', severity: 'severe', towCost: 6000, towMinutes: 50 },
  { id: 'transmission_fail', label: 'Отказала коробка передач', severity: 'severe', towCost: 15000, towMinutes: 90 },
];
function breakdownPoolFor(vehicleSpec) {
  return (vehicleSpec.cat === 'foot' || vehicleSpec.cat === 'scooter' || vehicleSpec.cat === 'bike')
    ? BREAKDOWN_TYPES_TWOWHEEL
    : BREAKDOWN_TYPES_MOTOR;
}

// ---------- equipment ----------

const EQUIPMENT = [
  { id: 'thermal_bag', name: 'Термосумка', price: 2500, unlocks: ['chilled'] },
  { id: 'fridge_box', name: 'Холодильный бокс (аккумуляторный)', price: 18000, unlocks: ['chilled', 'frozen'] },
  { id: 'pet_carrier_small', name: 'Переноска для мелких животных', price: 3000, unlocks: ['live_small'] },
  { id: 'pet_carrier_large', name: 'Клетка/переноска для крупных животных', price: 9000, unlocks: ['live_large'] },
  { id: 'fragile_case', name: 'Кейс для хрупких грузов', price: 4000, unlocks: ['fragile'] },
  { id: 'secure_case', name: 'Опломбированный кейс (ценности/документы)', price: 6000, unlocks: ['valuable'] },
];

const STORAGE_LABEL = { normal: 'обычные условия', chilled: 'нужна термосумка/холод', frozen: 'нужна заморозка', fragile: 'хрупкое', live_small: 'нужна переноска (мелкое животное)', live_large: 'нужна клетка (крупное животное)', valuable: 'нужен опломбированный кейс' };
const STORAGE_GLYPH = { normal: '📦', chilled: '🧊', frozen: '❄️', fragile: '🥚', live_small: '🐾', live_large: '🐕', valuable: '💎' };

// ---------- items & urgency ----------

const ITEM_TEMPLATES = [
  { name: 'Коробка с одеждой', storage: 'normal', weightKg: [1, 4], volumeL: [8, 20], urgency: ['none', 'standard'] },
  { name: 'Книги', storage: 'normal', weightKg: [2, 8], volumeL: [5, 15], urgency: ['none'] },
  { name: 'Электроника (гаджеты)', storage: 'fragile', weightKg: [0.3, 2], volumeL: [1, 5], urgency: ['standard', 'urgent'] },
  { name: 'Ноутбук', storage: 'fragile', weightKg: [1.5, 3], volumeL: [3, 6], urgency: ['standard', 'urgent'] },
  { name: 'Торт на заказ', storage: 'chilled', weightKg: [1, 3], volumeL: [8, 20], urgency: ['urgent'] },
  { name: 'Мороженое (опт)', storage: 'frozen', weightKg: [3, 10], volumeL: [10, 25], urgency: ['urgent'] },
  { name: 'Замороженные полуфабрикаты', storage: 'frozen', weightKg: [5, 15], volumeL: [15, 35], urgency: ['standard'] },
  { name: 'Свежие продукты', storage: 'chilled', weightKg: [2, 10], volumeL: [10, 30], urgency: ['standard', 'urgent'] },
  { name: 'Букет цветов', storage: 'fragile', weightKg: [0.5, 2], volumeL: [5, 15], urgency: ['urgent'] },
  { name: 'Лекарства', storage: 'chilled', weightKg: [0.2, 2], volumeL: [1, 5], urgency: ['urgent'] },
  { name: 'Документы', storage: 'valuable', weightKg: [0.1, 0.5], volumeL: [0.5, 1], urgency: ['urgent', 'standard'] },
  { name: 'Ювелирные изделия', storage: 'valuable', weightKg: [0.1, 1], volumeL: [0.5, 2], urgency: ['standard'] },
  { name: 'Кот в переноске', storage: 'live_small', weightKg: [3, 6], volumeL: [15, 25], urgency: ['standard'] },
  { name: 'Небольшая собака', storage: 'live_small', weightKg: [5, 12], volumeL: [20, 35], urgency: ['standard'] },
  { name: 'Крупная собака', storage: 'live_large', weightKg: [15, 40], volumeL: [40, 70], urgency: ['standard'] },
  { name: 'Стройматериалы (мешки смеси)', storage: 'normal', weightKg: [20, 60], volumeL: [20, 50], urgency: ['none'] },
  { name: 'Мебель (разобранная)', storage: 'normal', weightKg: [30, 120], volumeL: [100, 400], urgency: ['none', 'standard'] },
  { name: 'Бытовая техника', storage: 'fragile', weightKg: [5, 40], volumeL: [20, 100], urgency: ['standard'] },
  { name: 'Пицца/готовая еда', storage: 'chilled', weightKg: [1, 4], volumeL: [5, 15], urgency: ['urgent'] },
  { name: 'Автозапчасти', storage: 'normal', weightKg: [2, 25], volumeL: [3, 30], urgency: ['standard', 'none'] },
];

const URGENCY_LEVELS = {
  urgent: { label: 'Срочно', windowRealMs: 60 * 60 * 1000 },
  standard: { label: 'Обычно', windowRealMs: 24 * 60 * 60 * 1000 },
  none: { label: 'Без срока', windowRealMs: Infinity },
};

const POINT_STYLES = {
  home: { color: '#e2a63b', glyph: '🏠' },
  cafe: { color: '#d98a3d', glyph: '☕' },
  shop: { color: '#8a63d2', glyph: '🛵' },
  workshop: { color: '#5c8fd6', glyph: '🔧' },
  delivery: { color: '#4a9dd1', glyph: '📦' },
  gas: { color: '#d1574a', glyph: '⛽' },
  waystop: { color: '#4aa17a', glyph: '⛽' },
};

// ---------- Ривное — стартовый (полностью авторский) город ----------

const RIVNOE_POINTS_RAW = [
  { id: 'home', name: 'Дом', type: 'home', x: 12, y: 50 },
  { id: 'cafe', name: 'Кафе «Уют»', type: 'cafe', x: 35, y: 40 },
  { id: 'shop', name: 'Магазин техники «Скорость»', type: 'shop', x: 70, y: 28 },
  { id: 'workshop', name: 'Мастерская «Гайка»', type: 'workshop', x: 78, y: 55 },
  { id: 'gas', name: 'АЗС «Полный бак»', type: 'gas', x: 45, y: 75 },
  { id: 'warehouse', name: 'Склад «Логист»', type: 'delivery', x: 50, y: 50 },
  { id: 'mall', name: 'ТЦ Горизонт', type: 'delivery', x: 22, y: 15 },
  { id: 'bus', name: 'Автовокзал', type: 'delivery', x: 85, y: 15 },
  { id: 'hospital', name: 'Больница №1', type: 'delivery', x: 60, y: 8 },
  { id: 'market', name: 'Рынок', type: 'delivery', x: 28, y: 66 },
  { id: 'district', name: 'Спальный район', type: 'delivery', x: 85, y: 85 },
  { id: 'park', name: 'Парк Победы', type: 'delivery', x: 15, y: 82 },
];
const RIVNOE_EDGES_RAW = [
  ['home', 'park'], ['home', 'cafe'],
  ['cafe', 'mall'], ['cafe', 'market'], ['cafe', 'shop'], ['cafe', 'warehouse'],
  ['mall', 'bus'], ['mall', 'hospital'], ['mall', 'warehouse'],
  ['bus', 'hospital'], ['bus', 'shop'],
  ['shop', 'workshop'], ['shop', 'hospital'], ['shop', 'warehouse'],
  ['workshop', 'district'],
  ['market', 'park'], ['market', 'district'], ['market', 'warehouse'],
  ['park', 'district'],
  ['market', 'gas'], ['warehouse', 'gas'],
];

// ---------- country cities ----------

const COUNTRY_NAME = 'Залесье';
const COUNTRY_CITIES = [
  { id: 'rivnoe', name: 'Ривное', x: 26, y: 58 },
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
function cityMeta(id) { return COUNTRY_CITIES.find(c => c.id === id); }

// Every city (incl. procedurally generated ones) gets: a namespaced point set,
// a namespaced edge list, and exactly one "gate" point wired to the country
// highway network. WORLD_POINTS/WORLD_EDGES accumulate everyone's points.
const WORLD_POINTS = {};
const WORLD_EDGES = [];

function addCityDef(cityId, rawPoints, rawEdges, gateAnchorLocalId) {
  rawPoints.forEach(p => {
    WORLD_POINTS[`${cityId}:${p.id}`] = { id: `${cityId}:${p.id}`, name: p.name, type: p.type, x: p.x, y: p.y };
  });
  rawEdges.forEach(([a, b]) => WORLD_EDGES.push([`${cityId}:${a}`, `${cityId}:${b}`]));
  const meta = cityMeta(cityId);
  const gateId = `${cityId}:gate`;
  WORLD_POINTS[gateId] = { id: gateId, name: 'Выезд на трассу', type: 'gate', x: 3, y: 50, countryX: meta.x, countryY: meta.y };
  WORLD_EDGES.push([gateId, `${cityId}:${gateAnchorLocalId}`]);
}

addCityDef('rivnoe', RIVNOE_POINTS_RAW, RIVNOE_EDGES_RAW, 'home');

function generateCityLayout(cityId) {
  const rng = seededRandom(hashStr('layout:' + cityId));
  const count = 7 + Math.floor(rng() * 3);
  const fillerTypes = ['delivery', 'delivery', 'delivery', 'gas'];
  const points = [
    { id: 'p0', name: 'Центр', type: 'delivery', x: 45 + rng() * 10, y: 45 + rng() * 10 },
    { id: 'p1', name: 'Кафе «Дорожное»', type: 'cafe', x: 20 + rng() * 20, y: 20 + rng() * 20 },
    { id: 'p2', name: 'Магазин техники', type: 'shop', x: 65 + rng() * 20, y: 20 + rng() * 20 },
    { id: 'p3', name: 'Мастерская', type: 'workshop', x: 65 + rng() * 20, y: 65 + rng() * 20 },
  ];
  for (let i = 4; i < count; i++) {
    points.push({
      id: `p${i}`, name: `Точка ${i}`,
      type: pickSeeded(fillerTypes, rng),
      x: 12 + rng() * 76, y: 12 + rng() * 76,
    });
  }
  const edges = [];
  for (let i = 1; i < points.length; i++) edges.push([points[i - 1].id, points[i].id]);
  const extra = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < extra; i++) {
    const a = points[Math.floor(rng() * points.length)];
    const b = points[Math.floor(rng() * points.length)];
    if (a.id !== b.id) edges.push([a.id, b.id]);
  }
  return { points, edges };
}

COUNTRY_CITIES.filter(c => c.id !== 'rivnoe').forEach(c => {
  const layout = generateCityLayout(c.id);
  addCityDef(c.id, layout.points, layout.edges, 'p0');
});

function pointSpace(id) { return id.startsWith('hwy:') ? 'country' : id.split(':')[0]; }
function pointById(id) { return WORLD_POINTS[id]; }

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

// ---------- highway chains between cities (with waystops) ----------

COUNTRY_ROAD_EDGES.forEach(([cityAId, cityBId]) => {
  const a = cityMeta(cityAId), b = cityMeta(cityBId);
  const edgeKey = [cityAId, cityBId].slice().sort().join('-');
  const fullPoly = windingPolyline(`country:${edgeKey}`, a, b, 7, 7);
  const totalLenKm = polylineLengthUnits(fullPoly) * COUNTRY_KM_PER_UNIT;
  const stopCount = clamp(Math.floor(totalLenKm / 45), 0, 3);
  const fractions = [];
  for (let i = 1; i <= stopCount; i++) fractions.push(i / (stopCount + 1));

  let prevId = `${cityAId}:gate`;
  fractions.forEach((f, i) => {
    const pos = pointOnPolyline(fullPoly, f);
    const stopId = `hwy:${edgeKey}:${i}`;
    WORLD_POINTS[stopId] = { id: stopId, name: `Придорожная стоянка ${i + 1} (${a.name}—${b.name})`, type: 'waystop', x: pos.x, y: pos.y };
    WORLD_EDGES.push([prevId, stopId]);
    prevId = stopId;
  });
  WORLD_EDGES.push([prevId, `${cityBId}:gate`]);
});

const ALL_DELIVERY_POINT_IDS = Object.values(WORLD_POINTS).filter(p => p.type === 'delivery').map(p => p.id);
const DELIVERY_BY_CITY = {};
ALL_DELIVERY_POINT_IDS.forEach(id => {
  const city = pointSpace(id);
  (DELIVERY_BY_CITY[city] = DELIVERY_BY_CITY[city] || []).push(id);
});
const CITIES_WITH_DELIVERY = Object.keys(DELIVERY_BY_CITY).filter(c => DELIVERY_BY_CITY[c].length >= 2);

// ---------- space-aware distance & pathfinding over the unified world graph ----------
// An edge is "city-local" only if both endpoints belong to the same city
// (using its own fine-grained 0-100 map + CITY_KM_PER_UNIT). Anything that
// touches a highway node, or crosses between a gate and its own city, is
// resolved in "country" space (using COUNTRY_KM_PER_UNIT and the point's
// countryX/countryY when it has one — gates have both a local and a country
// position, everything else has just one).

function edgeSpace(aId, bId) {
  const spaceA = pointSpace(aId), spaceB = pointSpace(bId);
  return (spaceA === spaceB && spaceA !== 'country') ? spaceA : 'country';
}
function edgeCoord(id, space) {
  const pt = WORLD_POINTS[id];
  if (space === 'country' && pt.countryX !== undefined) return { x: pt.countryX, y: pt.countryY };
  return { x: pt.x, y: pt.y };
}
function edgeScale(space) { return space === 'country' ? COUNTRY_KM_PER_UNIT : CITY_KM_PER_UNIT; }
function edgeJitter(space) { return space === 'country' ? [7, 7] : [5, 5]; }

function segDist(aId, bId) {
  const space = edgeSpace(aId, bId);
  const a = edgeCoord(aId, space), b = edgeCoord(bId, space);
  const [seg, off] = edgeJitter(space);
  const poly = getEdgePolyline(space, aId, bId, a, b, seg, off);
  return polylineLengthUnits(poly) * edgeScale(space);
}

// A waypoint is either a node id (string) or a plain {x,y,space} coordinate —
// the latter is used for the courier's exact live position when a route is
// redirected mid-trip, so the remaining distance is charged honestly instead
// of snapping for free to the nearest graph node.
function waypointCoord(wp) { return typeof wp === 'string' ? WORLD_POINTS[wp] : wp; }
function waypointSpace(wp) { return typeof wp === 'string' ? pointSpace(wp) : wp.space; }
function waypointDist(wpA, wpB) {
  if (typeof wpA === 'string' && typeof wpB === 'string') return segDist(wpA, wpB);
  const space = typeof wpA !== 'string' ? wpA.space : wpB.space;
  const a = typeof wpA === 'string' ? edgeCoord(wpA, space) : wpA;
  const b = typeof wpB === 'string' ? edgeCoord(wpB, space) : wpB;
  return Math.hypot(a.x - b.x, a.y - b.y) * edgeScale(space);
}

function buildGraph() {
  const g = {};
  Object.keys(WORLD_POINTS).forEach(id => { g[id] = []; });
  WORLD_EDGES.forEach(([a, b]) => {
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
  Object.keys(WORLD_POINTS).forEach(id => { dist[id] = Infinity; });
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

// Returns {x,y,space} — space tells the renderer which canvas (which city, or
// the country map) this live position belongs to.
function positionAlongPath(path, fracKm, totalKm) {
  if (path.length === 1) {
    const p = waypointCoord(path[0]);
    return { x: p.x, y: p.y, space: waypointSpace(path[0]) };
  }
  let remaining = clamp(fracKm, 0, totalKm);
  for (let i = 0; i < path.length - 1; i++) {
    const wpA = path[i], wpB = path[i + 1];
    const bothStr = typeof wpA === 'string' && typeof wpB === 'string';
    let segLen, poly = null, space;
    if (bothStr) {
      space = edgeSpace(wpA, wpB);
      const a = edgeCoord(wpA, space), b = edgeCoord(wpB, space);
      const [seg, off] = edgeJitter(space);
      poly = getEdgePolyline(space, wpA, wpB, a, b, seg, off);
      segLen = polylineLengthUnits(poly) * edgeScale(space);
    } else {
      space = waypointSpace(wpA) !== 'country' ? waypointSpace(wpA) : waypointSpace(wpB);
      segLen = waypointDist(wpA, wpB);
    }
    if (remaining <= segLen || i === path.length - 2) {
      if (poly) { const pt = pointOnPolyline(poly, segLen === 0 ? 0 : remaining / segLen); return { x: pt.x, y: pt.y, space }; }
      const a = typeof wpA === 'string' ? edgeCoord(wpA, space) : wpA;
      const b = typeof wpB === 'string' ? edgeCoord(wpB, space) : wpB;
      const t = segLen === 0 ? 0 : clamp(remaining / segLen, 0, 1);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, space };
    }
    remaining -= segLen;
  }
  const lastId = path[path.length - 1];
  const last = waypointCoord(lastId);
  return { x: last.x, y: last.y, space: waypointSpace(lastId) };
}

function isNight() {
  const minuteOfDay = (state.gameTime + DAY_START_OFFSET) % 1440;
  return minuteOfDay >= NIGHT_START_MIN || minuteOfDay < NIGHT_END_MIN;
}

// ---------- state ----------

let state = null;
let jobIdSeq = 1;
let actionIdSeq = 1;
let lastFrameTs = null;
let autosaveAccum = 0;
let toasts = [];
let uiSelectedPointId = null;
let catchupBuffer = null;

function newGameState() {
  const startingVehicle = { type: 'foot', condition: 100, upgraded: false, fuel: Infinity };
  return {
    money: START_MONEY,
    gameTime: 0,
    lastRealTimestamp: Date.now(),
    gameOver: null, // null | 'bankruptcy'
    player: {
      positionId: 'rivnoe:home',
      status: 'idle', // idle | moving | resting | eating
      activity: null,
      fatigue: 15,
      hunger: 15,
      vehicles: [startingVehicle], // every owned vehicle instance; .vehicle below is always one of these (same reference)
      vehicle: startingVehicle,
      restElapsed: 0,
      eatElapsed: 0,
      restPlan: null,
      eatPlan: null,
      jobs: [], // { id, fromId, toId, itemName, storage, weightKg, volumeL, urgencyKey, deadlineReal, payout, pickedUp }
      equipment: {},
      warnedHunger: false,
      warnedFatigue: false,
      warnedDebt: false,
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

// ---------- cargo & equipment ----------

function vehicleSpec() { return VEHICLE_BY_ID[state.player.vehicle.type]; }

function hasRequiredEquipment(storage) {
  if (storage === 'normal') return true;
  const spec = vehicleSpec();
  if (spec.fridge && (storage === 'chilled' || storage === 'frozen')) return true;
  const need = EQUIPMENT.find(e => e.unlocks.includes(storage));
  if (!need) return true;
  return !!state.player.equipment[need.id];
}

function equipmentLabelFor(storage) {
  const spec = vehicleSpec();
  if (spec.fridge && (storage === 'chilled' || storage === 'frozen')) return null;
  const need = EQUIPMENT.find(e => e.unlocks.includes(storage));
  return need ? need.name : null;
}

function cargoWeightKg() { return state.player.jobs.filter(j => j.pickedUp).reduce((s, j) => s + j.weightKg, 0); }
function cargoVolumeL() { return state.player.jobs.filter(j => j.pickedUp).reduce((s, j) => s + j.volumeL, 0); }

// ---------- jobs: generation, taking, pickup, delivery ----------

function pickJobEndpoints() {
  // Most jobs stay inside one city (walkable/bikeable); only a minority are
  // genuine cross-country hauls that need a real vehicle.
  if (Math.random() < 0.8 && CITIES_WITH_DELIVERY.length > 0) {
    const city = Math.random() < 0.55 ? 'rivnoe' : pick(CITIES_WITH_DELIVERY);
    const pts = DELIVERY_BY_CITY[city];
    if (pts && pts.length >= 2) {
      const fromId = pick(pts);
      let toId = pick(pts), guard = 0;
      while (toId === fromId && guard++ < 20) toId = pick(pts);
      return { fromId, toId };
    }
  }
  const fromId = pick(ALL_DELIVERY_POINT_IDS);
  let toId = pick(ALL_DELIVERY_POINT_IDS), guard = 0;
  while (pointSpace(toId) === pointSpace(fromId) && guard++ < 20) toId = pick(ALL_DELIVERY_POINT_IDS);
  return { fromId, toId };
}

function generateJob() {
  const { fromId, toId } = pickJobEndpoints();
  const template = pick(ITEM_TEMPLATES);
  const weightKg = Math.round(rand(template.weightKg[0], template.weightKg[1]) * 10) / 10;
  const volumeL = Math.round(rand(template.volumeL[0], template.volumeL[1]));
  const urgencyKey = pick(template.urgency);
  const urgency = URGENCY_LEVELS[urgencyKey];
  const distanceKm = pathDistanceKm(shortestPath(fromId, toId));
  const storageSurcharge = { normal: 0, chilled: 80, frozen: 150, fragile: 60, live_small: 120, live_large: 220, valuable: 100 }[template.storage] || 0;
  const urgencySurcharge = { urgent: 250, standard: 60, none: 0 }[urgencyKey];
  const weightSurcharge = Math.round(weightKg * 3);
  const payout = Math.round(120 + distanceKm * 20 + storageSurcharge + urgencySurcharge + weightSurcharge + rand(-15, 25));
  return {
    id: jobIdSeq++, fromId, toId,
    itemName: template.name, storage: template.storage, weightKg, volumeL,
    urgencyKey, urgencyLabel: urgency.label,
    deadlineReal: urgency.windowRealMs === Infinity ? null : Date.now() + urgency.windowRealMs,
    distanceKm: Math.round(distanceKm * 10) / 10,
    payout, pickedUp: false,
  };
}

function jobPoolTarget() { return clamp(6 + Math.floor(state.stats.jobsCompleted / 4), 6, 24); }
function maintainJobPool() {
  while (state.availableJobs.length < jobPoolTarget()) state.availableJobs.push(generateJob());
}

function checkJobDeadlines() {
  const now = Date.now();
  const before = state.availableJobs.length;
  state.availableJobs = state.availableJobs.filter(j => !(j.deadlineReal && now > j.deadlineReal));
  if (state.availableJobs.length < before) log('Один из срочных заказов просрочен и снят с биржи', { silent: true });

  const heldBefore = state.player.jobs.length;
  state.player.jobs = state.player.jobs.filter(j => {
    if (!j.pickedUp && j.deadlineReal && now > j.deadlineReal) return false;
    return true;
  });
  if (state.player.jobs.length < heldBefore) log('Не успел забрать заказ вовремя — заказ отменён', { silent: true });
}

function pushPendingAction(item) {
  item.id = actionIdSeq++;
  state.pendingActions.push(item);
  return item;
}

function takeJob(jobId) {
  const pendingCount = state.player.jobs.filter(j => !j.pickedUp).length;
  if (pendingCount >= MAX_PENDING_JOBS) { toast(`Нельзя резервировать больше ${MAX_PENDING_JOBS} заказов одновременно`); return; }
  const idx = state.availableJobs.findIndex(j => j.id === jobId);
  if (idx === -1) return;
  const job = state.availableJobs.splice(idx, 1)[0];
  state.player.jobs.push(job);
  log(`Взял заказ: ${job.itemName} (${pointById(job.fromId).name} → ${pointById(job.toId).name}), ${job.payout} ₽`);
}

function pickUpJob(jobId) {
  const p = state.player;
  const job = p.jobs.find(j => j.id === jobId && !j.pickedUp);
  if (!job) return;
  if (p.status !== 'idle' || p.positionId !== job.fromId) return;
  if (!hasRequiredEquipment(job.storage)) { toast(`Нужно снаряжение: ${equipmentLabelFor(job.storage)}`); return; }
  const spec = vehicleSpec();
  if (cargoWeightKg() + job.weightKg > spec.kg || cargoVolumeL() + job.volumeL > spec.l) {
    toast('Не влезает — превышен вес или объём груза для текущего транспорта');
    return;
  }
  job.pickedUp = true;
  log(`Забрал заказ: ${job.itemName} → ${pointById(job.toId).name}`);
}

function lateDeliveryPenaltyFrac(job) {
  if (!job.deadlineReal) return 0;
  const msLate = Date.now() - job.deadlineReal;
  if (msLate <= 0) return 0;
  const daysLate = msLate / (24 * 60 * 60 * 1000);
  return clamp(daysLate * LATE_PENALTY_PER_DAY, 0, LATE_PENALTY_MAX);
}

function deliverJob(jobId) {
  const p = state.player;
  const job = p.jobs.find(j => j.id === jobId && j.pickedUp);
  if (!job) return;
  if (p.status !== 'idle' || p.positionId !== job.toId) return;
  const penaltyFrac = lateDeliveryPenaltyFrac(job);
  const actualPayout = Math.round(job.payout * (1 - penaltyFrac));
  state.money += actualPayout;
  state.stats.jobsCompleted++;
  state.stats.totalEarned += actualPayout;
  p.jobs = p.jobs.filter(j => j.id !== jobId);
  if (penaltyFrac > 0) {
    log(`Доставил «${job.itemName}» с опозданием (-${Math.round(penaltyFrac * 100)}%), получил ${actualPayout} ₽ вместо ${job.payout} ₽`);
  } else {
    log(`Доставил «${job.itemName}», получил ${actualPayout} ₽`);
  }
}

function refuseJobPenaltyFrac(job) {
  return state.player.positionId === job.fromId ? REFUSE_PENALTY_SAME_LOCATION : REFUSE_PENALTY_OTHER_LOCATION;
}

function refuseJob(jobId) {
  const p = state.player;
  const job = p.jobs.find(j => j.id === jobId && j.pickedUp);
  if (!job) return;
  if (p.status !== 'idle') { toast('Отказаться можно, только когда стоишь на месте'); return; }
  const penaltyFrac = refuseJobPenaltyFrac(job);
  const penalty = Math.round(job.payout * penaltyFrac);
  state.money -= penalty;
  p.jobs = p.jobs.filter(j => j.id !== jobId);
  const sameSpot = p.positionId === job.fromId;
  log(`Отказался от «${job.itemName}» ${sameSpot ? 'там же, где забрал' : 'не в том месте'} — неустойка ${penalty} ₽`);
}

let pendingRefuseJobId = null;
function openRefuseConfirm(jobId) {
  const job = state.player.jobs.find(j => j.id === jobId && j.pickedUp);
  if (!job) return;
  pendingRefuseJobId = jobId;
  const penaltyFrac = refuseJobPenaltyFrac(job);
  const penalty = Math.round(job.payout * penaltyFrac);
  const sameSpot = state.player.positionId === job.fromId;
  const placeText = sameSpot ? `там же, где забрал (${pointById(job.fromId).name})` : `не в том месте (${pointById(state.player.positionId).name})`;
  el('refuse-text').textContent = `Если отказаться от «${job.itemName}» ${placeText}, спишется неустойка ${penalty} ₽ (${Math.round(penaltyFrac * 100)}% от вознаграждения ${job.payout} ₽).`;
  el('refuse-modal').classList.remove('hidden');
}

// ---------- rest / eat (available at any point; sleeping needs an actual home) ----------

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
const IDLE_REST_OPTION = { id: 'breathe', label: 'Просто отдохнуть, не ложась', minutes: 20, fatigueRelief: 10 };

function cancelCurrentAction() {
  const p = state.player;
  if (p.status === 'resting' || p.status === 'eating') {
    p.status = 'idle'; p.restPlan = null; p.eatPlan = null; p.restElapsed = 0; p.eatElapsed = 0;
  }
}

function startEating(optionId) {
  const p = state.player;
  if (p.status !== 'idle') return;
  const point = pointById(p.positionId);
  const isHome = point.type === 'home';
  const canEatHere = isHome || point.type === 'cafe' || point.type === 'waystop';
  if (!canEatHere) return;
  const opt = EAT_OPTIONS.find(o => o.id === optionId);
  const cost = isHome ? 0 : EAT_PRICE_CAFE[optionId];
  if (state.money < cost) { toast('Не хватает денег'); return; }
  state.money -= cost;
  p.status = 'eating';
  p.eatElapsed = 0;
  p.eatPlan = { totalMinutes: opt.minutes, hungerRelief: opt.hungerRelief, label: opt.label };
  log(isHome ? `Ест дома (${opt.label})` : `Ест: ${opt.label} (${cost} ₽)`, { silent: true });
}

function startSleeping(optionId) {
  const p = state.player;
  if (p.status !== 'idle' || pointById(p.positionId).type !== 'home') return;
  const opt = SLEEP_OPTIONS.find(o => o.id === optionId);
  p.status = 'resting';
  p.restElapsed = 0;
  p.restPlan = { totalMinutes: opt.minutes, fatigueRelief: opt.fatigueRelief, label: opt.label };
  log(`Лёг спать дома: ${opt.label}`, { silent: true });
}

function startIdleRest() {
  const p = state.player;
  if (p.status !== 'idle') return;
  p.status = 'resting';
  p.restElapsed = 0;
  p.restPlan = { totalMinutes: IDLE_REST_OPTION.minutes, fatigueRelief: IDLE_REST_OPTION.fatigueRelief, label: IDLE_REST_OPTION.label };
  log('Немного отдохнул', { silent: true });
}

function interruptRest() {
  const p = state.player;
  if (p.status === 'resting' || p.status === 'eating') { cancelCurrentAction(); log('Прервал отдых', { silent: true }); }
}

// ---------- refuelling ----------

function refuel() {
  const p = state.player;
  const spec = vehicleSpec();
  if (spec.fuel === 'legs') return;
  const point = pointById(p.positionId);
  if (point.type !== 'gas' && point.type !== 'waystop') return;
  if (p.status !== 'idle') return;
  const missing = spec.tank - p.vehicle.fuel;
  if (missing <= 0.01) return;
  const cost = Math.round(missing * FUEL_COST_PER_KM_RANGE[spec.fuel]);
  if (state.money < cost) { toast('Не хватает денег на заправку'); return; }
  state.money -= cost;
  p.vehicle.fuel = spec.tank;
  log(`Заправился (${cost} ₽)`, { silent: true });
}

// ---------- travel ----------

function currentEdgeState() {
  const p = state.player;
  const a = p.activity;
  if (!a) return null;
  let remaining = clamp(a.traveledKm, 0, a.totalKm);
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

function tripFeasibility(totalKm) {
  const spec = vehicleSpec();
  if (totalKm > spec.trip) return { ok: false, reason: `Слишком далеко для «${spec.name}» за один раз (макс. ${spec.trip} км без остановки). Доберись до заправки/стоянки по пути и продолжи оттуда.` };
  if (spec.fuel !== 'legs' && totalKm > state.player.vehicle.fuel) {
    return { ok: false, reason: `Не хватит топлива/заряда (осталось ${Math.round(state.player.vehicle.fuel)} км хода). Заправься или выбери путь через заправку.` };
  }
  return { ok: true };
}

function beginTravelFromWaypoints(path) {
  const p = state.player;
  const targetId = path[path.length - 1];
  const totalKm = pathDistanceKm(path);
  if (totalKm <= 0.0001) { onArrive(targetId); return; }
  const feas = tripFeasibility(totalKm);
  if (!feas.ok) { toast(feas.reason); return; }
  const spec = vehicleSpec();
  p.status = 'moving';
  p.activity = {
    path, targetId,
    traveledKm: 0,
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
    const currentPointRaw = positionAlongPath(p.activity.path, p.activity.traveledKm, p.activity.totalKm);
    const currentPoint = { x: currentPointRaw.x, y: currentPointRaw.y, space: currentPointRaw.space };
    if (!edge) return;
    if (edge.aId === null) {
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

function triggerBreakdown(activity) {
  const p = state.player;
  const spec = vehicleSpec();
  const conditionFactor = (100 - p.vehicle.condition) / 100;
  const severeChance = 0.15 + conditionFactor * 0.5;
  const pool = breakdownPoolFor(spec);
  const candidates = Math.random() < severeChance
    ? pool.filter(b => b.severity === 'severe')
    : pool.filter(b => b.severity === 'minor');
  const type = pick(candidates);
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
  const spec = vehicleSpec();

  if (action.kind === 'breakdown') {
    const type = breakdownPoolFor(spec).find(t => t.id === action.typeId);
    if (choice === 'selfFix') {
      state.money -= type.selfFixCost;
      state.player.vehicle.condition = clamp(state.player.vehicle.condition + 30, 0, 100);
      log(`Починил на месте: ${type.label} (${type.selfFixCost} ₽)`);
    } else if (choice === 'ignore') {
      activity.totalKm *= type.ignorePenalty;
      log(`Поехал дальше, несмотря на «${type.label}»`);
    } else if (choice === 'tow') {
      state.money -= type.towCost;
      state.player.vehicle.condition = 100;
      log(`Вызвал эвакуатор, починили в мастерской за ${type.towCost} ₽`);
    }
  } else if (action.kind === 'exhausted') {
    // Roadside rest only relieves fatigue a little — it does NOT feed the courier.
    state.player.fatigue = 40;
    log('Отдохнул на обочине, силы немного вернулись, но есть по-прежнему хочется');
  }

  activity.problemPending = false;
  activity.problem = null;
  state.pendingActions.splice(idx, 1);
}

function buyVehicle(vehicleId) {
  const v = VEHICLE_BY_ID[vehicleId];
  const p = state.player;
  if (!v || p.status !== 'idle' || pointById(p.positionId).type !== 'shop') return;
  if (p.vehicles.some(veh => veh.type === vehicleId)) { toast('Такая техника уже есть в твоём гараже'); return; }
  if (state.money < v.price) return;
  if (cargoWeightKg() > v.kg || cargoVolumeL() > v.l) { toast('Текущий груз не влезет в этот транспорт'); return; }
  state.money -= v.price;
  const newVehicle = { type: v.id, condition: 100, upgraded: false, fuel: v.tank };
  p.vehicles.push(newVehicle);
  p.vehicle = newVehicle;
  log(`Купил транспорт: ${v.name}`);
}

function switchVehicle(vehicleType) {
  const p = state.player;
  if (p.vehicle.type === vehicleType) return;
  if (p.status !== 'idle') { toast('Пересесть можно, только когда стоишь на месте'); return; }
  const target = p.vehicles.find(veh => veh.type === vehicleType);
  if (!target) return;
  const spec = VEHICLE_BY_ID[vehicleType];
  if (cargoWeightKg() > spec.kg || cargoVolumeL() > spec.l) { toast('Текущий груз не влезет в эту технику'); return; }
  p.vehicle = target;
  log(`Пересел на: ${spec.name}`, { silent: true });
}

function vehicleResaleValue(veh) {
  const spec = VEHICLE_BY_ID[veh.type];
  if (!spec || spec.price === 0) return 0;
  const condFrac = clamp(veh.condition, 0, 100) / 100;
  const rate = VEHICLE_RESALE_MIN_RATE + (VEHICLE_RESALE_MAX_RATE - VEHICLE_RESALE_MIN_RATE) * condFrac;
  let value = spec.price * rate;
  if (veh.upgraded) value += UPGRADE_COST * VEHICLE_RESALE_UPGRADE_BONUS_RATE;
  return Math.round(value / 10) * 10;
}

function sellVehicle(vehicleType) {
  const p = state.player;
  const spec = VEHICLE_BY_ID[vehicleType];
  const veh = p.vehicles.find(v => v.type === vehicleType);
  if (!spec || !veh || spec.price === 0) { toast('Эту технику продать нельзя'); return; }
  if (p.status !== 'idle') { toast('Продавать можно, только когда стоишь на месте'); return; }
  if (p.vehicle.type === vehicleType) { toast('Сначала пересядь на другую технику'); return; }
  const value = vehicleResaleValue(veh);
  p.vehicles = p.vehicles.filter(v => v.type !== vehicleType);
  state.money += value;
  log(`Продал технику: ${spec.name} за ${value.toLocaleString('ru-RU')} ₽`);
}

function sellVehicleUpgrade(vehicleType) {
  const p = state.player;
  const spec = VEHICLE_BY_ID[vehicleType];
  const veh = p.vehicles.find(v => v.type === vehicleType);
  if (!spec || !veh || !veh.upgraded) return;
  if (p.status !== 'idle') { toast('Продавать можно, только когда стоишь на месте'); return; }
  const refund = Math.round(UPGRADE_COST * UPGRADE_RESALE_RATE / 10) * 10;
  veh.upgraded = false;
  state.money += refund;
  log(`Продал улучшение подвески (${spec.name}) за ${refund.toLocaleString('ru-RU')} ₽`);
}

function workshopRepair() {
  const p = state.player;
  if (p.status !== 'idle' || pointById(p.positionId).type !== 'workshop') return;
  if (state.money < WORKSHOP_REPAIR_COST) return;
  state.money -= WORKSHOP_REPAIR_COST;
  p.vehicle.condition = 100;
  log('Сделал полный ремонт в мастерской');
}

function workshopUpgrade() {
  const p = state.player;
  if (p.status !== 'idle' || pointById(p.positionId).type !== 'workshop') return;
  if (p.vehicle.upgraded || state.money < UPGRADE_COST) return;
  state.money -= UPGRADE_COST;
  p.vehicle.upgraded = true;
  log('Укрепил подвеску — поломки реже');
}

function buyEquipment(equipId) {
  const eq = EQUIPMENT.find(e => e.id === equipId);
  const p = state.player;
  if (!eq || p.status !== 'idle' || pointById(p.positionId).type !== 'shop') return;
  if (p.equipment[equipId]) return;
  if (state.money < eq.price) return;
  state.money -= eq.price;
  p.equipment[equipId] = true;
  log(`Купил снаряжение: ${eq.name}`);
}

// ---------- simulation ----------

function simulateTick(dt, summary) {
  if (state.gameOver) return;
  const p = state.player;
  checkJobDeadlines();

  const upkeepPerDay = LIVING_COST_PER_DAY + Math.round(vehicleSpec().price * VEHICLE_UPKEEP_RATE);
  state.money -= upkeepPerDay * (dt / 1440);
  if (state.money <= BANKRUPTCY_DEBT_LIMIT) {
    state.gameOver = 'bankruptcy';
    log(`Банкротство: долг превысил ${-BANKRUPTCY_DEBT_LIMIT} ₽. Расходы на жизнь и технику съели весь бюджет.`);
    return;
  } else if (state.money < 0 && !p.warnedDebt) {
    p.warnedDebt = true;
    toast('Ты в минусе — расходы на жизнь идут в долг. Заработай, пока не наступило банкротство!');
  } else if (state.money >= 0) {
    p.warnedDebt = false;
  }

  if (p.status === 'moving') {
    const a = p.activity;
    if (a.problemPending) {
      p.hunger = clamp(p.hunger + HUNGER_RATE_STUCK * dt, 0, 100);
    } else {
      const spec = vehicleSpec();
      const nightMult = isNight() ? NIGHT_SPEED_MULT : 1;
      const effSpeed = spec.speed * nightMult;
      const kmThisTick = effSpeed * (dt / 60);
      a.traveledKm = clamp(a.traveledKm + kmThisTick, 0, a.totalKm);
      p.fatigue = clamp(p.fatigue + spec.fat * kmThisTick, 0, 100);
      p.hunger = clamp(p.hunger + HUNGER_RATE_MOVING * dt, 0, 100);
      p.vehicle.condition = clamp(p.vehicle.condition - kmThisTick * WEAR_PER_KM, 0, 100);
      if (spec.fuel !== 'legs') p.vehicle.fuel = clamp(p.vehicle.fuel - kmThisTick, 0, spec.tank);

      const progress = a.totalKm > 0 ? a.traveledKm / a.totalKm : 1;
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
      } else if (a.traveledKm >= a.totalKm) {
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
}

const HUNGER_RATE_MOVING = 0.18;
const HUNGER_RATE_IDLE = 0.12;
const HUNGER_RATE_RESTING = 0.08;
const HUNGER_RATE_STUCK = 0.06;

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
    if (state.gameOver) break;
  }
  summary.netMoneyChange = Math.round(state.money - summary.moneyBefore);
  summary.bankrupt = state.gameOver === 'bankruptcy';
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

// JSON round-tripping breaks the shared object identity between
// player.vehicle and its entry in player.vehicles (it deserializes as two
// separate copies) — re-link them, and backfill vehicles for old saves.
function relinkActiveVehicle() {
  const p = state.player;
  if (!p.vehicles || p.vehicles.length === 0) { p.vehicles = [p.vehicle]; return; }
  const match = p.vehicles.find(v => v.type === p.vehicle.type);
  if (match) p.vehicle = match;
  else p.vehicles.push(p.vehicle);
}

function loadGame() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return false;
  state = JSON.parse(raw);
  relinkActiveVehicle();
  return true;
}

function hasSave() { return !!localStorage.getItem(SAVE_KEY); }

// ---------- rendering ----------

const el = id => document.getElementById(id);
const menuScreen = el('menu-screen');
const gameScreen = el('game-screen');
const canvas = el('map-canvas');
const ctx = canvas.getContext('2d');
let lastClickables = {};

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

function drawDecor(decor, toPx, scalePxPerUnit) {
  decor.forests.forEach(f => {
    ctx.fillStyle = 'rgba(70,130,70,0.16)';
    const blobs = [[0, 0], [0.5, 0.3], [-0.4, 0.35], [0.2, -0.4]];
    blobs.forEach(([dx, dy]) => {
      const [x, y] = toPx(f.x + dx * f.r * 0.5, f.y + dy * f.r * 0.5);
      ctx.beginPath(); ctx.arc(x, y, f.r * 0.6 * scalePxPerUnit, 0, Math.PI * 2); ctx.fill();
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
  const [seg, off] = edgeJitter(mapKey === 'country' ? 'country' : 'city');
  ctx.strokeStyle = '#333c4a';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  edges.forEach(([aId, bId]) => {
    const a = byId(aId), b = byId(bId);
    const poly = getEdgePolyline(mapKey, aId, bId, a, b, seg, off);
    strokePolyline(poly, toPx);
  });
  ctx.strokeStyle = '#4a5568';
  ctx.lineWidth = 1;
  edges.forEach(([aId, bId]) => {
    const a = byId(aId), b = byId(bId);
    const poly = getEdgePolyline(mapKey, aId, bId, a, b, seg, off);
    strokePolyline(poly, toPx);
  });
}

// Animated vehicle marker: rotates to face the travel heading, and draws
// rolling wheels (a rotating spoke) instead of a static glyph.
function drawVehicleMarker(cx, cy, angle, drawStyle, traveledKm, isProblem) {
  const bodyColor = isProblem ? '#d9534f' : '#7fd17f';
  const wheelAngle = (traveledKm * 14) % (Math.PI * 2);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  function wheel(wx, wy, r) {
    ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#20242c'; ctx.fill();
    ctx.strokeStyle = '#aab2bd'; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(wx - Math.cos(wheelAngle) * r, wy - Math.sin(wheelAngle) * r);
    ctx.lineTo(wx + Math.cos(wheelAngle) * r, wy + Math.sin(wheelAngle) * r);
    ctx.strokeStyle = '#e5e9ef'; ctx.lineWidth = 1.4; ctx.stroke();
  }

  if (drawStyle === 'foot') {
    ctx.fillStyle = bodyColor;
    ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
    const stride = Math.sin(traveledKm * 20) * 3;
    ctx.strokeStyle = bodyColor; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-2, 3); ctx.lineTo(-2 - stride, 8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(2, 3); ctx.lineTo(2 + stride, 8); ctx.stroke();
  } else if (drawStyle === 'twowheel') {
    wheel(-6, 0, 3.4);
    wheel(6, 0, 3.4);
    ctx.strokeStyle = bodyColor; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(6, 0); ctx.stroke();
    ctx.fillStyle = bodyColor; ctx.beginPath(); ctx.arc(3, -3, 2.2, 0, Math.PI * 2); ctx.fill();
  } else if (drawStyle === 'car') {
    wheel(-6, -4.5, 2.6); wheel(-6, 4.5, 2.6);
    wheel(6, -4.5, 2.6); wheel(6, 4.5, 2.6);
    ctx.fillStyle = bodyColor;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-9, -5.5, 18, 11, 3) : ctx.rect(-9, -5.5, 18, 11);
    ctx.fill();
  } else if (drawStyle === 'truck') {
    wheel(-8, -5.5, 3); wheel(-8, 5.5, 3);
    wheel(2, -5.5, 3); wheel(2, 5.5, 3);
    ctx.fillStyle = bodyColor;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-12, -6.5, 24, 13, 3) : ctx.rect(-12, -6.5, 24, 13);
    ctx.fill();
  }
  ctx.restore();
}

function headingAngle(path, traveledKm, totalKm, space) {
  const ahead = clamp(traveledKm + Math.max(0.05, totalKm * 0.01), 0, totalKm);
  const behind = clamp(traveledKm - Math.max(0.05, totalKm * 0.01), 0, totalKm);
  const p1 = positionAlongPath(path, behind, totalKm);
  const p2 = positionAlongPath(path, ahead, totalKm);
  return Math.atan2(p2.y - p1.y, p2.x - p1.x);
}

// ---------- unified camera: one continuous pan/zoom world, Google-Maps style ----------
// World space = the country's own 0-100 coordinate range. Each city's local
// 0-100 layout is nested into a small CITY_WORLD_RADIUS-sized box centered on
// that city's country position, so a single camera (pan + zoom) covers both
// the whole country and every city's streets without a mode switch.

const CITY_WORLD_RADIUS = 5;
const ZOOM_MIN = 2.2;
const ZOOM_MAX = 90;
const LOD_RADIUS_THRESHOLD_PX = 55; // city on-screen radius (px) above which it expands to full detail

const camera = { x: 26, y: 58, zoom: 34 }; // overwritten by centerOnPlayer() on load
let cameraTween = null;

function localToWorld(x, y, space) {
  if (space === 'country') return { x, y };
  const meta = cityMeta(space);
  return { x: meta.x + (x - 50) / 50 * CITY_WORLD_RADIUS, y: meta.y + (y - 50) / 50 * CITY_WORLD_RADIUS };
}
function pointToWorld(id) {
  const pt = WORLD_POINTS[id];
  return localToWorld(pt.x, pt.y, pointSpace(id));
}
function worldToScreen(wx, wy, w, h) {
  return [(wx - camera.x) * camera.zoom + w / 2, (wy - camera.y) * camera.zoom + h / 2];
}
function cityDetailVisible() { return CITY_WORLD_RADIUS * camera.zoom >= LOD_RADIUS_THRESHOLD_PX; }

function livePlayerWorldPos() {
  const p = state.player;
  if (p.status === 'moving' && p.activity) {
    const pos = positionAlongPath(p.activity.path, p.activity.traveledKm, p.activity.totalKm);
    return { world: localToWorld(pos.x, pos.y, pos.space), space: pos.space, angle: headingAngle(p.activity.path, p.activity.traveledKm, p.activity.totalKm) };
  }
  const space = pointSpace(p.positionId);
  return { world: pointToWorld(p.positionId), space, angle: 0 };
}

// Fit-to-view zoom levels computed from the canvas's actual (possibly
// non-square, e.g. the narrow-viewport 4:3 fallback) aspect ratio, so a whole
// city or the whole country always fits regardless of screen shape.
function cityFitZoom() {
  const rect = canvas.getBoundingClientRect();
  const minDim = Math.min(rect.width, rect.height) || 390;
  return clamp(minDim / (CITY_WORLD_RADIUS * 2.2), ZOOM_MIN, ZOOM_MAX);
}
function countryFitZoom() {
  const rect = canvas.getBoundingClientRect();
  const minDim = Math.min(rect.width, rect.height) || 390;
  return clamp(minDim / 95, ZOOM_MIN, ZOOM_MAX);
}

function centerOnPlayer(animated) {
  const live = livePlayerWorldPos();
  // For a city, frame the whole city (not a tight self-centered crop) so the
  // player's surroundings stay visible; on the open highway, center exactly.
  let targetX = live.world.x, targetY = live.world.y, targetZoom;
  if (live.space === 'country') {
    targetZoom = countryFitZoom();
  } else {
    targetZoom = cityFitZoom();
    const meta = cityMeta(live.space);
    targetX = meta.x; targetY = meta.y;
  }
  if (!animated) { camera.x = targetX; camera.y = targetY; camera.zoom = targetZoom; cameraTween = null; return; }
  cameraTween = { fromX: camera.x, fromY: camera.y, fromZoom: camera.zoom, toX: targetX, toY: targetY, toZoom: targetZoom, start: performance.now(), duration: 3250 };
}

function zoomToCity(cityId) {
  const meta = cityMeta(cityId);
  cameraTween = { fromX: camera.x, fromY: camera.y, fromZoom: camera.zoom, toX: meta.x, toY: meta.y, toZoom: cityFitZoom(), start: performance.now(), duration: 550 };
}

function updateCameraTween(ts) {
  if (!cameraTween) return;
  const t = clamp((ts - cameraTween.start) / cameraTween.duration, 0, 1);
  const eased = 1 - Math.pow(1 - t, 3);
  camera.x = cameraTween.fromX + (cameraTween.toX - cameraTween.fromX) * eased;
  camera.y = cameraTween.fromY + (cameraTween.toY - cameraTween.fromY) * eased;
  camera.zoom = cameraTween.fromZoom + (cameraTween.toZoom - cameraTween.fromZoom) * eased;
  if (t >= 1) cameraTween = null;
}

function drawCityDetail(cityId, toPxWorld, w, h) {
  const points = Object.values(WORLD_POINTS).filter(p => pointSpace(p.id) === cityId);
  const edges = WORLD_EDGES.filter(([a, b]) => pointSpace(a) === cityId && pointSpace(b) === cityId);
  const toPx = (x, y) => { const wpt = localToWorld(x, y, cityId); return toPxWorld(wpt.x, wpt.y); };
  const scalePxPerUnit = camera.zoom * (CITY_WORLD_RADIUS / 50);

  drawDecor(getMapDecor('city:' + cityId), toPx, scalePxPerUnit);
  drawRoads(cityId, points, edges, toPx);

  points.forEach(pnt => {
    if (pnt.type === 'gate') return;
    const [x, y] = toPx(pnt.x, pnt.y);
    if (x < -30 || x > w + 30 || y < -30 || y > h + 30) return;
    lastClickables[pnt.id] = { x, y, r: 16, kind: 'point' };
    const style = POINT_STYLES[pnt.type] || POINT_STYLES.delivery;
    ctx.fillStyle = style.color;
    ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill();
    ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(style.glyph, x, y);
    ctx.textAlign = 'left'; ctx.fillStyle = '#9aa4b2'; ctx.font = '9px system-ui';
    ctx.fillText(pnt.name, x + 14, y + 3);
  });

  const meta = cityMeta(cityId);
  const [lx, ly] = toPxWorld(meta.x, meta.y - CITY_WORLD_RADIUS * 1.15);
  ctx.font = 'bold 12px system-ui'; ctx.fillStyle = '#eee'; ctx.textAlign = 'center';
  ctx.fillText(meta.name, lx, ly);
  ctx.textAlign = 'left';
}

function drawWorld() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  const toPxWorld = (wx, wy) => worldToScreen(wx, wy, w, h);
  lastClickables = {};

  drawDecor(getMapDecor('country'), toPxWorld, camera.zoom);

  ctx.strokeStyle = '#333c4a'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  COUNTRY_ROAD_EDGES.forEach(([aId, bId]) => {
    const a = cityMeta(aId), b = cityMeta(bId);
    strokePolyline(getEdgePolyline('country', aId, bId, a, b, 7, 7), toPxWorld);
  });
  ctx.strokeStyle = '#4a5568'; ctx.lineWidth = 1.5;
  COUNTRY_ROAD_EDGES.forEach(([aId, bId]) => {
    const a = cityMeta(aId), b = cityMeta(bId);
    strokePolyline(getEdgePolyline('country', aId, bId, a, b, 7, 7), toPxWorld);
  });

  Object.values(WORLD_POINTS).filter(p => p.type === 'waystop').forEach(stop => {
    const [x, y] = toPxWorld(stop.x, stop.y);
    if (x < -20 || x > w + 20 || y < -20 || y > h + 20) return;
    lastClickables[stop.id] = { x, y, r: 12, kind: 'point' };
    ctx.fillStyle = '#4aa17a';
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
    ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⛽', x, y);
    ctx.textAlign = 'left';
  });

  const detailed = cityDetailVisible();
  COUNTRY_CITIES.forEach(c => {
    const [x, y] = toPxWorld(c.x, c.y);
    const margin = CITY_WORLD_RADIUS * camera.zoom + 40;
    if (x < -margin || x > w + margin || y < -margin || y > h + margin) return;
    if (detailed) {
      drawCityDetail(c.id, toPxWorld, w, h);
    } else {
      lastClickables[c.id] = { x, y, r: 18, kind: 'city' };
      ctx.fillStyle = '#7fd17f';
      ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill();
      ctx.font = '15px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🏙', x, y);
      ctx.font = 'bold 11px system-ui'; ctx.fillStyle = '#eee';
      ctx.fillText(c.name, x, y + 22);
      ctx.textAlign = 'left';
    }
  });

  // Movers: the player today; the same drawing path will carry hired workers later.
  const live = livePlayerWorldPos();
  const [mx, my] = toPxWorld(live.world.x, live.world.y);
  const moverDetailed = live.space === 'country' ? detailed : detailed;
  const isProblem = state.player.status === 'moving' && state.player.activity && state.player.activity.problemPending;
  if (moverDetailed) {
    const traveled = state.player.activity ? state.player.activity.traveledKm : 0;
    drawVehicleMarker(mx, my, live.angle, vehicleSpec().draw, traveled, isProblem);
  } else {
    ctx.fillStyle = isProblem ? '#d9534f' : '#7fd17f';
    ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#14181f'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

function drawMap() {
  if (!state) return;
  drawWorld();
}

function handleTap(screenX, screenY) {
  if (!state) return;
  let bestId = null, bestKind = null, bestDist = Infinity;
  for (const id in lastClickables) {
    const c = lastClickables[id];
    const d = Math.hypot(c.x - screenX, c.y - screenY);
    if (d < c.r && d < bestDist) { bestDist = d; bestId = id; bestKind = c.kind; }
  }
  if (!bestId) { uiSelectedPointId = null; lastPointPanelSignature = null; renderPointPanel(); return; }
  if (bestKind === 'city') { zoomToCity(bestId); return; }
  uiSelectedPointId = bestId;
  lastPointPanelSignature = null;
  renderPointPanel();
}

let dragState = null;
canvas.addEventListener('mousedown', (e) => {
  if (!state) return;
  dragState = { startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y, moved: false };
});
window.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX, dy = e.clientY - dragState.startY;
  if (Math.hypot(dx, dy) > 4) { dragState.moved = true; cameraTween = null; }
  if (dragState.moved) {
    camera.x = dragState.camX - dx / camera.zoom;
    camera.y = dragState.camY - dy / camera.zoom;
  }
});
window.addEventListener('mouseup', (e) => {
  if (!dragState) return;
  if (!dragState.moved) {
    const rect = canvas.getBoundingClientRect();
    if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
      handleTap(e.clientX - rect.left, e.clientY - rect.top);
    }
  }
  dragState = null;
});

function touchDist(touches) { return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY); }
let touchPanState = null;
let pinchState = null;
canvas.addEventListener('touchstart', (e) => {
  if (!state) return;
  e.preventDefault();
  cameraTween = null;
  if (e.touches.length === 1) {
    touchPanState = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, camX: camera.x, camY: camera.y, moved: false };
    pinchState = null;
  } else if (e.touches.length === 2) {
    touchPanState = null;
    const rect = canvas.getBoundingClientRect();
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
    pinchState = {
      startDist: touchDist(e.touches), startZoom: camera.zoom,
      worldMid: { x: (midX - rect.width / 2) / camera.zoom + camera.x, y: (midY - rect.height / 2) / camera.zoom + camera.y },
    };
  }
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  if (!state) return;
  e.preventDefault();
  if (e.touches.length === 1 && touchPanState) {
    const dx = e.touches[0].clientX - touchPanState.startX, dy = e.touches[0].clientY - touchPanState.startY;
    if (Math.hypot(dx, dy) > 4) touchPanState.moved = true;
    camera.x = touchPanState.camX - dx / camera.zoom;
    camera.y = touchPanState.camY - dy / camera.zoom;
  } else if (e.touches.length === 2 && pinchState) {
    const d = touchDist(e.touches);
    const rect = canvas.getBoundingClientRect();
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
    camera.zoom = clamp(pinchState.startZoom * (d / pinchState.startDist), ZOOM_MIN, ZOOM_MAX);
    camera.x = pinchState.worldMid.x - (midX - rect.width / 2) / camera.zoom;
    camera.y = pinchState.worldMid.y - (midY - rect.height / 2) / camera.zoom;
  }
}, { passive: false });
canvas.addEventListener('touchend', (e) => {
  if (e.touches.length === 0 && touchPanState && !touchPanState.moved) {
    const rect = canvas.getBoundingClientRect();
    const t = e.changedTouches[0];
    handleTap(t.clientX - rect.left, t.clientY - rect.top);
  }
  if (e.touches.length < 2) pinchState = null;
  if (e.touches.length === 0) touchPanState = null;
});

canvas.addEventListener('wheel', (e) => {
  if (!state) return;
  e.preventDefault();
  cameraTween = null;
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const worldX = (sx - rect.width / 2) / camera.zoom + camera.x;
  const worldY = (sy - rect.height / 2) / camera.zoom + camera.y;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  camera.zoom = clamp(camera.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  camera.x = worldX - (sx - rect.width / 2) / camera.zoom;
  camera.y = worldY - (sy - rect.height / 2) / camera.zoom;
  renderAll();
}, { passive: false });

function formatKm(km) { return km < 10 ? km.toFixed(1) : Math.round(km); }
function formatDeadline(ms) {
  if (ms === null) return '∞ без срока';
  const remaining = ms - Date.now();
  if (remaining <= 0) return 'просрочен';
  const totalMin = Math.floor(remaining / 60000);
  if (totalMin < 60) return `${totalMin} мин`;
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return `${h} ч ${m} мин`;
}

let lastPointPanelSignature = null;
function renderPointPanel() {
  const panel = el('point-panel');
  const visible = !!uiSelectedPointId && state;
  const point = visible ? pointById(uiSelectedPointId) : null;
  const p = state ? state.player : null;
  const signature = visible ? `${uiSelectedPointId}|${p.positionId}|${p.status}|${p.jobs.map(j => j.id + ':' + j.pickedUp).join(',')}` : 'hidden';
  if (signature === lastPointPanelSignature) return;
  lastPointPanelSignature = signature;

  if (!visible || !point || point.type === 'gate') { panel.classList.add('hidden'); return; }
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

  // jobs to pick up / deliver right here
  p.jobs.filter(j => !j.pickedUp && j.fromId === uiSelectedPointId).forEach(j => {
    addBtn(`📦 Забрать «${j.itemName}»`, () => { pickUpJob(j.id); renderAll(); });
  });
  p.jobs.filter(j => j.pickedUp && j.toId === uiSelectedPointId).forEach(j => {
    addBtn(`✅ Сдать «${j.itemName}»`, () => { deliverJob(j.id); renderAll(); });
  });

  if (point.type === 'shop') { addBtn('Открыть магазин', () => openShop()); }
  if (point.type === 'workshop') { addBtn('Открыть мастерскую', () => openWorkshop()); }

  if (point.type === 'cafe' || point.type === 'waystop') {
    EAT_OPTIONS.forEach(opt => {
      const cost = EAT_PRICE_CAFE[opt.id];
      addBtn(`${opt.label} — ${cost} ₽`, () => { startEating(opt.id); renderAll(); }, state.money < cost);
    });
  }
  if (point.type === 'home') {
    EAT_OPTIONS.forEach(opt => addBtn(`${opt.label} (бесплатно)`, () => { startEating(opt.id); renderAll(); }));
    SLEEP_OPTIONS.forEach(opt => addBtn(opt.label, () => { startSleeping(opt.id); renderAll(); }));
  }
  if (point.type === 'gas' || point.type === 'waystop') {
    const spec = vehicleSpec();
    if (spec.fuel !== 'legs') {
      const missing = spec.tank - p.vehicle.fuel;
      const cost = Math.round(missing * FUEL_COST_PER_KM_RANGE[spec.fuel]);
      addBtn(missing <= 0.01 ? 'Бак полон' : `⛽ Заправиться — ${cost} ₽`, () => { refuel(); renderAll(); }, missing <= 0.01 || state.money < cost);
    }
  }
  if (point.type !== 'home') {
    addBtn(IDLE_REST_OPTION.label, () => { startIdleRest(); renderAll(); });
  }
}

const VEHICLE_CONTAINER_GLYPH = { foot: '🎒', twowheel: '🧺', car: '🚗', truck: '🚚' };

let lastCargoSignature = null;
function renderCargoPanel() {
  const box = el('cargo-panel');
  const p = state.player;
  const spec = vehicleSpec();
  const signature = p.jobs.map(j => `${j.id}:${j.pickedUp}`).join(',') + '|' + p.status + '|' + p.positionId + '|' + spec.id;
  if (signature === lastCargoSignature) return;
  lastCargoSignature = signature;

  box.classList.remove('hidden');
  box.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'cargo-header';
  const icon = document.createElement('div');
  icon.className = 'cargo-vehicle-icon';
  icon.textContent = VEHICLE_CONTAINER_GLYPH[spec.draw] || '🎒';
  const text = document.createElement('div');
  text.className = 'cargo-header-text';
  text.innerHTML = `<b>${spec.name}</b><div class="job-sub">${p.jobs.length ? 'Груз на борту' : 'Пусто — жди заказ'}</div>`;
  header.append(icon, text);
  box.appendChild(header);

  const weightPct = clamp(cargoWeightKg() / spec.kg * 100, 0, 100);
  const volPct = clamp(cargoVolumeL() / spec.l * 100, 0, 100);
  const caps = document.createElement('div');
  caps.className = 'cargo-cap-bars';
  caps.innerHTML = `
    <div class="cargo-cap-row"><span>Вес ${cargoWeightKg().toFixed(1)}/${spec.kg} кг</span></div>
    <div class="cargo-cap-row"><div class="vital-track"><div class="vital-fill" style="width:${weightPct}%;background:linear-gradient(to right,#a3700e,#e2a63b)"></div></div></div>
    <div class="cargo-cap-row"><span>Объём ${Math.round(cargoVolumeL())}/${spec.l} л</span></div>
    <div class="cargo-cap-row"><div class="vital-track"><div class="vital-fill" style="width:${volPct}%;background:linear-gradient(to right,#2a6690,#4a9dd1)"></div></div></div>`;
  box.appendChild(caps);

  if (p.jobs.length === 0) return;

  const grid = document.createElement('div');
  grid.className = 'cargo-grid';
  p.jobs.forEach(job => {
    const chip = document.createElement('div');
    chip.className = 'cargo-chip ' + (job.pickedUp ? 'loaded' : 'pending');
    const glyph = document.createElement('div');
    glyph.className = 'cargo-chip-glyph';
    glyph.textContent = STORAGE_GLYPH[job.storage];
    const name = document.createElement('div');
    name.className = 'cargo-chip-name';
    const statusText = job.pickedUp ? `→ ${pointById(job.toId).name}` : `забрать: ${pointById(job.fromId).name}`;
    let hintText = '';
    if (job.pickedUp && p.positionId !== job.toId) {
      if (p.positionId === job.fromId) {
        hintText = `<div class="job-sub refuse-hint refuse-hint-warn">Здесь можно вернуть груз (-${Math.round(REFUSE_PENALTY_SAME_LOCATION * 100)}%)</div>`;
      } else {
        hintText = `<div class="job-sub refuse-hint refuse-hint-danger">Здесь не то место — отказ обойдётся в -${Math.round(REFUSE_PENALTY_OTHER_LOCATION * 100)}%</div>`;
      }
    }
    name.innerHTML = `${job.itemName}<div class="job-sub">${statusText}</div>${hintText}`;
    const meta = document.createElement('div');
    meta.className = 'cargo-chip-meta';
    meta.textContent = `${job.weightKg}кг/${job.volumeL}л`;
    const btn = document.createElement('button');
    if (!job.pickedUp) {
      const canPickup = p.status === 'idle' && p.positionId === job.fromId;
      btn.textContent = '📦 Забрать';
      btn.disabled = !canPickup;
      btn.onclick = () => { pickUpJob(job.id); renderAll(); };
      chip.append(glyph, name, meta, btn);
    } else {
      const canDeliver = p.status === 'idle' && p.positionId === job.toId;
      btn.textContent = '✅ Сдать';
      btn.disabled = !canDeliver;
      btn.onclick = () => { deliverJob(job.id); renderAll(); };
      chip.append(glyph, name, meta, btn);
      if (p.positionId !== job.toId) {
        const refuseBtn = document.createElement('button');
        refuseBtn.className = 'danger-action';
        const penaltyPct = Math.round(refuseJobPenaltyFrac(job) * 100);
        refuseBtn.textContent = `❌ Отказаться (-${penaltyPct}%)`;
        refuseBtn.disabled = p.status !== 'idle';
        refuseBtn.onclick = () => openRefuseConfirm(job.id);
        chip.appendChild(refuseBtn);
      }
    }
    grid.appendChild(chip);
  });
  box.appendChild(grid);
}

let lastOrdersSignature = null;
let lastOrdersRenderRealTime = 0;
function jobFitsVehicle(job) {
  const spec = vehicleSpec();
  const weightOk = cargoWeightKg() + job.weightKg <= spec.kg;
  const volumeOk = cargoVolumeL() + job.volumeL <= spec.l;
  const equipOk = hasRequiredEquipment(job.storage);
  return weightOk && volumeOk && equipOk;
}

function renderOrdersCount() {
  el('orders-count').textContent = state.availableJobs.length;
}

const orderFilters = { storage: 'all', urgency: 'all', fitsOnly: false };

function renderOrdersList() {
  if (el('orders-modal').classList.contains('hidden')) return;
  const canTakeMore = state.player.jobs.filter(j => !j.pickedUp).length < MAX_PENDING_JOBS;
  const signature = canTakeMore + '|' + state.availableJobs.map(j => j.id).join(',') + '|' + JSON.stringify(orderFilters);
  const now = Date.now();
  if (signature === lastOrdersSignature && now - lastOrdersRenderRealTime < 1000) return;
  lastOrdersSignature = signature;
  lastOrdersRenderRealTime = now;

  const ul = el('orders-list');
  ul.innerHTML = '';
  const filtered = state.availableJobs.filter(job => {
    if (orderFilters.storage !== 'all' && job.storage !== orderFilters.storage) return false;
    if (orderFilters.urgency !== 'all' && job.urgencyKey !== orderFilters.urgency) return false;
    if (orderFilters.fitsOnly && !jobFitsVehicle(job)) return false;
    return true;
  });
  if (filtered.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Нет заказов по этим фильтрам';
    ul.appendChild(li);
    return;
  }
  filtered.forEach(job => {
    const li = document.createElement('li');
    const fits = jobFitsVehicle(job);
    li.className = fits ? 'job-fit' : 'job-nofit';
    const info = document.createElement('div');
    info.className = 'job-info';
    info.innerHTML = `<div>${STORAGE_GLYPH[job.storage]} <b>${job.itemName}</b> — ${job.weightKg} кг / ${job.volumeL} л</div>` +
      `<div class="job-sub">${pointById(job.fromId).name} → ${pointById(job.toId).name} · ${job.distanceKm} км</div>` +
      `<div class="job-sub">${job.urgencyKey === 'urgent' ? '🔥' : job.urgencyKey === 'standard' ? '🕐' : '∞'} ${formatDeadline(job.deadlineReal)}${!fits ? ' · не подходит' : ''}</div>`;
    const pay = document.createElement('span');
    pay.className = 'job-pay';
    pay.textContent = `${job.payout} ₽`;
    const btn = document.createElement('button');
    btn.textContent = 'Взять';
    btn.disabled = !canTakeMore;
    btn.onclick = () => { takeJob(job.id); renderAll(); };
    li.append(info, pay, btn);
    ul.appendChild(li);
  });
}

function renderStatusPanel() {
  const panel = el('status-panel');
  const p = state.player;
  let text;
  if (p.status === 'idle') text = `Стоит на месте (${pointById(p.positionId).name}), готов ехать`;
  else if (p.status === 'resting') text = `Отдыхает: ${p.restPlan ? p.restPlan.label : ''}`;
  else if (p.status === 'eating') text = `Ест: ${p.eatPlan ? p.eatPlan.label : ''}`;
  else if (p.status === 'moving') {
    const a = p.activity;
    const remainingKm = Math.max(0, a.totalKm - a.traveledKm);
    text = `→ ${pointById(a.targetId).name} · осталось ${formatKm(remainingKm)} км`;
    if (a.problemPending) text += ' — стоит';
  }
  const nightTag = isNight() ? ' 🌙 ночь, скорость ниже' : '';
  panel.textContent = text + nightTag;
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
    const type = breakdownPoolFor(vehicleSpec()).find(t => t.id === action.typeId);
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
  if (state.gameOver === 'bankruptcy') showBankruptcyModal();
  el('hud-money').textContent = `${Math.round(state.money)} ₽`;
  el('hud-money').style.color = state.money < 0 ? '#d9534f' : '';
  el('hud-time').textContent = formatTime(state.gameTime);
  // Displayed inverted: these read as energy/satiety, so the bar drains as
  // fatigue/hunger (the underlying tracked values) climb toward exhausted/hungry.
  el('bar-fatigue').style.width = `${100 - state.player.fatigue}%`;
  el('bar-hunger').style.width = `${100 - state.player.hunger}%`;
  renderStatusPanel();
  renderPendingActions();
  renderPointPanel();
  renderCargoPanel();
  renderGarageCount();
  renderOrdersCount();
  renderOrdersList();
  renderToasts();
  drawMap();
}

// ---------- shop / workshop modals ----------

let shopTab = 'vehicles';
function openShop() {
  el('shop-tab-vehicles').classList.toggle('active', shopTab === 'vehicles');
  el('shop-tab-equipment').classList.toggle('active', shopTab === 'equipment');
  const list = el('shop-list');
  list.innerHTML = '';
  if (shopTab === 'vehicles') {
    VEHICLE_CATS_ORDER.forEach(cat => {
      const header = document.createElement('li');
      header.className = 'shop-cat-header';
      header.textContent = `${CAT_GLYPH[cat]} ${CAT_LABEL[cat]}`;
      list.appendChild(header);
      VEHICLES.filter(v => v.cat === cat).forEach(v => {
        const li = document.createElement('li');
        const owned = state.player.vehicles.some(veh => veh.type === v.id);
        const info = document.createElement('div');
        const fuelTxt = v.fuel === 'legs' ? '' : ` · бак ${v.tank} км`;
        info.innerHTML = `<b>${v.name}</b><div class="job-sub">${v.speed} км/ч · до ${v.trip} км за раз${fuelTxt} · ${v.kg} кг / ${v.l} л${v.fridge ? ' · встроенный холод' : ''}</div>`;
        const btn = document.createElement('button');
        btn.textContent = owned ? 'В гараже' : (v.price === 0 ? 'Взять' : `Купить — ${v.price.toLocaleString('ru-RU')} ₽`);
        btn.disabled = owned || state.money < v.price;
        btn.onclick = () => { buyVehicle(v.id); openShop(); renderAll(); };
        li.append(info, btn);
        list.appendChild(li);
      });
    });
  } else {
    EQUIPMENT.forEach(eq => {
      const li = document.createElement('li');
      const owned = !!state.player.equipment[eq.id];
      const info = document.createElement('div');
      info.innerHTML = `<b>${eq.name}</b><div class="job-sub">Открывает: ${eq.unlocks.map(u => STORAGE_LABEL[u]).join(', ')}</div>`;
      const btn = document.createElement('button');
      btn.textContent = owned ? 'Есть' : `Купить — ${eq.price.toLocaleString('ru-RU')} ₽`;
      btn.disabled = owned || state.money < eq.price;
      btn.onclick = () => { buyEquipment(eq.id); openShop(); renderAll(); };
      li.append(info, btn);
      list.appendChild(li);
    });
  }
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

// ---------- garage (owned vehicles) ----------

let garageView = { mode: 'list' };

function renderGarageCount() {
  el('garage-count').textContent = state.player.vehicles.length;
}

function conditionLabel(pct) {
  if (pct >= 80) return 'отличное';
  if (pct >= 50) return 'нормальное';
  if (pct >= 25) return 'так себе';
  return 'плохое';
}

function openGarage() {
  garageView = { mode: 'list' };
  renderGarageContent();
  el('garage-modal').classList.remove('hidden');
}

function renderGarageContent() {
  const box = el('garage-content');
  box.innerHTML = '';
  if (garageView.mode === 'detail') renderGarageDetail(box, garageView.type);
  else renderGarageList(box);
}

function renderGarageList(box) {
  el('garage-title').textContent = 'Моя техника';
  const list = document.createElement('ul');
  list.className = 'garage-list';
  state.player.vehicles.forEach(veh => {
    const spec = VEHICLE_BY_ID[veh.type];
    const isActive = state.player.vehicle.type === veh.type;
    const li = document.createElement('li');
    li.className = isActive ? 'active-vehicle' : '';
    const icon = document.createElement('div');
    icon.className = 'garage-icon';
    icon.textContent = CAT_GLYPH[spec.cat];
    const info = document.createElement('div');
    info.className = 'garage-info';
    const fuelTxt = spec.fuel === 'legs' ? '' : ` · топливо ${Math.round(veh.fuel)}/${spec.tank} км`;
    info.innerHTML = `${isActive ? '<span class="garage-badge">За рулём</span><br>' : ''}<b>${spec.name}</b><div class="garage-sub">Состояние: ${Math.round(veh.condition)}%${fuelTxt}</div>`;
    li.append(icon, info);
    li.onclick = () => { garageView = { mode: 'detail', type: veh.type }; renderGarageContent(); };
    list.appendChild(li);
  });
  box.appendChild(list);
}

function renderGarageDetail(box, vehicleType) {
  const veh = state.player.vehicles.find(v => v.type === vehicleType);
  const spec = VEHICLE_BY_ID[vehicleType];
  if (!veh || !spec) { garageView = { mode: 'list' }; renderGarageContent(); return; }
  el('garage-title').textContent = spec.name;
  const isActive = state.player.vehicle.type === vehicleType;

  const back = document.createElement('button');
  back.className = 'garage-back-btn';
  back.textContent = '← Ко всей технике';
  back.onclick = () => { garageView = { mode: 'list' }; renderGarageContent(); };
  box.appendChild(back);

  const wrap = document.createElement('div');
  wrap.className = 'garage-detail';

  const header = document.createElement('div');
  header.className = 'garage-detail-header';
  header.innerHTML = `<div class="garage-icon">${CAT_GLYPH[spec.cat]}</div><div><b>${spec.name}</b><div class="garage-sub">${CAT_LABEL[spec.cat]}${isActive ? ' · за рулём сейчас' : ''}</div></div>`;
  wrap.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'garage-spec-grid';
  const fuelRow = spec.fuel === 'legs'
    ? '<div><span>Топливо</span>не требуется</div>'
    : `<div><span>Запас хода</span>${Math.round(veh.fuel)}/${spec.tank} км</div>`;
  grid.innerHTML = `
    <div><span>Состояние</span>${Math.round(veh.condition)}% (${conditionLabel(veh.condition)})</div>
    <div><span>Скорость</span>${spec.speed} км/ч</div>
    <div><span>Грузоподъёмность</span>${spec.kg} кг</div>
    <div><span>Объём кузова</span>${spec.l} л</div>
    <div><span>Макс. рейс без остановки</span>${spec.trip} км</div>
    ${fuelRow}
    <div><span>Подвеска</span>${veh.upgraded ? 'укреплена' : 'обычная'}</div>
    <div><span>Утомляемость</span>${spec.fat.toFixed(2)}/км</div>
  `;
  wrap.appendChild(grid);

  const breakdownNote = document.createElement('p');
  breakdownNote.className = 'hint';
  breakdownNote.textContent = 'Поломки пока считаются только через общее состояние — отдельные неисправности (колесо, руль, масло) добавим позже.';
  wrap.appendChild(breakdownNote);

  const actions = document.createElement('div');
  actions.className = 'garage-detail-actions';
  const switchBtn = document.createElement('button');
  switchBtn.textContent = isActive ? 'Уже за рулём' : '🔁 Пересесть';
  switchBtn.disabled = isActive || state.player.status !== 'idle';
  switchBtn.onclick = () => { switchVehicle(vehicleType); renderGarageContent(); renderAll(); };
  actions.appendChild(switchBtn);

  if (veh.upgraded) {
    const sellUpgradeBtn = document.createElement('button');
    const upgradeRefund = Math.round(UPGRADE_COST * UPGRADE_RESALE_RATE / 10) * 10;
    sellUpgradeBtn.className = 'secondary-action';
    sellUpgradeBtn.textContent = `🔧 Продать улучшение подвески — ${upgradeRefund.toLocaleString('ru-RU')} ₽`;
    sellUpgradeBtn.disabled = state.player.status !== 'idle';
    sellUpgradeBtn.onclick = () => { sellVehicleUpgrade(vehicleType); renderGarageContent(); renderAll(); };
    actions.appendChild(sellUpgradeBtn);
  }

  if (spec.price > 0) {
    const sellBtn = document.createElement('button');
    const resaleVal = vehicleResaleValue(veh);
    sellBtn.className = 'danger-action';
    sellBtn.textContent = isActive ? 'Нельзя продать (за рулём)' : `💰 Продать технику — ${resaleVal.toLocaleString('ru-RU')} ₽`;
    sellBtn.disabled = isActive || state.player.status !== 'idle';
    sellBtn.onclick = () => {
      sellVehicle(vehicleType);
      garageView = { mode: 'list' };
      renderGarageContent();
      renderAll();
    };
    actions.appendChild(sellBtn);
  }

  wrap.appendChild(actions);

  box.appendChild(wrap);
}

// ---------- main loop ----------

function frame(ts) {
  if (lastFrameTs === null) lastFrameTs = ts;
  const dtRealSec = (ts - lastFrameTs) / 1000;
  lastFrameTs = ts;
  const dtGameMin = dtRealSec * GAME_MIN_PER_REAL_SEC;
  if (dtGameMin > 0 && dtGameMin < 1000) simulateTick(dtGameMin, null);

  updateCameraTween(ts);

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
  lastActionsSignature = null;
  lastPointPanelSignature = null;
  uiSelectedPointId = null;
  centerOnPlayer(false);
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
  if (summary.bankrupt) { showBankruptcyModal(); return; }
  if (summary.entries.length === 0 && summary.netMoneyChange === 0) return;
  const sign = summary.netMoneyChange > 0 ? '+' : '';
  el('offline-header').textContent =
    `Доставлено заказов: ${summary.jobsCompleted}. Происшествий: ${summary.incidents}. Баланс изменился: ${sign}${summary.netMoneyChange} ₽.`;
  renderDiaryList(el('offline-list'), summary.entries.slice(0, 60));
  el('offline-modal').classList.remove('hidden');
}

let bankruptcyShown = false;
function showBankruptcyModal() {
  if (bankruptcyShown) return;
  bankruptcyShown = true;
  el('bankruptcy-modal').classList.remove('hidden');
}
el('btn-bankruptcy-restart').onclick = () => {
  el('bankruptcy-modal').classList.add('hidden');
  bankruptcyShown = false;
  state = newGameState();
  jobIdSeq = 1;
  saveGame();
  showGameScreen();
};

el('btn-new-game').onclick = () => {
  state = newGameState();
  jobIdSeq = 1;
  bankruptcyShown = false;
  saveGame();
  showGameScreen();
};

el('btn-continue').onclick = () => {
  if (!loadGame()) return;
  bankruptcyShown = false;
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
      relinkActiveVehicle();
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

el('btn-center-me').onclick = () => { centerOnPlayer(true); };

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

el('btn-open-orders').onclick = () => { el('orders-modal').classList.remove('hidden'); lastOrdersSignature = null; renderOrdersList(); };
el('btn-orders-close').onclick = () => el('orders-modal').classList.add('hidden');
el('filter-storage').onchange = (e) => { orderFilters.storage = e.target.value; lastOrdersSignature = null; renderOrdersList(); };
el('filter-urgency').onchange = (e) => { orderFilters.urgency = e.target.value; lastOrdersSignature = null; renderOrdersList(); };
el('filter-fits-only').onchange = (e) => { orderFilters.fitsOnly = e.target.checked; lastOrdersSignature = null; renderOrdersList(); };

el('btn-open-garage').onclick = () => openGarage();
el('btn-garage-close').onclick = () => el('garage-modal').classList.add('hidden');

el('btn-refuse-confirm').onclick = () => {
  if (pendingRefuseJobId !== null) refuseJob(pendingRefuseJobId);
  pendingRefuseJobId = null;
  el('refuse-modal').classList.add('hidden');
  renderAll();
};
el('btn-refuse-cancel').onclick = () => { pendingRefuseJobId = null; el('refuse-modal').classList.add('hidden'); };

el('btn-shop-close').onclick = () => el('shop-modal').classList.add('hidden');
el('shop-tab-vehicles').onclick = () => { shopTab = 'vehicles'; openShop(); };
el('shop-tab-equipment').onclick = () => { shopTab = 'equipment'; openShop(); };
el('btn-workshop-close').onclick = () => el('workshop-modal').classList.add('hidden');
el('btn-workshop-repair').onclick = () => { workshopRepair(); openWorkshop(); renderAll(); };
el('btn-workshop-upgrade').onclick = () => { workshopUpgrade(); openWorkshop(); renderAll(); };

window.addEventListener('beforeunload', () => { if (state) saveGame(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && state) saveGame(); });
window.addEventListener('resize', () => { if (!gameScreen.classList.contains('hidden')) resizeCanvas(); });

showMenuScreen();
