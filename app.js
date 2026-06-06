// SoberPace - App Logic & BAC Simulation Engine

// --- STATE MANAGEMENT ---
let profile = {
    gender: 'male',
    age: 40,
    weight: 125, // default weight
    weightUnit: 'lbs', // 'lbs' or 'kg'
    height: 172, // default height
    heightUnit: 'cm', // 'cm' or 'in'
    targetBacLimit: 0.060, // 0.06% BAC
    pacingTime: 60, // 60 minutes standard spacing
    pacingMode: 'auto', // 'auto' or 'manual'
    globalStomach: 'normal', // empty, normal, full
    decayRate: 0.015 // 0.015% BAC per hour
};

let drinks = []; // Current session drinks
let archives = []; // Past archived sessions
let currentTab = 'tab-dashboard';
let timerInterval = null;

// --- GLANCEABLE COUNTDOWN STATE (tab title / app badge / ready notification) ---
let glance = {
    readyAt: null,   // ms timestamp when the next drink becomes safe; null = no active session
    notified: true,  // whether the "ready" alert already fired for the current window (true = suppress)
};
let swRegistration = null; // service worker registration, used for background notifications
const DEFAULT_TITLE = 'SoberPace - 实时酒精代谢与控速助手';

// --- UNIT CONVERSIONS ---
function getWeightInKg() {
    if (profile.weightUnit === 'lbs') {
        return profile.weight / 2.20462;
    }
    return profile.weight;
}

function getHeightInCm() {
    if (profile.heightUnit === 'in') {
        return profile.height * 2.54;
    }
    return profile.height;
}

// --- BAC UNIT FORMATTING HELPER ---
function getBacDisplayValue(bacVal) {
    if (localStorage.getItem('soberpace_bac_unit') === 'mg_pct') {
        return (bacVal * 1000).toFixed(1) + ' mg%';
    }
    return bacVal.toFixed(3) + '%';
}

function getBacUnitLabel() {
    if (localStorage.getItem('soberpace_bac_unit') === 'mg_pct') {
        return ' mg%';
    }
    return '%';
}

// --- WATSON FORMULA FOR BODY WATER & WIDMARK CONSTANT r ---
function calculateWatsonR() {
    const wKg = getWeightInKg();
    const hCm = getHeightInCm();
    const age = profile.age;
    
    let tbw = 0;
    if (profile.gender === 'male') {
        tbw = 2.447 - (0.09156 * age) + (0.1074 * hCm) + (0.3362 * wKg);
    } else {
        // Female Watson formula
        tbw = -2.097 + (0.1069 * hCm) + (0.2466 * wKg);
    }
    
    // Blood is roughly 80% water. r = TBW / (0.8 * Weight)
    const r = tbw / (0.8 * wKg);
    
    // Safety boundaries to avoid anomalous mathematical calculation errors
    return Math.max(0.4, Math.min(0.9, r));
}

// Get absorption constant ka (per hour) based on stomach fullness
function getKa(stomachType) {
    const type = stomachType === 'default' ? profile.globalStomach : stomachType;
    switch (type) {
        case 'empty': return 4.0; // 30 min peak
        case 'full': return 1.2;  // 75 min peak
        case 'normal':
        default:
            return 2.5; // 45 min peak
    }
}

// Calculate recommended pacing interval (in minutes) based on absorption rate and target BAC limit.
// We simulate drinking standard drinks (14g, 25 minutes duration) at intervals of intervalMins.
// We search from 30 minutes to 360 minutes in steps of 5.
// The first interval that doesn't exceed the target limit is the safe pacing interval.
function calculateScientificPacingInterval() {
    const w = getWeightInKg();
    const r = calculateWatsonR();
    const ka = getKa('default');
    const beta = profile.decayRate;
    const limit = profile.targetBacLimit;

    const stdGrams = 14.0;
    const drinkDurationHours = 25 / 60; // 25 minutes duration

    for (let intervalMins = 30; intervalMins <= 360; intervalMins += 5) {
        // Run a simulation of drinking standard drinks spaced by intervalMins
        // We simulate for 6 hours (360 minutes)
        const simMinutes = 360;
        let currentBac = 0;
        let absorbedGramsArray = new Array(simMinutes + 1).fill(0);
        let maxBac = 0;
        
        let drinkTimes = [];
        for (let t = 0; t < simMinutes; t += intervalMins) {
            drinkTimes.push(t);
        }
        
        for (let m = 0; m <= simMinutes; m++) {
            let totalAbsorbed = 0;
            for (let d = 0; d < drinkTimes.length; d++) {
                const drinkTimeMins = drinkTimes[d];
                if (m >= drinkTimeMins) {
                    const dtHours = (m - drinkTimeMins) / 60;
                    const T = drinkDurationHours;
                    
                    let absorbed = 0;
                    if (dtHours <= T) {
                        absorbed = stdGrams * (dtHours / T - (1 - Math.exp(-ka * dtHours)) / (ka * T));
                    } else {
                        const term = (Math.exp(ka * T) - 1) / (ka * T);
                        absorbed = stdGrams * (1 - term * Math.exp(-ka * dtHours));
                    }
                    totalAbsorbed += absorbed;
                }
            }
            
            let deltaAbsorbed = 0;
            if (m === 0) {
                deltaAbsorbed = totalAbsorbed;
            } else {
                deltaAbsorbed = totalAbsorbed - absorbedGramsArray[m - 1];
            }
            absorbedGramsArray[m] = totalAbsorbed;
            
            const bacAdded = deltaAbsorbed / (w * r * 10);
            const rawBac = currentBac + bacAdded;
            const clearancePerMinute = beta / 60;
            currentBac = Math.max(0, rawBac - clearancePerMinute);
            
            if (currentBac > maxBac) {
                maxBac = currentBac;
            }
        }
        
        if (maxBac <= limit) {
            return intervalMins;
        }
    }
    return 180; // Fallback maximum limit
}

// Update the explanation card for pacing interval calculation
function updatePacingExplanation() {
    const explainBox = document.getElementById('pacing-explain-box');
    if (!explainBox) return;

    const w = getWeightInKg();
    const r = calculateWatsonR();
    const ka = getKa('default');
    const beta = profile.decayRate;
    const limit = profile.targetBacLimit;

    // Widmark delta BAC for standard drink (14g)
    const deltaBac = 14.0 / (w * r * 10);

    const displayLimit = getBacDisplayValue(limit);
    const displayDelta = getBacDisplayValue(deltaBac);
    const displayBeta = (localStorage.getItem('soberpace_bac_unit') === 'mg_pct') ? `-${(beta * 1000).toFixed(1)} mg%/时` : `-${beta.toFixed(3)}%/时`;

    explainBox.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 5px; color: var(--accent-purple); display: flex; align-items: center; gap: 4px;">🔬 智能计算原理与参数拆解</div>
        <p style="margin: 0 0 6px 0; font-size: 11.5px; color: var(--text-secondary);">系统连续模拟饮用标准杯（14g 纯酒精，相当于 355ml / 12oz 5% 啤酒）的代谢曲线，以寻找能保证您的 BAC 峰值低于安全上限 <strong>${displayLimit}</strong> 的安全物理间隔。</p>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; border-top: 1px solid rgba(255, 255, 255, 0.06); padding-top: 6px; font-family: monospace; font-size: 11.5px;">
            <div>• 单杯 BAC 增幅: <span style="color: var(--accent-purple); font-weight: bold;">+${displayDelta}</span></div>
            <div>• 酒精消除率 (β): <span style="color: var(--accent-purple); font-weight: bold;">${displayBeta}</span></div>
            <div>• 胃吸收速率 (Ka): <span style="color: var(--text-primary);">${ka.toFixed(1)}/小时</span></div>
            <div>• 胃部吸收状态: <span style="color: var(--text-primary);">${profile.globalStomach === 'empty' ? '空腹(极快)' : profile.globalStomach === 'full' ? '饱腹(缓慢)' : '正常'}</span></div>
        </div>
        <div style="margin-top: 6px; font-size: 10.5px; color: var(--text-muted); line-height: 1.4;">
            * 胃部饱腹度影响吸收峰值的时间与高度，体重与性别决定单杯带来的 BAC 爬升上限。
        </div>
    `;
}

// Calculate ethanol mass in grams
function calculateAlcoholGrams(volMl, abvPct) {
    return volMl * (abvPct / 100) * 0.789;
}

// Translate alcohol grams to standard US drinks (1 standard drink = 14 grams of ethanol)
function gramsToStandardDrinks(grams) {
    return grams / 14.0;
}

// Formats a millisecond timestamp as a clean clock time prefix (e.g. "今天 14:26" or "明天 02:15")
function formatClockTime(timeMs, nowMs) {
    const d = new Date(timeMs);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const timeStr = `${hh}:${mm}`;
    
    const dDate = new Date(timeMs).setHours(0,0,0,0);
    const nowDate = new Date(nowMs).setHours(0,0,0,0);
    const oneDay = 24 * 3600 * 1000;
    
    if (dDate === nowDate) {
        return `今天 ${timeStr}`;
    } else if (dDate === nowDate + oneDay) {
        return `明天 ${timeStr}`;
    } else {
        return `${d.getMonth() + 1}月${d.getDate()}日 ${timeStr}`;
    }
}

// --- SIMULATION ENGINE ---
// Simulates BAC minute-by-minute starting from the earliest drink
// Profile parameters are passed in to allow running hypothetical simulations
function runBacSimulation(drinksList, simProfile) {
    if (drinksList.length === 0) {
        return [];
    }

    const wKg = (simProfile.weightUnit === 'lbs') ? simProfile.weight / 2.20462 : simProfile.weight;
    const hCm = (simProfile.heightUnit === 'in') ? simProfile.height * 2.54 : simProfile.height;
    
    // Calculate Watson r factor
    let tbw = 0;
    if (simProfile.gender === 'male') {
        tbw = 2.447 - (0.09156 * simProfile.age) + (0.1074 * hCm) + (0.3362 * wKg);
    } else {
        tbw = -2.097 + (0.1069 * hCm) + (0.2466 * wKg);
    }
    const r = Math.max(0.4, Math.min(0.9, tbw / (0.8 * wKg)));

    // Find simulation timeline boundaries
    const drinkTimes = drinksList.map(d => d.time);
    const firstDrinkTime = Math.min(...drinkTimes);
    const now = Date.now();
    
    // Simulate from first drink to whichever is later: Now + 10 hours, or last drink + 14 hours
    const lastDrinkTime = Math.max(...drinkTimes);
    const startSimTime = firstDrinkTime;
    let endSimTime = Math.max(now + 10 * 3600 * 1000, lastDrinkTime + 14 * 3600 * 1000);
    
    const minutesToSimulate = Math.ceil((endSimTime - startSimTime) / (60 * 1000));
    
    let simTimeline = [];
    let currentBac = 0;
    
    // Pre-calculate cumulative absorption curve parameters for efficiency
    const activeDrinks = drinksList.map(d => {
        return {
            time: d.time,
            grams: d.alcoholGrams,
            ka: getKa(d.stomach || simProfile.globalStomach),
            duration: d.duration || 0
        };
    });

    // Step minute-by-minute
    for (let m = 0; m <= minutesToSimulate; m++) {
        const simTime = startSimTime + m * 60 * 1000;
        
        // Calculate total alcohol absorbed from all drinks up to this minute
        let totalAbsorbedGrams = 0;
        for (let i = 0; i < activeDrinks.length; i++) {
            const drink = activeDrinks[i];
            if (simTime >= drink.time) {
                const dtHours = (simTime - drink.time) / (3600 * 1000);
                const ka = drink.ka;
                const T = (drink.duration || 0) / 60; // duration in hours
                
                let absorbed = 0;
                if (T <= 0.0001) {
                    // Instant absorption model
                    absorbed = drink.grams * (1 - Math.exp(-ka * dtHours));
                } else {
                    // Double-compartment absorption model (Linear Ingestion -> Stomach -> Blood)
                    if (dtHours <= T) {
                        // During ingestion
                        absorbed = drink.grams * (dtHours / T - (1 - Math.exp(-ka * dtHours)) / (ka * T));
                    } else {
                        // After ingestion is complete
                        const term = (Math.exp(ka * T) - 1) / (ka * T);
                        absorbed = drink.grams * (1 - term * Math.exp(-ka * dtHours));
                    }
                }
                totalAbsorbedGrams += absorbed;
            }
        }

        // Calculate delta absorbed from previous minute
        let deltaAbsorbed = 0;
        if (m === 0) {
            deltaAbsorbed = totalAbsorbedGrams;
        } else {
            deltaAbsorbed = totalAbsorbedGrams - simTimeline[m - 1].absorbedGrams;
        }

        // BAC (%) change = grams / (bodyWeightKg * r * 10)
        const bacAdded = deltaAbsorbed / (wKg * r * 10);
        let rawBac = currentBac + bacAdded;

        // Apply constant metabolism clearance (decayRate per hour, translated to per minute)
        const clearancePerMinute = simProfile.decayRate / 60;
        currentBac = Math.max(0, rawBac - clearancePerMinute);

        simTimeline.push({
            time: simTime,
            bac: currentBac,
            absorbedGrams: totalAbsorbedGrams
        });
    }

    // Shrink simulation if BAC returns to zero early, leaving a small buffer
    let lastNonZeroIdx = 0;
    for (let m = simTimeline.length - 1; m >= 0; m--) {
        if (simTimeline[m].bac > 0) {
            lastNonZeroIdx = m;
            break;
        }
    }
    // Keep at least until Now + 4 hours or peak + 2 hours
    const minEndIndex = Math.ceil((Math.max(now + 4 * 3600 * 1000, lastDrinkTime + 4 * 3600 * 1000) - startSimTime) / (60 * 1000));
    const finalIndex = Math.max(lastNonZeroIdx + 60, minEndIndex); // Add 60 minutes trailing buffer
    
    return simTimeline.slice(0, Math.min(simTimeline.length, finalIndex));
}

// --- ENGINE RE-CALCULATION & METRIC EXTRACTION ---
function updateMetricsAndForecast() {
    const now = Date.now();
    syncBadge();
    
    // Update disclaimer units dynamically
    const usLimitEl = document.getElementById('disclaimer-us-limit');
    const utahLimitEl = document.getElementById('disclaimer-utah-limit');
    if (usLimitEl) {
        usLimitEl.textContent = getBacDisplayValue(0.08);
    }
    if (utahLimitEl) {
        utahLimitEl.textContent = getBacDisplayValue(0.05);
    }
    
    // Update dynamic target BAC limit marker on gauge and legend based on fixed max scale (0.150% BAC)
    const limit = profile.targetBacLimit;
    const maxBac = 0.150;
    const limitMarker = document.querySelector('.gauge-limit-marker');
    if (limitMarker) {
        const pct = limit / maxBac;
        const gapLength = pct * 534;
        const dashLength = 534 - gapLength;
        limitMarker.style.strokeDasharray = `${dashLength} ${gapLength}`;
        limitMarker.style.strokeDashoffset = dashLength;
    }
    
    // Update driving limit indicator position dynamically
    const driveMarker = document.querySelector('.gauge-drive-marker');
    if (driveMarker) {
        const driveLimit = 0.08;
        const drivePos = (driveLimit / maxBac) * 534;
        driveMarker.style.strokeDasharray = `4 530`;
        driveMarker.style.strokeDashoffset = 534 - (drivePos - 2);
    }
    
    const legendStartEl = document.getElementById('gauge-legend-start');
    if (legendStartEl) {
        legendStartEl.textContent = `绿色起点: ${getBacDisplayValue(0)} (清醒)`;
    }
    const legendDriveEl = document.getElementById('gauge-legend-drive');
    if (legendDriveEl) {
        legendDriveEl.textContent = `驾车警告: ${getBacDisplayValue(0.08)} (DUI)`;
    }
    const legendLimitEl = document.getElementById('gauge-legend-limit');
    if (legendLimitEl) {
        legendLimitEl.textContent = `红线刻度: 超过 ${getBacDisplayValue(limit)} (超标)`;
    }
    const chartLegendLimitEl = document.getElementById('legend-limit-val');
    if (chartLegendLimitEl) {
        chartLegendLimitEl.textContent = getBacDisplayValue(limit);
    }
    const chartLegendDriveEl = document.getElementById('legend-drive-val');
    if (chartLegendDriveEl) {
        chartLegendDriveEl.textContent = getBacDisplayValue(0.08);
    }
    
    // Clear display if no drinks logged
    if (drinks.length === 0) {
        document.getElementById('bac-value').textContent = getBacDisplayValue(0);
        document.getElementById('bac-status').className = 'bac-status-text status-safe';
        document.getElementById('bac-status').textContent = '安全状态';
        document.getElementById('stat-sober-time').textContent = '随时';
        document.getElementById('stat-safe-time').textContent = '当前安全';
        
        const safeTimeLabel = document.getElementById('stat-safe-time-label');
        if (safeTimeLabel) safeTimeLabel.textContent = `降至安全线(${getBacDisplayValue(limit)})`;
        const driveTimeLabel = document.getElementById('stat-drive-time-label');
        if (driveTimeLabel) driveTimeLabel.textContent = `美国驾车线 (${getBacDisplayValue(0.08)})`;

        document.getElementById('stat-peak-bac').textContent = getBacDisplayValue(0);
        document.getElementById('stat-drive-time').textContent = `安全 (低于${getBacDisplayValue(0.08)})`;
        document.getElementById('stat-total-drinks').textContent = '0 标准杯';
        document.getElementById('stat-total-grams').textContent = '0.0 克';
        
        // Circular gauge reset
        const circle = document.getElementById('gauge-progress');
        circle.style.strokeDashoffset = 534; // 0% progress
        circle.style.stroke = 'var(--accent-purple)';
        circle.style.filter = 'drop-shadow(0 0 8px var(--accent-glow-purple))';
        
        // Pacing advice reset
        const adviceCard = document.getElementById('advice-card');
        adviceCard.className = 'card advice-card state-safe';
        document.getElementById('advice-countdown').textContent = '随时可以';
        document.getElementById('advice-description').textContent = '当前血液酒精浓度为零。请记住：在喝下一杯酒之前，请点击下方进行喝前记录。建议每杯间隔一小时。';
        document.getElementById('advice-progress-fill').style.width = '100%';
        
        // Clear chart
        drawChart([]);

        // No active session: reset glanceable countdown outputs
        glance.readyAt = null;
        renderGlance(now);
        return;
    }

    // Run active simulation
    const timeline = runBacSimulation(drinks, profile);
    if (timeline.length === 0) return;

    // 1. Current BAC
    // Find timeline step closest to current time
    let currentStep = timeline[0];
    let minDiff = Math.abs(currentStep.time - now);
    for (let i = 1; i < timeline.length; i++) {
        const diff = Math.abs(timeline[i].time - now);
        if (diff < minDiff) {
            minDiff = diff;
            currentStep = timeline[i];
        }
    }
    const currentBac = currentStep.bac;
    
    // Format BAC text
    document.getElementById('bac-value').textContent = getBacDisplayValue(currentBac);
    
    // BAC Gauge color and fill update (scaled to fixed max BAC of 0.150% for visual alignment with the red limit marker)
    const circle = document.getElementById('gauge-progress');
    const progressPercent = currentBac / maxBac;
    const fillOffset = Math.max(0, 534 - (Math.min(1.0, progressPercent) * 534));
    circle.style.strokeDashoffset = fillOffset;

    // Status classes
    const statusTextEl = document.getElementById('bac-status');
    if (currentBac < 0.0005) {
        statusTextEl.textContent = '安全状态';
        statusTextEl.className = 'bac-status-text status-safe';
        circle.style.stroke = 'var(--color-safe)';
        circle.style.filter = 'drop-shadow(0 0 8px var(--color-safe-glow))';
    } else if (currentBac < limit * 0.7) {
        statusTextEl.textContent = '感觉微醺';
        statusTextEl.className = 'bac-status-text status-safe';
        circle.style.stroke = 'var(--color-safe)';
        circle.style.filter = 'drop-shadow(0 0 8px var(--color-safe-glow))';
    } else if (currentBac < limit) {
        statusTextEl.textContent = '接近上限';
        statusTextEl.className = 'bac-status-text status-caution';
        circle.style.stroke = 'var(--color-caution)';
        circle.style.filter = 'drop-shadow(0 0 8px var(--color-caution-glow))';
    } else {
        statusTextEl.textContent = '超出限制！';
        statusTextEl.className = 'bac-status-text status-danger';
        circle.style.stroke = 'var(--color-danger)';
        circle.style.filter = 'drop-shadow(0 0 8px var(--color-danger-glow))';
    }

    // 2. Sober, Safe, and Drive Time Forecasts
    let soberTime = null;
    let safeTime = null;
    let driveTime = null;
    const US_DRIVE_LIMIT = 0.08;

    // Loop forward from now
    for (let i = 0; i < timeline.length; i++) {
        const step = timeline[i];
        if (step.time >= now) {
            // Find when BAC drops below limit and stays there
            if (safeTime === null) {
                let remainsBelowLimit = true;
                for (let j = i; j < timeline.length; j++) {
                    if (timeline[j].bac >= limit) {
                        remainsBelowLimit = false;
                        break;
                    }
                }
                if (remainsBelowLimit) {
                    safeTime = step.time;
                }
            }
            // Find when BAC drops below US drive limit (0.08) and stays there
            if (driveTime === null) {
                let remainsBelowDriveLimit = true;
                for (let j = i; j < timeline.length; j++) {
                    if (timeline[j].bac >= US_DRIVE_LIMIT) {
                        remainsBelowDriveLimit = false;
                        break;
                    }
                }
                if (remainsBelowDriveLimit) {
                    driveTime = step.time;
                }
            }
            // Find when sober
            if (soberTime === null) {
                let remainsSober = true;
                for (let j = i; j < timeline.length; j++) {
                    if (timeline[j].bac > 0) {
                        remainsSober = false;
                        break;
                    }
                }
                if (remainsSober) {
                    soberTime = step.time;
                }
            }
        }
    }

    // Update labels dynamic text based on selected unit
    const safeTimeLabel = document.getElementById('stat-safe-time-label');
    if (safeTimeLabel) safeTimeLabel.textContent = `降至安全线(${getBacDisplayValue(limit)})`;
    const driveTimeLabel = document.getElementById('stat-drive-time-label');
    if (driveTimeLabel) driveTimeLabel.textContent = `美国驾车线 (${getBacDisplayValue(US_DRIVE_LIMIT)})`;

    // Format sober forecast
    if (currentBac < 0.0005) {
        document.getElementById('stat-sober-time').textContent = '当前清醒';
    } else if (soberTime) {
        document.getElementById('stat-sober-time').textContent = formatClockTime(soberTime, now);
    } else {
        document.getElementById('stat-sober-time').textContent = '待计算';
    }

    // Format safe limit forecast
    if (currentBac < limit) {
        document.getElementById('stat-safe-time').textContent = `低于${getBacDisplayValue(limit)}`;
    } else if (safeTime) {
        document.getElementById('stat-safe-time').textContent = formatClockTime(safeTime, now);
    } else {
        document.getElementById('stat-safe-time').textContent = '待计算';
    }

    // Format US drive limit forecast
    if (currentBac < US_DRIVE_LIMIT) {
        document.getElementById('stat-drive-time').textContent = `安全 (低于${getBacDisplayValue(US_DRIVE_LIMIT)})`;
    } else if (driveTime) {
        document.getElementById('stat-drive-time').textContent = formatClockTime(driveTime, now);
    } else {
        document.getElementById('stat-drive-time').textContent = '待计算';
    }

    // 3. Peak BAC
    let peakStep = timeline[0];
    for (let i = 1; i < timeline.length; i++) {
        if (timeline[i].bac > peakStep.bac) {
            peakStep = timeline[i];
        }
    }
    const peakTimeStr = formatClockTime(peakStep.time, now);
    document.getElementById('stat-peak-bac').textContent = `${getBacDisplayValue(peakStep.bac)} (${peakTimeStr})`;

    // 4. Total standard drinks & pure alcohol grams
    const totalGrams = drinks.reduce((sum, d) => sum + d.alcoholGrams, 0);
    const standardDrinks = gramsToStandardDrinks(totalGrams);
    document.getElementById('stat-total-drinks').textContent = standardDrinks.toFixed(1) + ' 标准杯';
    document.getElementById('stat-total-grams').textContent = totalGrams.toFixed(1) + ' 克';

    // 5. Pacing and Next Drink Advice Scan
    updatePacingAdvice(currentBac, now);

    // 6. Draw the BAC trend chart
    drawChart(timeline);

    // 7. Update glanceable countdown (tab title / app badge / ready notification)
    renderGlance(now);
}

// Calculates next drink pacing instructions
function updatePacingAdvice(currentBac, now) {
    if (drinks.length === 0) return;

    // Check last drink time
    const drinkTimes = drinks.map(d => d.time);
    const lastDrinkTime = Math.max(...drinkTimes);
    const timeSinceLastDrinkMs = now - lastDrinkTime;
    const pacingTimeMs = profile.pacingTime * 60 * 1000;
    
    // Determine target hypothetical drink properties (match last drink specs)
    const lastDrink = drinks[drinks.length - 1];
    const testVol = lastDrink ? lastDrink.vol : 330;
    const testAbv = lastDrink ? lastDrink.abv : 5.0;
    const testGrams = lastDrink ? lastDrink.alcoholGrams : 14.0;
    const testStomach = lastDrink ? lastDrink.stomach : profile.globalStomach;
    const testDuration = lastDrink ? (lastDrink.duration !== undefined ? lastDrink.duration : 25) : 25;
    const testName = lastDrink ? lastDrink.name : "标准饮品";

    // 1. Scan forward in time to check when it is metabolically safe to have a new matching drink
    // Metabolic safety: adding a drink at time T does not cause the projected future peak to exceed targetLimit.
    let safeMetabolicTime = now;
    const scanStepMs = 5 * 60 * 1000; // scan every 5 minutes
    const maxScanMs = 8 * 3600 * 1000; // max 8 hours scan
    
    for (let offset = 0; offset <= maxScanMs; offset += scanStepMs) {
        const testTime = now + offset;
        
        // Hypothetical drink consumed at testTime
        const testDrink = {
            id: 9999,
            name: testName,
            vol: testVol,
            abv: testAbv,
            alcoholGrams: testGrams,
            time: testTime,
            stomach: testStomach,
            duration: testDuration
        };
        
        const tempDrinks = [...drinks, testDrink];
        const tempTimeline = runBacSimulation(tempDrinks, profile);
        
        // Find hypothetical peak BAC
        let hypoPeak = 0;
        for (let i = 0; i < tempTimeline.length; i++) {
            if (tempTimeline[i].bac > hypoPeak) {
                hypoPeak = tempTimeline[i].bac;
            }
        }
        
        if (hypoPeak <= profile.targetBacLimit) {
            safeMetabolicTime = testTime;
            break;
        }
        
        // If we reached the end and it's still not safe, push safe time forward
        if (offset === maxScanMs) {
            safeMetabolicTime = now + maxScanMs;
        }
    }

    // 2. Final recommended next drink time is the maximum of:
    //    - Time when metabolic safety threshold is cleared (so adding a drink won't cross 0.060%)
    //    - Time when physical pacing limit is cleared (e.g. 60 minutes after last drink)
    const physicalPacingTime = lastDrinkTime + pacingTimeMs;
    const finalRecommendedTime = Math.max(safeMetabolicTime, physicalPacingTime);

    // Expose the recommended time as the single source of truth for the glanceable countdown
    glance.readyAt = finalRecommendedTime;

    const adviceCard = document.getElementById('advice-card');
    const countdownEl = document.getElementById('advice-countdown');
    const descEl = document.getElementById('advice-description');
    const fillEl = document.getElementById('advice-progress-fill');
    
    if (now >= finalRecommendedTime) {
        // Safe to drink now
        adviceCard.className = 'card advice-card state-safe';
        countdownEl.textContent = '随时可以';
        fillEl.style.width = '100%';
        
        const nextDrinkLimitHypo = testDrinkPeakNow();
        if (nextDrinkLimitHypo > profile.targetBacLimit) {
            // Highly unlikely due to metabolic scan, but safeguard alert
            adviceCard.className = 'card advice-card state-caution';
            descEl.textContent = `您可以喝下一杯，但由于代谢原因，现在喝可能会在晚些时候推高 BAC。建议继续放缓速度。`;
        } else {
            const drinkNameDisplay = lastDrink ? lastDrink.name : "下一杯";
            descEl.textContent = `体内代谢已平稳，且距离上一杯已超 ${profile.pacingTime} 分钟。若想继续饮用${drinkNameDisplay}，请在喝之前立刻点击记录，以保障记录的连续性。`;
        }
    } else {
        // Not safe yet - show countdown and warnings
        const diffMs = finalRecommendedTime - now;
        
        // Update countdown text
        const totalSecs = Math.ceil(diffMs / 1000);
        const hrs = Math.floor(totalSecs / 3600);
        const mins = Math.floor((totalSecs % 3600) / 60);
        const secs = totalSecs % 60;
        if (hrs > 0) {
            countdownEl.textContent = `${hrs}小时 ${mins}分 ${secs.toString().padStart(2, '0')}秒`;
        } else {
            countdownEl.textContent = `${mins}分 ${secs.toString().padStart(2, '0')}秒`;
        }
        
        // Progress fill ratio
        let progressPct = 0;
        if (finalRecommendedTime > lastDrinkTime) {
            const totalDuration = finalRecommendedTime - lastDrinkTime;
            const elapsed = now - lastDrinkTime;
            progressPct = Math.min(100, Math.max(0, (elapsed / totalDuration) * 100));
        }
        fillEl.style.width = `${progressPct}%`;

        // Style warnings based on whether it is pacing restriction or metabolic restriction
        if (finalRecommendedTime === physicalPacingTime) {
            // Under pacing restriction (drink spacing)
            adviceCard.className = 'card advice-card state-caution';
            const pacingLeftMins = Math.ceil((physicalPacingTime - now) / (60 * 1000));
            descEl.textContent = `控速提示：您的代谢情况允许饮用下一杯，但为保证酒意不上头并避免第二天头痛，请遵守每杯至少间隔 ${profile.pacingTime} 分钟的规则。请再等待约 ${pacingLeftMins} 分钟。`;
        } else {
            // Under metabolic restriction (BAC limit)
            adviceCard.className = 'card advice-card state-danger';
            const waitTimeStr = formatClockTime(finalRecommendedTime, now);
            const drinkNameDisplay = lastDrink ? lastDrink.name : "标准酒精饮品";
            descEl.textContent = `警告：若当前立即喝下一杯${drinkNameDisplay}，您未来的 BAC 峰值将超出预设的 ${getBacDisplayValue(profile.targetBacLimit)} 安全线，大幅增加第二天宿醉风险。请在 ${waitTimeStr} 之前暂停饮酒。`;
        }
    }
}

// Fast check: if a drink is added right now, what is the peak BAC?
function testDrinkPeakNow() {
    const lastDrink = drinks.length > 0 ? drinks[drinks.length - 1] : null;
    const testVol = lastDrink ? lastDrink.vol : 330;
    const testAbv = lastDrink ? lastDrink.abv : 5.0;
    const testGrams = lastDrink ? lastDrink.alcoholGrams : 14.0;
    const testStomach = lastDrink ? lastDrink.stomach : profile.globalStomach;
    const testDuration = lastDrink ? (lastDrink.duration !== undefined ? lastDrink.duration : 25) : 25;
    const testName = lastDrink ? lastDrink.name : "测试";

    const testDrink = {
        id: 9999,
        name: testName,
        vol: testVol,
        abv: testAbv,
        alcoholGrams: testGrams,
        time: Date.now(),
        stomach: testStomach,
        duration: testDuration
    };
    const tempTimeline = runBacSimulation([...drinks, testDrink], profile);
    let peak = 0;
    for (let i = 0; i < tempTimeline.length; i++) {
        if (tempTimeline[i].bac > peak) {
            peak = tempTimeline[i].bac;
        }
    }
    return peak;
}


// --- GLANCEABLE COUNTDOWN: tab title, PWA app badge, and ready notification ---

// Whether the user has opted into "ready" push notifications (per-device, like the unit setting)
function notificationsEnabled() {
    return localStorage.getItem('soberpace_notify') === '1';
}

// Set or clear the PWA app-icon badge (installed PWA on supported platforms only)
function setGlanceBadge(count) {
    if (!('setAppBadge' in navigator)) return;
    try {
        if (count > 0) {
            navigator.setAppBadge(count).catch(() => {});
        } else {
            navigator.clearAppBadge().catch(() => {});
        }
    } catch (e) {
        /* Badging API unsupported – ignore */
    }
}

// Fire a system notification when it becomes safe to have the next drink
function fireReadyNotification() {
    if (!notificationsEnabled()) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const title = '🍷 可以喝下一杯了';
    const options = {
        body: '体内代谢已降至安全线，距上一杯也已满间隔。想续杯请记得先点击记录。',
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: 'soberpace-next-drink',
        renotify: true,
    };
    try {
        // Prefer the service worker so the alert shows even when the tab is in the background
        if (swRegistration && swRegistration.showNotification) {
            swRegistration.showNotification(title, options);
        } else {
            new Notification(title, options);
        }
    } catch (e) {
        /* ignore */
    }
}

// Render the countdown to all glanceable outputs. Reads glance.readyAt (set by updatePacingAdvice).
function renderGlance(now) {
    // No active session – reset everything
    if (glance.readyAt === null) {
        document.title = DEFAULT_TITLE;
        setGlanceBadge(0);
        glance.notified = true; // nothing pending, suppress any future stale alert
        return;
    }

    const diffMs = glance.readyAt - now;

    if (diffMs <= 0) {
        // Safe to drink now
        document.title = '✅ 可以喝下一杯了 · SoberPace';
        setGlanceBadge(0);
        if (!glance.notified) {
            fireReadyNotification();
            glance.notified = true;
        }
        return;
    }

    // Still counting down – arm the notification for when it reaches zero
    glance.notified = false;

    document.title = `⏳ ${formatCountdownClock(diffMs)} · 下一杯`;
    setGlanceBadge(Math.ceil(diffMs / 60000)); // remaining whole minutes
}

// Format a remaining-time duration (ms) as a compact clock string:
// "1:23:45" when there are hours, otherwise "2:05". Non-positive -> "0:00".
function formatCountdownClock(diffMs) {
    if (diffMs <= 0) return '0:00';
    const totalSecs = Math.ceil(diffMs / 1000);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    return h > 0
        ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
        : `${m}:${s.toString().padStart(2, '0')}`;
}


// --- SVG LINE CHART DRAWING ---
function drawChart(timeline) {
    const chartSvg = document.getElementById('bac-svg-chart');
    const gridGroup = document.getElementById('chart-grid');
    const chartPath = document.getElementById('chart-path');
    const chartArea = document.getElementById('chart-area');
    const currentTimeLine = document.getElementById('chart-current-time-line');
    const currentDot = document.getElementById('chart-current-dot');
    const limitLine = document.getElementById('chart-limit-line');
    const xLabelsContainer = document.getElementById('chart-x-labels');

    // Default dimensions
    const width = 500;
    const height = 200;

    // Clean dynamic elements
    gridGroup.innerHTML = '';

    if (timeline.length === 0) {
        chartPath.setAttribute('d', '');
        chartArea.setAttribute('d', '');
        currentTimeLine.setAttribute('x1', '0');
        currentTimeLine.setAttribute('x2', '0');
        currentDot.setAttribute('cx', '-10');
        currentDot.setAttribute('cy', '-10');
        limitLine.setAttribute('y1', '100');
        limitLine.setAttribute('y2', '100');
        const driveLine = document.getElementById('chart-drive-line');
        if (driveLine) {
            driveLine.setAttribute('y1', '100');
            driveLine.setAttribute('y2', '100');
        }
        
        // Reset labels
        xLabelsContainer.innerHTML = '<span>现在</span><span>+2小时</span><span>+4小时</span><span>+6小时</span><span>+8小时</span>';
        return;
    }

    const now = Date.now();
    const times = timeline.map(pt => pt.time);
    const baseStartTime = drinks.length > 0 ? drinks[0].time : now;
    const startXTime = Math.floor(baseStartTime / (3600 * 1000)) * (3600 * 1000); // Round down to clean hour

    const baseEndTime = Math.max(now + 7 * 3600 * 1000, Math.max(...times));
    let endXTime = Math.ceil(baseEndTime / (3600 * 1000)) * (3600 * 1000); // Round up to clean hour

    // Ensure total duration is a multiple of 4 hours so that the 5 labels (4 intervals) land on clean integer hours
    let totalHours = Math.ceil((endXTime - startXTime) / (3600 * 1000));
    if (totalHours % 4 !== 0) {
        totalHours += (4 - (totalHours % 4));
    }
    endXTime = startXTime + totalHours * 3600 * 1000;
    const totalDuration = endXTime - startXTime;

    // Find BAC limits for Y scaling
    const bacs = timeline.map(pt => pt.bac);
    const maxBac = Math.max(...bacs);
    const yMax = Math.max(0.10, maxBac * 1.25); // Scale Y axis to at least 0.10% so the 0.06% and 0.08% lines are always fully visible

    // Helper functions for coordinate mappings
    function mapX(t) {
        return ((t - startXTime) / totalDuration) * width;
    }
    function mapY(bacVal) {
        return height - (bacVal / yMax) * height;
    }

    // 1. Draw Grid Lines & Y-axis labels
    const yTickSteps = [0.02, 0.04, 0.06, 0.08];
    if (yMax > 0.12) {
        yTickSteps.push(0.12);
    }
    if (yMax > 0.16) {
        yTickSteps.push(0.16);
    }
    
    yTickSteps.forEach(val => {
        const y = mapY(val);
        if (y >= 0 && y <= height) {
            // Draw grid line
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('class', 'grid-line');
            line.setAttribute('x1', '0');
            line.setAttribute('y1', y.toString());
            line.setAttribute('x2', width.toString());
            line.setAttribute('y2', y.toString());
            gridGroup.appendChild(line);

            // Draw text label
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('class', 'grid-label');
            text.setAttribute('x', '5');
            text.setAttribute('y', (y - 4).toString());
            text.textContent = (localStorage.getItem('soberpace_bac_unit') === 'mg_pct') ? (val * 1000).toFixed(0) + ' mg%' : val.toFixed(2) + '%';
            gridGroup.appendChild(text);
        }
    });

    // Draw hourly vertical grid lines
    const hourMs = 3600 * 1000;
    
    xLabelsContainer.innerHTML = '';
    const numLabels = 5;
    const labelSpacing = totalDuration / (numLabels - 1);

    for (let i = 0; i < numLabels; i++) {
        const tLabel = startXTime + i * labelSpacing;
        const x = mapX(tLabel);
        
        // Draw grid line
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('class', 'grid-line');
        line.setAttribute('x1', x.toString());
        line.setAttribute('y1', '0');
        line.setAttribute('x2', x.toString());
        line.setAttribute('y2', height.toString());
        gridGroup.appendChild(line);

        // Add X labels
        const labelSpan = document.createElement('span');
        const diffHours = (tLabel - now) / hourMs;
        if (Math.abs(diffHours) < 0.05) {
            labelSpan.textContent = '现在';
            labelSpan.style.color = 'var(--text-secondary)';
            labelSpan.style.fontWeight = 'bold';
        } else {
            const timeObj = new Date(tLabel);
            labelSpan.textContent = timeObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        xLabelsContainer.appendChild(labelSpan);
    }

    // 2. Adjust Limit Line Y position
    const limitY = mapY(profile.targetBacLimit);
    limitLine.setAttribute('y1', limitY.toString());
    limitLine.setAttribute('y2', limitY.toString());

    const driveLine = document.getElementById('chart-drive-line');
    if (driveLine) {
        const driveY = mapY(0.08);
        driveLine.setAttribute('y1', driveY.toString());
        driveLine.setAttribute('y2', driveY.toString());
    }

    // 3. Build Graph Paths
    let pathD = '';
    let areaD = '';

    // Filter points to fit chart time range and sort
    let chartPoints = timeline
        .filter(pt => pt.time >= startXTime && pt.time <= endXTime)
        .sort((a, b) => a.time - b.time);

    // Prepend a baseline point (BAC = 0) at startXTime if the first data point starts later
    if (chartPoints.length > 0 && chartPoints[0].time > startXTime) {
        chartPoints.unshift({
            time: startXTime,
            bac: 0,
            absorbedGrams: 0
        });
    }

    if (chartPoints.length > 0) {
        // Map first point
        const startX = mapX(chartPoints[0].time);
        const startY = mapY(chartPoints[0].bac);
        pathD = `M ${startX} ${startY}`;
        areaD = `M ${startX} ${height} L ${startX} ${startY}`;

        // Map intermediate points
        for (let i = 1; i < chartPoints.length; i++) {
            const px = mapX(chartPoints[i].time);
            const py = mapY(chartPoints[i].bac);
            pathD += ` L ${px} ${py}`;
            areaD += ` L ${px} ${py}`;
        }
        
        // Close area path
        const endX = mapX(chartPoints[chartPoints.length - 1].time);
        areaD += ` L ${endX} ${height} Z`;
    }

    chartPath.setAttribute('d', pathD);
    chartArea.setAttribute('d', areaD);

    // 4. Update Current Time Line and Dot
    const currentX = mapX(now);
    currentTimeLine.setAttribute('x1', currentX.toString());
    currentTimeLine.setAttribute('x2', currentX.toString());

    // Interpolate BAC at current time to place dot accurately
    let currentBacVal = 0;
    if (timeline.length > 0) {
        // Find closest interval
        let ptA = timeline[0];
        let ptB = timeline[timeline.length - 1];
        
        for (let i = 0; i < timeline.length - 1; i++) {
            if (now >= timeline[i].time && now <= timeline[i+1].time) {
                ptA = timeline[i];
                ptB = timeline[i+1];
                break;
            }
        }
        
        const timeDiff = ptB.time - ptA.time;
        if (timeDiff > 0) {
            const factor = (now - ptA.time) / timeDiff;
            currentBacVal = ptA.bac + factor * (ptB.bac - ptA.bac);
        } else {
            currentBacVal = ptA.bac;
        }
    }

    const dotY = mapY(currentBacVal);
    currentDot.setAttribute('cx', currentX.toString());
    currentDot.setAttribute('cy', dotY.toString());
}

// --- LOCAL STORAGE DATA STORAGE & RETRIEVAL ---
// --- AUTHORIZATION STATE ---
let authToken = localStorage.getItem('soberpace_token') || '';
let loggedInUser = localStorage.getItem('soberpace_username') || '';

// API fetch wrapper with Auth header
async function apiRequest(endpoint, method = 'GET', body = null) {
    const headers = {
        'Content-Type': 'application/json'
    };
    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }

    const config = {
        method,
        headers
    };

    if (body) {
        config.body = JSON.stringify(body);
    }

    try {
        const response = await fetch(endpoint, config);
        const data = await response.json();
        
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                logoutUser();
                throw new Error('您的登录已过期，请重新登录。');
            }
            throw new Error(data.error || 'API请求失败。');
        }
        
        return data;
    } catch (error) {
        console.error(`API Error on ${endpoint}:`, error.message);
        throw error;
    }
}

// --- AUTHENTICATION INTERFACE WIRING ---
let isAuthRegisterMode = false;

function showAuthScreen() {
    const authScreen = document.getElementById('auth-screen');
    if (authScreen) {
        authScreen.classList.add('active');
    }
    
    // Restore form and footer visibility, hide loading spinner
    const authForm = document.getElementById('auth-form');
    const authFooter = document.querySelector('.auth-footer');
    const authLoading = document.getElementById('auth-loading-state');
    const authSubtitle = document.getElementById('auth-subtitle');
    
    if (authForm) authForm.style.display = 'flex';
    if (authFooter) authFooter.style.display = 'block';
    if (authSubtitle) {
        authSubtitle.textContent = isAuthRegisterMode ? '注册并开启生理指标估算' : '多用户酒精浓度代谢与控速助手';
    }
    if (authLoading) authLoading.style.display = 'none';
}

function hideAuthScreen() {
    const authScreen = document.getElementById('auth-screen');
    if (authScreen) {
        authScreen.classList.remove('active');
    }
}

function logoutUser() {
    localStorage.removeItem('soberpace_token');
    localStorage.removeItem('soberpace_username');
    authToken = '';
    loggedInUser = '';
    drinks = [];
    archives = [];
    
    const userBadge = document.getElementById('logged-user-badge');
    if (userBadge) userBadge.textContent = '未登录';
    
    syncBadge();
    updateMetricsAndForecast();
    renderDrinkList();
    renderArchiveList();
    
    const authForm = document.getElementById('auth-form');
    if (authForm) authForm.reset();
    
    showAuthScreen();
}

function initAuthSystem() {
    const toggleBtn = document.getElementById('btn-auth-toggle');
    const authForm = document.getElementById('auth-form');
    const logoutBtn = document.getElementById('btn-logout');
    const regProfileFields = document.getElementById('auth-reg-profile');
    const submitBtn = document.getElementById('btn-auth-submit');
    const errorMsg = document.getElementById('auth-error-msg');
    
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            isAuthRegisterMode = !isAuthRegisterMode;
            if (isAuthRegisterMode) {
                if (regProfileFields) regProfileFields.style.display = 'flex';
                submitBtn.textContent = '创建账户并登录';
                toggleBtn.textContent = '立即登录';
                document.getElementById('auth-subtitle').textContent = '注册并开启生理指标估算';
            } else {
                if (regProfileFields) regProfileFields.style.display = 'none';
                submitBtn.textContent = '立即登录';
                toggleBtn.textContent = '立即注册';
                document.getElementById('auth-subtitle').textContent = '多用户酒精浓度代谢与控速助手';
            }
            if (errorMsg) errorMsg.style.display = 'none';
        });
    }

    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (errorMsg) errorMsg.style.display = 'none';
            
            const username = document.getElementById('auth-user').value.trim();
            const password = document.getElementById('auth-pass').value;
            
            if (!username || !password) {
                if (errorMsg) {
                    errorMsg.style.display = 'block';
                    errorMsg.textContent = '用户名或密码不能为空。';
                }
                return;
            }

            const payload = { username, password };
            
            if (isAuthRegisterMode) {
                payload.gender = document.getElementById('auth-gender').value;
                payload.age = parseInt(document.getElementById('auth-age').value) || 40;
                payload.weight = parseFloat(document.getElementById('auth-weight').value) || 125.0;
                payload.weightUnit = document.getElementById('auth-weight-unit').value;
                payload.height = parseFloat(document.getElementById('auth-height').value) || 172.0;
                payload.heightUnit = document.getElementById('auth-height-unit').value;
            }

            const endpoint = isAuthRegisterMode ? '/api/register' : '/api/login';
            
            try {
                submitBtn.disabled = true;
                submitBtn.textContent = isAuthRegisterMode ? '注册中...' : '登录中...';
                
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                const data = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.error || '登录或注册失败，请检查您的凭证。');
                }
                
                localStorage.setItem('soberpace_token', data.token);
                localStorage.setItem('soberpace_username', data.username);
                authToken = data.token;
                loggedInUser = data.username;
                
                await loadData();
                hideAuthScreen();
                authForm.reset();
            } catch (err) {
                if (errorMsg) {
                    errorMsg.style.display = 'block';
                    errorMsg.textContent = err.message;
                }
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = isAuthRegisterMode ? '创建账户并登录' : '立即登录';
            }
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if (confirm('确认退出当前账号登录吗？')) {
                logoutUser();
            }
        });
    }
}

// --- DATABASE DATA SYNC & RETRIEVAL ---
async function loadData() {
    if (!authToken) {
        showAuthScreen();
        return;
    }

    // Hide input form & toggle button, show loading spinner to prevent PWA login flicker
    const authForm = document.getElementById('auth-form');
    const authFooter = document.querySelector('.auth-footer');
    const authLoading = document.getElementById('auth-loading-state');
    const authSubtitle = document.getElementById('auth-subtitle');
    
    if (authForm) authForm.style.display = 'none';
    if (authFooter) authFooter.style.display = 'none';
    if (authSubtitle) authSubtitle.textContent = '安全同步中...';
    if (authLoading) authLoading.style.display = 'flex';

    try {
        const savedProfile = await apiRequest('/api/profile');
        if (savedProfile) {
            profile = savedProfile;
        }
        
        const savedDrinks = await apiRequest('/api/drinks');
        if (savedDrinks) {
            drinks = savedDrinks;
        }

        const savedArchives = await apiRequest('/api/archives');
        if (savedArchives) {
            archives = savedArchives;
        }
        
        syncProfileToUI();
        updateRBadge();
        updateMetricsAndForecast();
        
        const badge = document.getElementById('logged-user-badge');
        if (badge) badge.textContent = loggedInUser;
        
        hideAuthScreen();
        preselectQuickLogFromLastDrink();
    } catch (err) {
        const errorMsg = document.getElementById('auth-error-msg');
        if (errorMsg) {
            errorMsg.style.display = 'block';
            errorMsg.textContent = err.message || '网络连接失败，请检查后端服务。';
        }
        showAuthScreen();
    }
}

function syncProfileToUI() {
    const genderEl = document.getElementById('profile-gender');
    const ageEl = document.getElementById('profile-age');
    const weightEl = document.getElementById('profile-weight');
    const weightUnitEl = document.getElementById('weight-unit');
    const heightEl = document.getElementById('profile-height');
    const heightUnitEl = document.getElementById('height-unit');
    
    const limitEl = document.getElementById('settings-bac-limit');
    const pacingEl = document.getElementById('settings-pacing-time');
    const stomachEl = document.getElementById('settings-stomach');
    const decayEl = document.getElementById('settings-decay-rate');

    if (genderEl) genderEl.value = profile.gender;
    if (ageEl) ageEl.value = profile.age;
    if (weightEl) weightEl.value = profile.weight;
    if (weightUnitEl) weightUnitEl.value = profile.weightUnit;
    if (heightEl) heightEl.value = profile.height;
    if (heightUnitEl) heightUnitEl.value = profile.heightUnit;
    
    const limitLabelEl = document.querySelector('label[for="settings-bac-limit"]');
    if (limitEl && limitLabelEl) {
        if (localStorage.getItem('soberpace_bac_unit') === 'mg_pct') {
            limitLabelEl.innerHTML = `个人 BAC 目标上限 (mg%) <span class="label-help">超过此值会提示橙色/红色警告。建议控制在 60mg% 以下，以保证第二天无宿醉。</span>`;
            limitEl.setAttribute('step', '1');
            limitEl.setAttribute('min', '10');
            limitEl.setAttribute('max', '300');
            limitEl.value = (profile.targetBacLimit * 1000).toFixed(1);
        } else {
            limitLabelEl.innerHTML = `个人 BAC 目标上限 (%) <span class="label-help">超过此值会提示橙色/红色警告。建议控制在 0.06% 以下，以保证第二天无宿醉。</span>`;
            limitEl.setAttribute('step', '0.005');
            limitEl.setAttribute('min', '0.010');
            limitEl.setAttribute('max', '0.300');
            limitEl.value = profile.targetBacLimit.toFixed(3);
        }
    }
    
    // Set pacing mode radio and calculate interval if in auto mode
    const pacingModeVal = profile.pacingMode || 'auto';
    const radioAuto = document.getElementById('pacing-mode-auto');
    const radioManual = document.getElementById('pacing-mode-manual');
    const autoLabel = document.getElementById('pacing-auto-label');

    if (radioAuto && radioManual) {
        if (pacingModeVal === 'auto') {
            radioAuto.checked = true;
            if (pacingEl) pacingEl.disabled = true;
            const calculatedTime = calculateScientificPacingInterval();
            profile.pacingTime = calculatedTime;
            if (pacingEl) pacingEl.value = calculatedTime;
            if (autoLabel) {
                autoLabel.textContent = `(系统计算: ${calculatedTime}分钟)`;
                autoLabel.style.display = 'inline';
            }
        } else {
            radioManual.checked = true;
            if (pacingEl) pacingEl.disabled = false;
            if (pacingEl) pacingEl.value = profile.pacingTime;
            if (autoLabel) {
                autoLabel.style.display = 'none';
            }
        }
    } else {
        if (pacingEl) pacingEl.value = profile.pacingTime;
    }

    if (stomachEl) stomachEl.value = profile.globalStomach;
    if (decayEl) decayEl.value = profile.decayRate.toFixed(3);
    
    // Bind BAC unit select dropdown
    const unitEl = document.getElementById('settings-bac-unit');
    if (unitEl) {
        unitEl.value = localStorage.getItem('soberpace_bac_unit') || 'pct';
    }
    
    updatePacingExplanation();
}

async function saveData() {
    if (!authToken) return;
    try {
        await apiRequest('/api/profile', 'PUT', profile);
    } catch (err) {
        console.error('Failed to sync profile settings to DB:', err.message);
    }
}

// Update the R label in the Profile page
function updateRBadge() {
    const r = calculateWatsonR();
    document.getElementById('calculated-r').textContent = r.toFixed(3);
}

// --- UI INTERACTIONS & EVENT LISTENERS ---
// Guarded so app.js can be require()'d in Node (e.g. for unit tests) without a DOM.
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        initAuthSystem();
        loadData();
        initPasscodeSystem();
        setupTabNavigation();
        setupDrinkLogging();
        setupSettingsPanel();
        renderDrinkList();
        renderArchiveList();

        // Start live updates (every second for the countdown timer and BAC recalculation)
        updateMetricsAndForecast();
        timerInterval = setInterval(() => {
            updateMetricsAndForecast();
        }, 1000);

        // Initial load sync
        syncBadge();
    });
}

// Sync the visual header badge reflecting active/sober state
function syncBadge() {
    const badge = document.getElementById('session-badge');
    if (drinks.length > 0) {
        badge.innerHTML = '<span class="dot pulse"></span> 记录中';
        badge.style.opacity = '1';
    } else {
        badge.innerHTML = '<span class="dot" style="background-color: var(--text-muted)"></span> 空闲';
        badge.style.opacity = '0.7';
    }
}

// Bottom navigation logic
function setupTabNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const tabContents = document.querySelectorAll('.tab-content');

    function switchTab(item) {
        const targetTab = item.getAttribute('data-tab');
        if (!targetTab) return;
        
        navItems.forEach(nav => nav.classList.remove('active'));
        tabContents.forEach(content => {
            content.classList.remove('active');
            content.style.display = ''; // Clear inline styles to allow CSS none/flex to work
        });
        
        item.classList.add('active');
        const targetEl = document.getElementById(targetTab);
        if (targetEl) {
            targetEl.classList.add('active');
        }
        
        currentTab = targetTab;
        
        // Re-render charts or lists when clicking into those sections
        if (targetTab === 'tab-dashboard') {
            updateMetricsAndForecast();
        } else if (targetTab === 'tab-history') {
            renderDrinkList();
            renderArchiveList();
        }
    }

    navItems.forEach(item => {
        // Fast touch response for mobile PWAs (eliminates 300ms click delay)
        item.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                switchTab(item);
                e.preventDefault(); // Prevents click fallback emulation to avoid double triggers
            }
        }, { passive: false });

        // Normal click handler fallback for desktop
        item.addEventListener('click', () => {
            switchTab(item);
        });
    });
}

// Toast Notification System
let activeToast = null;
let activeToastTimeout = null;

function showToast(message, undoCallback) {
    if (activeToast) {
        clearTimeout(activeToastTimeout);
        activeToast.classList.add('fade-out');
        const oldToast = activeToast;
        setTimeout(() => {
            oldToast.remove();
        }, 300);
        activeToast = null;
    }

    const container = document.querySelector('.app-container') || document.body;
    const toast = document.createElement('div');
    toast.className = 'toast-notification';

    const textSpan = document.createElement('span');
    textSpan.className = 'toast-text';
    textSpan.textContent = message;
    toast.appendChild(textSpan);

    if (undoCallback) {
        const undoBtn = document.createElement('button');
        undoBtn.className = 'toast-undo-btn';
        undoBtn.textContent = '撤销';
        undoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            undoCallback();
            toast.classList.add('fade-out');
            setTimeout(() => {
                toast.remove();
                if (activeToast === toast) activeToast = null;
            }, 300);
        });
        toast.appendChild(undoBtn);
    }

    container.appendChild(toast);
    activeToast = toast;

    // Subtle vibration on toast creation (if browser supports it)
    if (navigator.vibrate) {
        navigator.vibrate(80);
    }

    activeToastTimeout = setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => {
            toast.remove();
            if (activeToast === toast) activeToast = null;
        }, 300);
    }, 4000);
}

// Pacing Evaluation Helper
function evaluatePacing(drinksList) {
    if (!drinksList || drinksList.length <= 1) {
        return { total: 0, compliant: 0, tooFast: 0 };
    }
    
    // Sort a copy of drinks chronologically by time
    const sorted = [...drinksList].sort((a, b) => a.time - b.time);
    let compliant = 0;
    let tooFast = 0;
    
    const pacingTime = profile.pacingTime || 60;
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const current = sorted[i];
        const elapsedMins = (current.time - prev.time) / 60000;
        
        if (elapsedMins < pacingTime) {
            tooFast++;
        } else {
            compliant++;
        }
    }
    
    return {
        total: sorted.length - 1,
        compliant,
        tooFast
    };
}

// Add drinks (Quick & Custom)
// Add drinks (Quick Beer Selector & Custom Modal)
function setupDrinkLogging() {
    // Segmented tab switching logic
    const tabButtons = document.querySelectorAll('.quick-tab-btn');
    const panelBeer = document.getElementById('panel-beer-selector');
    const panelWine = document.getElementById('panel-wine-selector');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const type = btn.getAttribute('data-type');
            if (type === 'beer') {
                if (panelBeer) panelBeer.style.display = 'block';
                if (panelWine) panelWine.style.display = 'none';
            } else {
                if (panelBeer) panelBeer.style.display = 'none';
                if (panelWine) panelWine.style.display = 'block';
            }
        });
    });

    // Selected beer stats (state indicators)
    let selectedVolValue = 330; // default 330ml
    let selectedVolUnit = "ml";
    let selectedVolDisplay = "330ml";
    let selectedAbv = 5.0; // default 5.0%

    const volPills = document.querySelectorAll('#beer-vol-options .select-pill');
    const abvPills = document.querySelectorAll('#beer-abv-options .select-pill');
    const fastLogBtn = document.getElementById('btn-beer-fast-log');

    function updateFastLogButtonText() {
        if (fastLogBtn) {
            let durationMins = 25;
            if (selectedVolValue >= 450) {
                durationMins = 40;
            } else if (selectedVolValue <= 100) {
                durationMins = 5;
            }
            fastLogBtn.textContent = `🍺 喝前记录：${selectedVolDisplay} (${selectedAbv.toFixed(1)}%) • 预计饮用 ${durationMins} 分钟`;
        }
    }

    // Initialize button text on startup
    updateFastLogButtonText();

    // Bind Volume options
    volPills.forEach(pill => {
        pill.addEventListener('click', () => {
            volPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            
            selectedVolValue = parseFloat(pill.getAttribute('data-value'));
            selectedVolUnit = pill.getAttribute('data-unit');
            selectedVolDisplay = pill.getAttribute('data-display') || (selectedVolValue + 'ml');
            
            updateFastLogButtonText();
        });
    });

    // Bind ABV options
    abvPills.forEach(pill => {
        pill.addEventListener('click', () => {
            abvPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            
            selectedAbv = parseFloat(pill.getAttribute('data-value'));
            
            updateFastLogButtonText();
        });
    });

    // Bind Fast Log execution
    if (fastLogBtn) {
        fastLogBtn.addEventListener('click', async () => {
            const drinkName = `啤酒 (${selectedVolDisplay})`;
            
            let durationMins = 25;
            if (selectedVolValue >= 450) {
                durationMins = 40;
            } else if (selectedVolValue <= 100) {
                durationMins = 5;
            }
            const loggedDrink = await addDrink(drinkName, selectedVolValue, selectedAbv, 0, 'default', durationMins);
            
            // Animation flash
            fastLogBtn.style.transform = 'scale(0.97)';
            setTimeout(() => {
                fastLogBtn.style.transform = 'none';
            }, 100);

            // Show confirmation toast with Undo callback
            showToast(`已成功记录：${selectedVolDisplay} (${selectedAbv.toFixed(1)}%) 🍺`, () => {
                if (loggedDrink && loggedDrink.id) {
                    deleteDrink(loggedDrink.id);
                    showToast('已撤销该记录 ↩️');
                }
            });
        });
    }

    // Selected wine stats (state indicators)
    let selectedWineVolValue = 150; // default 150ml
    let selectedWineVolUnit = "ml";
    let selectedWineVolDisplay = "150ml";
    let selectedWineAbv = 13.5; // default 13.5%

    const wineVolPills = document.querySelectorAll('#wine-vol-options .select-pill');
    const wineAbvPills = document.querySelectorAll('#wine-abv-options .select-pill');
    const fastWineLogBtn = document.getElementById('btn-wine-fast-log');

    function updateWineFastLogButtonText() {
        if (fastWineLogBtn) {
            let durationMins = 25;
            if (selectedWineVolValue <= 75) {
                durationMins = 15;
            } else if (selectedWineVolValue <= 120) {
                durationMins = 20;
            } else if (selectedWineVolValue <= 150) {
                durationMins = 25;
            } else {
                durationMins = 35;
            }
            fastWineLogBtn.textContent = `🍷 喝前记录：${selectedWineVolDisplay} (${selectedWineAbv.toFixed(1)}%) • 预计饮用 ${durationMins} 分钟`;
        }
    }

    // Initialize wine button text
    updateWineFastLogButtonText();

    // Bind Wine Volume options
    wineVolPills.forEach(pill => {
        pill.addEventListener('click', () => {
            wineVolPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            
            selectedWineVolValue = parseFloat(pill.getAttribute('data-value'));
            selectedWineVolUnit = pill.getAttribute('data-unit');
            selectedWineVolDisplay = pill.getAttribute('data-display') || (selectedWineVolValue + 'ml');
            
            updateWineFastLogButtonText();
        });
    });

    // Bind Wine ABV options
    wineAbvPills.forEach(pill => {
        pill.addEventListener('click', () => {
            wineAbvPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            
            selectedWineAbv = parseFloat(pill.getAttribute('data-value'));
            
            updateWineFastLogButtonText();
        });
    });

    // Bind Wine Fast Log execution
    if (fastWineLogBtn) {
        fastWineLogBtn.addEventListener('click', async () => {
            const drinkName = `红酒 (${selectedWineVolDisplay})`;
            
            let durationMins = 25;
            if (selectedWineVolValue <= 75) {
                durationMins = 15;
            } else if (selectedWineVolValue <= 120) {
                durationMins = 20;
            } else if (selectedWineVolValue <= 150) {
                durationMins = 25;
            } else {
                durationMins = 35;
            }

            const loggedDrink = await addDrink(drinkName, selectedWineVolValue, selectedWineAbv, 0, 'default', durationMins);
            
            // Animation flash
            fastWineLogBtn.style.transform = 'scale(0.97)';
            setTimeout(() => {
                fastWineLogBtn.style.transform = 'none';
            }, 100);

            // Show confirmation toast with Undo callback
            showToast(`已成功记录：${selectedWineVolDisplay} (${selectedWineAbv.toFixed(1)}%) 🍷`, () => {
                if (loggedDrink && loggedDrink.id) {
                    deleteDrink(loggedDrink.id);
                    showToast('已撤销该记录 ↩️');
                }
            });
        });
    }

    // 2. Custom Add Modal operations
    const customTrigger = document.getElementById('custom-drink-trigger');
    const modal = document.getElementById('modal-custom-drink');
    const closeBtn = document.getElementById('modal-close-btn');
    const cancelBtn = document.getElementById('modal-cancel-btn');
    const submitBtn = document.getElementById('modal-submit-btn');
    const form = document.getElementById('custom-drink-form');

    if (customTrigger) {
        customTrigger.addEventListener('click', () => {
            modal.classList.add('active');
        });
    }

    function closeModal() {
        if (modal) {
            modal.classList.remove('active');
        }
        if (form) {
            form.reset();
        }
    }

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });
    }

    if (submitBtn) {
        submitBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            
            const name = document.getElementById('custom-name').value.trim() || '自定义饮品';
            const vol = parseFloat(document.getElementById('custom-vol').value);
            const abv = parseFloat(document.getElementById('custom-abv').value);
            const offset = parseInt(document.getElementById('custom-time-offset').value);
            const duration = parseInt(document.getElementById('custom-duration').value);
            const stomach = document.getElementById('custom-stomach').value;

            if (isNaN(vol) || vol <= 0 || isNaN(abv) || abv <= 0) {
                alert('请输入有效的容量与酒精浓度值。');
                return;
            }

            const loggedDrink = await addDrink(name, vol, abv, offset, stomach, duration);
            closeModal();

            // Show confirmation toast with Undo callback
            showToast(`已成功记录：${name} (${vol}ml, ${abv}%) 🥃`, () => {
                if (loggedDrink && loggedDrink.id) {
                    deleteDrink(loggedDrink.id);
                    showToast('已撤销该记录 ↩️');
                }
            });
        });
    }
}

// Log a drink into current session
async function addDrink(name, volMl, abvPct, offsetMinutes, stomach, duration) {
    const time = Date.now() - (offsetMinutes * 60 * 1000);
    const alcoholGrams = calculateAlcoholGrams(volMl, abvPct);
    
    let durationMins = duration;
    if (durationMins === undefined || durationMins === null) {
        // Auto-estimate based on volume
        if (volMl >= 450) {
            durationMins = 40;
        } else if (volMl <= 100) {
            durationMins = 5;
        } else {
            durationMins = 25;
        }
    }
    
    const newDrink = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        name: name,
        vol: volMl,
        abv: abvPct,
        alcoholGrams: alcoholGrams,
        time: time,
        stomach: stomach,
        duration: durationMins
    };

    drinks.push(newDrink);
    drinks.sort((a, b) => a.time - b.time);

    if (authToken) {
        try {
            await apiRequest('/api/drinks', 'POST', newDrink);
        } catch (err) {
            console.error('Failed to sync drink to DB:', err.message);
        }
    }
    
    updateMetricsAndForecast();
    syncBadge();
    preselectQuickLogFromLastDrink();
    return newDrink;
}

// Delete drink from list
async function deleteDrink(id) {
    drinks = drinks.filter(d => d.id !== id);
    
    if (authToken) {
        try {
            await apiRequest(`/api/drinks/${id}`, 'DELETE');
        } catch (err) {
            console.error('Failed to delete drink from DB:', err.message);
        }
    }

    updateMetricsAndForecast();
    renderDrinkList();
    syncBadge();
    preselectQuickLogFromLastDrink();
}

// Renders the list of drinks consumed in current session
function renderDrinkList() {
    const listContainer = document.getElementById('current-drinks-list');
    listContainer.innerHTML = '';

    if (drinks.length === 0) {
        listContainer.innerHTML = `
            <div class="empty-state">
                <p>本次饮酒会话暂无记录。请先在首页记录您的第一杯！</p>
            </div>
        `;
        return;
    }

    drinks.forEach((d, i) => {
        const item = document.createElement('div');
        item.className = 'drink-item';
        
        const timeStr = formatClockTime(d.time, Date.now());
        const stdDrinks = gramsToStandardDrinks(d.alcoholGrams).toFixed(1);
        const durationText = d.duration !== undefined ? ` • 饮用: ${d.duration}分钟` : '';
        
        // Pacing badge logic
        let pacingBadgeHtml = '';
        if (i === 0) {
            pacingBadgeHtml = `<span class="pacing-badge pace-start">🏁 起步杯</span>`;
        } else {
            const prevDrink = drinks[i - 1];
            const elapsedMins = (d.time - prevDrink.time) / 60000;
            const pacingTime = profile.pacingTime || 60;
            if (elapsedMins < pacingTime) {
                pacingBadgeHtml = `<span class="pacing-badge pace-fast">🔴 喝太快了 (推荐间隔 ${pacingTime}分钟，实际仅间隔 ${Math.round(elapsedMins)}分钟)</span>`;
            } else {
                pacingBadgeHtml = `<span class="pacing-badge pace-good">🟢 节奏良好 (间隔 ${Math.round(elapsedMins)}分钟，遵循了推荐)</span>`;
            }
        }
        
        item.innerHTML = `
            <div class="drink-meta">
                <span class="drink-name">${d.name}</span>
                <span class="drink-details">${d.vol}ml / ${d.abv}% ABV • ${stdDrinks} 标准杯${durationText}</span>
                <span class="drink-time">记录时间: ${timeStr}</span>
                ${pacingBadgeHtml}
            </div>
            <div class="drink-action">
                <span class="alcohol-grams">${d.alcoholGrams.toFixed(1)}g 纯酒精</span>
                <button class="btn-delete" data-id="${d.id}">&times;</button>
            </div>
        `;
        
        // Attach delete listener
        item.querySelector('.btn-delete').addEventListener('click', () => {
            if (confirm(`确定删除这杯 "${d.name}" 的记录吗？`)) {
                deleteDrink(d.id);
            }
        });
        
        listContainer.appendChild(item);
    });
}

// --- ARCHIVES AND SESSION RESET LOGIC ---
const endSessionBtn = typeof document !== 'undefined' && document.getElementById('btn-end-session');
if (endSessionBtn) endSessionBtn.addEventListener('click', () => {
    if (drinks.length === 0) {
        alert('当前没有可结束的饮酒记录。');
        return;
    }

    if (confirm('确认结束本次饮酒会话（酒局）吗？\n\n注意：单杯记录此前已在云端实时保存。此操作仅是在本次酒局结束时：\n1. 将本次所有记录打包（计算最高 BAC 峰值和持续时长）并存档在下方“历史记录”中；\n2. 清空当前主页仪表盘的实时状态，以便您下次重新开始新的酒局。')) {
        archiveCurrentSession();
    }
});

async function archiveCurrentSession() {
    const timeline = runBacSimulation(drinks, profile);
    
    let peakBac = 0;
    timeline.forEach(pt => {
        if (pt.bac > peakBac) peakBac = pt.bac;
    });

    const drinkTimes = drinks.map(d => d.time);
    const startTime = Math.min(...drinkTimes);
    const endTime = Date.now();
    const durationHours = (endTime - startTime) / (3600 * 1000);

    const newArchive = {
        id: Date.now(),
        date: new Date(startTime).toLocaleDateString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
        drinks: [...drinks],
        peakBac: peakBac,
        duration: durationHours
    };

    archives.unshift(newArchive);
    
    if (authToken) {
        try {
            await apiRequest('/api/archives', 'POST', newArchive);
        } catch (err) {
            console.error('Failed to sync archive to DB:', err.message);
        }
    }

    // Preserve local copy of drinks for potential undo
    const savedDrinks = [...drinks];
    const archiveId = newArchive.id;

    drinks = []; // Reset active session
    updateMetricsAndForecast();
    renderDrinkList();
    renderArchiveList();
    syncBadge();
    
    // Show toast message with undo action
    showToast('当前会话已成功归档备份 📂', async () => {
        // Restore local memory states
        drinks = savedDrinks;
        archives = archives.filter(a => a.id !== archiveId);
        
        if (authToken) {
            try {
                // Delete the archived session from database
                await apiRequest(`/api/archives/${archiveId}`, 'DELETE');
                // Re-sync drinks to database
                for (const d of savedDrinks) {
                    await apiRequest('/api/drinks', 'POST', d);
                }
            } catch (err) {
                console.error('Failed to sync undo archive to DB:', err.message);
            }
        }
        
        updateMetricsAndForecast();
        renderDrinkList();
        renderArchiveList();
        syncBadge();
        preselectQuickLogFromLastDrink();
        showToast('已撤销归档，会话已恢复 ↩️');
    });
}

// Restore a historical session back to active dashboard
async function restoreArchiveToActiveSession(archiveId) {
    const targetArchive = archives.find(a => a.id === archiveId);
    if (!targetArchive) return;
    
    const savedDrinks = targetArchive.drinks || [];
    if (savedDrinks.length === 0) {
        alert('此条历史存档缺少单杯饮酒明细数据，无法进行恢复。');
        return;
    }

    // 1. Remove archive locally
    archives = archives.filter(a => a.id !== archiveId);
    // 2. Set active drinks locally
    drinks = savedDrinks;
    
    if (authToken) {
        try {
            // Delete all current active drinks in DB
            await apiRequest('/api/drinks', 'DELETE');
            // Delete the archived session from DB
            await apiRequest(`/api/archives/${archiveId}`, 'DELETE');
            // Write restored drinks to DB
            for (const d of savedDrinks) {
                await apiRequest('/api/drinks', 'POST', d);
            }
        } catch (err) {
            console.error('Failed to sync restored archive to DB:', err.message);
        }
    }
    
    updateMetricsAndForecast();
    renderDrinkList();
    renderArchiveList();
    syncBadge();
    preselectQuickLogFromLastDrink();
    
    showToast('会话恢复成功，已为您还原数据 ↩️');
}

// Render history archives
function renderArchiveList() {
    const listContainer = document.getElementById('archives-list');
    listContainer.innerHTML = '';

    if (archives.length === 0) {
        listContainer.innerHTML = `
            <div class="empty-state">
                <p>暂无历史存档记录。</p>
            </div>
        `;
        return;
    }

    archives.forEach(arc => {
        const item = document.createElement('div');
        item.className = 'archive-item';
        
        const isPeakSafe = arc.peakBac <= profile.targetBacLimit;
        const peakClass = isPeakSafe ? 'peak-safe' : '';
        const totalGrams = arc.drinks.reduce((sum, d) => sum + d.alcoholGrams, 0);
        const stdDrinks = gramsToStandardDrinks(totalGrams).toFixed(1);
        
        // Evaluate historical pacing
        const pacing = evaluatePacing(arc.drinks);
        let pacingText = '';
        if (pacing.total > 0) {
            if (pacing.tooFast === 0) {
                pacingText = `<span class="archive-pacing-badge pace-good">🟢 控速完美 (100% 达标)</span>`;
            } else {
                const percent = Math.round((pacing.compliant / pacing.total) * 100);
                pacingText = `<span class="archive-pacing-badge pace-fast">⚠️ 控速率: ${percent}% (喝快 ${pacing.tooFast} 次)</span>`;
            }
        } else if (arc.drinks && arc.drinks.length === 1) {
            pacingText = `<span class="archive-pacing-badge pace-start">🏁 仅饮单杯</span>`;
        }
        
        item.innerHTML = `
            <div class="archive-top">
                <span class="archive-date">${arc.date}</span>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <button class="btn-restore" data-id="${arc.id}">恢复</button>
                    <span class="archive-peak ${peakClass}">峰值 BAC: ${getBacDisplayValue(arc.peakBac)}</span>
                </div>
            </div>
            <div class="archive-bottom">
                <span>耗时: ${arc.duration.toFixed(1)} 小时</span>
                <span>饮酒: ${arc.drinks.length} 次 (${stdDrinks} 标准杯)</span>
                ${pacingText}
            </div>
        `;
        
        // Attach restore listener
        item.querySelector('.btn-restore').addEventListener('click', async () => {
            if (drinks.length > 0) {
                if (!confirm('恢复此存档记录将会覆盖并清空您主页当前未结束的饮酒记录。是否确定继续？')) {
                    return;
                }
            } else {
                if (!confirm('确定要将此场历史酒局重新恢复为当前活动会话吗？\n（恢复后此记录将从历史归档中移除并还原至首页）')) {
                    return;
                }
            }
            await restoreArchiveToActiveSession(arc.id);
        });
        
        listContainer.appendChild(item);
    });
}

// Clear all archived history
const clearArchivesBtn = typeof document !== 'undefined' && document.getElementById('btn-clear-archives');
if (clearArchivesBtn) {
    clearArchivesBtn.addEventListener('click', async () => {
        if (archives.length === 0) return;
        
        if (confirm('确认清空所有历史存档记录吗？此操作将永久清空数据库且不可撤销！')) {
            archives = [];
            if (authToken) {
                try {
                    await apiRequest('/api/archives', 'DELETE');
                } catch (err) {
                    console.error('Failed to clear archives from DB:', err.message);
                }
            }
            renderArchiveList();
        }
    });
}

// Export all drinks to CSV
const exportCsvBtn = typeof document !== 'undefined' && document.getElementById('btn-export-csv');
if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => {
        // Helper to find BAC at a specific time in a simulation timeline
        const getBacAtTime = (timeline, time) => {
            if (!timeline || timeline.length === 0) return 0;
            let closestStep = timeline[0];
            let minDiff = Math.abs(closestStep.time - time);
            for (let i = 1; i < timeline.length; i++) {
                const diff = Math.abs(timeline[i].time - time);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestStep = timeline[i];
                }
            }
            return closestStep.bac;
        };

        // 1. Gather all active drinks with dynamic BAC simulation
        let activePeakBac = 0;
        let activeTimeline = [];
        if (drinks.length > 0) {
            activeTimeline = runBacSimulation(drinks, profile);
            activeTimeline.forEach(pt => {
                if (pt.bac > activePeakBac) activePeakBac = pt.bac;
            });
        }

        const activeDrinks = drinks.map(d => {
            const bacBefore = getBacAtTime(activeTimeline, d.time);
            return {
                sessionDate: '当前未结束会话',
                name: d.name,
                volume: d.volume,
                abv: d.abv,
                time: d.time,
                duration: d.duration || 0,
                grams: d.alcoholGrams,
                bacBefore: bacBefore,
                peakBac: activePeakBac
            };
        });

        // 2. Gather all archived drinks with individual session BAC simulation
        const archivedDrinks = [];
        archives.forEach(arc => {
            const dateStr = arc.date;
            if (arc.drinks && Array.isArray(arc.drinks)) {
                const arcTimeline = runBacSimulation(arc.drinks, profile);
                arc.drinks.forEach(d => {
                    const bacBefore = getBacAtTime(arcTimeline, d.time);
                    archivedDrinks.push({
                        sessionDate: dateStr,
                        name: d.name,
                        volume: d.volume,
                        abv: d.abv,
                        time: d.time,
                        duration: d.duration || 0,
                        grams: d.alcoholGrams,
                        bacBefore: bacBefore,
                        peakBac: arc.peakBac || 0
                    });
                });
            }
        });

        const allDrinks = [...activeDrinks, ...archivedDrinks];

        if (allDrinks.length === 0) {
            alert('暂无可导出的饮酒记录！');
            return;
        }

        // Sort by time descending (newest first)
        allDrinks.sort((a, b) => b.time - a.time);

        // 3. Build CSV Content
        const headers = ['归属会话/状态', '饮品名称', '容量(ml)', '酒精度(%)', '饮用时间', '预计饮用时长(分钟)', '纯酒精量(克)', '饮用前估计BAC(%)', '单场会话峰值BAC(%)'];
        let csvContent = headers.join(',') + '\n';

        allDrinks.forEach(d => {
            const formattedTime = new Date(d.time).toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            
            // Escape commas and double quotes in CSV fields
            const safeName = `"${(d.name || '未命名').replace(/"/g, '""')}"`;
            const safeSession = `"${d.sessionDate.replace(/"/g, '""')}"`;
            const safeTime = `"${formattedTime}"`;
            
            const row = [
                safeSession,
                safeName,
                d.volume,
                d.abv.toFixed(1),
                safeTime,
                d.duration,
                d.grams.toFixed(2),
                d.bacBefore.toFixed(3) + '%',
                d.peakBac.toFixed(3) + '%'
            ];
            csvContent += row.join(',') + '\n';
        });

        // 4. Download file using UTF-8 BOM (Byte Order Mark) to ensure Excel parses Chinese characters correctly
        const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
        const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement('a');
        link.setAttribute('href', url);
        const filename = `soberpace_export_${new Date().toISOString().slice(0, 10)}.csv`;
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
}

// Pre-select quick logging panel items based on user's last drink
function preselectQuickLogFromLastDrink() {
    if (drinks.length === 0) {
        // Reset to system defaults
        const tabBtnBeer = document.querySelector('.quick-tab-btn[data-type="beer"]');
        if (tabBtnBeer) tabBtnBeer.click();
        
        const defaultBeerVolPill = document.querySelector('#beer-vol-options .select-pill[data-value="330"]');
        if (defaultBeerVolPill) defaultBeerVolPill.click();
        
        const defaultBeerAbvPill = document.querySelector('#beer-abv-options .select-pill[data-value="5"]');
        if (defaultBeerAbvPill) defaultBeerAbvPill.click();

        const defaultWineVolPill = document.querySelector('#wine-vol-options .select-pill[data-value="150"]');
        if (defaultWineVolPill) defaultWineVolPill.click();
        
        const defaultWineAbvPill = document.querySelector('#wine-abv-options .select-pill[data-value="13.5"]');
        if (defaultWineAbvPill) defaultWineAbvPill.click();
        return;
    }
    
    const lastDrink = drinks[drinks.length - 1];
    
    if (lastDrink.name.includes("啤酒")) {
        const tabBtnBeer = document.querySelector('.quick-tab-btn[data-type="beer"]');
        if (tabBtnBeer) tabBtnBeer.click();
        
        const volPills = document.querySelectorAll('#beer-vol-options .select-pill');
        let matchedVolPill = null;
        let closestVolDiff = Infinity;
        
        volPills.forEach(pill => {
            const val = parseFloat(pill.getAttribute('data-value'));
            const diff = Math.abs(val - lastDrink.vol);
            if (diff < closestVolDiff) {
                closestVolDiff = diff;
                matchedVolPill = pill;
            }
        });
        
        if (matchedVolPill && closestVolDiff < 50) {
            matchedVolPill.click();
        }
        
        const abvPills = document.querySelectorAll('#beer-abv-options .select-pill');
        let matchedAbvPill = null;
        let closestAbvDiff = Infinity;
        
        abvPills.forEach(pill => {
            const val = parseFloat(pill.getAttribute('data-value'));
            const diff = Math.abs(val - lastDrink.abv);
            if (diff < closestAbvDiff) {
                closestAbvDiff = diff;
                matchedAbvPill = pill;
            }
        });
        
        if (matchedAbvPill && closestAbvDiff < 0.5) {
            matchedAbvPill.click();
        }
    } else if (lastDrink.name.includes("红酒")) {
        const tabBtnWine = document.querySelector('.quick-tab-btn[data-type="wine"]');
        if (tabBtnWine) tabBtnWine.click();
        
        const wineVolPills = document.querySelectorAll('#wine-vol-options .select-pill');
        let matchedVolPill = null;
        let closestVolDiff = Infinity;
        
        wineVolPills.forEach(pill => {
            const val = parseFloat(pill.getAttribute('data-value'));
            const diff = Math.abs(val - lastDrink.vol);
            if (diff < closestVolDiff) {
                closestVolDiff = diff;
                matchedVolPill = pill;
            }
        });
        
        if (matchedVolPill && closestVolDiff < 30) {
            matchedVolPill.click();
        }
        
        const wineAbvPills = document.querySelectorAll('#wine-abv-options .select-pill');
        let matchedAbvPill = null;
        let closestAbvDiff = Infinity;
        
        wineAbvPills.forEach(pill => {
            const val = parseFloat(pill.getAttribute('data-value'));
            const diff = Math.abs(val - lastDrink.abv);
            if (diff < closestAbvDiff) {
                closestAbvDiff = diff;
                matchedAbvPill = pill;
            }
        });
        
        if (matchedAbvPill && closestAbvDiff < 0.5) {
            matchedAbvPill.click();
        }
    }
}

// --- SETTINGS INTERACTION LOGIC ---
function setupSettingsPanel() {
    // 1. Profile fields
    const genderEl = document.getElementById('profile-gender');
    const ageEl = document.getElementById('profile-age');
    const weightEl = document.getElementById('profile-weight');
    const weightUnitEl = document.getElementById('weight-unit');
    const heightEl = document.getElementById('profile-height');
    const heightUnitEl = document.getElementById('height-unit');
    
    // 2. Prefs fields
    const limitEl = document.getElementById('settings-bac-limit');
    const pacingEl = document.getElementById('settings-pacing-time');
    const stomachEl = document.getElementById('settings-stomach');
    const decayEl = document.getElementById('settings-decay-rate');

    function syncProfileFromUI() {
        profile.gender = genderEl.value;
        profile.age = parseInt(ageEl.value) || 40;
        profile.weight = parseFloat(weightEl.value) || 125;
        profile.weightUnit = weightUnitEl.value;
        profile.height = parseFloat(heightEl.value) || 172;
        profile.heightUnit = heightUnitEl.value;
        
        let limitVal = parseFloat(limitEl.value) || 0.060;
        if (localStorage.getItem('soberpace_bac_unit') === 'mg_pct') {
            limitVal = limitVal / 1000;
        }
        profile.targetBacLimit = limitVal;
        profile.globalStomach = stomachEl.value;
        profile.decayRate = parseFloat(decayEl.value) || 0.015;

        // Read pacing mode radio buttons
        const radioAuto = document.getElementById('pacing-mode-auto');
        if (radioAuto) {
            profile.pacingMode = radioAuto.checked ? 'auto' : 'manual';
        }

        const autoLabel = document.getElementById('pacing-auto-label');
        if (profile.pacingMode === 'auto') {
            const calculatedTime = calculateScientificPacingInterval();
            profile.pacingTime = calculatedTime;
            if (pacingEl) {
                pacingEl.value = calculatedTime;
                pacingEl.disabled = true;
            }
            if (autoLabel) {
                autoLabel.textContent = `(系统计算: ${calculatedTime}分钟)`;
                autoLabel.style.display = 'inline';
            }
        } else {
            profile.pacingTime = parseInt(pacingEl.value) || 60;
            if (pacingEl) {
                pacingEl.disabled = false;
            }
            if (autoLabel) {
                autoLabel.style.display = 'none';
            }
        }
        
        updateRBadge();
        saveData();
        updateMetricsAndForecast();
    }

    const unitEl = document.getElementById('settings-bac-unit');

    // Attach event listeners to all controls to save reactively
    [genderEl, ageEl, weightEl, weightUnitEl, heightEl, heightUnitEl, limitEl, pacingEl, stomachEl, decayEl].forEach(ctrl => {
        ctrl.addEventListener('change', syncProfileFromUI);
        ctrl.addEventListener('input', syncProfileFromUI);
    });

    if (unitEl) {
        unitEl.addEventListener('change', () => {
            localStorage.setItem('soberpace_bac_unit', unitEl.value);
            syncProfileToUI();
            updateMetricsAndForecast();
            saveData();
        });
    }

    // Listen to pacing-mode radio changes
    document.querySelectorAll('input[name="pacing-mode"]').forEach(radio => {
        radio.addEventListener('change', syncProfileFromUI);
    });

    // Next-drink "ready" notification toggle (per-device preference)
    const notifyEl = document.getElementById('settings-notify');
    const notifyStatusEl = document.getElementById('notify-status');

    function refreshNotifyStatus() {
        if (!notifyStatusEl) return;
        if (!('Notification' in window)) {
            notifyStatusEl.textContent = '当前浏览器不支持系统通知（标签页标题与角标倒计时仍然可用）。';
            if (notifyEl) notifyEl.disabled = true;
            return;
        }
        const on = notificationsEnabled() && Notification.permission === 'granted';
        if (notifyEl) notifyEl.checked = on;
        if (Notification.permission === 'denied') {
            notifyStatusEl.textContent = '通知权限已被拒绝，请到浏览器/系统设置中手动允许后再开启。';
        } else if (on) {
            notifyStatusEl.textContent = '已开启：到点会推送系统通知；倒计时也会显示在标签页标题和手机 App 图标角标上。';
        } else {
            notifyStatusEl.textContent = '未开启。开启后到了可安全饮用的时间会推送系统通知。';
        }
    }

    if (notifyEl) {
        notifyEl.addEventListener('change', async () => {
            if (notifyEl.checked) {
                if (!('Notification' in window)) return;
                let perm = Notification.permission;
                if (perm === 'default') {
                    perm = await Notification.requestPermission();
                }
                if (perm === 'granted') {
                    localStorage.setItem('soberpace_notify', '1');
                } else {
                    notifyEl.checked = false;
                    localStorage.removeItem('soberpace_notify');
                }
            } else {
                localStorage.removeItem('soberpace_notify');
            }
            refreshNotifyStatus();
        });
        refreshNotifyStatus();
    }

    // Factory Reset App button
    const resetBtn = document.getElementById('btn-factory-reset');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (confirm('重要警告：此操作将彻底清除此设备上的所有登录状态、密码锁和缓存，使 App 恢复至最初的出厂未登录状态！是否继续？')) {
                localStorage.clear();
                
                // Reload page to reset state
                window.location.reload();
            }
        });
    }
}

// --- REGISTER SERVICE WORKER FOR OFFLINE PWA ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => {
                swRegistration = reg;
                console.log('Service Worker registered successfully:', reg.scope);
            })
            .catch(err => console.log('Service Worker registration failed:', err));
    });
    // Ensure we have a usable registration for background notifications even on warm loads
    navigator.serviceWorker.ready.then(reg => { swRegistration = reg; }).catch(() => {});
}

// --- PASSCODE LOCK SYSTEM ---
let passcodeState = {
    currentInput: '',
    savedPin: '',
    isSettingMode: false,
    isDisablingMode: false,
    tempFirstInput: '',
    customCallback: null
};

function initPasscodeSystem() {
    passcodeState.savedPin = localStorage.getItem('soberpace_pin') || '';
    
    // Bind numpad buttons
    const numButtons = document.querySelectorAll('.num-btn[data-val]');
    numButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            handlePasscodeInput(btn.getAttribute('data-val'));
        });
    });

    const btnDel = document.getElementById('btn-pin-del');
    if (btnDel) {
        btnDel.addEventListener('click', () => {
            if (passcodeState.currentInput.length > 0) {
                passcodeState.currentInput = passcodeState.currentInput.slice(0, -1);
                updatePasscodeDots();
            }
        });
    }

    const btnReset = document.getElementById('btn-pin-reset');
    if (btnReset) {
        btnReset.addEventListener('click', () => {
            resetPasscodeVerification();
        });
    }

    // Bind settings lock toggle button
    const btnTogglePin = document.getElementById('btn-toggle-pin');
    if (btnTogglePin) {
        btnTogglePin.addEventListener('click', () => {
            const saved = localStorage.getItem('soberpace_pin');
            if (saved) {
                // Set disabling mode verification
                passcodeState.isDisablingMode = true;
                passcodeState.isSettingMode = false;
                passcodeState.customCallback = null;
                showPasscodeScreen("停用密码锁", "请输入您当前的 4 位密码以关闭应用锁");
            } else {
                // Set enabling mode setup
                passcodeState.isSettingMode = true;
                passcodeState.isDisablingMode = false;
                passcodeState.customCallback = null;
                passcodeState.tempFirstInput = '';
                showPasscodeScreen("设置新密码", "请输入 4 位数字作为安全密码");
            }
        });
    }

    const btnChangePin = document.getElementById('btn-change-pin');
    if (btnChangePin) {
        btnChangePin.addEventListener('click', () => {
            // Verify old PIN before changing
            passcodeState.isDisablingMode = false;
            passcodeState.isSettingMode = false;
            passcodeState.tempFirstInput = '';
            const saved = localStorage.getItem('soberpace_pin');
            if (saved) {
                // Hook to redirect to setup after verification
                passcodeState.customCallback = () => {
                    passcodeState.isSettingMode = true;
                    passcodeState.isDisablingMode = false;
                    passcodeState.tempFirstInput = '';
                    showPasscodeScreen("输入新密码", "请输入 4 位新密码");
                };
                showPasscodeScreen("身份验证", "请输入当前密码以验证身份");
            }
        });
    }

    // Sync button text in settings panel on startup
    syncPasscodeSettingsUI();

    // Check if we need to show lock screen on initial boot
    if (passcodeState.savedPin) {
        showPasscodeScreen("密码解锁", "请输入您的 4 位数安全密码以继续");
    }

    // Lock app when switching back from background
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            const activePin = localStorage.getItem('soberpace_pin');
            if (activePin && !document.getElementById('passcode-screen').classList.contains('active')) {
                resetPasscodeVerification();
                showPasscodeScreen("输入密码解锁", "请输入您的 4 位安全密码");
            }
        }
    });
}

function syncPasscodeSettingsUI() {
    const btnTogglePin = document.getElementById('btn-toggle-pin');
    const btnChangePin = document.getElementById('btn-change-pin');
    const saved = localStorage.getItem('soberpace_pin');
    
    if (btnTogglePin) {
        if (saved) {
            btnTogglePin.textContent = "停用密码锁";
            btnTogglePin.className = "btn btn-danger btn-block";
        } else {
            btnTogglePin.textContent = "启用密码锁";
            btnTogglePin.className = "btn btn-secondary btn-block";
        }
    }
    
    if (btnChangePin) {
        btnChangePin.style.display = saved ? "block" : "none";
    }
}

function showPasscodeScreen(title, promptText) {
    const screen = document.getElementById('passcode-screen');
    const titleEl = document.getElementById('passcode-title');
    const promptEl = document.getElementById('passcode-prompt');
    
    if (titleEl) titleEl.textContent = title;
    if (promptEl) promptEl.textContent = promptText;
    
    resetPasscodeState();
    if (screen) screen.classList.add('active');
}

function hidePasscodeScreen() {
    const screen = document.getElementById('passcode-screen');
    if (screen) screen.classList.remove('active');
    resetPasscodeState();
}

function resetPasscodeState() {
    passcodeState.currentInput = '';
    updatePasscodeDots();
}

function resetPasscodeVerification() {
    passcodeState.currentInput = '';
    updatePasscodeDots();
    
    const titleEl = document.getElementById('passcode-title');
    const promptEl = document.getElementById('passcode-prompt');
    
    if (passcodeState.isSettingMode) {
        if (passcodeState.tempFirstInput === '') {
            if (titleEl) titleEl.textContent = "设置新密码";
            if (promptEl) promptEl.textContent = "请输入 4 位数字作为安全密码";
        } else {
            if (titleEl) titleEl.textContent = "请再次输入";
            if (promptEl) promptEl.textContent = "请再次输入以确认新密码";
        }
    } else if (passcodeState.isDisablingMode) {
        if (titleEl) titleEl.textContent = "停用密码锁";
        if (promptEl) promptEl.textContent = "请输入当前密码以停用密码锁";
    } else {
        if (titleEl) titleEl.textContent = "输入密码解锁";
        if (promptEl) promptEl.textContent = "请输入您的 4 位数安全密码以继续";
    }
}

function updatePasscodeDots() {
    const dots = document.querySelectorAll('.dot-indicator');
    const len = passcodeState.currentInput.length;
    
    dots.forEach((dot, idx) => {
        dot.className = "dot-indicator"; // reset
        if (idx < len) {
            dot.classList.add('filled');
        }
    });
}

function handlePasscodeInput(val) {
    if (passcodeState.currentInput.length >= 4) return;
    
    passcodeState.currentInput += val;
    updatePasscodeDots();

    if (passcodeState.currentInput.length === 4) {
        // Trigger verification after a brief delay for user feedback
        setTimeout(() => {
            verifyPasscode();
        }, 200);
    }
}

function verifyPasscode() {
    const titleEl = document.getElementById('passcode-title');
    const promptEl = document.getElementById('passcode-prompt');
    const saved = localStorage.getItem('soberpace_pin') || '';

    // 1. SETTING PIN MODE
    if (passcodeState.isSettingMode) {
        if (passcodeState.tempFirstInput === '') {
            // First stage of setting PIN
            passcodeState.tempFirstInput = passcodeState.currentInput;
            passcodeState.currentInput = '';
            updatePasscodeDots();
            if (titleEl) titleEl.textContent = "请再次输入";
            if (promptEl) promptEl.textContent = "确保两次输入的密码一致以完成设定";
        } else {
            // Confirmation stage
            if (passcodeState.currentInput === passcodeState.tempFirstInput) {
                // Match! Save it.
                localStorage.setItem('soberpace_pin', passcodeState.currentInput);
                passcodeState.savedPin = passcodeState.currentInput;
                hidePasscodeScreen();
                alert("安全密码已启用成功！在云端访问时您的隐私已受保护。");
                syncPasscodeSettingsUI();
            } else {
                // Mismatch
                triggerPasscodeError("密码不匹配", "两次输入的密码不一致，请重置重试");
            }
        }
    } 
    // 2. DISABLING PIN MODE
    else if (passcodeState.isDisablingMode) {
        if (passcodeState.currentInput === saved) {
            // Verified. Disable!
            localStorage.removeItem('soberpace_pin');
            passcodeState.savedPin = '';
            hidePasscodeScreen();
            alert("密码锁已停用。注意：云端公开部署时将失去隐私保护。");
            syncPasscodeSettingsUI();
        } else {
            triggerPasscodeError("验证失败", "密码错误，无法停用密码锁");
        }
    } 
    // 3. CHANGE PIN STAGE 1 (VERIFYING CURRENT)
    else if (passcodeState.customCallback) {
        if (passcodeState.currentInput === saved) {
            // Verified. Run callback (proceed to setup new PIN)
            const cb = passcodeState.customCallback;
            passcodeState.customCallback = null;
            cb();
        } else {
            triggerPasscodeError("验证失败", "当前密码错误，请重新输入");
        }
    }
    // 4. STANDARD UNLOCKING MODE
    else {
        if (passcodeState.currentInput === saved) {
            // Correct PIN. Unlock!
            hidePasscodeScreen();
        } else {
            triggerPasscodeError("解锁失败", "密码错误，请重新输入");
        }
    }
}

function triggerPasscodeError(title, promptText) {
    const dotsContainer = document.querySelector('.passcode-dots');
    const dots = document.querySelectorAll('.dot-indicator');
    const titleEl = document.getElementById('passcode-title');
    const promptEl = document.getElementById('passcode-prompt');

    if (titleEl) titleEl.textContent = title;
    if (promptEl) promptEl.textContent = promptText;

    if (dotsContainer) dotsContainer.classList.add('shake');
    dots.forEach(dot => {
        dot.classList.add('error');
    });

    setTimeout(() => {
        if (dotsContainer) dotsContainer.classList.remove('shake');
        resetPasscodeVerification();
    }, 800);
}

// --- NODE EXPORTS (for unit tests; no-op in the browser) ---
// `profile` is exported by reference so tests can mutate its properties to
// exercise the functions that read the module-global profile.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        profile,
        getWeightInKg,
        getHeightInCm,
        calculateWatsonR,
        getKa,
        calculateAlcoholGrams,
        gramsToStandardDrinks,
        calculateScientificPacingInterval,
        runBacSimulation,
        formatCountdownClock,
    };
}

