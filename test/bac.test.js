// Unit tests for SoberPace's core science & helpers.
// Run with: npm test   (uses the built-in node:test runner, zero dependencies)
//
// app.js is a browser script. Before requiring it we install a minimal
// localStorage shim on globalThis, since app.js reads localStorage at load
// time (let authToken = localStorage.getItem(...)). The DOM-touching init is
// already guarded behind `typeof document !== 'undefined'`.

const test = require('node:test');
const assert = require('node:assert');

// --- Minimal localStorage shim (must exist before app.js is required) ---
const _store = {};
const localStorageShim = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(_store, k) ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: (k) => { delete _store[k]; },
    clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};
Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageShim, configurable: true, writable: true,
});

const app = require('../app.js');
const {
    profile, calculateWatsonR, getKa, calculateAlcoholGrams,
    gramsToStandardDrinks, calculateScientificPacingInterval,
    runBacSimulation, formatCountdownClock,
} = app;

// A known-good baseline profile used for the global-reading functions.
function setBaselineProfile(overrides = {}) {
    Object.assign(profile, {
        gender: 'male', age: 40,
        weight: 80, weightUnit: 'kg',
        height: 180, heightUnit: 'cm',
        targetBacLimit: 0.06, pacingTime: 60, pacingMode: 'manual',
        globalStomach: 'normal', decayRate: 0.015,
    }, overrides);
}

const close = (a, b, eps = 1e-4) =>
    assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b} (±${eps})`);

// Build a drink object the way the app does.
function drink(grams, timeMs, { stomach = 'normal', duration = 25 } = {}) {
    return { name: 't', vol: 0, abv: 0, alcoholGrams: grams, time: timeMs, stomach, duration };
}
const baseSimProfile = () => ({
    gender: 'male', age: 40, weight: 80, weightUnit: 'kg',
    height: 180, heightUnit: 'cm', targetBacLimit: 0.06,
    globalStomach: 'normal', decayRate: 0.015,
});
const peakBac = (timeline) => timeline.reduce((m, s) => Math.max(m, s.bac), 0);
const peakIndex = (timeline) => {
    let idx = 0;
    for (let i = 1; i < timeline.length; i++) if (timeline[i].bac > timeline[idx].bac) idx = i;
    return idx;
};

// --- calculateAlcoholGrams ---
test('calculateAlcoholGrams: ethanol mass = vol * abv * density(0.789)', () => {
    close(calculateAlcoholGrams(500, 5), 500 * 0.05 * 0.789); // 19.725 g
    close(calculateAlcoholGrams(0, 5), 0);
    close(calculateAlcoholGrams(330, 4.5), 330 * 0.045 * 0.789);
});

// --- gramsToStandardDrinks ---
test('gramsToStandardDrinks: 1 standard drink = 14 g ethanol', () => {
    close(gramsToStandardDrinks(14), 1);
    close(gramsToStandardDrinks(28), 2);
    close(gramsToStandardDrinks(0), 0);
});

// --- getKa ---
test('getKa: absorption constant by stomach fullness', () => {
    assert.strictEqual(getKa('empty'), 4.0);
    assert.strictEqual(getKa('normal'), 2.5);
    assert.strictEqual(getKa('full'), 1.2);
    assert.strictEqual(getKa('anything-else'), 2.5); // defaults to normal
});

// --- calculateWatsonR ---
test('calculateWatsonR: male Watson formula (locks in the 0.09156 age coefficient)', () => {
    setBaselineProfile();
    // tbw = 2.447 - 0.09156*40 + 0.1074*180 + 0.3362*80 = 45.0126
    // r   = 45.0126 / (0.8 * 80) = 0.70332...
    // (The buggy 0.09516 coefficient would give 0.70107 — outside this tolerance.)
    close(calculateWatsonR(), 0.703322, 1e-4);
});

test('calculateWatsonR: female Watson formula', () => {
    setBaselineProfile({ gender: 'female', weight: 60, height: 165 });
    // tbw = -2.097 + 0.1069*165 + 0.2466*60 = 30.3375 ; r = 30.3375/48 = 0.632031
    close(calculateWatsonR(), 0.632031, 1e-4);
});

test('calculateWatsonR: result is clamped into [0.4, 0.9]', () => {
    setBaselineProfile({ weight: 30, height: 200 }); // tiny, very-tall -> r would exceed 0.9
    assert.strictEqual(calculateWatsonR(), 0.9);
});

test('calculateWatsonR: respects unit conversion (lbs/in match kg/cm)', () => {
    setBaselineProfile({ weight: 80, weightUnit: 'kg', height: 180, heightUnit: 'cm' });
    const metric = calculateWatsonR();
    setBaselineProfile({ weight: 80 * 2.20462, weightUnit: 'lbs', height: 180 / 2.54, heightUnit: 'in' });
    close(calculateWatsonR(), metric, 1e-6);
});

// --- runBacSimulation ---
test('runBacSimulation: empty input -> empty timeline', () => {
    assert.deepStrictEqual(runBacSimulation([], baseSimProfile()), []);
});

test('runBacSimulation: one drink produces a positive peak and returns toward zero', () => {
    const t0 = 1_700_000_000_000;
    const tl = runBacSimulation([drink(19.725, t0)], baseSimProfile());
    assert.ok(tl.length > 0);
    assert.ok(tl[0].bac < 0.001, 'BAC starts ~0 at the moment of the first drink');
    assert.ok(peakBac(tl) > 0, 'peak BAC is positive');
    assert.ok(tl[tl.length - 1].bac < peakBac(tl), 'BAC declines from its peak');
});

test('runBacSimulation: more ethanol -> higher peak (monotonic)', () => {
    const t0 = 1_700_000_000_000;
    const p = baseSimProfile();
    const peak14 = peakBac(runBacSimulation([drink(14, t0)], p));
    const peak28 = peakBac(runBacSimulation([drink(28, t0)], p));
    assert.ok(peak28 > peak14, `28g peak (${peak28}) should exceed 14g peak (${peak14})`);
});

test('runBacSimulation: empty stomach peaks earlier than a full stomach', () => {
    const t0 = 1_700_000_000_000;
    const p = baseSimProfile();
    const empty = runBacSimulation([drink(28, t0, { stomach: 'empty', duration: 0 })], p);
    const full = runBacSimulation([drink(28, t0, { stomach: 'full', duration: 0 })], p);
    assert.ok(peakIndex(empty) < peakIndex(full), 'faster absorption (empty) peaks sooner');
});

test('runBacSimulation: heavier body -> lower peak BAC', () => {
    const t0 = 1_700_000_000_000;
    const light = peakBac(runBacSimulation([drink(28, t0)], baseSimProfile()));
    const heavy = peakBac(runBacSimulation([drink(28, t0)], { ...baseSimProfile(), weight: 120 }));
    assert.ok(heavy < light, `heavier person peak (${heavy}) should be below lighter (${light})`);
});

// --- calculateScientificPacingInterval ---
test('calculateScientificPacingInterval: returns a sane interval (multiple of 5 within bounds)', () => {
    setBaselineProfile();
    const iv = calculateScientificPacingInterval();
    assert.strictEqual(typeof iv, 'number');
    assert.ok(iv >= 30 && iv <= 360, `interval ${iv} within [30, 360]`);
    assert.ok(iv % 5 === 0 || iv === 180, 'interval is on the 5-minute search grid');
});

test('calculateScientificPacingInterval: a higher BAC limit allows a shorter interval', () => {
    setBaselineProfile({ targetBacLimit: 0.04 });
    const strict = calculateScientificPacingInterval();
    setBaselineProfile({ targetBacLimit: 0.08 });
    const lax = calculateScientificPacingInterval();
    assert.ok(lax <= strict, `lax limit interval (${lax}) should be <= strict (${strict})`);
});

// --- formatCountdownClock (the new glanceable countdown) ---
test('formatCountdownClock: m:ss under an hour, h:mm:ss at/over an hour', () => {
    assert.strictEqual(formatCountdownClock(5_000), '0:05');
    assert.strictEqual(formatCountdownClock(65_000), '1:05');
    assert.strictEqual(formatCountdownClock((2 * 60 + 5) * 1000), '2:05');
    assert.strictEqual(formatCountdownClock(3_600_000), '1:00:00');
    assert.strictEqual(formatCountdownClock((1 * 3600 + 23 * 60 + 45) * 1000), '1:23:45');
});

test('formatCountdownClock: non-positive durations render as 0:00', () => {
    assert.strictEqual(formatCountdownClock(0), '0:00');
    assert.strictEqual(formatCountdownClock(-1000), '0:00');
});
