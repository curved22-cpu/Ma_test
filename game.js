'use strict';

const SAVE_KEY = 'courier_save_v5';
const TIME_SCALE = 100; // game runs 100x faster than real life (testing value)
const GAME_MIN_PER_REAL_SEC = TIME_SCALE / 60;
const DAY_START_OFFSET = 9 * 60; // game clock begins at Day 1, 09:00
const MAX_OFFLINE_MS = 60 * 24 * 3600 * 1000; // cap catch-up at 60 real days
const TOAST_DURATION_MS = 5000;
const TOAST_EXIT_MS = 700; // duration of the fly-to-diary dismiss animation
const CITY_KM_PER_UNIT = 0.08;   // city-local map scale (a walkable town, not a 50km sprawl)
const COUNTRY_KM_PER_UNIT = 3;   // country map scale (cross-country distances)
const NIGHT_START_MIN = 22 * 60;
const NIGHT_END_MIN = 6 * 60;
const NIGHT_SPEED_MULT = 0.7;
const WEAR_PER_KM = 0.5;
// Sleepiness is the courier's one and only tiredness stat — the real need for
// sleep, nothing else. It fills up over 16 waking game-hours no matter what he's
// doing, and only actual sleep brings it back down. There is no separate "energy"
// that a quick roadside break can top up — running the tank to empty is dangerous,
// not just inconvenient.
const SLEEPINESS_RATE = 100 / (20 * 60); // per game-minute: empty after 20 waking hours
const ENDURE_SLEEPINESS_MULT = 3; // sleepiness builds 3x faster while "enduring" hunger with no money for food
const SLEEPY_WARN_THRESHOLD = 80;
const SLEEPY_ACCIDENT_CHANCE = 0.6; // per tick, once totally out of sleep and still driving
const SLEEPY_ACCIDENT_CONDITION_DAMAGE = 35;
const SLEEPY_ACCIDENT_REPAIR_COST = 1200;
const SLEEPY_ACCIDENT_TRIP_PENALTY = 1.2; // lost time/distance from the accident itself
const SLEEPY_GRACE_MINUTES = 60; // adrenaline window after a scare before it can happen again
const FOOT_COLLAPSE_MINUTES = 120; // forced roadside nap for a pedestrian who runs out of sleep
const CARGO_MISHAP_FINE = 500; // charged only if actually carrying picked-up cargo at the time
// Breakdown chance per trip scales with wear: worn-out technique is much more likely
// to act up, which is the whole point — it rewards keeping condition/suspension up.
const BREAKDOWN_BASE_CHANCE = 0.02; // at perfect (100%) condition
const BREAKDOWN_WEAR_BONUS = 0.04;  // extra chance added at 0% condition
const BREAKDOWN_SEVERE_BASE = 0.02; // severe (tow-worthy) share of triggered breakdowns at perfect condition
const BREAKDOWN_SEVERE_WEAR_BONUS = 0.10; // extra severe share added at 0% condition
const WORKSHOP_REPAIR_COST = 600;
const UPGRADE_COST = 4000;
const VEHICLE_RESALE_MAX_RATE = 0.55; // resale share of price at 100% condition
const VEHICLE_RESALE_MIN_RATE = 0.15; // resale share of price at 0% condition (still has scrap/parts value)
const VEHICLE_RESALE_UPGRADE_BONUS_RATE = 0.5; // upgraded suspension adds this share of UPGRADE_COST to resale value
const UPGRADE_RESALE_RATE = 0.5; // selling just the upgrade refunds half of UPGRADE_COST
const MAX_PENDING_JOBS = 3;
// Cost of living scales with lifetime earnings (a proxy for business growth/status).
// Charged once per day at midnight as a random amount within the active tier's range.
const LIVING_COST_TIERS = [
  { minEarned: 0, min: 60, max: 200 },
  { minEarned: 20000, min: 150, max: 400 },
  { minEarned: 100000, min: 300, max: 700 },
  { minEarned: 500000, min: 500, max: 1200 },
];
const VEHICLE_UPKEEP_RATE = 0.0008; // fraction of active vehicle price, charged once per day
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
  { id: 'foot', name: 'Пешком', cat: 'foot', draw: 'foot', speed: 5, price: 0, kg: 5, l: 10, trip: 8, fuel: 'legs', tank: Infinity },

  { id: 'scoot_manual1', name: 'Самокат простой', cat: 'scooter', draw: 'twowheel', speed: 10, price: 1200, kg: 3, l: 5, trip: 4, fuel: 'legs', tank: Infinity },
  { id: 'scoot_manual2', name: 'Самокат спортивный', cat: 'scooter', draw: 'twowheel', speed: 13, price: 3200, kg: 4, l: 6, trip: 5, fuel: 'legs', tank: Infinity },
  { id: 'scoot_e1', name: 'Электросамокат бюджетный', cat: 'scooter', draw: 'twowheel', speed: 20, price: 12000, kg: 5, l: 8, trip: 15, fuel: 'electric', tank: 20 },
  { id: 'scoot_e2', name: 'Электросамокат городской', cat: 'scooter', draw: 'twowheel', speed: 25, price: 20000, kg: 6, l: 10, trip: 20, fuel: 'electric', tank: 30 },
  { id: 'scoot_e3', name: 'Электросамокат мощный', cat: 'scooter', draw: 'twowheel', speed: 32, price: 35000, kg: 8, l: 12, trip: 25, fuel: 'electric', tank: 40 },
  { id: 'scoot_e4', name: 'Электросамокат внедорожный', cat: 'scooter', draw: 'twowheel', speed: 38, price: 55000, kg: 10, l: 15, trip: 35, fuel: 'electric', tank: 50 },

  { id: 'bike_city', name: 'Городской велосипед', cat: 'bike', draw: 'twowheel', speed: 15, price: 6000, kg: 8, l: 15, trip: 12, fuel: 'legs', tank: Infinity },
  { id: 'bike_fold', name: 'Складной велосипед', cat: 'bike', draw: 'twowheel', speed: 14, price: 8000, kg: 7, l: 12, trip: 10, fuel: 'legs', tank: Infinity },
  { id: 'bike_road', name: 'Шоссейный велосипед', cat: 'bike', draw: 'twowheel', speed: 22, price: 15000, kg: 6, l: 10, trip: 18, fuel: 'legs', tank: Infinity },
  { id: 'bike_cargo', name: 'Грузовой велосипед (карго-байк)', cat: 'bike', draw: 'twowheel', speed: 16, price: 25000, kg: 40, l: 80, trip: 15, fuel: 'legs', tank: Infinity },
  { id: 'bike_e1', name: 'Электровелосипед бюджетный', cat: 'bike', draw: 'twowheel', speed: 22, price: 30000, kg: 15, l: 25, trip: 30, fuel: 'electric', tank: 40 },
  { id: 'bike_e2', name: 'Электровелосипед городской', cat: 'bike', draw: 'twowheel', speed: 27, price: 45000, kg: 18, l: 30, trip: 40, fuel: 'electric', tank: 55 },
  { id: 'bike_e_cargo', name: 'Электрокарго-байк', cat: 'bike', draw: 'twowheel', speed: 24, price: 70000, kg: 60, l: 120, trip: 35, fuel: 'electric', tank: 50 },
  { id: 'bike_e3', name: 'Электровелосипед мощный', cat: 'bike', draw: 'twowheel', speed: 32, price: 95000, kg: 20, l: 35, trip: 50, fuel: 'electric', tank: 70 },

  { id: 'moped_50', name: 'Мопед 50 куб.см', cat: 'moped', draw: 'twowheel', speed: 45, price: 60000, kg: 15, l: 25, trip: 60, fuel: 'gasoline', tank: 90 },
  { id: 'moped_cargo', name: 'Мопед грузовой', cat: 'moped', draw: 'twowheel', speed: 50, price: 110000, kg: 50, l: 90, trip: 70, fuel: 'gasoline', tank: 100 },
  { id: 'scooter_city', name: 'Скутер городской', cat: 'moped', draw: 'twowheel', speed: 55, price: 85000, kg: 20, l: 35, trip: 80, fuel: 'gasoline', tank: 120 },
  { id: 'scooter_tour', name: 'Скутер туристический', cat: 'moped', draw: 'twowheel', speed: 65, price: 120000, kg: 25, l: 40, trip: 100, fuel: 'gasoline', tank: 150 },
  { id: 'escooter_moto', name: 'Электроскутер', cat: 'moped', draw: 'twowheel', speed: 60, price: 140000, kg: 25, l: 40, trip: 90, fuel: 'electric', tank: 110 },
  { id: 'scooter_prem', name: 'Скутер премиум', cat: 'moped', draw: 'twowheel', speed: 70, price: 180000, kg: 28, l: 45, trip: 110, fuel: 'gasoline', tank: 160 },
  { id: 'escooter_long', name: 'Электроскутер дальнобойный', cat: 'moped', draw: 'twowheel', speed: 65, price: 220000, kg: 30, l: 45, trip: 130, fuel: 'electric', tank: 160 },
  { id: 'scooter_sport', name: 'Скутер спорт', cat: 'moped', draw: 'twowheel', speed: 80, price: 260000, kg: 20, l: 30, trip: 120, fuel: 'gasoline', tank: 150 },

  { id: 'moto_125', name: 'Мотоцикл лёгкий 125cc', cat: 'motorcycle', draw: 'twowheel', speed: 90, price: 180000, kg: 20, l: 30, trip: 150, fuel: 'gasoline', tank: 200 },
  { id: 'moto_enduro', name: 'Мотоцикл эндуро', cat: 'motorcycle', draw: 'twowheel', speed: 100, price: 320000, kg: 25, l: 35, trip: 180, fuel: 'gasoline', tank: 250 },
  { id: 'moto_400', name: 'Мотоцикл городской 400cc', cat: 'motorcycle', draw: 'twowheel', speed: 110, price: 450000, kg: 25, l: 40, trip: 220, fuel: 'gasoline', tank: 300 },
  { id: 'moto_tourer', name: 'Мотоцикл-турер', cat: 'motorcycle', draw: 'twowheel', speed: 120, price: 650000, kg: 35, l: 60, trip: 280, fuel: 'gasoline', tank: 380 },
  { id: 'moto_sport', name: 'Мотоцикл спортивный', cat: 'motorcycle', draw: 'twowheel', speed: 140, price: 900000, kg: 15, l: 20, trip: 250, fuel: 'gasoline', tank: 320 },
  { id: 'moto_prem', name: 'Мотоцикл премиум-турер', cat: 'motorcycle', draw: 'twowheel', speed: 130, price: 1400000, kg: 45, l: 80, trip: 350, fuel: 'gasoline', tank: 450 },

  { id: 'car_sedan_used', name: 'Подержанный седан', cat: 'car', draw: 'car', speed: 90, price: 450000, kg: 300, l: 400, trip: 400, fuel: 'gasoline', tank: 500 },
  { id: 'car_hatch', name: 'Компактный хэтчбек', cat: 'car', draw: 'car', speed: 100, price: 650000, kg: 320, l: 420, trip: 450, fuel: 'gasoline', tank: 550 },
  { id: 'car_wagon', name: 'Универсал', cat: 'car', draw: 'car', speed: 100, price: 900000, kg: 400, l: 600, trip: 500, fuel: 'gasoline', tank: 600 },
  { id: 'car_crossover', name: 'Кроссовер', cat: 'car', draw: 'car', speed: 110, price: 1300000, kg: 450, l: 650, trip: 550, fuel: 'gasoline', tank: 650 },
  { id: 'car_business', name: 'Бизнес-седан', cat: 'car', draw: 'car', speed: 120, price: 1800000, kg: 400, l: 550, trip: 600, fuel: 'gasoline', tank: 700 },
  { id: 'car_ev_city', name: 'Электромобиль городской', cat: 'car', draw: 'car', speed: 110, price: 2200000, kg: 400, l: 550, trip: 350, fuel: 'electric', tank: 400 },
  { id: 'car_suv', name: 'Внедорожник', cat: 'car', draw: 'car', speed: 115, price: 2800000, kg: 600, l: 900, trip: 650, fuel: 'gasoline', tank: 800 },
  { id: 'car_prem_sedan', name: 'Премиум седан', cat: 'car', draw: 'car', speed: 130, price: 3800000, kg: 400, l: 550, trip: 700, fuel: 'gasoline', tank: 850 },
  { id: 'car_ev_prem', name: 'Электромобиль премиум', cat: 'car', draw: 'car', speed: 130, price: 5500000, kg: 500, l: 700, trip: 500, fuel: 'electric', tank: 550 },
  { id: 'car_sport', name: 'Спорткар', cat: 'car', draw: 'car', speed: 150, price: 7000000, kg: 150, l: 200, trip: 600, fuel: 'gasoline', tank: 750 },

  { id: 'van_small', name: 'Малый фургон', cat: 'van', draw: 'truck', speed: 90, price: 1200000, kg: 800, l: 2500, trip: 500, fuel: 'gasoline', tank: 700 },
  { id: 'van_mid', name: 'Фургон средний', cat: 'van', draw: 'truck', speed: 90, price: 2200000, kg: 1500, l: 5000, trip: 600, fuel: 'gasoline', tank: 850 },
  { id: 'van_fridge', name: 'Рефрижератор малый', cat: 'van', draw: 'truck', speed: 85, price: 3200000, kg: 1200, l: 4000, trip: 550, fuel: 'diesel', tank: 800, fridge: true },
  { id: 'truck_mid', name: 'Грузовик среднетоннажный', cat: 'truck', draw: 'truck', speed: 80, price: 4500000, kg: 3500, l: 12000, trip: 700, fuel: 'diesel', tank: 1000 },
  { id: 'truck_semi', name: 'Фура (полуприцеп)', cat: 'truck', draw: 'truck', speed: 85, price: 9000000, kg: 20000, l: 60000, trip: 1200, fuel: 'diesel', tank: 1800 },
  { id: 'truck_semi_fridge', name: 'Рефрижератор-фура', cat: 'truck', draw: 'truck', speed: 85, price: 12000000, kg: 18000, l: 55000, trip: 1200, fuel: 'diesel', tank: 1800, fridge: true },
  { id: 'truck_mega', name: 'Мега-фура премиум', cat: 'truck', draw: 'truck', speed: 90, price: 18000000, kg: 24000, l: 70000, trip: 1500, fuel: 'diesel', tank: 2200 },
];
const VEHICLE_BY_ID = {};
VEHICLES.forEach(v => { VEHICLE_BY_ID[v.id] = v; });

const CAT_GLYPH = { foot: '🚶', scooter: '🛴', bike: '🚲', moped: '🛵', motorcycle: '🏍️', car: '🚗', van: '🚐', truck: '🚚' };
const CAT_LABEL = { foot: 'Пешком', scooter: 'Самокаты', bike: 'Велосипеды', moped: 'Мопеды и скутеры', motorcycle: 'Мотоциклы', car: 'Автомобили', van: 'Фургоны', truck: 'Грузовики' };
const VEHICLE_CATS_ORDER = ['foot', 'scooter', 'bike', 'moped', 'motorcycle', 'car', 'van', 'truck'];
const TIER_LABEL = { village: 'посёлок', small: 'малый город', big: 'крупный город', metro: 'мегаполис' };

const FUEL_COST_PER_KM_RANGE = { gasoline: 2.6, diesel: 2.2, electric: 1.1, legs: 0 };

// A pedestrian has no wheels, chain, or frame — mishaps are physical, not mechanical.
const BREAKDOWN_TYPES_FOOT = [
  { id: 'blister', label: 'Стёр ногу мозолью', severity: 'minor', selfFixCost: 100, selfFixMinutes: 10, ignorePenalty: 1.1 },
  { id: 'twisted_ankle', label: 'Подвернул ногу', severity: 'minor', selfFixCost: 150, selfFixMinutes: 12, ignorePenalty: 1.15 },
  { id: 'lost_shoe', label: 'Порвался шнурок, слетел ботинок', severity: 'severe', towCost: 400, towMinutes: 30 },
  { id: 'sprain', label: 'Серьёзно подвернул лодыжку', severity: 'severe', towCost: 1200, towMinutes: 60 },
];
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
  if (vehicleSpec.cat === 'foot') return BREAKDOWN_TYPES_FOOT;
  return (vehicleSpec.cat === 'scooter' || vehicleSpec.cat === 'bike')
    ? BREAKDOWN_TYPES_TWOWHEEL
    : BREAKDOWN_TYPES_MOTOR;
}
function isPersonalMishap(vehicleSpec) { return vehicleSpec.cat === 'foot'; }

// ---------- equipment ----------

// Foot-only gear bonuses (applied live in vehicleSpec() below, not baked into
// a separate vehicle entry) — declared here, before EQUIPMENT references them.
const ERGO_BACKPACK_KG_BONUS = 5;
const ERGO_BACKPACK_L_BONUS = 10;
const COMFY_SNEAKERS_SPEED_BONUS = 2; // km/h
const COMFY_SNEAKERS_SLEEPINESS_MULT = 0.8; // 20% less tiring to walk

const EQUIPMENT = [
  { id: 'thermal_bag', name: 'Термосумка', price: 2500, unlocks: ['chilled'] },
  { id: 'fridge_box', name: 'Холодильный бокс (аккумуляторный)', price: 18000, unlocks: ['chilled', 'frozen'] },
  { id: 'pet_carrier_small', name: 'Переноска для мелких животных', price: 3000, unlocks: ['live_small'] },
  { id: 'pet_carrier_large', name: 'Клетка/переноска для крупных животных', price: 9000, unlocks: ['live_large'] },
  { id: 'fragile_case', name: 'Кейс для хрупких грузов', price: 4000, unlocks: ['fragile'] },
  { id: 'secure_case', name: 'Опломбированный кейс (ценности/документы)', price: 6000, unlocks: ['valuable'] },
  { id: 'sleeper_cab', name: 'Спальное место в кабине', price: 25000, unlocks: [], desc: 'Как у дальнобойщиков — можно нормально выспаться в машине/фургоне/грузовике без штрафа за неудобство' },
  { id: 'ergo_backpack', name: 'Эргономичный рюкзак', price: 3500, unlocks: [], desc: `Пеший курьер берёт с собой больше: +${ERGO_BACKPACK_KG_BONUS} кг, +${ERGO_BACKPACK_L_BONUS} л` },
  { id: 'comfy_sneakers', name: 'Удобные кроссовки', price: 2000, unlocks: [], desc: `Пешком быстрее (+${COMFY_SNEAKERS_SPEED_BONUS} км/ч) и меньше устаёт в пути` },
];

const STORAGE_LABEL = { normal: 'обычные условия', chilled: 'нужна термосумка/холод', frozen: 'нужна заморозка', fragile: 'хрупкое', live_small: 'нужна переноска (мелкое животное)', live_large: 'нужна клетка (крупное животное)', valuable: 'нужен опломбированный кейс' };
const STORAGE_GLYPH = { normal: '📦', chilled: '🧊', frozen: '❄️', fragile: '🥚', live_small: '🐾', live_large: '🐕', valuable: '💎' };

// ---------- items & urgency ----------

// `sources`, when present, restricts which delivery points this item can be picked up
// from (only meaningful for Rivnoe's named points — generated cities' generic points
// aren't in any list, so templatesFor() falls back to the unfiltered pool for them).
// This is what keeps "frozen fish" off the bus station and onto the market/warehouse.
const RIVNOE_WAREHOUSE = 'rivnoe:warehouse';
const RIVNOE_MALL = 'rivnoe:mall';
const RIVNOE_BUS = 'rivnoe:bus';
const RIVNOE_HOSPITAL = 'rivnoe:hospital';
const RIVNOE_MARKET = 'rivnoe:market';
const RIVNOE_DISTRICT = 'rivnoe:district';

const ITEM_TEMPLATES = [
  { name: 'Коробка с одеждой', storage: 'normal', weightKg: [1, 4], volumeL: [8, 20], urgency: ['none', 'standard'], sources: [RIVNOE_MALL, RIVNOE_DISTRICT] },
  { name: 'Книги', storage: 'normal', weightKg: [2, 8], volumeL: [5, 15], urgency: ['none'] },
  { name: 'Электроника (гаджеты)', storage: 'fragile', weightKg: [0.3, 2], volumeL: [1, 5], urgency: ['standard', 'urgent'], sources: [RIVNOE_MALL] },
  { name: 'Ноутбук', storage: 'fragile', weightKg: [1.5, 3], volumeL: [3, 6], urgency: ['standard', 'urgent'], sources: [RIVNOE_MALL] },
  { name: 'Торт на заказ', storage: 'chilled', weightKg: [1, 3], volumeL: [8, 20], urgency: ['urgent'], sources: [RIVNOE_MALL, RIVNOE_DISTRICT] },
  { name: 'Мороженое (опт)', storage: 'frozen', weightKg: [3, 10], volumeL: [10, 25], urgency: ['urgent'], sources: [RIVNOE_WAREHOUSE, RIVNOE_MARKET] },
  { name: 'Замороженные полуфабрикаты', storage: 'frozen', weightKg: [5, 15], volumeL: [15, 35], urgency: ['standard'], sources: [RIVNOE_WAREHOUSE, RIVNOE_MARKET] },
  { name: 'Мороженая рыба', storage: 'frozen', weightKg: [3, 12], volumeL: [8, 20], urgency: ['standard'], sources: [RIVNOE_MARKET, RIVNOE_WAREHOUSE] },
  { name: 'Свежая рыба', storage: 'chilled', weightKg: [1, 6], volumeL: [3, 10], urgency: ['urgent', 'standard'], sources: [RIVNOE_MARKET] },
  { name: 'Свежие продукты', storage: 'chilled', weightKg: [2, 10], volumeL: [10, 30], urgency: ['standard', 'urgent'], sources: [RIVNOE_MARKET] },
  { name: 'Мёд и варенье', storage: 'normal', weightKg: [1, 5], volumeL: [2, 8], urgency: ['none', 'standard'], sources: [RIVNOE_MARKET] },
  { name: 'Комнатное растение', storage: 'fragile', weightKg: [1, 4], volumeL: [5, 15], urgency: ['standard'], sources: [RIVNOE_MARKET, RIVNOE_DISTRICT] },
  { name: 'Букет цветов', storage: 'fragile', weightKg: [0.5, 2], volumeL: [5, 15], urgency: ['urgent'], sources: [RIVNOE_MARKET, RIVNOE_MALL] },
  { name: 'Лекарства', storage: 'chilled', weightKg: [0.2, 2], volumeL: [1, 5], urgency: ['urgent'], sources: [RIVNOE_HOSPITAL] },
  { name: 'Медицинские анализы', storage: 'chilled', weightKg: [0.1, 0.5], volumeL: [0.5, 2], urgency: ['urgent'], sources: [RIVNOE_HOSPITAL] },
  { name: 'Документы', storage: 'valuable', weightKg: [0.1, 0.5], volumeL: [0.5, 1], urgency: ['urgent', 'standard'], sources: [RIVNOE_BUS, RIVNOE_HOSPITAL, RIVNOE_DISTRICT] },
  { name: 'Посылка (передача с автобуса)', storage: 'normal', weightKg: [0.5, 5], volumeL: [2, 15], urgency: ['standard', 'urgent'], sources: [RIVNOE_BUS] },
  { name: 'Чемодан пассажира', storage: 'normal', weightKg: [5, 20], volumeL: [30, 60], urgency: ['urgent', 'standard'], sources: [RIVNOE_BUS] },
  { name: 'Ювелирные изделия', storage: 'valuable', weightKg: [0.1, 1], volumeL: [0.5, 2], urgency: ['standard'], sources: [RIVNOE_MALL] },
  { name: 'Кот в переноске', storage: 'live_small', weightKg: [3, 6], volumeL: [15, 25], urgency: ['standard'], sources: [RIVNOE_DISTRICT] },
  { name: 'Небольшая собака', storage: 'live_small', weightKg: [5, 12], volumeL: [20, 35], urgency: ['standard'], sources: [RIVNOE_DISTRICT] },
  { name: 'Крупная собака', storage: 'live_large', weightKg: [15, 40], volumeL: [40, 70], urgency: ['standard'], sources: [RIVNOE_DISTRICT] },
  { name: 'Аквариумные рыбки', storage: 'live_small', weightKg: [1, 3], volumeL: [5, 15], urgency: ['urgent'], sources: [RIVNOE_MARKET] },
  { name: 'Корм для животных', storage: 'normal', weightKg: [5, 20], volumeL: [10, 30], urgency: ['none', 'standard'], sources: [RIVNOE_MARKET, RIVNOE_WAREHOUSE] },
  { name: 'Стройматериалы (мешки смеси)', storage: 'normal', weightKg: [20, 60], volumeL: [20, 50], urgency: ['none'], sources: [RIVNOE_WAREHOUSE] },
  { name: 'Садовый инвентарь', storage: 'normal', weightKg: [3, 15], volumeL: [10, 40], urgency: ['none', 'standard'], sources: [RIVNOE_WAREHOUSE, RIVNOE_MARKET] },
  { name: 'Мебель (разобранная)', storage: 'normal', weightKg: [30, 120], volumeL: [100, 400], urgency: ['none', 'standard'], sources: [RIVNOE_WAREHOUSE, RIVNOE_DISTRICT] },
  { name: 'Бытовая техника', storage: 'fragile', weightKg: [5, 40], volumeL: [20, 100], urgency: ['standard'], sources: [RIVNOE_MALL, RIVNOE_WAREHOUSE] },
  { name: 'Автозапчасти', storage: 'normal', weightKg: [2, 25], volumeL: [3, 30], urgency: ['standard', 'none'], sources: [RIVNOE_WAREHOUSE] },
  { name: 'Шины для авто', storage: 'normal', weightKg: [8, 25], volumeL: [30, 60], urgency: ['none', 'standard'], sources: [RIVNOE_WAREHOUSE] },
  { name: 'Пицца/готовая еда', storage: 'chilled', weightKg: [1, 4], volumeL: [5, 15], urgency: ['urgent'], sources: [RIVNOE_MALL, RIVNOE_DISTRICT] },
  { name: 'Домашняя выпечка', storage: 'normal', weightKg: [1, 3], volumeL: [5, 12], urgency: ['urgent', 'standard'], sources: [RIVNOE_DISTRICT] },
  { name: 'Постельное бельё', storage: 'normal', weightKg: [1, 5], volumeL: [5, 20], urgency: ['none', 'standard'], sources: [RIVNOE_MALL] },
  { name: 'Обувь', storage: 'normal', weightKg: [0.5, 3], volumeL: [3, 10], urgency: ['none', 'standard'], sources: [RIVNOE_MALL] },
  { name: 'Сувениры', storage: 'fragile', weightKg: [0.3, 2], volumeL: [2, 8], urgency: ['none', 'standard'], sources: [RIVNOE_MALL, RIVNOE_MARKET] },
  { name: 'Велозапчасти', storage: 'normal', weightKg: [1, 8], volumeL: [3, 15], urgency: ['none', 'standard'], sources: [RIVNOE_WAREHOUSE, RIVNOE_MALL] },
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
  garage: { color: '#3fae6b', glyph: '🅿️' },
};

// ---------- Ривное — стартовый (полностью авторский) город ----------

const RIVNOE_POINTS_RAW = [
  { id: 'home', name: 'Дом', type: 'home', x: 12, y: 50 },
  { id: 'cafe', name: 'Кафе «Уют»', type: 'cafe', x: 35, y: 40, hours: { open: 7 * 60, close: 23 * 60 } },
  { id: 'shop', name: 'Магазин техники «Скорость»', type: 'shop', x: 70, y: 28, hours: { open: 9 * 60, close: 20 * 60 } },
  { id: 'workshop', name: 'Мастерская «Гайка»', type: 'workshop', x: 78, y: 55, hours: { open: 9 * 60, close: 19 * 60 } },
  { id: 'gas', name: 'АЗС «Полный бак»', type: 'gas', x: 45, y: 75, hours: { always: true } },
  { id: 'warehouse', name: 'Склад «Логист»', type: 'delivery', x: 50, y: 50, hours: { open: 8 * 60, close: 18 * 60 } },
  { id: 'mall', name: 'ТЦ Горизонт', type: 'delivery', x: 22, y: 15, hours: { open: 10 * 60, close: 22 * 60 } },
  { id: 'bus', name: 'Автовокзал', type: 'delivery', x: 85, y: 15, hours: { always: true } },
  { id: 'hospital', name: 'Больница №1', type: 'delivery', x: 60, y: 8, hours: { always: true } },
  { id: 'market', name: 'Рынок', type: 'delivery', x: 28, y: 66, hours: { open: 7 * 60, close: 19 * 60 } },
  { id: 'district', name: 'Спальный район', type: 'delivery', x: 85, y: 85, hours: { always: true } },
  { id: 'park', name: 'Парк Победы', type: 'delivery', x: 15, y: 82, hours: { open: 6 * 60, close: 23 * 60 } },
  { id: 'garage', name: 'Гараж компании', type: 'garage', x: 62, y: 62, hours: { always: true } },
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
  ['garage', 'workshop'], ['garage', 'warehouse'],
];

// ---------- country cities ----------
// ~50 named settlements across 4 size tiers. Rivnoe is the hand-authored
// starting village (kept exactly as before); everyone else is generated
// from a tier "blueprint" so every point gets a real, logical name instead
// of a placeholder like "Точка 6" — bus stations, markets, hospitals etc.,
// scaled up or down depending on whether the settlement is a huge city or
// a tiny village. Shop assortment is also gated by tier (see SETTLEMENT_TIER
// and openShop()), so bigger vehicles are only sold in bigger settlements.

const COUNTRY_NAME = 'Залесье';

const SETTLEMENT_NAMES = {
  metro: ['Новоград', 'Приморск', 'Златогорск', 'Каменнодольск', 'Верхнеречье', 'Южногорск', 'Красноград'],
  big: ['Северск', 'Приволье', 'Светлоград', 'Новоселье', 'Раздолье', 'Спасск', 'Троицкое', 'Покровка', 'Верхнегорск', 'Зеленодольск'],
  small: ['Заречье', 'Сосновка', 'Берёзово', 'Каменск', 'Озёрное', 'Морозовск', 'Ясногорск', 'Белово', 'Черемушкино', 'Гранитногорск', 'Солнцево', 'Крутоярск', 'Туманово', 'Береговое', 'Тополёво', 'Ивановка', 'Сергеевка', 'Журавлёво', 'Орловка', 'Волково'],
  village: ['Горки', 'Луговое', 'Ключи', 'Дубровка', 'Тихвинка', 'Ольховка', 'Заводское', 'Родники', 'Вишнёвка', 'Малиновка', 'Полевое', 'Ельники'],
};

function seededShuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Place all non-Rivnoe settlements on a jittered grid so they never overlap,
// then shuffle which grid cell each tier lands in so big cities aren't
// clustered in one corner of the country. A relaxation pass afterward pushes
// apart any pair that still ended up too close, so nothing reads as crowded.
// The northern strip is reserved for the mountain range, so settlements are
// kept out of it (villages can still sit in the foothills just below it).
const MOUNTAIN_BAND_Y = 12;
const MIN_SETTLEMENT_DIST = 8.5;
function buildSettlementPositions() {
  const placementRng = seededRandom(hashStr('settlement-grid'));
  const cols = 8, rows = 7;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) cells.push({ c, r });
  }
  const shuffledCells = seededShuffle(cells, placementRng);
  const order = [
    ...SETTLEMENT_NAMES.metro.map(name => ({ name, tier: 'metro' })),
    ...SETTLEMENT_NAMES.big.map(name => ({ name, tier: 'big' })),
    ...SETTLEMENT_NAMES.small.map(name => ({ name, tier: 'small' })),
    ...SETTLEMENT_NAMES.village.map(name => ({ name, tier: 'village' })),
  ];
  const shuffledOrder = seededShuffle(order, placementRng);
  const pitchX = 100 / cols, pitchY = 100 / rows;
  const settlements = shuffledOrder.map((s, i) => {
    const cell = shuffledCells[i];
    const jx = (placementRng() - 0.5) * pitchX * 0.3;
    const jy = (placementRng() - 0.5) * pitchY * 0.3;
    const x = clamp(cell.c * pitchX + pitchX / 2 + jx, 5, 95);
    const y = clamp(cell.r * pitchY + pitchY / 2 + jy, MOUNTAIN_BAND_Y + 3, 95);
    return { id: `${s.tier}${i}`, name: s.name, tier: s.tier, x, y };
  });

  for (let iter = 0; iter < 120; iter++) {
    for (let i = 0; i < settlements.length; i++) {
      for (let j = i + 1; j < settlements.length; j++) {
        const a = settlements[i], b = settlements[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.0001 && dist < MIN_SETTLEMENT_DIST) {
          const push = (MIN_SETTLEMENT_DIST - dist) / 2;
          const ux = dx / dist, uy = dy / dist;
          a.x -= ux * push; a.y -= uy * push;
          b.x += ux * push; b.y += uy * push;
        }
      }
    }
    // Clamp back into bounds every iteration, not just at the end — otherwise a
    // settlement pushed out of bounds mid-relaxation gets snapped back afterward
    // and lands close to a neighbor again, undoing the spacing just gained.
    settlements.forEach(s => {
      s.x = clamp(s.x, 5, 95);
      s.y = clamp(s.y, MOUNTAIN_BAND_Y + 3, 95);
    });
  }
  return settlements;
}

const COUNTRY_CITIES = [
  { id: 'rivnoe', name: 'Ривное', x: 26, y: 58, tier: 'village' },
  ...buildSettlementPositions(),
];
const SETTLEMENT_TIER = {};
COUNTRY_CITIES.forEach(c => { SETTLEMENT_TIER[c.id] = c.tier; });

function cityMeta(id) { return COUNTRY_CITIES.find(c => c.id === id); }

// Minimum spanning tree over all settlements (so the whole country is
// guaranteed reachable) plus a handful of extra shortcut edges so the road
// network has loops instead of being a single strict tree.
function buildCountryRoadEdges() {
  const rng = seededRandom(hashStr('country-roads'));
  const nodes = COUNTRY_CITIES;
  const parent = {};
  nodes.forEach(n => { parent[n.id] = n.id; });
  function find(id) { while (parent[id] !== id) { parent[id] = parent[parent[id]]; id = parent[id]; } return id; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra === rb) return false; parent[ra] = rb; return true; }

  const pairs = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dist = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      pairs.push({ a: nodes[i].id, b: nodes[j].id, dist });
    }
  }
  pairs.sort((p, q) => p.dist - q.dist);

  const edges = [];
  pairs.forEach(p => { if (union(p.a, p.b)) edges.push([p.a, p.b]); });

  // A few extra shortcuts between geographically close settlements not
  // already directly connected, so the network isn't a single fragile tree.
  const existing = new Set(edges.map(([a, b]) => [a, b].sort().join('|')));
  const shortcutCandidates = pairs.filter(p => p.dist < 16 && !existing.has([p.a, p.b].sort().join('|')));
  const extraCount = Math.min(18, shortcutCandidates.length);
  for (let i = 0; i < extraCount; i++) {
    const idx = Math.floor(rng() * shortcutCandidates.length);
    const pick = shortcutCandidates.splice(idx, 1)[0];
    const key = [pick.a, pick.b].sort().join('|');
    if (!existing.has(key)) { edges.push([pick.a, pick.b]); existing.add(key); }
  }
  return edges;
}
const COUNTRY_ROAD_EDGES = buildCountryRoadEdges();

// A road's look depends on what it connects: a route between two big
// settlements is a proper highway (wide, straight-ish, bright); anything
// touching a small town or village is a rural road (thinner, muted, winding).
function countryEdgeClass(aId, bId) {
  const big = t => t === 'metro' || t === 'big';
  return (big(SETTLEMENT_TIER[aId]) && big(SETTLEMENT_TIER[bId])) ? 'highway' : 'rural';
}
function countryEdgeGeom(aId, bId) {
  return countryEdgeClass(aId, bId) === 'highway' ? { segments: 5, maxOffset: 4 } : { segments: 8, maxOffset: 9 };
}

// Memoized once — the country road network never changes at runtime.
let countryRoadPolylinesCache = null;
function getCountryRoadPolylines() {
  if (countryRoadPolylinesCache) return countryRoadPolylinesCache;
  countryRoadPolylinesCache = COUNTRY_ROAD_EDGES.map(([aId, bId]) => {
    const geom = countryEdgeGeom(aId, bId);
    const poly = getEdgePolyline('country', aId, bId, cityMeta(aId), cityMeta(bId), geom.segments, geom.maxOffset);
    return { aId, bId, cls: countryEdgeClass(aId, bId), poly };
  });
  return countryRoadPolylinesCache;
}

// Every city (incl. procedurally generated ones) gets: a namespaced point set,
// a namespaced edge list, and exactly one "gate" point wired to the country
// highway network. WORLD_POINTS/WORLD_EDGES accumulate everyone's points.
const WORLD_POINTS = {};
const WORLD_EDGES = [];

function addCityDef(cityId, rawPoints, rawEdges, gateAnchorLocalId) {
  rawPoints.forEach(p => {
    WORLD_POINTS[`${cityId}:${p.id}`] = { id: `${cityId}:${p.id}`, name: p.name, type: p.type, x: p.x, y: p.y, hours: p.hours || null };
  });
  rawEdges.forEach(([a, b]) => WORLD_EDGES.push([`${cityId}:${a}`, `${cityId}:${b}`]));
  const meta = cityMeta(cityId);
  const gateId = `${cityId}:gate`;
  WORLD_POINTS[gateId] = { id: gateId, name: 'Выезд на трассу', type: 'gate', x: 3, y: 50, countryX: meta.x, countryY: meta.y };
  WORLD_EDGES.push([gateId, `${cityId}:${gateAnchorLocalId}`]);
}

addCityDef('rivnoe', RIVNOE_POINTS_RAW, RIVNOE_EDGES_RAW, 'home');

// ---------- procedural settlement layouts (tiered, named, logical) ----------

const SETTLEMENT_NAME_POOLS = {
  market: ['Центральный рынок', 'Колхозный рынок', 'Рынок «Изобилие»', 'Городской рынок', 'Ярмарка'],
  warehouse: ['Склад «Логист»', 'Оптовая база', 'Грузовой терминал', 'Логистический центр'],
  bus: ['Автовокзал', 'Автостанция'],
  busStop: ['Автобусная остановка', 'Остановка «Центральная»'],
  hospital: ['Больница №1', 'Городская больница', 'Поликлиника №2'],
  clinic: ['Фельдшерский пункт', 'Амбулатория'],
  mall: ['ТЦ «Горизонт»', 'ТЦ «Галактика»', 'Торговый центр', 'Универмаг'],
  district: ['Северный микрорайон', 'Южный микрорайон', 'Частный сектор', 'Новый квартал', 'Заречная слобода', 'Рабочий посёлок'],
  park: ['Парк Победы', 'Центральный парк', 'Городской сад', 'Сквер Мира'],
  cafe: ['Кафе «Уют»', 'Кафе «Дорожное»', 'Кафе «Ромашка»', 'Столовая №1', 'Кафе «Встреча»'],
  workshop: ['Мастерская «Гайка»', 'Автосервис', 'СТО «Мотор»'],
  gas: ['АЗС «Полный бак»', 'Заправка', 'АЗС №3'],
  shop: ['Магазин техники «Скорость»', 'Мото-Авто Центр', 'Салон техники', 'Магазин «Колесо»'],
  garage: ['Гараж компании', 'Автобаза', 'Транспортный двор', 'Грузовой двор'],
};
const SETTLEMENT_POINT_TYPE = {
  market: 'delivery', warehouse: 'delivery', bus: 'delivery', busStop: 'delivery',
  hospital: 'delivery', clinic: 'delivery', mall: 'delivery', district: 'delivery', park: 'delivery',
  cafe: 'cafe', workshop: 'workshop', gas: 'gas', shop: 'shop', garage: 'garage',
};
// Every organization keeps its own hours; a few run round the clock.
const HOURS_BY_KIND = {
  market: { open: 7 * 60, close: 19 * 60 },
  warehouse: { open: 8 * 60, close: 18 * 60 },
  bus: { always: true },
  busStop: { always: true },
  hospital: { always: true },
  clinic: { open: 8 * 60, close: 20 * 60 },
  mall: { open: 10 * 60, close: 22 * 60 },
  district: { always: true }, // delivering to someone's home, not a business
  park: { open: 6 * 60, close: 23 * 60 },
  cafe: { open: 7 * 60, close: 23 * 60 },
  workshop: { open: 9 * 60, close: 19 * 60 },
  gas: { always: true },
  shop: { open: 9 * 60, close: 20 * 60 },
  garage: { always: true }, // company property — accessible round the clock
};
function hoursForKind(kind, rng) {
  const base = HOURS_BY_KIND[kind];
  if (!base) return null;
  // A minority of cafes are 24h diners — variety, and a legitimate lifeline
  // for a courier stuck hungry in the middle of the night.
  if (kind === 'cafe' && !base.always && rng() < 0.2) return { always: true };
  return base;
}
// What each tier is built from: which delivery-ish points it gets (repeats
// allowed for multiple districts/malls), how many cafes, and whether it has
// a vehicle shop, workshop, or gas station at all.
const TIER_BLUEPRINTS = {
  village: { points: ['busStop', 'market'], cafes: 1, gasChance: 0.5, shop: false, workshop: false },
  small: { points: ['bus', 'market', 'district'], cafes: 1, gasChance: 0.8, shop: true, workshop: false },
  big: { points: ['bus', 'market', 'warehouse', 'district', 'district', 'mall'], cafes: 2, gasChance: 1, shop: true, workshop: true },
  metro: { points: ['bus', 'market', 'warehouse', 'hospital', 'mall', 'mall', 'district', 'district', 'district', 'park'], cafes: 3, gasChance: 1, shop: true, workshop: true },
};
// Vehicle categories sold in each tier's shop — bigger settlements stock
// bigger vehicles, giving cross-country travel an actual purpose.
const TIER_SHOP_CATEGORIES = {
  village: ['foot', 'scooter', 'bike', 'moped'],
  small: ['foot', 'scooter', 'bike', 'moped', 'motorcycle'],
  big: ['foot', 'scooter', 'bike', 'moped', 'motorcycle', 'car'],
  metro: ['foot', 'scooter', 'bike', 'moped', 'motorcycle', 'car', 'van', 'truck'],
};

function pickUnusedName(kind, rng, used) {
  const pool = SETTLEMENT_NAME_POOLS[kind];
  for (let i = 0; i < pool.length; i++) {
    const candidate = pickSeeded(pool, rng);
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
  const fallback = `${pool[0]} №${used.size + 1}`;
  used.add(fallback);
  return fallback;
}

// Big cities/metros get a radial layout instead of a rigid grid: points sit at
// varying distances/angles from the centre (uneven "block" sizes, nothing
// snapped to a corner), connected by radial avenues out from the centre plus
// roads linking points within the same ring — and metros additionally close
// the outermost ring into a loop, like a beltway/MKAD around the city.
function buildUrbanPoints(kinds, tier, rng, used) {
  const n = kinds.length;
  const ringCount = tier === 'metro' ? 3 + Math.floor(rng() * 2) : 2 + Math.floor(rng() * 2);
  const ringAssignments = [];
  for (let i = 0; i < n; i++) ringAssignments.push(i % ringCount);
  const shuffledRings = seededShuffle(ringAssignments, rng);
  const minRadius = 9, maxRadius = 38;
  return kinds.map((kind, i) => {
    const ring = shuffledRings[i];
    const radiusBase = ringCount > 1 ? minRadius + (ring / (ringCount - 1)) * (maxRadius - minRadius) : (minRadius + maxRadius) / 2;
    const radius = radiusBase + (rng() - 0.5) * 7;
    const angle = rng() * Math.PI * 2;
    const x = clamp(50 + Math.cos(angle) * radius, 6, 94);
    const y = clamp(50 + Math.sin(angle) * radius, 6, 94);
    return { id: `pt${i}`, name: pickUnusedName(kind, rng, used), type: SETTLEMENT_POINT_TYPE[kind], x, y, ring, angle, hours: hoursForKind(kind, rng) };
  });
}
function buildUrbanEdges(points, tier) {
  const edges = [];
  const byRing = {};
  points.forEach(p => (byRing[p.ring] = byRing[p.ring] || []).push(p));
  const ringIndices = Object.keys(byRing).map(Number).sort((a, b) => a - b);

  ringIndices.forEach((ringIdx, idx) => {
    const ringPts = byRing[ringIdx].slice().sort((a, b) => a.angle - b.angle);
    for (let i = 1; i < ringPts.length; i++) edges.push([ringPts[i - 1].id, ringPts[i].id]);
    const isOutermost = idx === ringIndices.length - 1;
    if (isOutermost && tier === 'metro' && ringPts.length >= 3) {
      edges.push([ringPts[ringPts.length - 1].id, ringPts[0].id]); // beltway closure
    }
  });

  for (let r = 1; r < ringIndices.length; r++) {
    const inner = byRing[ringIndices[r - 1]];
    const outer = byRing[ringIndices[r]];
    outer.forEach(op => {
      let best = null, bestDiff = Infinity;
      inner.forEach(ip => {
        let diff = Math.abs(ip.angle - op.angle);
        diff = Math.min(diff, Math.PI * 2 - diff);
        if (diff < bestDiff) { bestDiff = diff; best = ip; }
      });
      edges.push([op.id, best.id]); // radial avenue toward the centre
    });
  }
  return edges;
}
function buildOrganicPoints(kinds, rng, used) {
  return kinds.map((kind, i) => ({ id: `pt${i}`, name: pickUnusedName(kind, rng, used), type: SETTLEMENT_POINT_TYPE[kind], x: 12 + rng() * 76, y: 12 + rng() * 76, hours: hoursForKind(kind, rng) }));
}
function buildOrganicEdges(points, rng) {
  const edges = [];
  for (let i = 1; i < points.length; i++) edges.push([points[i - 1].id, points[i].id]);
  const extra = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < extra; i++) {
    const a = points[Math.floor(rng() * points.length)];
    const b = points[Math.floor(rng() * points.length)];
    if (a.id !== b.id) edges.push([a.id, b.id]);
  }
  return edges;
}

function buildSettlementLayout(cityId, tier) {
  const rng = seededRandom(hashStr('layout:' + cityId));
  const blueprint = TIER_BLUEPRINTS[tier];
  const used = new Set();
  const kinds = [...blueprint.points];
  for (let i = 0; i < blueprint.cafes; i++) kinds.push('cafe');
  if (blueprint.shop) kinds.push('shop');
  if (blueprint.workshop) kinds.push('workshop');
  if (rng() < blueprint.gasChance) kinds.push('gas');
  // Every settlement gets exactly one company garage slot, regardless of
  // tier — it's what makes it purchasable later, not something built in.
  kinds.push('garage');

  const isUrban = tier === 'big' || tier === 'metro';
  const points = isUrban ? buildUrbanPoints(kinds, tier, rng, used) : buildOrganicPoints(kinds, rng, used);
  const edges = isUrban ? buildUrbanEdges(points, tier) : buildOrganicEdges(points, rng);
  return { points, edges, anchorId: points[0].id };
}

COUNTRY_CITIES.filter(c => c.id !== 'rivnoe').forEach(c => {
  const layout = buildSettlementLayout(c.id, c.tier);
  addCityDef(c.id, layout.points, layout.edges, layout.anchorId);
});

function pointSpace(id) { return id.startsWith('hwy:') ? 'country' : id.split(':')[0]; }
function pointById(id) { return WORLD_POINTS[id]; }
function pointFullLabel(id) {
  const pt = pointById(id);
  const city = cityMeta(pointSpace(id));
  return city ? `${pt.name} (${city.name})` : pt.name;
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
  const lakes = [];
  const lakeCount = rng() < 0.55 ? 1 : 0;
  for (let i = 0; i < lakeCount; i++) lakes.push({ x: 10 + rng() * 80, y: 10 + rng() * 80, r: 6 + rng() * 6 });
  // Marshes cluster near riverbanks — realistic, and ties the decor together.
  const marshes = [];
  rivers.forEach((river, ri) => {
    const marshCount = rng() < 0.6 ? 1 : 0;
    for (let i = 0; i < marshCount; i++) {
      const t = 0.15 + rng() * 0.7;
      const spot = pointOnPolyline(river, t);
      const angle = rng() * Math.PI * 2;
      const dist = 2 + rng() * 3;
      marshes.push({ x: clamp(spot.x + Math.cos(angle) * dist, 2, 98), y: clamp(spot.y + Math.sin(angle) * dist, 2, 98), r: 4 + rng() * 4 });
    }
  });
  const decor = { forests, rivers, lakes, marshes };
  DECOR_CACHE[mapKey] = decor;
  return decor;
}

// ---------- highway chains between cities (with waystops) ----------

COUNTRY_ROAD_EDGES.forEach(([cityAId, cityBId]) => {
  const a = cityMeta(cityAId), b = cityMeta(cityBId);
  const edgeKey = [cityAId, cityBId].slice().sort().join('-');
  const geom = countryEdgeGeom(cityAId, cityBId);
  const fullPoly = windingPolyline(`country:${edgeKey}`, a, b, geom.segments, geom.maxOffset);
  const totalLenKm = polylineLengthUnits(fullPoly) * COUNTRY_KM_PER_UNIT;
  const stopCount = clamp(Math.floor(totalLenKm / 45), 0, 3);
  const fractions = [];
  for (let i = 1; i <= stopCount; i++) fractions.push(i / (stopCount + 1));

  let prevId = `${cityAId}:gate`;
  fractions.forEach((f, i) => {
    const pos = pointOnPolyline(fullPoly, f);
    const stopId = `hwy:${edgeKey}:${i}`;
    WORLD_POINTS[stopId] = { id: stopId, name: `Придорожная стоянка ${i + 1} (${a.name}—${b.name})`, type: 'waystop', x: pos.x, y: pos.y, hours: { always: true } };
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
// Big cities/metros have laid-out street grids (straight block roads); small
// towns and villages grew organically (winding lanes). This same jitter feeds
// both the actual travel-distance math and the road rendering, so the two
// always agree with each other.
function edgeJitter(space) {
  if (space === 'country') return [7, 7];
  const tier = SETTLEMENT_TIER[space] || 'village';
  return (tier === 'big' || tier === 'metro') ? [1, 0] : [5, 5];
}

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
// Cumulative km at each node of the path (cum[0] === 0, cum[last] === total
// path length) — lets a traveler figure out exactly which node they've just
// reached/passed given only how many km they've covered so far.
function pathCumulativeKm(path) {
  const cum = [0];
  for (let i = 0; i < path.length - 1; i++) cum.push(cum[i] + waypointDist(path[i], path[i + 1]));
  return cum;
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

function minuteOfDay(gameTime) { return (gameTime + DAY_START_OFFSET) % 1440; }

function isNight() {
  const m = minuteOfDay(state.gameTime);
  return m >= NIGHT_START_MIN || m < NIGHT_END_MIN;
}

const MAX_NIGHT_ALPHA = 0.6;
// A smooth dusk → deep night → dawn curve entirely inside the mechanical night
// window: darkness peaks exactly at its midpoint (02:00) and fades back to
// nothing right at the window's edges (22:00 / 06:00), so it lines up with the
// existing night-speed penalty instead of just being a hard on/off tint.
function nightAlpha() {
  const m = minuteOfDay(state.gameTime);
  const nightMid = (NIGHT_START_MIN + (NIGHT_END_MIN + 1440)) / 2 % 1440; // 02:00
  const halfWindow = ((NIGHT_END_MIN + 1440) - NIGHT_START_MIN) / 2; // 4h
  const diff = Math.abs(((m - nightMid + 720 + 1440) % 1440) - 720);
  const t = clamp(1 - diff / halfWindow, 0, 1);
  return t * MAX_NIGHT_ALPHA;
}

// ---------- business hours ----------
// `hours` on a point is either {always:true} or {open, close} in minutes-of-day.
// Points with no `hours` at all (home, gate, the highway itself) are never gated.
function isPointOpenNow(point) {
  const hours = point && point.hours;
  if (!hours) return true;
  if (hours.always) return true;
  const m = minuteOfDay(state.gameTime);
  return hours.open <= hours.close ? (m >= hours.open && m < hours.close) : (m >= hours.open || m < hours.close);
}
function minutesUntilOpen(point) {
  const hours = point && point.hours;
  if (!hours || hours.always) return 0;
  const m = minuteOfDay(state.gameTime);
  if (isPointOpenNow(point)) return 0;
  return m < hours.open ? hours.open - m : (1440 - m) + hours.open;
}
function formatHoursLabel(point) {
  const hours = point && point.hours;
  if (!hours) return '';
  if (hours.always) return 'круглосуточно';
  const fmt = mins => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return `${fmt(hours.open)}–${fmt(hours.close)}`;
}

// ---------- state ----------

let state = null;
let actionIdSeq = 1;
let lastFrameTs = null;
let autosaveAccum = 0;
let toasts = [];
let leavingToastIds = new Set();
let uiSelectedPointId = null;
let uiRouteJobId = null; // taken job whose full route is highlighted on the map
let catchupBuffer = null;
let offlinePauseRequested = false; // set mid-catchup when a crisis must hand control back live
let offlineAutoTally = null; // { meals, foodSpent, sleeps, sleepSpent } while catching up

function resolveOfflineBreakdown(activity) {
  const p = state.player;
  const spec = vehicleSpec();
  const type = breakdownPoolFor(spec).find(t => t.id === activity.problem.typeId);
  if (!type) return;
  const pendingIdx = state.pendingActions.findIndex(pa => pa.kind === 'breakdown' && pa.typeId === type.id);
  if (type.severity === 'minor') {
    // Minor issues are cheap enough to just shrug off automatically.
    activity.totalKm *= type.ignorePenalty;
    log(`${type.label} — мелочь, проигнорировал на ходу (офлайн)`, { silent: true });
  } else if (state.money >= type.towCost) {
    // Can afford the fix — handled automatically, same as choosing it live.
    state.money -= type.towCost;
    p.vehicle.condition = 100;
    log(`${type.label} — устранили автоматически за ${type.towCost} ₽ (офлайн)`, { silent: true });
  } else {
    // Can't afford it — freeze here so the player deals with it live.
    offlinePauseRequested = true;
    return;
  }
  if (pendingIdx !== -1) state.pendingActions.splice(pendingIdx, 1);
  activity.problemPending = false;
  activity.problem = null;
}

const OFFLINE_SLEEP_AWAY_COST = 200; // flat "spent the night somewhere" cost when not home

function offlineAutoEat() {
  const p = state.player;
  const isHome = pointById(p.positionId).type === 'home';
  const opt = EAT_OPTIONS.find(o => o.id === 'meal');
  const cost = isHome ? 0 : EAT_PRICE_CAFE.meal;
  if (state.money < cost) { startEnduring(); return; }
  state.money -= cost;
  p.status = 'eating';
  p.eatElapsed = 0;
  p.eatPlan = { totalMinutes: opt.minutes, hungerRelief: opt.hungerRelief, label: opt.label, hungerStart: p.hunger };
  if (offlineAutoTally) { offlineAutoTally.meals++; offlineAutoTally.foodSpent += cost; }
  log(isHome ? 'Поел дома (авто, пока был офлайн)' : `Поел в кафе по пути — ${cost} ₽ (авто, офлайн)`, { silent: true });
}

function offlineAutoSleep() {
  const p = state.player;
  const spec = vehicleSpec();
  const isHome = pointById(p.positionId).type === 'home';
  if (isHome) {
    p.status = 'resting'; p.restElapsed = 0;
    p.restPlan = { totalMinutes: 480, sleepinessRelief: 100, isSleep: true, label: 'Выспаться (8 ч)', sleepinessStart: p.sleepiness };
    if (offlineAutoTally) offlineAutoTally.sleeps++;
    log('Поспал дома (авто, пока был офлайн)', { silent: true });
    return;
  }
  if (state.money >= OFFLINE_SLEEP_AWAY_COST) {
    state.money -= OFFLINE_SLEEP_AWAY_COST;
    p.status = 'resting'; p.restElapsed = 0;
    p.restPlan = { totalMinutes: 480, sleepinessRelief: 100, isSleep: true, label: 'Ночлег', sleepinessStart: p.sleepiness };
    if (offlineAutoTally) { offlineAutoTally.sleeps++; offlineAutoTally.sleepSpent += OFFLINE_SLEEP_AWAY_COST; }
    log(`Переночевал не дома — ${OFFLINE_SLEEP_AWAY_COST} ₽ (авто, офлайн)`, { silent: true });
    return;
  }
  if (spec.draw === 'car' || spec.draw === 'truck') {
    const relief = p.equipment['sleeper_cab'] ? 100 : 70;
    p.status = 'resting'; p.restElapsed = 0;
    p.restPlan = { totalMinutes: 480, sleepinessRelief: relief, isSleep: true, label: 'Поспать в машине (8 ч)', sleepinessStart: p.sleepiness };
    log('Без денег на ночлег — переночевал в машине (авто, офлайн)', { silent: true });
    return;
  }
  // No money and nowhere to properly lie down — same as if this happened live.
  triggerSleepyCollapse();
}

function newGameState() {
  const startingVehicle = { type: 'foot', condition: 100, upgraded: false, fuel: Infinity };
  return {
    money: START_MONEY,
    gameTime: 0,
    lastRealTimestamp: Date.now(),
    autoPlay: true, // when off, time simply doesn't pass while the game is closed
    gameOver: null, // null | 'bankruptcy'
    player: {
      positionId: 'rivnoe:home',
      status: 'idle', // idle | moving | resting | eating | refueling | collapsed
      activity: null,
      hunger: 15,
      sleepiness: 15,
      sleepyGrace: 0, // minutes of post-accident grace before another sleepy-accident roll can happen
      vehicles: [startingVehicle], // every owned vehicle instance; .vehicle below is always one of these (same reference)
      vehicle: startingVehicle,
      restElapsed: 0,
      eatElapsed: 0,
      refuelElapsed: 0,
      restPlan: null,
      eatPlan: null,
      refuelPlan: null,
      collapseRemaining: 0,
      collapsePrevStatus: 'idle',
      collapseSleepinessStart: 0,
      jobs: [], // { id, fromId, toId, itemName, storage, weightKg, volumeL, urgencyKey, deadlineReal, payout, pickedUp }
      equipment: {},
      warnedHunger: false,
      warnedSleepy: false,
      warnedDebt: false,
      offeredFoodDelivery: false,
      enduring: false,
    },
    availableJobs: [],
    jobIdSeq: 1, // persisted so ids never collide across a page reload (see migrateEconomyFields)
    eventLog: [],
    pendingActions: [],
    stats: { jobsCompleted: 0, totalEarned: 0 },
    lastProcessedDay: 0,
    dailyExpense: { living: 0, vehicleUpkeep: 0, total: 0, day: 1 },
    company: { registered: false, garages: {}, employees: [], employeeIdSeq: 1 }, // once registered: intercity jobs/travel + garages + hiring unlock
  };
}

const COMPANY_HOME_CITY = 'rivnoe'; // the only city playable before registering a company
const COMPANY_REGISTRATION_COST = 20000;
function hasCarForCompany() {
  return state.player.vehicles.some(v => { const spec = VEHICLE_BY_ID[v.type]; return spec && spec.cat === 'car'; });
}
function canRegisterCompany() {
  return !state.company.registered && state.money >= COMPANY_REGISTRATION_COST && hasCarForCompany();
}
function registerCompany() {
  if (state.company.registered) return;
  if (!hasCarForCompany()) { toast('Нужна хотя бы одна легковая машина'); return; }
  if (state.money < COMPANY_REGISTRATION_COST) { toast('Не хватает денег на регистрацию компании'); return; }
  state.money -= COMPANY_REGISTRATION_COST;
  state.company.registered = true;
  log(`Зарегистрировал компанию-грузоперевозчика (${COMPANY_REGISTRATION_COST.toLocaleString('ru-RU')} ₽) — межгородские перевозки открыты`);
}

// ---------- company garages ----------
// One purchasable garage slot per settlement — a company-funded stand-in for
// "home" while out on the road: free eat/sleep/repair (and free EV charging,
// same as at home) for whoever is standing there, no travel back to Rivnoe.
const GARAGE_COST_BY_TIER = { village: 8000, small: 18000, big: 40000, metro: 80000 };
function garageCostForCity(cityId) {
  return GARAGE_COST_BY_TIER[SETTLEMENT_TIER[cityId] || 'village'];
}
function hasGarageInCity(cityId) {
  return !!(state.company.garages && state.company.garages[cityId]);
}
function buyGarage(cityId) {
  if (!state.company.registered) { toast('Нужна своя компания, чтобы покупать гаражи'); return; }
  if (hasGarageInCity(cityId)) return;
  const cost = garageCostForCity(cityId);
  if (state.money < cost) { toast('Не хватает денег на гараж'); return; }
  state.money -= cost;
  state.company.garages[cityId] = { capacity: GARAGE_DEFAULT_CAPACITY };
  log(`Купил гараж компании в городе «${cityMeta(cityId).name}» (${cost.toLocaleString('ru-RU')} ₽) — ${GARAGE_DEFAULT_CAPACITY} места для сотрудников`);
}

// A garage isn't just for the player's own eat/sleep/repair — every non-foot
// employee needs a bunk somewhere, so garages also cap how many of them the
// company can house at once (expandable per-city; see expandGarage below).
const GARAGE_DEFAULT_CAPACITY = 2;
const GARAGE_EXPAND_BASE_COST = { village: 5000, small: 10000, big: 20000, metro: 40000 };
function garageCapacity(cityId) {
  const g = state.company.garages[cityId];
  return g ? g.capacity : 0;
}
function totalGarageCapacity() {
  return Object.keys(state.company.garages).reduce((sum, cid) => sum + garageCapacity(cid), 0);
}
function garageSlotsUsed() {
  return state.company.employees.filter(e => e.usesGarageSlot).length;
}
function garageSlotsAvailable() {
  return totalGarageCapacity() - garageSlotsUsed();
}
function garageExpandCost(cityId) {
  const g = state.company.garages[cityId];
  const level = g ? g.capacity - GARAGE_DEFAULT_CAPACITY : 0;
  const base = GARAGE_EXPAND_BASE_COST[SETTLEMENT_TIER[cityId] || 'village'];
  return Math.round(base * (1 + level * 0.6));
}
function expandGarage(cityId) {
  if (!hasGarageInCity(cityId)) { toast('В этом городе нет гаража компании'); return; }
  const cost = garageExpandCost(cityId);
  if (state.money < cost) { toast('Не хватает денег на расширение гаража'); return; }
  state.money -= cost;
  state.company.garages[cityId].capacity += 1;
  log(`Расширил гараж компании в городе «${cityMeta(cityId).name}» — теперь ${state.company.garages[cityId].capacity} мест (${cost.toLocaleString('ru-RU')} ₽)`);
}
function garageRepair() {
  const p = state.player;
  if (p.status !== 'idle') return;
  const point = pointById(p.positionId);
  if (point.type !== 'garage' || !hasGarageInCity(pointSpace(point.id))) return;
  if (p.vehicle.condition >= 100) return;
  p.vehicle.condition = 100;
  log('Бесплатный ремонт в гараже компании');
}

// ---------- staffing agency & employees ----------
// Stage 3: hiring infrastructure only — candidates, resumes/licenses, and
// handing them a vehicle from the fleet. The employees don't drive around or
// take jobs on their own yet (that's the next stage); this just builds the
// roster and the vehicle-assignment bookkeeping it depends on.
const PERSON_FIRST_NAMES = ['Александр', 'Дмитрий', 'Сергей', 'Андрей', 'Алексей', 'Иван', 'Михаил', 'Николай', 'Владимир', 'Артём', 'Максим', 'Егор', 'Кирилл', 'Роман', 'Виктор', 'Павел', 'Игорь', 'Юрий', 'Денис', 'Олег'];
const PERSON_LAST_NAMES = ['Иванов', 'Петров', 'Сидоров', 'Смирнов', 'Кузнецов', 'Попов', 'Соколов', 'Козлов', 'Новиков', 'Морозов', 'Волков', 'Алексеев', 'Захаров', 'Павлов', 'Семёнов', 'Голубев', 'Виноградов', 'Богданов'];

// Simplified real-world-ish license tiers — each one cumulatively unlocks the
// vehicle categories below it, so a "категория C" hire can also legally drive
// anything a "без прав" courier can.
const LICENSE_TIERS_ORDER = ['none', 'M', 'A', 'B', 'C'];
const LICENSE_UNLOCKS_CATS = {
  none: ['foot', 'scooter', 'bike'],
  M: ['moped'],
  A: ['motorcycle'],
  B: ['car'],
  C: ['van', 'truck'],
};
const LICENSE_LABEL = {
  none: 'без категории (пешком/самокат/велосипед)',
  M: 'категория M (+ мопед)',
  A: 'категория A (+ мотоцикл)',
  B: 'категория B (+ легковая)',
  C: 'категория C (+ фургон/грузовик)',
};
function licenseAllowsVehicleCat(license, cat) {
  const idx = LICENSE_TIERS_ORDER.indexOf(license);
  for (let i = 0; i <= idx; i++) { if (LICENSE_UNLOCKS_CATS[LICENSE_TIERS_ORDER[i]].includes(cat)) return true; }
  return false;
}
const HIRE_FEE_BY_LICENSE = { none: 3000, M: 6000, A: 9000, B: 15000, C: 30000 };
const JOB_PREF_OPTIONS = [
  { id: 'expensive', label: 'Самые дорогие заказы' },
  { id: 'fastest', label: 'Самые быстрые (короткие) заказы' },
  { id: 'closest', label: 'Заказы ближе к нему' },
];

let candidatePool = [];
function generateCandidate() {
  const roll = Math.random();
  const license = roll > 0.85 ? 'C' : roll > 0.7 ? 'B' : roll > 0.5 ? 'A' : roll > 0.3 ? 'M' : 'none';
  return { name: `${pick(PERSON_FIRST_NAMES)} ${pick(PERSON_LAST_NAMES)}`, license, fee: HIRE_FEE_BY_LICENSE[license] };
}
function refreshCandidatePool() {
  candidatePool = Array.from({ length: 4 }, generateCandidate);
}
function eligibleVehiclesFor(license) {
  return state.player.vehicles.filter(v => v !== state.player.vehicle && !v.assignedTo && licenseAllowsVehicleCat(license, VEHICLE_BY_ID[v.type].cat));
}
function hireEmployee(candidateIdx, vehicleType) {
  if (!state.company.registered) { toast('Нужна своя компания, чтобы нанимать сотрудников'); return; }
  const cand = candidatePool[candidateIdx];
  if (!cand) return;
  if (state.money < cand.fee) { toast('Не хватает денег на найм'); return; }
  const veh = state.player.vehicles.find(v => v.type === vehicleType);
  if (!veh || veh === state.player.vehicle || veh.assignedTo) { toast('Нужен свободный транспорт для этого сотрудника'); return; }
  const spec = VEHICLE_BY_ID[vehicleType];
  if (!licenseAllowsVehicleCat(cand.license, spec.cat)) { toast('У этого сотрудника нет прав на такой транспорт'); return; }
  // Pedestrian hires are "locals" who look after themselves at their own place —
  // everyone else needs a bunk in a company garage somewhere.
  const usesGarageSlot = spec.cat !== 'foot';
  if (usesGarageSlot && garageSlotsAvailable() <= 0) { toast('Нет свободных мест в гаражах — купи гараж или расширь существующий'); return; }
  state.money -= cand.fee;
  veh.assignedTo = state.company.employeeIdSeq;
  state.company.employees.push({
    id: state.company.employeeIdSeq++, name: cand.name, license: cand.license, vehicleType, jobPref: 'expensive',
    working: false, status: 'afk', positionId: state.player.positionId,
    hunger: 30, sleepiness: 20, activity: null, pendingActivity: null, earnings: 0,
    taskElapsed: 0, taskTotal: 0, trainingRemaining: 0, trainingTarget: null,
    usesGarageSlot,
  });
  candidatePool.splice(candidateIdx, 1);
  log(`Нанял сотрудника: ${cand.name} (${LICENSE_LABEL[cand.license]}) — выдал «${spec.name}» (${cand.fee.toLocaleString('ru-RU')} ₽)`);
}
function fireEmployee(employeeId) {
  const emp = state.company.employees.find(e => e.id === employeeId);
  if (!emp) return;
  if (!employeeIsFree(emp)) { toast('Сначала дождись, пока сотрудник освободится'); return; }
  const veh = state.player.vehicles.find(v => v.type === emp.vehicleType);
  if (veh) veh.assignedTo = null;
  state.company.employees = state.company.employees.filter(e => e.id !== employeeId);
  log(`Уволил сотрудника: ${emp.name}`);
}
function setEmployeeJobPref(employeeId, pref) {
  const emp = state.company.employees.find(e => e.id === employeeId);
  if (emp) emp.jobPref = pref;
}

// An employee mid-delivery or mid-course can't be reassigned out from under
// the job/training without either abandoning cargo or wasting the fee already
// paid — so every management action below requires them to be free first.
function employeeIsFree(emp) { return emp.status !== 'moving' && emp.status !== 'training'; }

function toggleEmployeeWorking(employeeId) {
  const emp = state.company.employees.find(e => e.id === employeeId);
  if (!emp) return;
  if (emp.status === 'training') { toast('Сотрудник сейчас на курсах — недоступен'); return; }
  if (!emp.working) {
    if (!emp.vehicleType) { toast('Сначала выдай сотруднику транспорт'); return; }
    emp.working = true;
    if (emp.status === 'afk') emp.status = 'idle';
  } else {
    emp.working = false;
    // If he's out mid-delivery, let him finish it — the tick loop sends him
    // heading for the nearest garage on his own once he's free again (or,
    // for a pedestrian, straight home), same as the player logging off.
    if (emp.status === 'idle') emp.status = 'afk';
  }
}

function takeEmployeeVehicle(employeeId) {
  const emp = state.company.employees.find(e => e.id === employeeId);
  if (!emp) return;
  if (!employeeIsFree(emp)) { toast('Сначала дождись, пока сотрудник освободится'); return; }
  if (!emp.vehicleType) return;
  const veh = state.player.vehicles.find(v => v.type === emp.vehicleType);
  if (veh) veh.assignedTo = null;
  emp.vehicleType = null;
  emp.working = false;
  emp.status = 'afk';
  emp.activity = null;
  emp.pendingActivity = null;
  log(`Забрал транспорт у сотрудника ${emp.name} — переведён в АФК`);
}

function assignEmployeeVehicle(employeeId, vehicleType) {
  const emp = state.company.employees.find(e => e.id === employeeId);
  if (!emp) return;
  if (!employeeIsFree(emp)) { toast('Сначала дождись, пока сотрудник освободится'); return; }
  const veh = state.player.vehicles.find(v => v.type === vehicleType);
  if (!veh || veh === state.player.vehicle || veh.assignedTo) { toast('Этот транспорт сейчас недоступен'); return; }
  const spec = VEHICLE_BY_ID[vehicleType];
  if (!licenseAllowsVehicleCat(emp.license, spec.cat)) { toast('У сотрудника нет прав на такой транспорт'); return; }
  const needsGarageNow = spec.cat !== 'foot';
  // Swapping a pedestrian onto real wheels newly claims a garage slot — swapping
  // the other way (or between two non-foot vehicles) doesn't change the count.
  if (needsGarageNow && !emp.usesGarageSlot && garageSlotsAvailable() <= 0) {
    toast('Нет свободных мест в гаражах для транспорта — купи гараж или расширь существующий'); return;
  }
  if (emp.vehicleType) {
    const oldVeh = state.player.vehicles.find(v => v.type === emp.vehicleType);
    if (oldVeh) oldVeh.assignedTo = null;
  }
  veh.assignedTo = emp.id;
  emp.vehicleType = vehicleType;
  emp.usesGarageSlot = needsGarageNow;
  log(`Выдал сотруднику ${emp.name} транспорт: ${spec.name}`);
}

function sendEmployeeToGarage(employeeId, cityId) {
  const emp = state.company.employees.find(e => e.id === employeeId);
  if (!emp) return;
  if (!hasGarageInCity(cityId)) { toast('В этом городе нет гаража компании'); return; }
  if (!employeeIsFree(emp)) { toast('Сначала дождись, пока сотрудник освободится'); return; }
  const spec = VEHICLE_BY_ID[emp.vehicleType];
  if (!spec) { toast('Сначала выдай сотруднику транспорт'); return; }
  if (spec.cat === 'foot' && pointSpace(emp.positionId) !== cityId) { toast('Пешком до другого города не дойти'); return; }
  emp.working = false;
  const targetId = `${cityId}:garage`;
  if (emp.positionId === targetId) { emp.status = 'afk'; emp.activity = null; log(`Сотрудник ${emp.name} уже в этом гараже — переведён в АФК`); return; }
  const path = shortestPath(emp.positionId, targetId);
  emp.activity = buildEmployeeActivity(path, targetId, 'to_garage', null);
  emp.status = 'moving';
  log(`Отправил сотрудника ${emp.name} в гараж компании (${cityMeta(cityId).name}) — едет туда своим ходом`);
}

const LICENSE_UPGRADE_COST = { M: 8000, A: 12000, B: 20000, C: 35000 };
const TRAINING_WAGE_PER_DAY = 200;
const TRAINING_DAYS = 14;
function startEmployeeTraining(employeeId) {
  const emp = state.company.employees.find(e => e.id === employeeId);
  if (!emp) return;
  const idx = LICENSE_TIERS_ORDER.indexOf(emp.license);
  if (idx >= LICENSE_TIERS_ORDER.length - 1) { toast('У сотрудника уже максимальная категория'); return; }
  if (!employeeIsFree(emp)) { toast('Сначала дождись, пока сотрудник освободится'); return; }
  const targetLicense = LICENSE_TIERS_ORDER[idx + 1];
  const cost = LICENSE_UPGRADE_COST[targetLicense] + TRAINING_WAGE_PER_DAY * TRAINING_DAYS;
  if (state.money < cost) { toast('Не хватает денег на обучение сотрудника'); return; }
  state.money -= cost;
  emp.working = false;
  emp.status = 'training';
  emp.trainingTarget = targetLicense;
  emp.trainingRemaining = TRAINING_DAYS * 1440;
  emp.activity = null;
  emp.pendingActivity = null;
  log(`Отправил сотрудника ${emp.name} на курсы повышения категории до «${targetLicense}» (${cost.toLocaleString('ru-RU')} ₽, ~${TRAINING_DAYS} дней, минимальная зарплата всё время курса)`);
}

// ---------- employee autonomous work loop ----------
// Employees drive the real road graph at their vehicle's speed and never
// teleport: fuel drains as they go (shared with the same vehicle instance
// the player owns), and while en route they proactively watch ahead and pull
// off at the next suitable stop — a gas station/waystop for fuel (with a
// safety margin, so they never actually run the tank dry), a cafe/gas/waystop
// or a company garage for food, a company garage (or, for car/truck, the cab
// itself, anywhere) for sleep, or — failing all of that — a paid roadside
// place to crash, billed to the company. Pedestrians are the one exception:
// they're modeled as locals who eat/sleep at their own place for free and
// don't need any of this (also why they're exempt from the garage-slot
// requirement to be hired at all). Going AFK doesn't strand them either —
// they finish whatever they're carrying, then drive to the nearest owned
// garage before actually parking. Deliberately still simplified vs. the
// player: only "normal"-storage jobs (no equipment of their own yet), and no
// condition wear/breakdowns/accidents.
const EMPLOYEE_EAT_THRESHOLD = 70;
const EMPLOYEE_SLEEP_THRESHOLD = 70;
const EMPLOYEE_EAT_MINUTES = 60;
const EMPLOYEE_SLEEP_MINUTES = 240;
const EMPLOYEE_HOSTEL_COST = 500;
const EMPLOYEE_FUEL_SAFETY_MARGIN = 1.2;
const EMPLOYEE_STATUS_LABEL = {
  afk: '🔴 АФК (за свой счёт)',
  idle: '🟢 Свободен, ищет заказ',
  moving: '🟢 В пути',
  eating: '🟢 Ест (за счёт компании)',
  resting: '🟢 Отдыхает (за счёт компании)',
  refueling: '🟢 Заправляется (за счёт компании)',
  training: '🎓 На курсах повышения категории',
};

function jobFitsEmployeeVehicle(job, emp) {
  const spec = VEHICLE_BY_ID[emp.vehicleType];
  if (!spec) return false;
  if (job.storage !== 'normal') return false;
  if (job.weightKg > spec.kg || job.volumeL > spec.l) return false;
  if (spec.cat === 'foot') {
    return pointSpace(job.fromId) === pointSpace(job.toId) && pointSpace(job.fromId) === pointSpace(emp.positionId);
  }
  return true;
}

function findJobForEmployee(emp) {
  const candidates = state.availableJobs.filter(j => jobFitsEmployeeVehicle(j, emp));
  if (candidates.length === 0) return null;
  if (emp.jobPref === 'expensive') return candidates.reduce((a, b) => (b.payout > a.payout ? b : a));
  if (emp.jobPref === 'fastest') return candidates.reduce((a, b) => (b.distanceKm < a.distanceKm ? b : a));
  let best = null, bestDist = Infinity;
  candidates.forEach(j => {
    const d = pathDistanceKm(shortestPath(emp.positionId, j.fromId));
    if (d < bestDist) { bestDist = d; best = j; }
  });
  return best;
}

function buildEmployeeActivity(path, targetId, phase, job) {
  const cum = pathCumulativeKm(path);
  return { path, cum, totalKm: cum[cum.length - 1], traveledKm: 0, nodeIndex: 0, targetId, phase, job: job || null };
}

// Nearest company garage by real road distance — used when an employee needs
// to be routed there (going AFK, or the manual "send to garage" action).
// Returns a ready-to-use activity object, or null if no garage is owned yet.
function nearestGarageActivity(emp) {
  const ownedCities = Object.keys(state.company.garages).filter(cid => hasGarageInCity(cid));
  if (ownedCities.length === 0) return null;
  let best = null, bestDist = Infinity;
  ownedCities.forEach(cid => {
    const targetId = `${cid}:garage`;
    const path = shortestPath(emp.positionId, targetId);
    const d = pathDistanceKm(path);
    if (d < bestDist) { bestDist = d; best = buildEmployeeActivity(path, targetId, 'to_garage', null); }
  });
  return best;
}

function beginEmployeeRefuel(emp, veh, spec, free) {
  const missing = spec.tank - veh.fuel;
  if (!free) state.money -= Math.round(missing * FUEL_COST_PER_KM_RANGE[spec.fuel]);
  emp.pendingActivity = emp.activity; emp.activity = null;
  emp.status = 'refueling';
  emp.taskElapsed = 0;
  emp.taskTotal = Math.max(2, Math.round((missing / spec.tank) * REFUEL_MINUTES_FULL));
}
function beginEmployeeEat(emp, free) {
  if (!free) state.money -= EAT_PRICE_CAFE.meal;
  emp.pendingActivity = emp.activity; emp.activity = null;
  emp.status = 'eating'; emp.taskElapsed = 0; emp.taskTotal = EMPLOYEE_EAT_MINUTES;
}
function beginEmployeeSleep(emp, free) {
  if (!free) state.money -= EMPLOYEE_HOSTEL_COST;
  emp.pendingActivity = emp.activity; emp.activity = null;
  emp.status = 'resting'; emp.taskElapsed = 0; emp.taskTotal = EMPLOYEE_SLEEP_MINUTES;
}
function resumeEmployeeActivity(emp) {
  if (emp.pendingActivity) { emp.activity = emp.pendingActivity; emp.pendingActivity = null; emp.status = 'moving'; }
  else emp.status = 'idle';
}

// Called at every node the employee reaches along its route (remainingKm is
// the distance still left in the CURRENT leg, or null when just standing
// idle deciding what to do next). Returns true if a stop was started.
function tryStopAtNode(emp, spec, veh, nodeId, remainingKm) {
  const pt = pointById(nodeId);
  if (!pt) return false;
  const citySpace = pointSpace(nodeId);
  // "home" is the PLAYER's own house, not a company facility — only an owned
  // garage is free for an employee's vehicle (this function is never called
  // for foot employees, who get their own separate, always-free, always-at-
  // home-conceptually handling in runEmployeeTick).
  const isGarage = pt.type === 'garage' && hasGarageInCity(citySpace);
  const isFuelStop = pt.type === 'gas' || pt.type === 'waystop';

  if (spec.fuel !== 'legs') {
    const forwardNeed = remainingKm !== null && veh.fuel < remainingKm * EMPLOYEE_FUEL_SAFETY_MARGIN;
    const opportunistic = remainingKm === null && veh.fuel < spec.tank * 0.5;
    if (forwardNeed || opportunistic) {
      if (isFuelStop) { beginEmployeeRefuel(emp, veh, spec, false); return true; }
      if (isGarage && spec.fuel === 'electric') { beginEmployeeRefuel(emp, veh, spec, true); return true; }
    }
  }
  if (emp.hunger >= EMPLOYEE_EAT_THRESHOLD) {
    if (isGarage) { beginEmployeeEat(emp, true); return true; }
    if (pt.type === 'cafe' || isFuelStop) { beginEmployeeEat(emp, false); return true; }
  }
  if (emp.sleepiness >= EMPLOYEE_SLEEP_THRESHOLD) {
    if (vehicleCanSleepIn(spec)) { beginEmployeeSleep(emp, true); return true; } // pulls over, sleeps in the cab
    if (isGarage) { beginEmployeeSleep(emp, true); return true; }
    beginEmployeeSleep(emp, false); return true; // last resort: a cheap room nearby, on the company
  }
  return false;
}

function runEmployeeTick(emp, dt) {
  if (emp.status === 'training') {
    emp.trainingRemaining = Math.max(0, emp.trainingRemaining - dt);
    if (emp.trainingRemaining <= 0) {
      const oldLicense = emp.license;
      emp.license = emp.trainingTarget;
      emp.trainingTarget = null;
      emp.status = 'idle';
      log(`Сотрудник ${emp.name} завершил обучение: ${LICENSE_LABEL[oldLicense]} → ${LICENSE_LABEL[emp.license]}`);
    }
    return;
  }
  if (emp.status === 'afk') return; // off the clock — takes care of himself, not our problem

  const spec = VEHICLE_BY_ID[emp.vehicleType];
  if (!spec) { emp.status = 'afk'; emp.working = false; return; }
  const veh = state.player.vehicles.find(v => v.type === emp.vehicleType);
  if (!veh) { emp.status = 'afk'; emp.working = false; emp.vehicleType = null; emp.activity = null; return; }
  const isFoot = spec.cat === 'foot';

  if (emp.status === 'eating') {
    emp.taskElapsed += dt;
    if (emp.taskElapsed >= emp.taskTotal) { emp.hunger = 10; resumeEmployeeActivity(emp); }
    return;
  }
  if (emp.status === 'resting') {
    emp.taskElapsed += dt;
    if (emp.taskElapsed >= emp.taskTotal) { emp.sleepiness = 10; resumeEmployeeActivity(emp); }
    return;
  }
  if (emp.status === 'refueling') {
    emp.taskElapsed += dt;
    if (emp.taskElapsed >= emp.taskTotal) { veh.fuel = spec.tank; resumeEmployeeActivity(emp); }
    return;
  }

  if (emp.status === 'moving' && emp.activity) {
    const a = emp.activity;
    const outOfFuel = !isFoot && spec.fuel !== 'legs' && veh.fuel <= 0;
    const kmThisTick = spec.speed * (outOfFuel ? 0.2 : 1) * (dt / 60);
    a.traveledKm = clamp(a.traveledKm + kmThisTick, 0, a.totalKm);
    emp.hunger = clamp(emp.hunger + HUNGER_RATE_MOVING * dt, 0, 100);
    emp.sleepiness = clamp(emp.sleepiness + SLEEPINESS_RATE * dt, 0, 100);
    if (!isFoot && spec.fuel !== 'legs') veh.fuel = clamp(veh.fuel - kmThisTick, 0, spec.tank);

    if (!isFoot) {
      // A save from before this per-node tracking existed (or a plan that
      // otherwise lost it) won't have cum/nodeIndex — rebuild rather than
      // silently skip every stop-check for the rest of the trip.
      if (!Array.isArray(a.cum)) { a.cum = pathCumulativeKm(a.path); a.nodeIndex = 0; }
      while (a.nodeIndex < a.path.length - 1 && a.cum[a.nodeIndex + 1] <= a.traveledKm + 0.0001) {
        a.nodeIndex++;
        emp.positionId = a.path[a.nodeIndex]; // physically there now, whether or not he stops
        const remainingKm = a.totalKm - a.cum[a.nodeIndex];
        if (remainingKm > 0.01 && tryStopAtNode(emp, spec, veh, a.path[a.nodeIndex], remainingKm)) return;
      }
    }

    if (a.traveledKm >= a.totalKm) {
      emp.positionId = a.targetId;
      if (a.phase === 'to_pickup') {
        const path = shortestPath(a.job.fromId, a.job.toId);
        emp.activity = buildEmployeeActivity(path, a.job.toId, 'to_dropoff', a.job);
      } else if (a.phase === 'to_dropoff') {
        const payout = a.job.payout;
        const half = Math.round(payout / 2);
        state.money += half;
        emp.earnings = (emp.earnings || 0) + half;
        log(`${emp.name} доставил «${a.job.itemName}» (${pointFullLabel(a.job.fromId)} → ${pointFullLabel(a.job.toId)}) — компании ${half} ₽, сотруднику ${payout - half} ₽`);
        emp.activity = null;
        emp.status = 'idle';
      } else { // to_garage
        emp.activity = null;
        emp.status = 'afk';
        log(`${emp.name} добрался до гаража компании и ушёл в АФК`, { silent: true });
      }
    }
    return;
  }

  // status === 'idle': not currently on a job — decide what to do next
  emp.hunger = clamp(emp.hunger + HUNGER_RATE_IDLE * dt, 0, 100);
  emp.sleepiness = clamp(emp.sleepiness + SLEEPINESS_RATE * dt, 0, 100);

  if (!emp.working) {
    if (isFoot) { emp.status = 'afk'; return; } // just heads home, abstracted
    const garageActivity = nearestGarageActivity(emp);
    if (garageActivity && garageActivity.totalKm > 0.01) { emp.activity = garageActivity; emp.status = 'moving'; }
    else emp.status = 'afk'; // already there, or no garage owned at all
    return;
  }

  if (isFoot) {
    if (emp.hunger >= EMPLOYEE_EAT_THRESHOLD) { emp.status = 'eating'; emp.taskElapsed = 0; emp.taskTotal = EMPLOYEE_EAT_MINUTES; return; }
    if (emp.sleepiness >= EMPLOYEE_SLEEP_THRESHOLD) { emp.status = 'resting'; emp.taskElapsed = 0; emp.taskTotal = EMPLOYEE_SLEEP_MINUTES; return; }
  } else if (tryStopAtNode(emp, spec, veh, emp.positionId, null)) {
    return;
  }

  const job = findJobForEmployee(emp);
  if (job) {
    const idx = state.availableJobs.findIndex(j => j.id === job.id);
    if (idx !== -1) state.availableJobs.splice(idx, 1);
    const path = shortestPath(emp.positionId, job.fromId);
    emp.activity = buildEmployeeActivity(path, job.fromId, 'to_pickup', job);
    emp.status = 'moving';
    log(`${emp.name} взял заказ «${job.itemName}» (${pointFullLabel(job.fromId)} → ${pointFullLabel(job.toId)})`, { silent: true });
  }
}

function dayIndexFromGameTime(gameTime) { return Math.floor((gameTime + DAY_START_OFFSET) / 1440); }

function livingCostRange() {
  let range = LIVING_COST_TIERS[0];
  for (const tier of LIVING_COST_TIERS) {
    if (state.stats.totalEarned >= tier.minEarned) range = tier;
  }
  return range;
}

function rollDailyExpense() {
  const range = livingCostRange();
  const living = Math.round(rand(range.min, range.max));
  const vehicleUpkeep = Math.round(vehicleSpec().price * VEHICLE_UPKEEP_RATE);
  state.dailyExpense = { living, vehicleUpkeep, total: living + vehicleUpkeep, day: dayIndexFromGameTime(state.gameTime) + 1 };
}

function chargeDailyExpense() {
  const charge = state.dailyExpense.total;
  state.money -= charge;
  log(`Расходы за день: ${state.dailyExpense.living} ₽ (жизнь) + ${state.dailyExpense.vehicleUpkeep} ₽ (техника) = ${charge} ₽`, { silent: true });
  if (state.money <= BANKRUPTCY_DEBT_LIMIT) {
    state.gameOver = 'bankruptcy';
    log(`Банкротство: долг превысил ${-BANKRUPTCY_DEBT_LIMIT} ₽. Расходы на жизнь и технику съели весь бюджет.`);
  }
  rollDailyExpense();
}

function initDailyEconomy() {
  rollDailyExpense();
  maintainJobPool();
  ensureFittingJobExists();
}

function migrateEconomyFields() {
  if (typeof state.lastProcessedDay !== 'number') state.lastProcessedDay = dayIndexFromGameTime(state.gameTime);
  if (!state.dailyExpense) rollDailyExpense();
  // A save from before the company system existed already had the run of the
  // whole country — grandfather it in as "registered" rather than retroactively
  // locking existing progress down to one city.
  if (!state.company) state.company = { registered: true, garages: {}, employees: [], employeeIdSeq: 1 };
  if (!state.company.garages) state.company.garages = {};
  if (!state.company.employees) state.company.employees = [];
  if (typeof state.company.employeeIdSeq !== 'number') state.company.employeeIdSeq = 1;
  // A save from before the autonomous work loop existed could have employees
  // hired but missing every field that loop depends on — back-fill rather
  // than let runEmployeeTick crash on a missing status/position.
  // A save from before garages tracked capacity had `garages[cityId] === true`
  // — upgrade it in place rather than break hasGarageInCity/garageCapacity.
  Object.keys(state.company.garages).forEach(cityId => {
    if (state.company.garages[cityId] === true) state.company.garages[cityId] = { capacity: GARAGE_DEFAULT_CAPACITY };
  });
  state.company.employees.forEach(emp => {
    if (typeof emp.working !== 'boolean') emp.working = false;
    if (!emp.status) emp.status = 'afk';
    if (typeof emp.positionId !== 'string') emp.positionId = `${COMPANY_HOME_CITY}:home`;
    if (typeof emp.hunger !== 'number') emp.hunger = 30;
    if (typeof emp.sleepiness !== 'number') emp.sleepiness = 20;
    if (emp.activity === undefined) emp.activity = null;
    if (emp.pendingActivity === undefined) emp.pendingActivity = null;
    if (typeof emp.earnings !== 'number') emp.earnings = 0;
    if (typeof emp.taskElapsed !== 'number') emp.taskElapsed = 0;
    if (typeof emp.taskTotal !== 'number') emp.taskTotal = 0;
    if (typeof emp.trainingRemaining !== 'number') emp.trainingRemaining = 0;
    if (emp.trainingTarget === undefined) emp.trainingTarget = null;
    if (typeof emp.usesGarageSlot !== 'boolean') {
      const s = VEHICLE_BY_ID[emp.vehicleType];
      emp.usesGarageSlot = s ? s.cat !== 'foot' : false;
    }
  });
  if (typeof state.autoPlay !== 'boolean') state.autoPlay = true;
  if (typeof state.player.sleepiness !== 'number') state.player.sleepiness = 15;
  if (typeof state.player.warnedSleepy !== 'boolean') state.player.warnedSleepy = false;
  if (typeof state.player.sleepyGrace !== 'number') state.player.sleepyGrace = 0;
  if (typeof state.player.refuelElapsed !== 'number') state.player.refuelElapsed = 0;
  if (state.player.refuelPlan === undefined) state.player.refuelPlan = null;
  delete state.player.fatigue;
  delete state.player.warnedFatigue;

  // A save left mid-rest/meal/refuel from just before the gradual-relief
  // update landed could carry a plan missing its new *Start field, which
  // silently corrupted hunger/sleepiness/fuel into NaN (an invalid CSS width
  // that just reads as "the bar stopped moving"). simulateTick now self-heals
  // any in-progress plan going forward, but a value that's already NaN needs
  // a hard reset here since there's no valid prior value left to recover.
  if (Number.isNaN(state.player.hunger)) state.player.hunger = 50;
  if (Number.isNaN(state.player.sleepiness)) state.player.sleepiness = 50;
  if (state.player.vehicle && Number.isNaN(state.player.vehicle.fuel)) {
    const spec = VEHICLE_BY_ID[state.player.vehicle.type];
    state.player.vehicle.fuel = spec ? spec.tank : Infinity;
  }

  // jobIdSeq used to be a bare module variable that reset to 1 on every page
  // reload while old jobs (with higher ids) stayed in the save — new jobs could
  // then collide in id with still-unclaimed old ones, and every id-lookup
  // (takeJob/pickUpJob/deliverJob/refuseJob) would silently act on whichever one
  // happened to come first. Recompute it from the highest id actually present so
  // it can never collide, whether this save predates the field or already has dupes.
  const maxExistingJobId = Math.max(0, ...state.availableJobs.map(j => j.id), ...state.player.jobs.map(j => j.id));
  if (typeof state.jobIdSeq !== 'number' || state.jobIdSeq <= maxExistingJobId) {
    state.jobIdSeq = maxExistingJobId + 1;
  }
  // A save already affected by the old bug may have two different jobs sharing
  // one id right now — reassign every id after the first occurrence so lookups
  // by id are unambiguous again (a taken job's own id must stay put, so only
  // availableJobs — never player.jobs — gets touched).
  const seenJobIds = new Set(state.player.jobs.map(j => j.id));
  state.availableJobs.forEach(job => {
    if (seenJobIds.has(job.id)) job.id = state.jobIdSeq++;
    seenJobIds.add(job.id);
  });
}

function log(text, opts) {
  const silent = opts && opts.silent;
  const entry = { t: formatTime(state.gameTime), text };
  state.eventLog.unshift(entry);
  if (state.eventLog.length > 300) state.eventLog.length = 300;
  if (catchupBuffer) catchupBuffer.unshift(entry);
  else if (!silent) toast(text);
}

// Regular toasts auto-expire like before, and don't intercept taps to whatever's
// underneath (map, point panel). Persistent ones (offline-return notices) are the
// exception: they stack until tapped, since the player needs to actually register them.
function toast(text, opts) {
  const persistent = !!(opts && opts.persistent);
  toasts.push({ id: actionIdSeq++, text, persistent, expiresAt: persistent ? Infinity : Date.now() + TOAST_DURATION_MS });
}

function dismissToast(id) {
  if (leavingToastIds.has(id)) return;
  leavingToastIds.add(id);
  lastToastSignature = null;
  renderToasts();
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id);
    leavingToastIds.delete(id);
    lastToastSignature = null;
    renderToasts();
  }, TOAST_EXIT_MS);
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

function vehicleSpec() {
  const base = VEHICLE_BY_ID[state.player.vehicle.type];
  if (base.cat !== 'foot') return base;
  const p = state.player;
  const kg = base.kg + (p.equipment['ergo_backpack'] ? ERGO_BACKPACK_KG_BONUS : 0);
  const l = base.l + (p.equipment['ergo_backpack'] ? ERGO_BACKPACK_L_BONUS : 0);
  const speed = base.speed + (p.equipment['comfy_sneakers'] ? COMFY_SNEAKERS_SPEED_BONUS : 0);
  if (kg === base.kg && l === base.l && speed === base.speed) return base;
  return { ...base, kg, l, speed };
}

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

function formatVolumeM3(liters) {
  const m3 = liters / 1000;
  const precision = m3 >= 10 ? 1 : m3 >= 1 ? 2 : m3 >= 0.01 ? 3 : 4;
  return `${parseFloat(m3.toFixed(precision))} м³`;
}

// ---------- jobs: generation, taking, pickup, delivery ----------

function pickJobEndpoints() {
  // Before the company is registered, the courier only works the home city —
  // no cross-country hauls to generate at all yet.
  if (!state.company.registered) {
    const pts = DELIVERY_BY_CITY[COMPANY_HOME_CITY];
    const fromId = pick(pts);
    let toId = pick(pts), guard = 0;
    while (toId === fromId && guard++ < 20) toId = pick(pts);
    return { fromId, toId };
  }
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

function templatesFor(fromId) {
  const compatible = ITEM_TEMPLATES.filter(t => !t.sources || t.sources.includes(fromId));
  return compatible.length ? compatible : ITEM_TEMPLATES;
}

function generateJob() {
  const { fromId, toId } = pickJobEndpoints();
  const template = pick(templatesFor(fromId));
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
    id: state.jobIdSeq++, fromId, toId,
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

// A job tailored to definitely fit in whatever's left of the current vehicle's
// capacity, staying inside the player's current city and skipping equipment
// requirements and urgent (1-hour) deadlines — a safety net so there is always
// at least one order a freshly-started or newly-switched courier can actually take.
function generateFittingJob(remainingKg, remainingL) {
  const p = state.player;
  const citySpace = pointSpace(p.positionId);
  const cityPts = DELIVERY_BY_CITY[citySpace] && DELIVERY_BY_CITY[citySpace].length >= 2
    ? DELIVERY_BY_CITY[citySpace] : DELIVERY_BY_CITY['rivnoe'];
  const fromId = pick(cityPts);
  let toId = pick(cityPts), guard = 0;
  while (toId === fromId && guard++ < 20) toId = pick(cityPts);

  const normalTemplatesHere = ITEM_TEMPLATES.filter(t => t.storage === 'normal' && (!t.sources || t.sources.includes(fromId)));
  const normalTemplates = normalTemplatesHere.length ? normalTemplatesHere : ITEM_TEMPLATES.filter(t => t.storage === 'normal');
  const template = pick(normalTemplates);
  const maxWeight = Math.min(template.weightKg[1], remainingKg);
  const minWeight = Math.min(template.weightKg[0], maxWeight);
  const weightKg = Math.round(rand(minWeight, maxWeight) * 10) / 10;
  const maxVolume = Math.min(template.volumeL[1], remainingL);
  const minVolume = Math.min(template.volumeL[0], maxVolume);
  const volumeL = Math.round(rand(minVolume, maxVolume));

  const easyUrgencies = template.urgency.filter(u => u !== 'urgent');
  const urgencyKey = pick(easyUrgencies.length ? easyUrgencies : template.urgency);
  const urgency = URGENCY_LEVELS[urgencyKey];
  const distanceKm = pathDistanceKm(shortestPath(fromId, toId));
  const weightSurcharge = Math.round(weightKg * 3);
  const urgencySurcharge = { urgent: 250, standard: 60, none: 0 }[urgencyKey];
  const payout = Math.round(120 + distanceKm * 20 + urgencySurcharge + weightSurcharge + rand(-15, 25));

  return {
    id: state.jobIdSeq++, fromId, toId,
    itemName: template.name, storage: template.storage, weightKg, volumeL,
    urgencyKey, urgencyLabel: urgency.label,
    deadlineReal: urgency.windowRealMs === Infinity ? null : Date.now() + urgency.windowRealMs,
    distanceKm: Math.round(distanceKm * 10) / 10,
    payout, pickedUp: false,
  };
}

const MIN_FITTING_JOBS = 2;
function ensureFittingJobExists() {
  const spec = vehicleSpec();
  const remainingKg = spec.kg - cargoWeightKg();
  const remainingL = spec.l - cargoVolumeL();
  if (remainingKg < 0.3 || remainingL < 1) return; // vehicle already full — nothing to guarantee right now
  let fittingCount = state.availableJobs.filter(j => jobFitsVehicle(j)).length;
  while (fittingCount < MIN_FITTING_JOBS) {
    state.availableJobs.push(generateFittingJob(remainingKg, remainingL));
    fittingCount++;
  }
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
  const job = state.availableJobs[idx];
  if (!jobWithinCompanyReach(job)) { toast('Пока нет своей компании — доступны только заказы внутри Ривного'); return; }
  if (!jobPickupReachable(job)) { toast('Пешком до места забора не дойти — этот заказ недоступен'); return; }
  if (!jobFitsVehicle(job)) { toast('Не подходит для текущего транспорта — вес, объём или снаряжение'); return; }
  state.availableJobs.splice(idx, 1);
  state.player.jobs.push(job);
  log(`Взял заказ: ${job.itemName} (${pointFullLabel(job.fromId)} → ${pointFullLabel(job.toId)}), ${job.payout} ₽`);
  ensureFittingJobExists();
}

function pickUpJob(jobId) {
  const p = state.player;
  const job = p.jobs.find(j => j.id === jobId && !j.pickedUp);
  if (!job) return;
  if (p.status !== 'idle' || p.positionId !== job.fromId) return;
  if (!isPointOpenNow(pointById(job.fromId))) { toast('Закрыто — придётся подождать открытия'); return; }
  if (!hasRequiredEquipment(job.storage)) { toast(`Нужно снаряжение: ${equipmentLabelFor(job.storage)}`); return; }
  const spec = vehicleSpec();
  if (cargoWeightKg() + job.weightKg > spec.kg || cargoVolumeL() + job.volumeL > spec.l) {
    toast('Не влезает — превышен вес или объём груза для текущего транспорта');
    return;
  }
  job.pickedUp = true;
  log(`Забрал заказ: ${job.itemName} → ${pointFullLabel(job.toId)}`);
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
  if (!isPointOpenNow(pointById(job.toId))) { toast('Закрыто — придётся подождать открытия'); return; }
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
const FOOD_DELIVERY_SURCHARGE = 0.5; // on top of the nearest cafe's regular meal price

function foodDeliveryPrice() { return Math.round(EAT_PRICE_CAFE.meal * (1 + FOOD_DELIVERY_SURCHARGE)); }

function orderFoodDelivery() {
  const price = foodDeliveryPrice();
  if (state.money < price) { toast('Не хватает денег на доставку еды'); return; }
  state.money -= price;
  state.player.hunger = clamp(state.player.hunger - EAT_OPTIONS.find(o => o.id === 'meal').hungerRelief, 0, 100);
  state.player.enduring = false;
  log(`Заказал доставку еды прямо в пути — ${price} ₽`);
}

function offerFoodDelivery() {
  pushPendingAction({
    kind: 'hungry',
    title: 'Проголодался в пути',
    text: `Живот совсем подводит. Можно заказать доставку еды прямо сюда — дороже, чем в кафе (доставка +${Math.round(FOOD_DELIVERY_SURCHARGE * 100)}%), но не придётся останавливаться и искать кафе. Если не заказать, голод продолжит расти — а когда дойдёт до предела, в сон начнёт клонить втрое быстрее, пока не поешь.`,
  });
}

// Free last-resort choice when hungry with no money for delivery: keep going,
// but sleepiness now builds 3x faster until the courier actually eats something.
// If both hunger and sleepiness bottom out while enduring, that's game over.
function startEnduring() {
  state.player.enduring = true;
  log('Решил перетерпеть голод — в сон теперь клонит втрое быстрее, пока не поест', { silent: true });
}
// Relief scales linearly with hours slept: 8h fully clears the bar, 4h clears
// exactly half, and so on (12.5 per hour).
const SLEEP_OPTIONS = [
  { id: 'nap', label: 'Вздремнуть (1 ч)', minutes: 60, sleepinessRelief: 12.5, isSleep: true },
  { id: 'sleep4', label: 'Поспать (4 ч)', minutes: 240, sleepinessRelief: 50, isSleep: true },
  { id: 'sleep8', label: 'Выспаться (8 ч)', minutes: 480, sleepinessRelief: 100, isSleep: true },
];
// Sleeping in the vehicle itself works only where that's physically plausible
// (a car/van/truck cabin, not a bike or scooter) — and without a sleeper cab
// it's uncomfortable, so the same hours in the seat pay off only about half
// as much as a real bed would.
const VEHICLE_SLEEP_OPTIONS = [
  { id: 'car_sleep4', label: 'Поспать в машине (4 ч)', minutes: 240, comfortRelief: 25, cabinRelief: 50 },
  { id: 'car_sleep8', label: 'Поспать в машине (8 ч)', minutes: 480, comfortRelief: 50, cabinRelief: 100 },
];
function vehicleCanSleepIn(spec) { return spec.draw === 'car' || spec.draw === 'truck'; }

// Hunger/sleepiness/fuel now move gradually in step with the action's own
// progress bar (see simulateTick), so interrupting just stops it wherever it
// currently is — whatever's already been gained is kept, nothing extra is
// deducted on top.
function cancelCurrentAction() {
  const p = state.player;
  if (p.status === 'resting' && p.restPlan) {
    if (p.restElapsed > 0) {
      log(`Прервал сон (${p.restPlan.label}), не доспал — восстановил ${Math.round(p.restPlan.sleepinessStart - p.sleepiness)} из ${p.restPlan.sleepinessRelief}`, { silent: true });
    }
    p.status = 'idle'; p.restPlan = null; p.restElapsed = 0;
  } else if (p.status === 'eating' && p.eatPlan) {
    if (p.eatElapsed > 0) {
      log(`Прервал приём пищи (${p.eatPlan.label}), не доел — утолил ${Math.round(p.eatPlan.hungerStart - p.hunger)} из ${p.eatPlan.hungerRelief}`, { silent: true });
      p.enduring = false;
    }
    p.status = 'idle'; p.eatPlan = null; p.eatElapsed = 0;
  } else if (p.status === 'refueling' && p.refuelPlan) {
    if (p.refuelElapsed > 0) {
      log(`Прервал заправку (${p.refuelPlan.label}) — залил ${Math.round(p.vehicle.fuel - p.refuelPlan.fuelStart)} из ${Math.round(p.refuelPlan.fuelTarget - p.refuelPlan.fuelStart)} км хода`, { silent: true });
    }
    p.status = 'idle'; p.refuelPlan = null; p.refuelElapsed = 0;
  }
}

function startEating(optionId) {
  const p = state.player;
  if (p.status !== 'idle') return;
  const point = pointById(p.positionId);
  const isHome = point.type === 'home';
  const isCompanyGarage = point.type === 'garage' && hasGarageInCity(pointSpace(point.id));
  const canEatHere = isHome || isCompanyGarage || point.type === 'cafe' || point.type === 'waystop' || point.type === 'gas';
  if (!canEatHere) return;
  if (!isPointOpenNow(point)) { toast('Закрыто — придётся подождать открытия'); return; }
  const opt = EAT_OPTIONS.find(o => o.id === optionId);
  const free = isHome || isCompanyGarage;
  const cost = free ? 0 : EAT_PRICE_CAFE[optionId];
  if (state.money < cost) { toast('Не хватает денег'); return; }
  state.money -= cost;
  p.status = 'eating';
  p.eatElapsed = 0;
  p.eatPlan = { totalMinutes: opt.minutes, hungerRelief: opt.hungerRelief, label: opt.label, hungerStart: p.hunger };
  log(isHome ? `Ест дома (${opt.label})` : isCompanyGarage ? `Ест в гараже компании (${opt.label})` : `Ест: ${opt.label} (${cost} ₽)`, { silent: true });
}

function startSleeping(optionId) {
  const p = state.player;
  const point = pointById(p.positionId);
  const isHome = point.type === 'home';
  const isCompanyGarage = point.type === 'garage' && hasGarageInCity(pointSpace(point.id));
  if (p.status !== 'idle' || !(isHome || isCompanyGarage)) return;
  const opt = SLEEP_OPTIONS.find(o => o.id === optionId);
  p.status = 'resting';
  p.restElapsed = 0;
  p.restPlan = { totalMinutes: opt.minutes, sleepinessRelief: opt.sleepinessRelief, isSleep: true, label: opt.label, sleepinessStart: p.sleepiness };
  log(isHome ? `Лёг спать дома: ${opt.label}` : `Лёг спать в гараже компании: ${opt.label}`, { silent: true });
}

function startVehicleSleep(optionId) {
  const p = state.player;
  const spec = vehicleSpec();
  if (p.status !== 'idle' || !vehicleCanSleepIn(spec)) return;
  const opt = VEHICLE_SLEEP_OPTIONS.find(o => o.id === optionId);
  const hasCab = !!p.equipment['sleeper_cab'];
  const relief = hasCab ? opt.cabinRelief : opt.comfortRelief;
  p.status = 'resting';
  p.restElapsed = 0;
  p.restPlan = { totalMinutes: opt.minutes, sleepinessRelief: relief, isSleep: true, label: opt.label, sleepinessStart: p.sleepiness };
  log(hasCab ? `Лёг спать в машине (со спальным местом): ${opt.label}` : `Поспал в машине, неудобно — толку в разы меньше: ${opt.label}`, { silent: true });
}

function interruptRest() {
  const p = state.player;
  if (p.status === 'resting' || p.status === 'eating' || p.status === 'refueling') { cancelCurrentAction(); log('Прервал отдых', { silent: true }); }
}

// ---------- refuelling ----------

// A full tank takes this many game-minutes to fill; a partial top-up scales
// down proportionally, same as the eat/sleep options' progress bars.
const REFUEL_MINUTES_FULL = 10;

function startRefuel() {
  const p = state.player;
  const spec = vehicleSpec();
  if (spec.fuel === 'legs') return;
  const point = pointById(p.positionId);
  // Charging an EV at home (or at an owned company garage) off the mains is
  // free — everywhere else (gas station, waystop) it's priced normally, same
  // as any other fuel type.
  const isCompanyGarage = point.type === 'garage' && hasGarageInCity(pointSpace(point.id));
  const atHome = (point.type === 'home' || isCompanyGarage) && spec.fuel === 'electric';
  if (!atHome && point.type !== 'gas' && point.type !== 'waystop') return;
  if (p.status !== 'idle') return;
  if (!atHome && !isPointOpenNow(point)) { toast('Закрыто — придётся подождать открытия'); return; }
  const missing = spec.tank - p.vehicle.fuel;
  if (missing <= 0.01) return;
  const cost = atHome ? 0 : Math.round(missing * FUEL_COST_PER_KM_RANGE[spec.fuel]);
  if (state.money < cost) { toast('Не хватает денег на заправку'); return; }
  state.money -= cost;
  p.status = 'refueling';
  p.refuelElapsed = 0;
  p.refuelPlan = {
    totalMinutes: Math.max(2, Math.round((missing / spec.tank) * REFUEL_MINUTES_FULL)),
    fuelStart: p.vehicle.fuel, fuelTarget: spec.tank, label: !atHome ? 'Заправка' : (isCompanyGarage ? 'Зарядка в гараже компании' : 'Зарядка дома'),
  };
  log(!atHome ? `Начал заправляться (${cost} ₽)` : (isCompanyGarage ? 'Поставил заряжаться в гараже компании' : 'Поставил заряжаться дома'), { silent: true });
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
    breakdownAt: Math.random() < breakdownOccurrenceChance() ? rand(0.25, 0.85) : null,
    breakdownTriggered: false,
    problemPending: false,
    problem: null,
  };
}

function startTravel(targetId) {
  const p = state.player;
  if (p.status === 'collapsed') { toast('Без сознания — сейчас никуда не пойдёт'); return; }
  if (!state.company.registered && pointSpace(targetId) !== COMPANY_HOME_CITY) {
    toast('Пока нет своей компании — работаешь только в Ривном. Зарегистрируй компанию, чтобы возить между городами.');
    return;
  }
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

function breakdownOccurrenceChance() {
  const conditionFactor = (100 - state.player.vehicle.condition) / 100;
  return BREAKDOWN_BASE_CHANCE + conditionFactor * BREAKDOWN_WEAR_BONUS;
}

function triggerBreakdown(activity) {
  const p = state.player;
  const spec = vehicleSpec();
  const personal = isPersonalMishap(spec);
  const conditionFactor = (100 - p.vehicle.condition) / 100;
  const severeChance = BREAKDOWN_SEVERE_BASE + conditionFactor * BREAKDOWN_SEVERE_WEAR_BONUS;
  const pool = breakdownPoolFor(spec);
  const candidates = Math.random() < severeChance
    ? pool.filter(b => b.severity === 'severe')
    : pool.filter(b => b.severity === 'minor');
  const type = pick(candidates);
  activity.problemPending = true;
  activity.problem = { kind: 'breakdown', typeId: type.id };
  log(`${personal ? 'Проблема' : 'Поломка'} в пути: ${type.label}`, { silent: true });
  pushPendingAction({
    kind: 'breakdown',
    typeId: type.id,
    title: type.label,
    text: type.severity === 'minor'
      ? `${type.label}. Можно ${personal ? 'обработать на месте' : 'починить на месте'} или ${personal ? 'идти' : 'ехать'} так, рискуя ${personal ? 'разболеться сильнее' : 'доломать технику'}.`
      : personal
        ? `${type.label}. Самому не справиться — придётся взять такси, чтобы добраться и отлежаться.`
        : `${type.label}. Своими силами не починить — нужно вызывать эвакуатор до мастерской.`,
  });
}

// Running the sleep tank fully dry is automatic and unavoidable — there's no
// choice to make, unlike breakdowns/hunger. On foot the courier just drops where
// he stands; behind the wheel it's a real accident, with a grace window afterward
// before it can happen again. This is a real 2-hour lockout, not an instant time
// skip — a genuine penalty for letting sleepiness run out, not just a discount.
function triggerSleepyCollapse() {
  const p = state.player;
  p.collapsePrevStatus = p.status === 'moving' ? 'moving' : 'idle';
  p.status = 'collapsed';
  p.collapseRemaining = FOOT_COLLAPSE_MINUTES;
  p.collapseSleepinessStart = p.sleepiness;
  if (p.jobs.some(j => j.pickedUp)) {
    state.money -= CARGO_MISHAP_FINE;
    log(`Не удержался на ногах от недосыпа — вырубило прямо на месте на 2 часа. Груз помялся, штраф ${CARGO_MISHAP_FINE} ₽.`);
  } else {
    log('Не удержался на ногах от недосыпа — вырубило прямо на месте на 2 часа.');
  }
}

function triggerSleepyAccident() {
  const p = state.player;
  p.sleepyGrace = SLEEPY_GRACE_MINUTES;
  p.vehicle.condition = clamp(p.vehicle.condition - SLEEPY_ACCIDENT_CONDITION_DAMAGE, 0, 100);
  state.money -= SLEEPY_ACCIDENT_REPAIR_COST;
  if (p.activity) p.activity.totalKm *= SLEEPY_ACCIDENT_TRIP_PENALTY;
  const cargoHit = p.jobs.some(j => j.pickedUp);
  if (cargoHit) state.money -= CARGO_MISHAP_FINE;
  const cargoText = cargoHit ? `, груз повреждён (-${CARGO_MISHAP_FINE} ₽)` : '';
  log(`Заснул за рулём — авария! Ремонт обошёлся в ${SLEEPY_ACCIDENT_REPAIR_COST} ₽${cargoText}. Час на то, чтобы прийти в себя, потом может вырубить снова.`);
}

function triggerExhausted(activity) {
  activity.problemPending = true;
  activity.problem = { kind: 'exhausted' };
  log('Так проголодался в пути, что дальше идти не может', { silent: true });
  pushPendingAction({
    kind: 'exhausted',
    title: 'Совсем нет сил от голода',
    text: 'Так голоден, что дальше идти/ехать нельзя. Закажи доставку еды сюда или через силу тащись дальше на голодный желудок.',
  });
}

function resolvePendingAction(actionId, choice) {
  const idx = state.pendingActions.findIndex(a => a.id === actionId);
  if (idx === -1) return;
  const action = state.pendingActions[idx];

  // Not tied to a blocked travel activity — the courier keeps moving either way.
  // Declining here has no consequence yet: hunger is only a warning at this
  // point (not maxed out), so tripled sleepiness only ever starts once it
  // actually hits 100% and he chooses to push through (see 'exhausted' below).
  if (action.kind === 'hungry') {
    if (choice === 'deliver') orderFoodDelivery();
    state.pendingActions.splice(idx, 1);
    return;
  }

  const activity = state.player.activity;
  if (!activity || !activity.problemPending) { state.pendingActions.splice(idx, 1); return; }
  const spec = vehicleSpec();

  if (action.kind === 'breakdown') {
    const type = breakdownPoolFor(spec).find(t => t.id === action.typeId);
    const personal = isPersonalMishap(spec);
    if (choice === 'selfFix') {
      state.money -= type.selfFixCost;
      state.player.vehicle.condition = clamp(state.player.vehicle.condition + 30, 0, 100);
      log(personal ? `Обработал: ${type.label} (${type.selfFixCost} ₽)` : `Починил на месте: ${type.label} (${type.selfFixCost} ₽)`);
    } else if (choice === 'ignore') {
      activity.totalKm *= type.ignorePenalty;
      log(personal ? `Пошёл дальше, несмотря на «${type.label}»` : `Поехал дальше, несмотря на «${type.label}»`);
    } else if (choice === 'tow') {
      state.money -= type.towCost;
      state.player.vehicle.condition = 100;
      log(personal ? `Взял такси, отлежался и восстановился (${type.towCost} ₽)` : `Вызвал эвакуатор, починили в мастерской за ${type.towCost} ₽`);
    }
  } else if (action.kind === 'exhausted') {
    if (choice === 'deliver') {
      orderFoodDelivery();
      log('Заказал доставку еды на обочину, пока стоял без сил', { silent: true });
    } else {
      startEnduring();
      log('Пошёл дальше на голодный желудок, через силу');
    }
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
  ensureFittingJobExists();
}

function switchVehicle(vehicleType) {
  const p = state.player;
  if (p.vehicle.type === vehicleType) return;
  if (p.status !== 'idle') { toast('Пересесть можно, только когда стоишь на месте'); return; }
  const target = p.vehicles.find(veh => veh.type === vehicleType);
  if (!target) return;
  if (target.assignedTo) { toast('Эта техника выдана сотруднику'); return; }
  const spec = VEHICLE_BY_ID[vehicleType];
  if (cargoWeightKg() > spec.kg || cargoVolumeL() > spec.l) { toast('Текущий груз не влезет в эту технику'); return; }
  p.vehicle = target;
  log(`Пересел на: ${spec.name}`, { silent: true });
  ensureFittingJobExists();
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
  if (veh.assignedTo) { toast('Сначала уволь сотрудника, использующего эту технику'); return; }
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
  if (vehicleSpec().cat === 'foot') { toast('У пешехода нет подвески — укреплять нечего'); return; }
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
  (state.company.employees || []).forEach(emp => runEmployeeTick(emp, dt));

  if (state.money < 0 && !p.warnedDebt) {
    p.warnedDebt = true;
    toast('Ты в минусе — расходы идут в долг. Заработай, пока не наступило банкротство!');
  } else if (state.money >= 0) {
    p.warnedDebt = false;
  }

  // While unattended, the courier takes care of himself instead of just
  // standing there: eats or sleeps automatically once idle and in real need.
  if (catchupBuffer && p.status === 'idle') {
    if (p.hunger >= 80) offlineAutoEat();
    else if (p.sleepiness >= 80) offlineAutoSleep();
  }

  // Sleepiness is the courier's one tiredness stat: it climbs with time no matter
  // what he's doing, and only actual sleep brings it down. Enduring hunger with no
  // money makes it climb 3x faster on top of that; comfy sneakers ease it back down
  // a bit while walking.
  const sneakersMult = (vehicleSpec().cat === 'foot' && p.equipment['comfy_sneakers']) ? COMFY_SNEAKERS_SLEEPINESS_MULT : 1;
  const sleepyMult = (p.enduring ? ENDURE_SLEEPINESS_MULT : 1) * sneakersMult;
  if (!(p.status === 'resting' && p.restPlan && p.restPlan.isSleep) && p.status !== 'collapsed') {
    p.sleepiness = clamp(p.sleepiness + SLEEPINESS_RATE * dt * sleepyMult, 0, 100);
  }
  p.sleepyGrace = Math.max(0, p.sleepyGrace - dt);

  if (p.status === 'moving') {
    const a = p.activity;
    const offline = !!catchupBuffer;
    if (p.enduring && p.sleepiness >= 100 && p.hunger >= 100) {
      // Truly unrecoverable — but never let it happen silently while the
      // player was away. Offline, freeze right here so they resume live at
      // this exact critical moment with a real choice; online, it's game over.
      if (offline) { triggerExhausted(a); offlinePauseRequested = true; }
      else { state.gameOver = 'starved'; log('Голод и истощение накрыли одновременно прямо в пути — курьер не выдержал. Дело закрыто.'); }
    } else if (a.problemPending) {
      p.hunger = clamp(p.hunger + HUNGER_RATE_STUCK * dt, 0, 100);
    } else {
      const spec = vehicleSpec();
      const nightMult = isNight() ? NIGHT_SPEED_MULT : 1;
      const effSpeed = spec.speed * nightMult;
      const kmThisTick = effSpeed * (dt / 60);
      a.traveledKm = clamp(a.traveledKm + kmThisTick, 0, a.totalKm);
      p.hunger = clamp(p.hunger + HUNGER_RATE_MOVING * dt, 0, 100);
      if (p.hunger >= 90 && p.hunger < 100 && !p.offeredFoodDelivery) {
        p.offeredFoodDelivery = true;
        if (offline) {
          // Hunger isn't actually maxed yet at this point — only auto-buy if
          // there's money for it; otherwise just let it keep climbing normally
          // (the real forced choice, and the only place enduring can start,
          // is the >=100% branch further below).
          if (state.money >= foodDeliveryPrice()) orderFoodDelivery();
        } else {
          offerFoodDelivery();
        }
      }
      p.vehicle.condition = clamp(p.vehicle.condition - kmThisTick * WEAR_PER_KM, 0, 100);
      if (spec.fuel !== 'legs') p.vehicle.fuel = clamp(p.vehicle.fuel - kmThisTick, 0, spec.tank);

      const progress = a.totalKm > 0 ? a.traveledKm / a.totalKm : 1;
      const breakdownChanceMod = p.vehicle.upgraded ? 0.5 : 1;
      if (!a.breakdownTriggered && a.breakdownAt !== null && progress >= a.breakdownAt) {
        a.breakdownTriggered = true;
        if (Math.random() < breakdownChanceMod) {
          triggerBreakdown(a);
          if (summary) summary.incidents++;
          if (offline) resolveOfflineBreakdown(a);
        }
      } else if (p.hunger >= 100 && !p.enduring) {
        // Once he's already pushing through on an empty stomach, being stuck at
        // 100% hunger is the expected (if risky) steady state, not a fresh crisis —
        // don't re-open this same prompt every tick.
        if (offline) {
          if (state.money >= foodDeliveryPrice()) orderFoodDelivery();
          else startEnduring();
        } else {
          triggerExhausted(a);
          if (summary) summary.incidents++;
        }
      } else if (a.traveledKm >= a.totalKm) {
        onArrive(a.targetId);
      }
    }
  } else if (p.status === 'resting') {
    p.restElapsed += dt;
    p.hunger = clamp(p.hunger + HUNGER_RATE_RESTING * dt, 0, 100);
    // Sleepiness eases down gradually in step with the progress bar, rather
    // than staying frozen until one lump-sum drop at the very end — so what
    // the bar shows always matches how rested he actually already is.
    if (p.restPlan.isSleep) {
      // A plan already in progress from before this field existed (an old
      // save) won't have it — back-fill instead of silently corrupting the
      // math into NaN and freezing the bar. Fall back to a flat default if
      // the current value is itself already NaN from that same old bug.
      if (!Number.isFinite(p.restPlan.sleepinessStart)) p.restPlan.sleepinessStart = Number.isFinite(p.sleepiness) ? p.sleepiness : 50;
      const frac = clamp(p.restElapsed / p.restPlan.totalMinutes, 0, 1);
      p.sleepiness = clamp(p.restPlan.sleepinessStart - p.restPlan.sleepinessRelief * frac, 0, 100);
    }
    if (p.restElapsed >= p.restPlan.totalMinutes) {
      log(`Отдохнул: ${p.restPlan.label}`);
      p.status = 'idle'; p.restPlan = null;
    }
  } else if (p.status === 'eating') {
    p.eatElapsed += dt;
    if (!Number.isFinite(p.eatPlan.hungerStart)) p.eatPlan.hungerStart = Number.isFinite(p.hunger) ? p.hunger : 50;
    const frac = clamp(p.eatElapsed / p.eatPlan.totalMinutes, 0, 1);
    p.hunger = clamp(p.eatPlan.hungerStart - p.eatPlan.hungerRelief * frac, 0, 100);
    if (p.eatElapsed >= p.eatPlan.totalMinutes) {
      p.enduring = false;
      log(`Поел: ${p.eatPlan.label}`);
      p.status = 'idle'; p.eatPlan = null;
    }
  } else if (p.status === 'refueling') {
    p.hunger = clamp(p.hunger + HUNGER_RATE_IDLE * dt, 0, 100);
    p.refuelElapsed += dt;
    if (!Number.isFinite(p.refuelPlan.fuelStart)) p.refuelPlan.fuelStart = Number.isFinite(p.vehicle.fuel) ? p.vehicle.fuel : 0;
    const frac = clamp(p.refuelElapsed / p.refuelPlan.totalMinutes, 0, 1);
    p.vehicle.fuel = p.refuelPlan.fuelStart + (p.refuelPlan.fuelTarget - p.refuelPlan.fuelStart) * frac;
    if (p.refuelElapsed >= p.refuelPlan.totalMinutes) {
      log(`Заправился: ${p.refuelPlan.label}`, { silent: true });
      p.status = 'idle'; p.refuelPlan = null;
    }
  } else if (p.status === 'collapsed') {
    // Fully unresponsive for the whole 2 hours — no travel, no actions, nothing
    // to click; being unconscious does bring some sleepiness relief, just a lot
    // less than a real rest would (this is the penalty, not a free nap).
    p.hunger = clamp(p.hunger + HUNGER_RATE_IDLE * dt, 0, 100);
    p.collapseRemaining -= dt;
    if (!Number.isFinite(p.collapseSleepinessStart)) p.collapseSleepinessStart = Number.isFinite(p.sleepiness) ? p.sleepiness : 100;
    const totalRelief = FOOT_COLLAPSE_MINUTES * SLEEPINESS_RATE;
    const frac = clamp((FOOT_COLLAPSE_MINUTES - p.collapseRemaining) / FOOT_COLLAPSE_MINUTES, 0, 1);
    p.sleepiness = clamp(p.collapseSleepinessStart - totalRelief * frac, 0, 100);
    if (p.collapseRemaining <= 0) {
      p.status = p.collapsePrevStatus === 'moving' && p.activity ? 'moving' : 'idle';
      p.collapseRemaining = 0;
      log('Пришёл в себя после обморока', { silent: true });
    }
  } else {
    p.hunger = clamp(p.hunger + HUNGER_RATE_IDLE * dt, 0, 100);
  }

  // Ran the sleep tank fully dry: on foot he just collapses where he stands; behind
  // the wheel (or handlebars) of anything else, it's a serious accident risk instead.
  if (!state.gameOver && p.sleepiness >= 100 && p.status !== 'collapsed') {
    const spec = vehicleSpec();
    if (p.sleepyGrace <= 0) {
      if (p.status === 'moving' && spec.cat !== 'foot') {
        if (Math.random() < SLEEPY_ACCIDENT_CHANCE) {
          triggerSleepyAccident();
          if (summary) summary.incidents++;
        }
      } else {
        triggerSleepyCollapse();
        if (summary) summary.incidents++;
      }
    }
  }

  if (p.hunger >= 90 && !p.warnedHunger) { p.warnedHunger = true; toast('Курьер сильно голоден — пора поесть'); }
  if (p.hunger < 80) { p.warnedHunger = false; p.offeredFoodDelivery = false; }
  if (p.sleepiness >= SLEEPY_WARN_THRESHOLD && !p.warnedSleepy) { p.warnedSleepy = true; toast('Курьера конкретно клонит в сон — если не поспать по-настоящему, того и гляди вырубит или будет авария'); }
  if (p.sleepiness < 70) p.warnedSleepy = false;

  state.gameTime += dt;
  while (dayIndexFromGameTime(state.gameTime) > state.lastProcessedDay && !state.gameOver) {
    state.lastProcessedDay++;
    chargeDailyExpense();
    maintainJobPool();
    ensureFittingJobExists();
  }
}

const HUNGER_RATE_MOVING = 0.18;
const HUNGER_RATE_IDLE = 0.12;
const HUNGER_RATE_RESTING = 0.08;
const HUNGER_RATE_STUCK = 0.06;

function runOfflineCatchup() {
  const now = Date.now();
  // Manually paused: time simply doesn't pass while the game is closed —
  // resume exactly where things were left off, no catch-up simulation at all.
  if (!state.autoPlay) { state.lastRealTimestamp = now; return null; }
  let elapsedMs = now - state.lastRealTimestamp;
  if (elapsedMs <= 0) { state.lastRealTimestamp = now; return null; }
  if (elapsedMs > MAX_OFFLINE_MS) elapsedMs = MAX_OFFLINE_MS;
  const totalGameMinutes = (elapsedMs / 1000) * GAME_MIN_PER_REAL_SEC;
  catchupBuffer = [];
  offlinePauseRequested = false;
  offlineAutoTally = { meals: 0, foodSpent: 0, sleeps: 0, sleepSpent: 0 };
  const summary = { jobsCompleted: 0, incidents: 0, moneyBefore: state.money };
  let remaining = totalGameMinutes;
  const step = 20;
  while (remaining > 0) {
    const dt = Math.min(step, remaining);
    const before = state.stats.jobsCompleted;
    simulateTick(dt, summary);
    if (state.stats.jobsCompleted > before) summary.jobsCompleted++;
    remaining -= dt;
    if (state.gameOver || offlinePauseRequested) break;
  }
  summary.netMoneyChange = Math.round(state.money - summary.moneyBefore);
  summary.bankrupt = state.gameOver === 'bankruptcy';
  summary.paused = offlinePauseRequested;
  summary.auto = offlineAutoTally;
  summary.entries = catchupBuffer;
  catchupBuffer = null;
  offlineAutoTally = null;
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
  migrateEconomyFields();
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

// Plain text drawn straight onto the photo backgrounds can lose contrast
// depending on what's underneath — a dark outline behind the fill keeps map
// labels legible over any part of the image instead of only some of it.
function drawMapLabel(text, x, y, opts) {
  const o = opts || {};
  ctx.font = o.font || '9px system-ui';
  ctx.textAlign = o.align || 'left';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = o.strokeStyle || 'rgba(8,10,14,0.85)';
  ctx.lineWidth = o.strokeWidth || 3;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = o.fill || '#eee';
  ctx.fillText(text, x, y);
}

const BLOB_OFFSETS = [[0, 0], [0.5, 0.3], [-0.4, 0.35], [0.2, -0.4], [-0.3, -0.25]];
function drawBlobCluster(x, y, r, toPx, scalePxPerUnit, fillStyle, offsets) {
  ctx.fillStyle = fillStyle;
  (offsets || BLOB_OFFSETS).forEach(([dx, dy]) => {
    const [px, py] = toPx(x + dx * r * 0.5, y + dy * r * 0.5);
    ctx.beginPath(); ctx.arc(px, py, r * 0.6 * scalePxPerUnit, 0, Math.PI * 2); ctx.fill();
  });
}

function drawDecor(decor, toPx, scalePxPerUnit) {
  decor.forests.forEach(f => drawBlobCluster(f.x, f.y, f.r, toPx, scalePxPerUnit, 'rgba(70,130,70,0.16)'));

  (decor.lakes || []).forEach(l => {
    drawBlobCluster(l.x, l.y, l.r * 1.3, toPx, scalePxPerUnit, 'rgba(45,90,140,0.55)');
    drawBlobCluster(l.x, l.y, l.r * 0.85, toPx, scalePxPerUnit, 'rgba(80,140,190,0.5)');
  });

  (decor.marshes || []).forEach(m => {
    drawBlobCluster(m.x, m.y, m.r, toPx, scalePxPerUnit, 'rgba(95,105,55,0.35)');
    drawBlobCluster(m.x, m.y, m.r * 0.6, toPx, scalePxPerUnit, 'rgba(120,130,70,0.3)', [[0.2, 0], [-0.3, 0.2]]);
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

// ---------- biome background, mountains, bridges ----------

let biomePatchesCache = null;
function getBiomePatches() {
  if (biomePatchesCache) return biomePatchesCache;
  const rng = seededRandom(hashStr('biome-patches'));
  const colors = ['rgba(150,140,70,0.16)', 'rgba(50,90,55,0.18)', 'rgba(130,155,115,0.14)'];
  const patches = [];
  for (let i = 0; i < 8; i++) {
    patches.push({ x: 6 + rng() * 88, y: MOUNTAIN_BAND_Y + 4 + rng() * 82, r: 11 + rng() * 15, color: pickSeeded(colors, rng) });
  }
  biomePatchesCache = patches;
  return patches;
}

// A soft vertical climate gradient (snowy north near the mountains, temperate
// plains through the middle, dry steppe toward the south) plus a handful of
// large translucent patches so it doesn't read as a flat vector band.
function drawBiomeBackground(toPxWorld, w, h) {
  const [x0, y0] = toPxWorld(50, 0);
  const [x1, y1] = toPxWorld(50, 100);
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  grad.addColorStop(0, '#a9bcc6');
  grad.addColorStop(0.12, '#7fa082');
  grad.addColorStop(0.38, '#3f6b42');
  grad.addColorStop(0.72, '#436e3f');
  grad.addColorStop(1, '#84884a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  getBiomePatches().forEach(p => drawBlobCluster(p.x, p.y, p.r, toPxWorld, camera.zoom, p.color));
}

// A single jagged silhouette (zigzagging peak/valley/peak/valley) along the
// country's northern edge, with snow caps on the taller peaks.
const MOUNTAIN_BASE_Y = 7;
const MOUNTAIN_RANGE = (() => {
  const rng = seededRandom(hashStr('mountains'));
  const count = 20;
  const peaks = [];
  for (let i = 0; i <= count; i++) {
    const x = (i / count) * 112 - 6;
    const tall = i % 2 === 0;
    peaks.push({ x, h: tall ? 9 + rng() * 6 : 3 + rng() * 3 });
  }
  return peaks;
})();
function drawMountains(toPxWorld) {
  ctx.fillStyle = 'rgba(58,64,76,0.65)';
  ctx.beginPath();
  const first = toPxWorld(MOUNTAIN_RANGE[0].x, MOUNTAIN_BASE_Y);
  ctx.moveTo(first[0], first[1]);
  MOUNTAIN_RANGE.forEach(pk => {
    const [px, py] = toPxWorld(pk.x, MOUNTAIN_BASE_Y - pk.h);
    ctx.lineTo(px, py);
  });
  const last = toPxWorld(MOUNTAIN_RANGE[MOUNTAIN_RANGE.length - 1].x, MOUNTAIN_BASE_Y);
  ctx.lineTo(last[0], last[1]);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(238,242,248,0.9)';
  MOUNTAIN_RANGE.forEach(pk => {
    if (pk.h < 8) return;
    const tip = toPxWorld(pk.x, MOUNTAIN_BASE_Y - pk.h);
    const left = toPxWorld(pk.x - 1.6, MOUNTAIN_BASE_Y - pk.h * 0.7);
    const right = toPxWorld(pk.x + 1.6, MOUNTAIN_BASE_Y - pk.h * 0.7);
    ctx.beginPath(); ctx.moveTo(tip[0], tip[1]); ctx.lineTo(left[0], left[1]); ctx.lineTo(right[0], right[1]); ctx.closePath(); ctx.fill();
  });
}

// Where a road crosses a river, drop a short bridge deck at the exact
// intersection point, angled along the road so it reads as spanning the water.
function segIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + d1x * t, y: p1.y + d1y * t, angle: Math.atan2(d1y, d1x) };
}
function computeBridges(rivers, roadPolylines) {
  const bridges = [];
  rivers.forEach(river => {
    for (let i = 0; i < river.length - 1; i++) {
      roadPolylines.forEach(poly => {
        for (let j = 0; j < poly.length - 1; j++) {
          const hit = segIntersect(river[i], river[i + 1], poly[j], poly[j + 1]);
          if (hit) bridges.push(hit);
        }
      });
    }
  });
  return bridges;
}
let countryBridgesCache = null;
function getCountryBridges() {
  if (countryBridgesCache) return countryBridgesCache;
  const decor = getMapDecor('country');
  const roadPolys = getCountryRoadPolylines().map(r => r.poly);
  countryBridgesCache = computeBridges(decor.rivers, roadPolys);
  return countryBridgesCache;
}
const cityBridgesCache = {};
function getCityBridges(cityId, points, edges) {
  if (cityBridgesCache[cityId]) return cityBridgesCache[cityId];
  const decor = getMapDecor('city:' + cityId);
  const byId = id => points.find(p => p.id === id);
  const [seg, off] = edgeJitter(cityId);
  const roadPolys = edges.map(([aId, bId]) => getEdgePolyline(cityId, aId, bId, byId(aId), byId(bId), seg, off));
  cityBridgesCache[cityId] = computeBridges(decor.rivers, roadPolys);
  return cityBridgesCache[cityId];
}
function drawBridges(bridges, toPx, scalePxPerUnit) {
  bridges.forEach(b => {
    const [px, py] = toPx(b.x, b.y);
    const len = 3.2 * scalePxPerUnit, wid = 1.15 * scalePxPerUnit;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(b.angle);
    ctx.fillStyle = '#8a7256';
    ctx.strokeStyle = '#5a4835';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-len / 2, -wid / 2, len, wid, Math.min(wid * 0.3, len * 0.3));
    else ctx.rect(-len / 2, -wid / 2, len, wid);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  });
}

function drawRoads(mapKey, points, edges, toPx) {
  const byId = id => points.find(p => p.id === id);
  const [seg, off] = edgeJitter(mapKey);
  const tier = SETTLEMENT_TIER[mapKey] || 'village';
  const isUrban = tier === 'big' || tier === 'metro';
  ctx.strokeStyle = isUrban ? '#2c3038' : '#3a2e22';
  ctx.lineWidth = isUrban ? 4 : 3;
  ctx.lineCap = 'round';
  edges.forEach(([aId, bId]) => {
    const a = byId(aId), b = byId(bId);
    const poly = getEdgePolyline(mapKey, aId, bId, a, b, seg, off);
    strokePolyline(poly, toPx);
  });
  ctx.strokeStyle = isUrban ? '#828d9c' : '#a9895f';
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
    // A walking person must never render upside-down: skip the heading rotation
    // entirely (head always up, feet always down) and just mirror left/right
    // to face the direction of travel.
    if (Math.cos(angle) < 0) ctx.scale(-1, 1);
    // The road passes through the feet, not the torso: y=0 is the ground contact
    // point, and the whole figure is built upward from there (negative y).
    const phase = traveledKm * 20;
    const stride = Math.sin(phase);
    const legSwing = stride * 3.4;
    const armSwing = -stride * 2.6;
    const bob = Math.abs(Math.cos(phase)) * 1.1;
    const feetY = 0;
    const hipY = -6.2 - bob;
    const shoulderY = hipY - 4;
    const headY = shoulderY - 4;

    ctx.strokeStyle = bodyColor;
    ctx.fillStyle = bodyColor;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';

    ctx.beginPath(); ctx.arc(0, headY, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, headY + 2.3); ctx.lineTo(0, hipY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, shoulderY); ctx.lineTo(-armSwing, shoulderY + 3.6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, shoulderY); ctx.lineTo(armSwing, shoulderY + 3.6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, hipY); ctx.lineTo(-legSwing, feetY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, hipY); ctx.lineTo(legSwing, feetY); ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.rotate(angle);

  if (drawStyle === 'twowheel') {
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

// A single painted terrain texture (snowy mountains north -> plains -> dry
// steppe south) covering the whole country's 0-100 world square, drawn as the
// base layer under every road/river/marker. Falls back to the old procedural
// gradient+silhouette while the image is still loading (or fails to load).
const mapBgCountryImg = new Image();
let mapBgCountryLoaded = false;
mapBgCountryImg.onload = () => { mapBgCountryLoaded = true; };
mapBgCountryImg.src = 'assets/map-bg-country.jpg';
const MAP_BG_FALLBACK_COLOR = '#9b9676'; // approx. average tone of the image, for any panned-off-map margin

// A handful of cities can have their own hand-painted background texture
// (currently just the starting city); everywhere else keeps the shared
// country texture. Loaded lazily and cached per city id.
const CITY_BG_SOURCES = { rivnoe: 'assets/map-bg-rivnoe.jpg' };
const cityBgImages = {};
function getCityBgImage(cityId) {
  const src = CITY_BG_SOURCES[cityId];
  if (!src) return null;
  if (!cityBgImages[cityId]) {
    const entry = { img: new Image(), loaded: false };
    entry.img.onload = () => { entry.loaded = true; };
    entry.img.src = src;
    cityBgImages[cityId] = entry;
  }
  return cityBgImages[cityId];
}

// As the camera approaches a city with its own background texture, that
// texture fades in (out of a blur) over this zoom range, finishing right as
// cityDetailVisible() flips on full vector road/point detail — so the ground
// texture and the streets snap into focus together instead of at different times.
const CITY_BG_BLEND_START_ZOOM = 6;
const CITY_BG_BLEND_END_ZOOM = LOD_RADIUS_THRESHOLD_PX / CITY_WORLD_RADIUS;
const CITY_BG_MAX_BLUR_PX = 10;
function cityBgBlendT() {
  return clamp((camera.zoom - CITY_BG_BLEND_START_ZOOM) / (CITY_BG_BLEND_END_ZOOM - CITY_BG_BLEND_START_ZOOM), 0, 1);
}
// A hard-edged square patch reads as an obvious seam against the surrounding
// country texture, so the city image is pre-masked once (cached) with a radial
// alpha falloff — it fades out to fully transparent well before its own edges,
// blending softly into whatever's underneath instead of cutting off sharply.
const cityBgMaskedCache = {};
function getCityBgMasked(cityId) {
  const entry = getCityBgImage(cityId);
  if (!entry || !entry.loaded) return null;
  if (cityBgMaskedCache[cityId]) return cityBgMaskedCache[cityId];
  const size = entry.img.naturalWidth || 1024;
  const off = document.createElement('canvas');
  off.width = size; off.height = size;
  const octx = off.getContext('2d');
  octx.drawImage(entry.img, 0, 0, size, size);
  octx.globalCompositeOperation = 'destination-in';
  const grad = octx.createRadialGradient(size / 2, size / 2, size * 0.36, size / 2, size / 2, size * 0.5);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  octx.fillStyle = grad;
  octx.fillRect(0, 0, size, size);
  cityBgMaskedCache[cityId] = off;
  return off;
}
function drawCityBackgroundPatch(c, toPxWorld) {
  const masked = getCityBgMasked(c.id);
  if (!masked) return;
  const t = cityBgBlendT();
  if (t <= 0.01) return;
  const [x0, y0] = toPxWorld(c.x - CITY_WORLD_RADIUS, c.y - CITY_WORLD_RADIUS);
  const size = CITY_WORLD_RADIUS * 2 * camera.zoom;
  ctx.save();
  ctx.globalAlpha = t;
  ctx.filter = `blur(${Math.round((1 - t) * CITY_BG_MAX_BLUR_PX)}px)`;
  ctx.drawImage(masked, x0, y0, size, size);
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.restore();
}

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

// Keep the visible viewport inside the country background image's own
// 0-100 world square whenever it's big enough to fill the screen — otherwise
// panning/zooming out could expose the flat fallback-color margin beyond the
// image's edge as a hard rectangle. If the whole world is smaller than the
// viewport (very zoomed out), center it instead of clamping to an inverted range.
function clampCameraToWorld(w, h) {
  const halfWorldW = (w / 2) / camera.zoom;
  const halfWorldH = (h / 2) / camera.zoom;
  camera.x = halfWorldW * 2 >= 100 ? 50 : clamp(camera.x, halfWorldW, 100 - halfWorldW);
  camera.y = halfWorldH * 2 >= 100 ? 50 : clamp(camera.y, halfWorldH, 100 - halfWorldH);
}

// Generalized over any {status, activity, positionId} mover — the player, or
// (per Stage 4) a working employee out on their own delivery loop.
function liveWorldPosFor(mover) {
  if (mover.status === 'moving' && mover.activity) {
    const pos = positionAlongPath(mover.activity.path, mover.activity.traveledKm, mover.activity.totalKm);
    return { world: localToWorld(pos.x, pos.y, pos.space), space: pos.space, angle: headingAngle(mover.activity.path, mover.activity.traveledKm, mover.activity.totalKm) };
  }
  const space = pointSpace(mover.positionId);
  return { world: pointToWorld(mover.positionId), space, angle: 0 };
}
function livePlayerWorldPos() { return liveWorldPosFor(state.player); }

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

// Shows the full pickup-to-drop-off path for a taken job on the map. If the
// whole route stays inside the city the player is currently in, frame that
// city; otherwise the route crosses settlements, so pull back to the country
// view (centered between the two endpoints) to show the whole trip.
function showJobRoute(jobId) {
  if (uiRouteJobId === jobId) { uiRouteJobId = null; return; }
  const job = state.player.jobs.find(j => j.id === jobId);
  if (!job) return;
  uiRouteJobId = jobId;
  const fromCity = pointSpace(job.fromId), toCity = pointSpace(job.toId);
  const playerCity = pointSpace(state.player.positionId);
  if (fromCity === toCity && fromCity === playerCity) {
    zoomToCity(fromCity);
    return;
  }
  const wa = pointToWorld(job.fromId), wb = pointToWorld(job.toId);
  cameraTween = {
    fromX: camera.x, fromY: camera.y, fromZoom: camera.zoom,
    toX: (wa.x + wb.x) / 2, toY: (wa.y + wb.y) / 2, toZoom: countryFitZoom(),
    start: performance.now(), duration: 650,
  };
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

  // A city with its own painted background already depicts its river/greenery,
  // so the old code-drawn decor (forest/lake/marsh blobs, a synthetic river,
  // bridges) would just double up as stray shapes floating over the artwork.
  if (!CITY_BG_SOURCES[cityId]) {
    drawDecor(getMapDecor('city:' + cityId), toPx, scalePxPerUnit);
  }
  drawRoads(cityId, points, edges, toPx);
  if (!CITY_BG_SOURCES[cityId]) {
    drawBridges(getCityBridges(cityId, points, edges), toPx, scalePxPerUnit);
  }

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
    drawMapLabel(pnt.name, x + 14, y + 3, { font: '9px system-ui', fill: '#eef1f5' });
  });

  const meta = cityMeta(cityId);
  const [lx, ly] = toPxWorld(meta.x, meta.y - CITY_WORLD_RADIUS * 1.15);
  drawMapLabel(meta.name, lx, ly, { font: 'bold 12px system-ui', align: 'center' });
}

function drawRouteHighlight(toPxWorld) {
  if (!uiRouteJobId) return;
  const job = state.player.jobs.find(j => j.id === uiRouteJobId);
  if (!job) { uiRouteJobId = null; return; }
  const path = shortestPath(job.fromId, job.toId);
  ctx.save();
  ctx.strokeStyle = '#f2c94a';
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.setLineDash([9, 6]);
  ctx.lineDashOffset = -(performance.now() / 40 % 15); // marching-ants: crawl the dashes along the route
  for (let i = 0; i < path.length - 1; i++) {
    const aId = path[i], bId = path[i + 1];
    const space = edgeSpace(aId, bId);
    const a = edgeCoord(aId, space), b = edgeCoord(bId, space);
    const [seg, off] = edgeJitter(space);
    const poly = getEdgePolyline(space, aId, bId, a, b, seg, off).map(pt => localToWorld(pt.x, pt.y, space));
    strokePolyline(poly, toPxWorld);
  }
  ctx.setLineDash([]);
  [{ id: job.fromId, color: '#4a9dd1' }, { id: job.toId, color: '#7fd17f' }].forEach(({ id, color }) => {
    const w = pointToWorld(id);
    const [x, y] = toPxWorld(w.x, w.y);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0d1015'; ctx.lineWidth = 2; ctx.stroke();
  });
  ctx.restore();
}

function drawWorld() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  clampCameraToWorld(w, h);
  ctx.clearRect(0, 0, w, h);
  const toPxWorld = (wx, wy) => worldToScreen(wx, wy, w, h);
  lastClickables = {};

  if (mapBgCountryLoaded) {
    ctx.fillStyle = MAP_BG_FALLBACK_COLOR;
    ctx.fillRect(0, 0, w, h);
    const [x0, y0] = toPxWorld(0, 0);
    const size = 100 * camera.zoom;
    ctx.drawImage(mapBgCountryImg, x0, y0, size, size);
  } else {
    drawBiomeBackground(toPxWorld, w, h);
    drawMountains(toPxWorld);
  }
  COUNTRY_CITIES.forEach(c => drawCityBackgroundPatch(c, toPxWorld));
  drawDecor(getMapDecor('country'), toPxWorld, camera.zoom);

  const roadPolys = getCountryRoadPolylines();
  const ruralPolys = roadPolys.filter(r => r.cls === 'rural').map(r => r.poly);
  const highwayPolys = roadPolys.filter(r => r.cls === 'highway').map(r => r.poly);

  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  ctx.strokeStyle = '#333c4a'; ctx.lineWidth = 4;
  ruralPolys.forEach(p => strokePolyline(p, toPxWorld));
  ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 1.4;
  ruralPolys.forEach(p => strokePolyline(p, toPxWorld));

  ctx.strokeStyle = '#4a3a12'; ctx.lineWidth = 6;
  highwayPolys.forEach(p => strokePolyline(p, toPxWorld));
  ctx.strokeStyle = '#e2a83b'; ctx.lineWidth = 3.6;
  highwayPolys.forEach(p => strokePolyline(p, toPxWorld));
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
  highwayPolys.forEach(p => strokePolyline(p, toPxWorld));
  ctx.setLineDash([]);

  drawBridges(getCountryBridges(), toPxWorld, camera.zoom);

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
      drawMapLabel(c.name, x, y + 22, { font: 'bold 11px system-ui', align: 'center' });
    }
  });

  drawRouteHighlight(toPxWorld);

  // Movers: the player, plus any employee currently out working (not parked AFK).
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

  (state.company.employees || []).forEach(emp => {
    if (emp.status === 'afk' || emp.status === 'training') return;
    const eLive = liveWorldPosFor(emp);
    const [ex, ey] = toPxWorld(eLive.world.x, eLive.world.y);
    if (ex < -20 || ex > w + 20 || ey < -20 || ey > h + 20) return;
    lastClickables[`emp:${emp.id}`] = { x: ex, y: ey, r: 11, kind: 'employee', employeeId: emp.id };
    ctx.fillStyle = '#4a9dd1';
    ctx.beginPath(); ctx.arc(ex, ey, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#14181f'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = '9px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🧑', ex, ey);
    ctx.textAlign = 'left';
  });

  const alpha = nightAlpha();
  if (alpha > 0.01) {
    ctx.fillStyle = `rgba(8,12,30,${alpha})`;
    ctx.fillRect(0, 0, w, h);
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
    // <= (not <) so an employee marker standing exactly on a point (e.g.
    // parked at "Дом") wins an exact-distance tie — movers are drawn on top
    // and are added to lastClickables after points, so they should win taps.
    if (d < c.r && d <= bestDist) { bestDist = d; bestId = id; bestKind = c.kind; }
  }
  if (!bestId) { uiSelectedPointId = null; lastPointPanelSignature = null; renderPointPanel(); return; }
  if (bestKind === 'city') { zoomToCity(bestId); return; }
  if (bestKind === 'employee') {
    const employeeId = lastClickables[bestId].employeeId;
    companyView = { mode: 'employeeDetail', employeeId };
    el('company-modal').classList.remove('hidden');
    renderCompanyContent();
    return;
  }
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

function formatMinutesDuration(mins) {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm > 0 ? `${h} ч ${mm} мин` : `${h} ч`;
}

let lastPointPanelSignature = null;
function renderPointPanel() {
  const panel = el('point-panel');
  const visible = !!uiSelectedPointId && state;
  const point = visible ? pointById(uiSelectedPointId) : null;
  const p = state ? state.player : null;
  const collapseTag = p && p.status === 'collapsed' ? Math.ceil(p.collapseRemaining) : 'x';
  const signature = visible ? `${uiSelectedPointId}|${p.positionId}|${p.status}|${collapseTag}|${p.jobs.map(j => j.id + ':' + j.pickedUp).join(',')}|${point && isPointOpenNow(point)}` : 'hidden';
  if (signature === lastPointPanelSignature) return;
  lastPointPanelSignature = signature;

  if (!visible || !point || point.type === 'gate') { panel.classList.add('hidden'); return; }
  const here = p.status !== 'moving' && p.positionId === uiSelectedPointId;
  const openNow = isPointOpenNow(point);
  panel.classList.remove('hidden');
  panel.innerHTML = '';
  const label = document.createElement('div');
  label.textContent = point.name + (here ? ' (ты тут)' : '');
  panel.appendChild(label);

  if (point.hours) {
    const hoursLine = document.createElement('div');
    hoursLine.className = 'job-sub';
    hoursLine.textContent = openNow
      ? `Часы работы: ${formatHoursLabel(point)}`
      : `Закрыто (часы работы: ${formatHoursLabel(point)}) — откроется через ${formatMinutesDuration(minutesUntilOpen(point))}`;
    panel.appendChild(hoursLine);
  }

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

  if (p.status === 'collapsed') {
    const remaining = formatMinutesDuration(p.collapseRemaining);
    const label2 = document.createElement('div');
    label2.className = 'job-sub';
    label2.textContent = `Без сознания от недосыпа — придёт в себя через ${remaining}`;
    panel.appendChild(label2);
    return;
  }

  if (!here) {
    addBtn('Поехать сюда', () => { startTravel(point.id); uiSelectedPointId = null; renderAll(); });
    return;
  }

  if (p.status === 'resting' || p.status === 'eating' || p.status === 'refueling') {
    const planLabel = (p.restPlan || p.eatPlan || p.refuelPlan || {}).label || '';
    label.textContent += ` — ${planLabel}...`;
    addBtn('Прервать', () => { interruptRest(); renderAll(); });
    return;
  }

  // jobs to pick up / deliver right here
  p.jobs.filter(j => !j.pickedUp && j.fromId === uiSelectedPointId).forEach(j => {
    addBtn(`📦 Забрать «${j.itemName}»`, () => { pickUpJob(j.id); renderAll(); }, !openNow);
  });
  p.jobs.filter(j => j.pickedUp && j.toId === uiSelectedPointId).forEach(j => {
    addBtn(`✅ Сдать «${j.itemName}»`, () => { deliverJob(j.id); renderAll(); }, !openNow);
  });

  if (point.type === 'shop') { addBtn('Открыть магазин', () => openShop(true), !openNow); }
  if (point.type === 'workshop') { addBtn('Открыть мастерскую', () => openWorkshop(), !openNow); }

  if (point.type === 'cafe' || point.type === 'waystop' || point.type === 'gas') {
    EAT_OPTIONS.forEach(opt => {
      const cost = EAT_PRICE_CAFE[opt.id];
      addBtn(`${opt.label} — ${cost} ₽`, () => { startEating(opt.id); renderAll(); }, state.money < cost || !openNow);
    });
  }
  if (point.type === 'home') {
    EAT_OPTIONS.forEach(opt => addBtn(`${opt.label} (бесплатно)`, () => { startEating(opt.id); renderAll(); }));
    SLEEP_OPTIONS.forEach(opt => addBtn(opt.label, () => { startSleeping(opt.id); renderAll(); }));
    const spec = vehicleSpec();
    if (spec.fuel === 'electric') {
      const missing = spec.tank - p.vehicle.fuel;
      addBtn(missing <= 0.01 ? 'Заряжен полностью' : '🔌 Зарядить дома (бесплатно)', () => { startRefuel(); renderAll(); }, missing <= 0.01);
    }
  }
  if (point.type === 'gas' || point.type === 'waystop') {
    const spec = vehicleSpec();
    if (spec.fuel !== 'legs') {
      const missing = spec.tank - p.vehicle.fuel;
      const cost = Math.round(missing * FUEL_COST_PER_KM_RANGE[spec.fuel]);
      addBtn(missing <= 0.01 ? 'Бак полон' : `⛽ Заправиться — ${cost} ₽`, () => { startRefuel(); renderAll(); }, missing <= 0.01 || state.money < cost || !openNow);
    }
  }
  if (point.type === 'garage') {
    const citySpace = pointSpace(point.id);
    if (!state.company.registered) {
      const l = document.createElement('div');
      l.className = 'job-sub';
      l.textContent = 'Нужна своя компания — оформи регистрацию в меню «Компания»';
      panel.appendChild(l);
    } else if (!hasGarageInCity(citySpace)) {
      const cost = garageCostForCity(citySpace);
      addBtn(`Купить гараж — ${cost.toLocaleString('ru-RU')} ₽`, () => { buyGarage(citySpace); renderAll(); }, state.money < cost);
    } else {
      EAT_OPTIONS.forEach(opt => addBtn(`${opt.label} (за счёт компании)`, () => { startEating(opt.id); renderAll(); }));
      SLEEP_OPTIONS.forEach(opt => addBtn(opt.label, () => { startSleeping(opt.id); renderAll(); }));
      const spec = vehicleSpec();
      if (spec.fuel === 'electric') {
        const missing = spec.tank - p.vehicle.fuel;
        addBtn(missing <= 0.01 ? 'Заряжен полностью' : '🔌 Зарядить (за счёт компании)', () => { startRefuel(); renderAll(); }, missing <= 0.01);
      }
      addBtn(p.vehicle.condition >= 100 ? 'Техника в порядке' : '🔧 Ремонт (за счёт компании)', () => { garageRepair(); renderAll(); }, p.vehicle.condition >= 100);
    }
  }
  if (point.type !== 'home' && point.type !== 'garage' && vehicleCanSleepIn(vehicleSpec())) {
    VEHICLE_SLEEP_OPTIONS.forEach(opt => addBtn(opt.label, () => { startVehicleSleep(opt.id); renderAll(); }));
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

  const weightPct = clamp(cargoWeightKg() / spec.kg * 100, 0, 100);
  const volPct = clamp(cargoVolumeL() / spec.l * 100, 0, 100);
  const info = document.createElement('div');
  info.className = 'cargo-header-info';
  info.innerHTML = `
    <div class="cargo-header-text"><b>${spec.name}</b> · ${p.jobs.length ? 'груз на борту' : 'пусто'}</div>
    <div class="cargo-cap-row"><span>${cargoWeightKg().toFixed(1)}/${spec.kg} кг</span><div class="vital-track"><div class="vital-fill" style="width:${weightPct}%;background:linear-gradient(to right,#a3700e,#e2a63b)"></div></div></div>
    <div class="cargo-cap-row"><span>${formatVolumeM3(cargoVolumeL())} / ${formatVolumeM3(spec.l)}</span><div class="vital-track"><div class="vital-fill" style="width:${volPct}%;background:linear-gradient(to right,#2a6690,#4a9dd1)"></div></div></div>`;
  header.append(icon, info);
  box.appendChild(header);

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
    const statusText = job.pickedUp ? `→ ${pointFullLabel(job.toId)}` : `забрать: ${pointFullLabel(job.fromId)}`;
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
    meta.textContent = `${job.weightKg}кг/${formatVolumeM3(job.volumeL)}`;
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
    const routeBtn = document.createElement('button');
    routeBtn.className = 'secondary-action';
    routeBtn.textContent = uiRouteJobId === job.id ? '🗺️ Скрыть маршрут' : '🗺️ Показать маршрут';
    routeBtn.onclick = () => { showJobRoute(job.id); lastCargoSignature = null; renderAll(); };
    chip.appendChild(routeBtn);
    grid.appendChild(chip);
  });
  box.appendChild(grid);
}

let lastOrdersSignature = null;
let lastOrdersRenderRealTime = 0;
// Before the company is registered, intercity jobs shouldn't even be takeable
// (job generation already avoids them, but this covers any stray one already
// sitting in the pool from before registration, or from an old save).
function jobWithinCompanyReach(job) {
  return state.company.registered || (pointSpace(job.fromId) === COMPANY_HOME_CITY && pointSpace(job.toId) === COMPANY_HOME_CITY);
}

// A pickup a foot courier can't practically walk to right now (wrong settlement
// entirely) — this blocks taking the job outright: there's no point reserving
// a delivery you have no way of even starting.
function jobPickupReachable(job) {
  const spec = vehicleSpec();
  return spec.cat !== 'foot' || pointSpace(job.fromId) === pointSpace(state.player.positionId);
}

function jobFitsVehicle(job) {
  const spec = vehicleSpec();
  const weightOk = cargoWeightKg() + job.weightKg <= spec.kg;
  const volumeOk = cargoVolumeL() + job.volumeL <= spec.l;
  const equipOk = hasRequiredEquipment(job.storage);
  // Walking between settlements is technically possible (rest stops exist) but absurd —
  // a job only "fits" on foot if pickup and drop-off are in the same settlement AND
  // that settlement is the one the courier is actually standing in right now (otherwise
  // he can't even reach the pickup point to begin with).
  const rangeOk = spec.cat !== 'foot'
    || (pointSpace(job.fromId) === pointSpace(job.toId) && pointSpace(job.fromId) === pointSpace(state.player.positionId));
  return weightOk && volumeOk && equipOk && rangeOk;
}

function renderOrdersCount() {
  el('orders-count').textContent = state.availableJobs.length;
}

const orderFilters = { storage: 'all', urgency: 'all', fitsOnly: false, sameCity: false, sort: 'default' };

function renderOrdersList() {
  if (el('orders-modal').classList.contains('hidden')) return;
  const canTakeMore = state.player.jobs.filter(j => !j.pickedUp).length < MAX_PENDING_JOBS;
  const signature = canTakeMore + '|' + state.player.positionId + '|' + state.availableJobs.map(j => j.id).join(',') + '|' + JSON.stringify(orderFilters);
  const now = Date.now();
  if (signature === lastOrdersSignature && now - lastOrdersRenderRealTime < 1000) return;
  lastOrdersSignature = signature;
  lastOrdersRenderRealTime = now;

  const playerCity = pointSpace(state.player.positionId);
  const ul = el('orders-list');
  ul.innerHTML = '';
  let filtered = state.availableJobs.filter(job => {
    if (orderFilters.storage !== 'all' && job.storage !== orderFilters.storage) return false;
    if (orderFilters.urgency !== 'all' && job.urgencyKey !== orderFilters.urgency) return false;
    if (orderFilters.fitsOnly && !jobFitsVehicle(job)) return false;
    if (orderFilters.sameCity && pointSpace(job.fromId) !== playerCity) return false;
    return true;
  });
  if (orderFilters.sort === 'distance') {
    filtered = filtered.map(job => ({ job, pickupKm: pathDistanceKm(shortestPath(state.player.positionId, job.fromId)) }))
      .sort((a, b) => a.pickupKm - b.pickupKm).map(x => x.job);
  } else if (orderFilters.sort === 'price_desc') {
    filtered = filtered.slice().sort((a, b) => b.payout - a.payout);
  } else if (orderFilters.sort === 'price_asc') {
    filtered = filtered.slice().sort((a, b) => a.payout - b.payout);
  }
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
    const pickupKm = orderFilters.sort === 'distance' ? pathDistanceKm(shortestPath(state.player.positionId, job.fromId)) : null;
    const pickupDistTag = pickupKm !== null ? ` · забрать за ${formatKm(pickupKm)} км` : '';
    const withinReach = jobWithinCompanyReach(job);
    info.innerHTML = `<div>${STORAGE_GLYPH[job.storage]} <b>${job.itemName}</b> — ${job.weightKg} кг / ${formatVolumeM3(job.volumeL)}</div>` +
      `<div class="job-sub">${pointFullLabel(job.fromId)} → ${pointFullLabel(job.toId)} · ${job.distanceKm} км${pickupDistTag}</div>` +
      `<div class="job-sub">${job.urgencyKey === 'urgent' ? '🔥' : job.urgencyKey === 'standard' ? '🕐' : '∞'} ${formatDeadline(job.deadlineReal)}${!withinReach ? ' · нужна своя компания' : !jobPickupReachable(job) ? ' · пешком туда не дойти' : !fits ? ' · не подходит' : ''}</div>`;
    const pay = document.createElement('span');
    pay.className = 'job-pay';
    pay.textContent = `${job.payout} ₽`;
    const btn = document.createElement('button');
    btn.textContent = 'Взять';
    btn.disabled = !canTakeMore || !withinReach || !jobPickupReachable(job) || !fits;
    btn.onclick = () => { takeJob(job.id); renderAll(); };
    li.append(info, pay, btn);
    ul.appendChild(li);
  });
}

let lastStatusSignature = null;
function renderStatusPanel() {
  const panel = el('status-panel');
  const p = state.player;
  let text;
  let progressFraction = null;
  let remainingLabel = '';
  if (p.status === 'idle') {
    text = `Стоит на месте (${pointById(p.positionId).name}), готов ехать`;
  } else if (p.status === 'resting') {
    text = `Отдыхает: ${p.restPlan ? p.restPlan.label : ''}`;
    if (p.restPlan) {
      progressFraction = clamp(p.restElapsed / p.restPlan.totalMinutes, 0, 1);
      remainingLabel = formatMinutesDuration(p.restPlan.totalMinutes - p.restElapsed);
    }
  } else if (p.status === 'eating') {
    text = `Ест: ${p.eatPlan ? p.eatPlan.label : ''}`;
    if (p.eatPlan) {
      progressFraction = clamp(p.eatElapsed / p.eatPlan.totalMinutes, 0, 1);
      remainingLabel = formatMinutesDuration(p.eatPlan.totalMinutes - p.eatElapsed);
    }
  } else if (p.status === 'refueling') {
    text = `Заправляется: ${p.refuelPlan ? p.refuelPlan.label : ''}`;
    if (p.refuelPlan) {
      progressFraction = clamp(p.refuelElapsed / p.refuelPlan.totalMinutes, 0, 1);
      remainingLabel = formatMinutesDuration(p.refuelPlan.totalMinutes - p.refuelElapsed);
    }
  } else if (p.status === 'collapsed') {
    text = 'Без сознания от недосыпа';
    progressFraction = clamp(1 - p.collapseRemaining / FOOT_COLLAPSE_MINUTES, 0, 1);
    remainingLabel = formatMinutesDuration(p.collapseRemaining);
  } else if (p.status === 'moving') {
    const a = p.activity;
    const remainingKm = Math.max(0, a.totalKm - a.traveledKm);
    text = `→ ${pointFullLabel(a.targetId)} · осталось ${formatKm(remainingKm)} км`;
    if (a.problemPending) text += ' — стоит';
  }
  const nightTag = isNight() ? ' 🌙 ночь, скорость ниже' : '';

  const signature = `${p.status}|${text}|${progressFraction === null ? 'x' : Math.round(progressFraction * 100)}`;
  if (signature === lastStatusSignature) return;
  lastStatusSignature = signature;

  if (progressFraction !== null) {
    panel.innerHTML = `
      <div>${text}${nightTag}</div>
      <div class="vital-track status-progress-track"><div class="vital-fill" style="width:${Math.round(progressFraction * 100)}%;background:linear-gradient(to right,#2a6690,#4a9dd1)"></div></div>
      <div class="job-sub">Осталось ~${remainingLabel}</div>
    `;
  } else {
    panel.textContent = text + nightTag;
  }
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
  const addBtn = (label, choice, disabled) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.disabled = !!disabled;
    b.onclick = () => { resolvePendingAction(action.id, choice); el('problem-modal').classList.add('hidden'); renderAll(); };
    actionsBox.appendChild(b);
  };
  if (action.kind === 'breakdown') {
    const spec = vehicleSpec();
    const personal = isPersonalMishap(spec);
    const type = breakdownPoolFor(spec).find(t => t.id === action.typeId);
    if (type.severity === 'minor') {
      addBtn(`${personal ? 'Обработать на месте' : 'Починить на месте'} — ${type.selfFixCost} ₽`, 'selfFix');
      addBtn(personal ? 'Идти так, рискуя' : 'Ехать так, рискуя', 'ignore');
    } else {
      addBtn(`${personal ? 'Взять такси до дома' : 'Вызвать эвакуатор'} — ${type.towCost} ₽`, 'tow');
    }
  } else if (action.kind === 'exhausted') {
    addBtn('Идти через силу, на голодный желудок', 'ignore');
    if (state.player.hunger >= 60) {
      addBtn(`🍔 Заказать доставку еды — ${foodDeliveryPrice()} ₽`, 'deliver', state.money < foodDeliveryPrice());
    }
  } else if (action.kind === 'hungry') {
    addBtn(`🍔 Заказать доставку — ${foodDeliveryPrice()} ₽`, 'deliver', state.money < foodDeliveryPrice());
    addBtn('Пока обойдусь', 'endure');
  }
  el('problem-modal').classList.remove('hidden');
}

let lastToastSignature = null;
// Every toast (not just the persistent offline-summary ones) can be tapped
// away early — leavingToastIds tracks that regardless of whether it was a
// manual tap or the toast's own natural expiry countdown.
function toastIsLeaving(t, now) {
  return leavingToastIds.has(t.id) || (!t.persistent && now >= t.expiresAt - TOAST_EXIT_MS);
}
function renderToasts() {
  const now = Date.now();
  toasts = toasts.filter(t => t.persistent || t.expiresAt > now);
  const signature = toasts.map(t => `${t.id}:${toastIsLeaving(t, now)}`).join(',');
  if (signature === lastToastSignature) return;
  lastToastSignature = signature;

  const area = el('toast-area');
  area.innerHTML = '';
  toasts.forEach(t => {
    const leaving = toastIsLeaving(t, now);
    const div = document.createElement('div');
    div.className = 'toast' + (t.persistent ? ' toast-persistent' : '');
    div.textContent = t.text;
    if (!leaving) div.onclick = () => dismissToast(t.id);
    area.appendChild(div);
    if (leaving) {
      // Fly precisely into the diary icon regardless of screen size: measure both
      // elements' current positions and animate the exact delta between them.
      const from = div.getBoundingClientRect();
      const to = el('btn-diary').getBoundingClientRect();
      const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
      const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
      div.style.setProperty('--fly-x', `${dx}px`);
      div.style.setProperty('--fly-y', `${dy}px`);
      div.classList.add('toast-leaving');
    }
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
  if (state.gameOver === 'starved') showStarvedModal();
  el('hud-money').textContent = `${Math.round(state.money)} ₽`;
  el('hud-money').style.color = state.money < 0 ? '#d9534f' : '';
  el('hud-time').textContent = formatTime(state.gameTime);
  el('btn-expenses').textContent = `-${state.dailyExpense.total} ₽/день`;
  // Displayed inverted: these read as satiety/rest, so the bar drains as
  // hunger/sleepiness (the underlying tracked values) climb toward hungry/exhausted.
  el('bar-hunger').style.width = `${100 - state.player.hunger}%`;
  el('bar-sleepiness').style.width = `${100 - state.player.sleepiness}%`;
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
let shopVehicleCategory = null; // null = category tile grid; otherwise the selected cat's vehicle list
function openShop(resetVehicleView) {
  if (!isPointOpenNow(pointById(state.player.positionId))) { toast('Закрыто — придётся подождать открытия'); return; }
  if (resetVehicleView) shopVehicleCategory = null;
  el('shop-tab-vehicles').classList.toggle('active', shopTab === 'vehicles');
  el('shop-tab-equipment').classList.toggle('active', shopTab === 'equipment');
  const citySpace = pointSpace(state.player.positionId);
  const tier = SETTLEMENT_TIER[citySpace] || 'village';
  const cityName = cityMeta(citySpace) ? cityMeta(citySpace).name : '';
  const allowedCats = TIER_SHOP_CATEGORIES[tier];
  el('shop-subtitle').textContent = `${cityName} (${TIER_LABEL[tier]}) — ассортимент зависит от размера города`;
  const list = el('shop-list');
  list.innerHTML = '';
  if (shopTab === 'vehicles') {
    const catsHere = VEHICLE_CATS_ORDER.filter(cat => allowedCats.includes(cat));
    if (!shopVehicleCategory || !catsHere.includes(shopVehicleCategory)) {
      // Top level: one tile per category — tap it to drill into that category's list.
      list.classList.add('shop-tiles');
      catsHere.forEach(cat => {
        const tile = document.createElement('li');
        tile.className = 'shop-tile';
        const ownedCount = state.player.vehicles.filter(v => VEHICLE_BY_ID[v.type] && VEHICLE_BY_ID[v.type].cat === cat).length;
        tile.innerHTML = `<div class="shop-tile-icon">${CAT_GLYPH[cat]}</div><div class="shop-tile-label">${CAT_LABEL[cat]}</div>` +
          (ownedCount ? `<div class="shop-tile-count">в гараже: ${ownedCount}</div>` : '');
        tile.onclick = () => { shopVehicleCategory = cat; openShop(); };
        list.appendChild(tile);
      });
    } else {
      list.classList.remove('shop-tiles');
      const backLi = document.createElement('li');
      backLi.className = 'shop-back-row';
      const backBtn = document.createElement('button');
      backBtn.className = 'shop-back-btn';
      backBtn.textContent = '← Все категории';
      backBtn.onclick = () => { shopVehicleCategory = null; openShop(); };
      backLi.appendChild(backBtn);
      list.appendChild(backLi);
      const header = document.createElement('li');
      header.className = 'shop-cat-header';
      header.textContent = `${CAT_GLYPH[shopVehicleCategory]} ${CAT_LABEL[shopVehicleCategory]}`;
      list.appendChild(header);
      VEHICLES.filter(v => v.cat === shopVehicleCategory).forEach(v => {
        const li = document.createElement('li');
        const owned = state.player.vehicles.some(veh => veh.type === v.id);
        const info = document.createElement('div');
        const fuelTxt = v.fuel === 'legs' ? '' : ` · бак ${v.tank} км`;
        info.innerHTML = `<b>${v.name}</b><div class="job-sub">${v.speed} км/ч · до ${v.trip} км за раз${fuelTxt} · ${v.kg} кг / ${formatVolumeM3(v.l)}${v.fridge ? ' · встроенный холод' : ''}</div>`;
        const btn = document.createElement('button');
        btn.textContent = owned ? 'В гараже' : (v.price === 0 ? 'Взять' : `Купить — ${v.price.toLocaleString('ru-RU')} ₽`);
        btn.disabled = owned || state.money < v.price;
        btn.onclick = () => { buyVehicle(v.id); openShop(); renderAll(); };
        li.append(info, btn);
        list.appendChild(li);
      });
    }
  } else {
    list.classList.remove('shop-tiles');
    EQUIPMENT.forEach(eq => {
      const li = document.createElement('li');
      const owned = !!state.player.equipment[eq.id];
      const info = document.createElement('div');
      const eqSub = eq.unlocks.length ? `Открывает: ${eq.unlocks.map(u => STORAGE_LABEL[u]).join(', ')}` : eq.desc;
      info.innerHTML = `<b>${eq.name}</b><div class="job-sub">${eqSub}</div>`;
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
  if (!isPointOpenNow(pointById(state.player.positionId))) { toast('Закрыто — придётся подождать открытия'); return; }
  el('workshop-condition').textContent = `Состояние техники: ${Math.round(state.player.vehicle.condition)}%`;
  el('btn-workshop-repair').textContent = `Полный ремонт — ${WORKSHOP_REPAIR_COST} ₽`;
  el('btn-workshop-repair').disabled = state.money < WORKSHOP_REPAIR_COST;
  const isFoot = vehicleSpec().cat === 'foot';
  const upgraded = state.player.vehicle.upgraded;
  el('btn-workshop-upgrade').textContent = `Укрепить подвеску — ${UPGRADE_COST} ₽`;
  el('btn-workshop-upgrade').disabled = isFoot || upgraded || state.money < UPGRADE_COST;
  el('workshop-upgrade-hint').textContent = isFoot
    ? 'У пешехода нет подвески — недоступно'
    : (upgraded ? 'Подвеска уже укреплена' : 'Снижает шанс серьёзных поломок');
  el('workshop-modal').classList.remove('hidden');
}

// ---------- company ----------

let companyView = { mode: 'main' };

function renderCompanyContent() {
  const box = el('company-content');
  box.innerHTML = '';
  if (!state.company.registered) { renderCompanyRegistration(box); return; }
  if (companyView.mode === 'employees') { renderEmployeesList(box); return; }
  if (companyView.mode === 'hire') { renderHireScreen(box); return; }
  if (companyView.mode === 'employeeDetail') { renderEmployeeDetail(box, companyView.employeeId); return; }
  renderCompanyMain(box);
}

function renderCompanyRegistration(box) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = 'Пока ты просто курьер и работаешь только в Ривном. Зарегистрируй свою компанию-грузоперевозчика, чтобы возить заказы между городами и нанимать сотрудников.';
  box.appendChild(p);
  const reqList = document.createElement('div');
  const hasCar = hasCarForCompany();
  const hasMoney = state.money >= COMPANY_REGISTRATION_COST;
  reqList.innerHTML = `
    <div class="job-sub">${hasMoney ? '✅' : '❌'} ${COMPANY_REGISTRATION_COST.toLocaleString('ru-RU')} ₽ на регистрацию</div>
    <div class="job-sub">${hasCar ? '✅' : '❌'} Хотя бы одна легковая машина</div>
  `;
  box.appendChild(reqList);
  const btn = document.createElement('button');
  btn.textContent = `Зарегистрировать компанию — ${COMPANY_REGISTRATION_COST.toLocaleString('ru-RU')} ₽`;
  btn.disabled = !canRegisterCompany();
  btn.onclick = () => { registerCompany(); renderCompanyContent(); renderAll(); };
  box.appendChild(btn);
}

function renderCompanyMain(box) {
  const p = document.createElement('p');
  p.textContent = '✅ Компания зарегистрирована — межгородские перевозки открыты.';
  box.appendChild(p);

  const navRow = document.createElement('div');
  navRow.className = 'company-nav-row';
  const staffBtn = document.createElement('button');
  staffBtn.textContent = `👥 Сотрудники (${state.company.employees.length}) — мест: ${garageSlotsUsed()}/${totalGarageCapacity()}`;
  staffBtn.onclick = () => { companyView = { mode: 'employees' }; renderCompanyContent(); };
  navRow.appendChild(staffBtn);
  box.appendChild(navRow);

  const garageHeading = document.createElement('h3');
  garageHeading.textContent = 'Гаражи';
  box.appendChild(garageHeading);
  const garageHint = document.createElement('p');
  garageHint.className = 'hint';
  garageHint.textContent = 'В каждом городе есть один участок под гараж компании — бесплатные еда, сон, ремонт и зарядка электротранспорта для тебя и сотрудников. Каждый гараж даёт ограниченное число мест для сотрудников (кроме пеших — им гараж не нужен); места можно расширять.';
  box.appendChild(garageHint);

  const garageList = document.createElement('ul');
  garageList.className = 'garage-list';
  COUNTRY_CITIES.forEach(city => {
    const owned = hasGarageInCity(city.id);
    const cost = garageCostForCity(city.id);
    const li = document.createElement('li');
    li.className = owned ? 'active-vehicle' : '';
    const icon = document.createElement('div');
    icon.className = 'garage-icon';
    icon.textContent = '🅿️';
    const info = document.createElement('div');
    info.className = 'garage-info';
    info.innerHTML = `${owned ? `<span class="garage-badge">Мест: ${garageCapacity(city.id)}</span><br>` : ''}<b>${city.name}</b><div class="garage-sub">${TIER_LABEL[city.tier] || city.tier}</div>`;
    li.append(icon, info);
    if (!owned) {
      const buyBtn = document.createElement('button');
      buyBtn.className = 'garage-buy-btn';
      buyBtn.textContent = `${cost.toLocaleString('ru-RU')} ₽`;
      buyBtn.disabled = state.money < cost;
      buyBtn.onclick = () => { buyGarage(city.id); renderCompanyContent(); renderAll(); };
      li.appendChild(buyBtn);
    } else {
      const expandCost = garageExpandCost(city.id);
      const expandBtn = document.createElement('button');
      expandBtn.className = 'garage-buy-btn';
      expandBtn.textContent = `+1 место — ${expandCost.toLocaleString('ru-RU')} ₽`;
      expandBtn.disabled = state.money < expandCost;
      expandBtn.onclick = () => { expandGarage(city.id); renderCompanyContent(); renderAll(); };
      li.appendChild(expandBtn);
    }
    garageList.appendChild(li);
  });
  box.appendChild(garageList);
}

function renderEmployeesList(box) {
  const backBtn = document.createElement('button');
  backBtn.textContent = '← Назад';
  backBtn.onclick = () => { companyView = { mode: 'main' }; renderCompanyContent(); };
  box.appendChild(backBtn);

  const heading = document.createElement('h3');
  heading.textContent = 'Сотрудники';
  box.appendChild(heading);

  const hireBtn = document.createElement('button');
  hireBtn.textContent = '➕ Нанять через кадровое агентство';
  hireBtn.onclick = () => { refreshCandidatePool(); companyView = { mode: 'hire' }; renderCompanyContent(); };
  box.appendChild(hireBtn);

  if (state.company.employees.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Пока никто не нанят.';
    box.appendChild(hint);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'garage-list';
  state.company.employees.forEach(emp => {
    const vehSpec = VEHICLE_BY_ID[emp.vehicleType];
    const li = document.createElement('li');
    const icon = document.createElement('div');
    icon.className = 'garage-icon';
    icon.textContent = '🧑';
    const info = document.createElement('div');
    info.className = 'garage-info';
    info.innerHTML = `<b>${emp.name}</b><div class="garage-sub">${EMPLOYEE_STATUS_LABEL[emp.status] || emp.status}</div><div class="garage-sub">${LICENSE_LABEL[emp.license]}</div><div class="garage-sub">Транспорт: ${vehSpec ? vehSpec.name : '—'}</div>`;
    li.append(icon, info);
    li.onclick = () => { companyView = { mode: 'employeeDetail', employeeId: emp.id }; renderCompanyContent(); };
    list.appendChild(li);
  });
  box.appendChild(list);
}

function renderHireScreen(box) {
  const backBtn = document.createElement('button');
  backBtn.textContent = '← Назад';
  backBtn.onclick = () => { companyView = { mode: 'employees' }; renderCompanyContent(); };
  box.appendChild(backBtn);

  const heading = document.createElement('h3');
  heading.textContent = 'Кадровое агентство';
  box.appendChild(heading);

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = '🔄 Обновить список';
  refreshBtn.onclick = () => { refreshCandidatePool(); renderCompanyContent(); };
  box.appendChild(refreshBtn);

  if (candidatePool.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Сейчас никто не ищет работу — обнови список.';
    box.appendChild(hint);
    return;
  }

  const slotsFree = garageSlotsAvailable() > 0;
  candidatePool.forEach((cand, idx) => {
    const card = document.createElement('div');
    card.className = 'candidate-card';
    card.innerHTML = `<b>${cand.name}</b><div class="job-sub">${LICENSE_LABEL[cand.license]}</div><div class="job-sub">Найм: ${cand.fee.toLocaleString('ru-RU')} ₽</div>`;
    // Foot vehicles don't need a garage slot at all — everything else does.
    const eligible = eligibleVehiclesFor(cand.license).filter(v => VEHICLE_BY_ID[v.type].cat === 'foot' || slotsFree);
    if (eligible.length === 0) {
      const noVeh = document.createElement('div');
      noVeh.className = 'job-sub';
      noVeh.textContent = eligibleVehiclesFor(cand.license).length === 0
        ? 'Нет свободного подходящего транспорта в твоём гараже'
        : 'Нет свободных мест в гаражах для этого транспорта';
      card.appendChild(noVeh);
    } else {
      const select = document.createElement('select');
      select.className = 'hire-select';
      eligible.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.type;
        opt.textContent = VEHICLE_BY_ID[v.type].name;
        select.appendChild(opt);
      });
      card.appendChild(select);
      const hireBtn = document.createElement('button');
      hireBtn.textContent = `Нанять — ${cand.fee.toLocaleString('ru-RU')} ₽`;
      hireBtn.disabled = state.money < cand.fee;
      hireBtn.onclick = () => { hireEmployee(idx, select.value); renderCompanyContent(); renderAll(); };
      card.appendChild(hireBtn);
    }
    box.appendChild(card);
  });
}

function renderEmployeeDetail(box, employeeId) {
  const emp = state.company.employees.find(e => e.id === employeeId);
  const backBtn = document.createElement('button');
  backBtn.textContent = '← Назад';
  backBtn.onclick = () => { companyView = { mode: 'employees' }; renderCompanyContent(); };
  box.appendChild(backBtn);

  if (!emp) return;
  const vehSpec = VEHICLE_BY_ID[emp.vehicleType];
  const free = employeeIsFree(emp);
  const heading = document.createElement('h3');
  heading.textContent = emp.name;
  box.appendChild(heading);

  const vehInstance = emp.vehicleType ? state.player.vehicles.find(v => v.type === emp.vehicleType) : null;
  const fuelLine = (vehInstance && vehSpec && vehSpec.fuel !== 'legs')
    ? `<div class="job-sub">Топливо: ${Math.round(vehInstance.fuel)}/${vehSpec.tank} км хода</div>` : '';
  const info = document.createElement('div');
  info.innerHTML = `
    <div class="job-sub">${EMPLOYEE_STATUS_LABEL[emp.status] || emp.status}${emp.status === 'training' ? ` — осталось ${formatMinutesDuration(emp.trainingRemaining)}` : ''}</div>
    <div class="job-sub">${LICENSE_LABEL[emp.license]}</div>
    <div class="job-sub">Транспорт: ${vehSpec ? vehSpec.name : '— нет транспорта'}</div>
    ${fuelLine}
    <div class="job-sub">Сытость: ${Math.round(emp.hunger)}% · Сон: ${Math.round(emp.sleepiness)}%</div>
    <div class="job-sub">Где сейчас: ${pointFullLabel(emp.positionId)}</div>
    <div class="job-sub">Заработал сотруднику: ${Math.round(emp.earnings || 0).toLocaleString('ru-RU')} ₽</div>
  `;
  box.appendChild(info);

  if (emp.status === 'training') {
    const trainHint = document.createElement('p');
    trainHint.className = 'hint';
    trainHint.textContent = `На курсах повышения категории — недоступен для других действий, пока не вернётся.`;
    box.appendChild(trainHint);
    return;
  }

  const workBtn = document.createElement('button');
  workBtn.textContent = emp.working ? '🟢 Работает — нажми, чтобы отправить в АФК' : '🔴 АФК — нажми, чтобы вывести на работу';
  workBtn.disabled = !emp.working && !emp.vehicleType;
  workBtn.onclick = () => { toggleEmployeeWorking(emp.id); renderCompanyContent(); };
  box.appendChild(workBtn);

  const vehHeading = document.createElement('h3');
  vehHeading.textContent = 'Транспорт';
  box.appendChild(vehHeading);
  if (emp.vehicleType) {
    const takeBtn = document.createElement('button');
    takeBtn.textContent = '🚫 Забрать транспорт (уйдёт в АФК)';
    takeBtn.disabled = !free;
    takeBtn.onclick = () => { takeEmployeeVehicle(emp.id); renderCompanyContent(); renderAll(); };
    box.appendChild(takeBtn);
  }
  const eligible = eligibleVehiclesFor(emp.license).filter(v => v.type !== emp.vehicleType);
  if (eligible.length > 0) {
    const swapSelect = document.createElement('select');
    swapSelect.className = 'hire-select';
    eligible.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.type;
      opt.textContent = VEHICLE_BY_ID[v.type].name;
      swapSelect.appendChild(opt);
    });
    box.appendChild(swapSelect);
    const swapBtn = document.createElement('button');
    swapBtn.textContent = emp.vehicleType ? 'Сменить транспорт' : 'Выдать транспорт';
    swapBtn.disabled = !free;
    swapBtn.onclick = () => { assignEmployeeVehicle(emp.id, swapSelect.value); renderCompanyContent(); renderAll(); };
    box.appendChild(swapBtn);
  } else {
    const noVeh = document.createElement('p');
    noVeh.className = 'hint';
    noVeh.textContent = 'Нет другого свободного подходящего транспорта в твоём гараже.';
    box.appendChild(noVeh);
  }

  const isFootEmployee = vehSpec && vehSpec.cat === 'foot';
  const ownedGarageCities = COUNTRY_CITIES.filter(c => hasGarageInCity(c.id));
  if (!isFootEmployee && ownedGarageCities.length > 0) {
    const garageHeading = document.createElement('h3');
    garageHeading.textContent = 'Отправить в гараж';
    box.appendChild(garageHeading);
    const garageTripHint = document.createElement('p');
    garageTripHint.className = 'hint';
    garageTripHint.textContent = 'Едет туда своим ходом (реально, не телепортом) и по пути сам заедет заправиться/поесть/поспать, если понадобится.';
    box.appendChild(garageTripHint);
    const gSelect = document.createElement('select');
    gSelect.className = 'hire-select';
    ownedGarageCities.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      gSelect.appendChild(opt);
    });
    box.appendChild(gSelect);
    const gBtn = document.createElement('button');
    gBtn.textContent = '🅿️ Отправить в гараж (своим ходом, уйдёт в АФК по прибытии)';
    gBtn.disabled = !free || !emp.vehicleType;
    gBtn.onclick = () => { sendEmployeeToGarage(emp.id, gSelect.value); renderCompanyContent(); renderAll(); };
    box.appendChild(gBtn);
  }

  const licenseIdx = LICENSE_TIERS_ORDER.indexOf(emp.license);
  if (licenseIdx < LICENSE_TIERS_ORDER.length - 1) {
    const targetLicense = LICENSE_TIERS_ORDER[licenseIdx + 1];
    const cost = LICENSE_UPGRADE_COST[targetLicense] + TRAINING_WAGE_PER_DAY * TRAINING_DAYS;
    const trainHeading = document.createElement('h3');
    trainHeading.textContent = 'Повышение категории';
    box.appendChild(trainHeading);
    const trainHint = document.createElement('p');
    trainHint.className = 'hint';
    trainHint.textContent = `До «${LICENSE_LABEL[targetLicense]}», ~${TRAINING_DAYS} дней, ${cost.toLocaleString('ru-RU')} ₽ (курс + минимальная зарплата на всё время обучения). На это время сотрудник не работает.`;
    box.appendChild(trainHint);
    const trainBtn = document.createElement('button');
    trainBtn.textContent = `🎓 Отправить на курсы — ${cost.toLocaleString('ru-RU')} ₽`;
    trainBtn.disabled = !free || state.money < cost;
    trainBtn.onclick = () => { startEmployeeTraining(emp.id); renderCompanyContent(); renderAll(); };
    box.appendChild(trainBtn);
  }

  const prefHeading = document.createElement('h3');
  prefHeading.textContent = 'Какие заказы брать';
  box.appendChild(prefHeading);
  JOB_PREF_OPTIONS.forEach(opt => {
    const btn = document.createElement('button');
    btn.textContent = (emp.jobPref === opt.id ? '✓ ' : '') + opt.label;
    btn.onclick = () => { setEmployeeJobPref(emp.id, opt.id); renderCompanyContent(); };
    box.appendChild(btn);
  });

  const fireBtn = document.createElement('button');
  fireBtn.className = 'danger-action';
  fireBtn.textContent = 'Уволить';
  fireBtn.disabled = !free;
  fireBtn.onclick = () => { fireEmployee(emp.id); companyView = { mode: 'employees' }; renderCompanyContent(); renderAll(); };
  box.appendChild(fireBtn);
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

function openExpenses() {
  const d = state.dailyExpense;
  const spec = vehicleSpec();
  el('expenses-content').innerHTML = `
    <div class="expenses-row"><span class="expenses-label">Жизнь (еда, жильё)</span><span>${d.living} ₽</span></div>
    <div class="expenses-row"><span class="expenses-label">Содержание техники (${spec.name})</span><span>${d.vehicleUpkeep} ₽</span></div>
    <div class="expenses-row total"><span>Итого за день ${d.day}</span><span>${d.total} ₽</span></div>
    <p class="hint">Списывается автоматически раз в сутки, в полночь по игровому времени. Сумма меняется каждый день и растёт по мере роста дела.</p>
  `;
  el('expenses-modal').classList.remove('hidden');
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
    info.innerHTML = `${isActive ? '<span class="garage-badge">Используется</span><br>' : ''}<b>${spec.name}</b><div class="garage-sub">Состояние: ${Math.round(veh.condition)}%${fuelTxt}</div>`;
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
  header.innerHTML = `<div class="garage-icon">${CAT_GLYPH[spec.cat]}</div><div><b>${spec.name}</b><div class="garage-sub">${CAT_LABEL[spec.cat]}${isActive ? ' · используется сейчас' : ''}</div></div>`;
  wrap.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'garage-spec-grid';
  const fuelRow = spec.fuel === 'legs'
    ? '<div><span>Топливо</span>не требуется</div>'
    : `<div><span>Запас хода</span>${Math.round(veh.fuel)}/${spec.tank} км</div>`;
  const suspensionRow = spec.cat === 'foot' ? '' : `<div><span>Подвеска</span>${veh.upgraded ? 'укреплена' : 'обычная'}</div>`;
  grid.innerHTML = `
    <div><span>Состояние</span>${Math.round(veh.condition)}% (${conditionLabel(veh.condition)})</div>
    <div><span>Скорость</span>${spec.speed} км/ч</div>
    <div><span>Грузоподъёмность</span>${spec.kg} кг</div>
    <div><span>Объём груза</span>${formatVolumeM3(spec.l)}</div>
    <div><span>Макс. рейс без остановки</span>${spec.trip} км</div>
    ${fuelRow}
    ${suspensionRow}
    <div><span>Сон в дороге</span>${vehicleCanSleepIn(spec) ? 'можно в кабине' : 'спать нельзя'}</div>
  `;
  wrap.appendChild(grid);

  const breakdownNote = document.createElement('p');
  breakdownNote.className = 'hint';
  breakdownNote.textContent = 'Поломки пока считаются только через общее состояние — отдельные неисправности (колесо, руль, масло) добавим позже.';
  wrap.appendChild(breakdownNote);

  const actions = document.createElement('div');
  actions.className = 'garage-detail-actions';
  const switchBtn = document.createElement('button');
  switchBtn.textContent = isActive ? 'Уже используется' : '🔁 Пересесть';
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
    sellBtn.textContent = isActive ? 'Нельзя продать (используется)' : `💰 Продать технику — ${resaleVal.toLocaleString('ru-RU')} ₽`;
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
  renderAutoplayToggle();
  requestAnimationFrame(frame);
}

function renderAutoplayToggle() {
  const btn = el('btn-autoplay-toggle');
  btn.classList.toggle('autoplay-on', state.autoPlay);
  btn.classList.toggle('autoplay-off', !state.autoPlay);
  btn.title = state.autoPlay
    ? 'Игра продолжит идти, пока закрыта. Нажми, чтобы поставить на паузу'
    : 'На паузе — время не идёт, пока тебя нет. Нажми, чтобы снова разрешить игре идти';
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
  if (summary.entries.length === 0 && summary.netMoneyChange === 0 && !summary.paused) return;
  const sign = summary.netMoneyChange > 0 ? '+' : '';
  el('offline-header').textContent = `Доставлено заказов: ${summary.jobsCompleted}. Происшествий: ${summary.incidents}. Баланс изменился: ${sign}${summary.netMoneyChange} ₽.`;
  renderDiaryList(el('offline-list'), summary.entries.slice(0, 60));
  el('offline-modal').classList.remove('hidden');

  // Auto-care spending and an unresolved crisis are important enough that they
  // shouldn't just be a line in a summary you tap "Понятно" past once — they sit
  // as their own persistent notifications until the player deliberately dismisses each.
  if (summary.auto && (summary.auto.meals > 0 || summary.auto.sleeps > 0)) {
    const parts = [];
    if (summary.auto.meals > 0) parts.push(`поел ${summary.auto.meals} раз (${summary.auto.foodSpent} ₽)`);
    if (summary.auto.sleeps > 0) parts.push(`поспал ${summary.auto.sleeps} раз (${summary.auto.sleepSpent} ₽)`);
    toast(`Пока тебя не было — автоматически: ${parts.join(', ')}.`, { persistent: true });
  }
  if (summary.paused) {
    toast('⚠️ Пока тебя не было, у курьера кончились деньги на еду, и он терпит голод на свой страх и риск — сейчас самое время его спасти.', { persistent: true });
  }
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
  initDailyEconomy();
  saveGame();
  showGameScreen();
};

let starvedShown = false;
function showStarvedModal() {
  if (starvedShown) return;
  starvedShown = true;
  el('starved-modal').classList.remove('hidden');
}
el('btn-starved-restart').onclick = () => {
  el('starved-modal').classList.add('hidden');
  starvedShown = false;
  state = newGameState();
  initDailyEconomy();
  saveGame();
  showGameScreen();
};

el('btn-new-game').onclick = () => {
  state = newGameState();
  bankruptcyShown = false;
  starvedShown = false;
  initDailyEconomy();
  saveGame();
  showGameScreen();
};

el('btn-continue').onclick = () => {
  if (!loadGame()) return;
  bankruptcyShown = false;
  starvedShown = false;
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
      migrateEconomyFields();
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

el('btn-autoplay-toggle').onclick = () => {
  state.autoPlay = !state.autoPlay;
  renderAutoplayToggle();
  saveGame();
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
// Temporary testing aid: adds funds to the current save so vehicles other than
// foot can actually be tried out. Remove once no longer needed for testing.
el('btn-debug-money').onclick = () => { state.money += 100000; saveGame(); renderAll(); toast('Добавлено 100 000 ₽ (тест)'); };
el('btn-offline-ok').onclick = () => el('offline-modal').classList.add('hidden');

el('btn-diary').onclick = () => {
  renderDiaryList(el('diary-list-full'), state.eventLog);
  el('diary-modal').classList.remove('hidden');
};
el('btn-diary-close').onclick = () => el('diary-modal').classList.add('hidden');

el('btn-open-orders').onclick = () => { el('orders-modal').classList.remove('hidden'); lastOrdersSignature = null; renderOrdersList(); };
el('btn-orders-close').onclick = () => el('orders-modal').classList.add('hidden');
el('btn-orders-close-x').onclick = () => el('orders-modal').classList.add('hidden');
el('filter-storage').onchange = (e) => { orderFilters.storage = e.target.value; lastOrdersSignature = null; renderOrdersList(); };
el('filter-urgency').onchange = (e) => { orderFilters.urgency = e.target.value; lastOrdersSignature = null; renderOrdersList(); };
el('filter-fits-only').onchange = (e) => { orderFilters.fitsOnly = e.target.checked; lastOrdersSignature = null; renderOrdersList(); };
el('filter-same-city').onchange = (e) => { orderFilters.sameCity = e.target.checked; lastOrdersSignature = null; renderOrdersList(); };
el('sort-orders').onchange = (e) => { orderFilters.sort = e.target.value; lastOrdersSignature = null; renderOrdersList(); };

el('btn-open-garage').onclick = () => openGarage();
el('btn-garage-close').onclick = () => el('garage-modal').classList.add('hidden');

el('btn-open-company').onclick = () => { el('company-modal').classList.remove('hidden'); renderCompanyContent(); };
el('btn-company-close').onclick = () => el('company-modal').classList.add('hidden');
el('btn-company-close-x').onclick = () => el('company-modal').classList.add('hidden');

el('btn-expenses').onclick = () => openExpenses();
el('btn-expenses-close').onclick = () => el('expenses-modal').classList.add('hidden');

el('btn-refuse-confirm').onclick = () => {
  if (pendingRefuseJobId !== null) refuseJob(pendingRefuseJobId);
  pendingRefuseJobId = null;
  el('refuse-modal').classList.add('hidden');
  renderAll();
};
el('btn-refuse-cancel').onclick = () => { pendingRefuseJobId = null; el('refuse-modal').classList.add('hidden'); };

el('btn-shop-close').onclick = () => el('shop-modal').classList.add('hidden');
el('shop-tab-vehicles').onclick = () => { shopTab = 'vehicles'; openShop(true); };
el('shop-tab-equipment').onclick = () => { shopTab = 'equipment'; openShop(true); };
el('btn-workshop-close').onclick = () => el('workshop-modal').classList.add('hidden');
el('btn-workshop-repair').onclick = () => { workshopRepair(); openWorkshop(); renderAll(); };
el('btn-workshop-upgrade').onclick = () => { workshopUpgrade(); openWorkshop(); renderAll(); };

window.addEventListener('beforeunload', () => { if (state) saveGame(); });
// requestAnimationFrame simply stops firing while the tab/app is backgrounded or
// minimized — the game doesn't "pause" on purpose, it just has no way to keep
// ticking without a frame callback. Route the same catch-up used when reopening
// from the menu through here too, so minimizing behaves the same as closing.
document.addEventListener('visibilitychange', () => {
  if (!state) return;
  if (document.hidden) {
    saveGame();
  } else if (!gameScreen.classList.contains('hidden')) {
    const summary = runOfflineCatchup();
    lastFrameTs = null;
    saveGame();
    renderAll();
    if (summary) showOfflineSummary(summary);
  }
});
window.addEventListener('resize', () => { if (!gameScreen.classList.contains('hidden')) resizeCanvas(); });
// The map is a flex child sized by whatever's left after the vitals bar and
// bottom tab bar/cargo panel take their own height — that can change for
// reasons a plain window "resize" event never fires for (mobile browser
// chrome show/hide changing dvh, cargo panel appearing/disappearing, fonts
// finishing layout late). Without this the canvas's pixel buffer goes stale
// relative to its actual box and gets stretched, which looks like the map
// is squished with a visible seam. A ResizeObserver on the box itself catches
// all of that directly.
if (window.ResizeObserver) {
  new ResizeObserver(() => { if (!gameScreen.classList.contains('hidden')) resizeCanvas(); }).observe(el('map-stage'));
}

showMenuScreen();
