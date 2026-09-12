require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
app.set('trust proxy', true); // so req.ip reflects the real client/device IP behind Render's proxy
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// ---------------- DATABASE ----------------
const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);
db.defaults({
  users: [],
  telemetry: [],
  events: [],
  audit: [],
  sensorFaultLog: [],
  config: {
    tempLower: 2.0, tempUpper: 8.0, tempWarningBand: 1.0,
    warningDurationMs: 60000, criticalDurationMs: 180000,
    vibrationSensitivity: 3,
    deviceName: "VaxGuard Unit 1", configVersion: 1,
    location: { lat: null, lng: null, label: '', source: null, accuracy: null }
  }
}).write();
// NOTE: Render free tier disk is EPHEMERAL — db.json resets on redeploy.

// ---------------- SECURITY: TAMPER-EVIDENT AUDIT LOG (#15) ----------------
function pushAudit({ actor, action, details }) {
  const last = db.get('audit').last().value();
  const prevHash = last ? last.hash : '0';
  const timestamp = Date.now();
  const payload = JSON.stringify({ actor: actor || null, action, details: details || null, timestamp, prevHash });
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const entry = { id: uuidv4(), timestamp, actor: actor || null, action, details: details || null, prevHash, hash };
  db.get('audit').push(entry).write();
  return entry;
}
function verifyAuditChain() {
  const entries = db.get('audit').value();
  let prevHash = '0';
  for (const e of entries) {
    const payload = JSON.stringify({ actor: e.actor, action: e.action, details: e.details, timestamp: e.timestamp, prevHash });
    if (crypto.createHash('sha256').update(payload).digest('hex') !== e.hash) return { tampered: true, brokenAt: e.id, entriesChecked: entries.length };
    prevHash = e.hash;
  }
  return { tampered: false, brokenAt: null, entriesChecked: entries.length };
}

// ---------------- AUTH (#14 brute-force lockout) ----------------
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_INSECURE_DEFAULT';
const failedLogins = {};

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try { req.user = jwt.verify(header.split(' ')[1], JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: 'Invalid/expired token' }); }
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const key = username || 'unknown';
  const rec = failedLogins[key] || { count: 0, lockedUntil: 0 };
  if (rec.lockedUntil > Date.now()) {
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil((rec.lockedUntil - Date.now()) / 1000)}s.` });
  }
  const user = db.get('users').find({ username }).value();
  const ok = user && await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    rec.count++;
    if (rec.count >= 5) {
      rec.lockedUntil = Date.now() + 15 * 60 * 1000;
      rec.count = 0;
      sendTelegram('SECURITY_LOCKOUT', 'HIGH', `Security: account "${username}" locked for 15 min after repeated failed logins (IP ${req.ip}).`);
    }
    failedLogins[key] = rec;
    pushAudit({ actor: username, action: 'LOGIN_FAILED', details: { ip: req.ip } });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  failedLogins[key] = { count: 0, lockedUntil: 0 };
  const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: '4h' });
  pushAudit({ actor: username, action: 'LOGIN', details: { ip: req.ip } });
  res.json({ token, role: user.role });
});

app.post('/api/auth/bootstrap-admin', async (req, res) => {
  if (db.get('users').value().length > 0) return res.status(403).json({ error: 'Admin already exists' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const passwordHash = await bcrypt.hash(password, 10);
  db.get('users').push({ username, passwordHash, role: 'admin' }).write();
  pushAudit({ actor: username, action: 'BOOTSTRAP_ADMIN' });
  res.json({ ok: true });
});

// ---------------- TELEGRAM ----------------
const lastAlertByType = {};
const COOLDOWN_MS = { WARNING: 5 * 60 * 1000, HIGH: 2 * 60 * 1000, CRITICAL: 30 * 1000, INFO: 15 * 60 * 1000 };

async function sendTelegram(eventType, priority, message) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const now = Date.now();
  if (now - (lastAlertByType[eventType] || 0) < (COOLDOWN_MS[priority] || COOLDOWN_MS.WARNING)) return;
  lastAlertByType[eventType] = now;
  const icon = priority === 'CRITICAL' ? '🔴' : priority === 'HIGH' ? '🟠' : priority === 'INFO' ? '🟢' : '🟡';
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `${icon} VaxGuard ${priority}\n${message}` })
    });
  } catch (e) { console.error('[telegram] failed:', e.message); }
}
function alertCopy(state, prevState, deviceId, temp, riskScore, simulated) {
  const tag = simulated ? '[SIMULATED TEST] ' : '';
  if (state === 'CRITICAL') return { type: 'CRITICAL', priority: 'CRITICAL', msg: `${tag}${deviceId}: Cold chain breach. Temp=${temp}°C, Risk=${riskScore}. Act now.` };
  if (simulated) return null; // simulated readings never alert below CRITICAL
  if (state === 'WARNING') return { type: 'WARNING', priority: 'HIGH', msg: `${deviceId}: Temperature has been out of range for a while (${temp}°C). Worth checking.` };
  if (state === 'SENSOR_FAULT') return { type: 'FAULT', priority: 'WARNING', msg: `${deviceId}: Temperature sensor isn't responding. Readings paused until it's back.` };
  if (['SAFE', 'RECOVERY'].includes(state) && ['CRITICAL', 'WARNING'].includes(prevState)) {
    return { type: 'RECOVERY', priority: 'INFO', msg: `${deviceId}: All good again — back to ${state.toLowerCase()} range.` };
  }
  return null;
}

// ================= AI / STATISTICS LAYER (34 explainable, rule-based features — not a trained ML model) =================

function linearRegression(series) {
  const n = series.length; if (n < 2) return { slope: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += series[i]; sumXY += i * series[i]; sumXX += i * i; }
  return { slope: (n * sumXY - sumX * sumY) / ((n * sumXX - sumX * sumX) || 1) };
}
function runningStats(series) {
  let n = 0, mean = 0, M2 = 0;
  for (const x of series) { n++; const d = x - mean; mean += d / n; M2 += d * (x - mean); }
  return { mean, stdDev: Math.sqrt(n > 1 ? M2 / (n - 1) : 0), n };
}
// 1. Risk score
function computeRiskScore(state, vibrationCount) {
  let score = 0; const reasons = [];
  if (state === 'WATCH') { score += 30; reasons.push('Temperature nearing configured band edge'); }
  if (state === 'WARNING') { score += 60; reasons.push('Temperature outside band, persisting'); }
  if (state === 'CRITICAL') { score += 90; reasons.push('Temperature critically out of range'); }
  if (state === 'SENSOR_FAULT') { score += 40; reasons.push('DHT11 sensor fault reduces confidence'); }
  if (vibrationCount >= 6) { score += 15; reasons.push('Abnormal vibration frequency detected'); }
  return { score: Math.min(100, score), reasons };
}
// 2. Trend
function trendDirection(temps) {
  const { slope } = linearRegression(temps);
  return slope > 0.02 ? 'RISING' : slope < -0.02 ? 'FALLING' : 'STABLE';
}
// 3. Anomaly (z-score)
function anomalyCheck(temps) {
  const { mean, stdDev, n } = runningStats(temps);
  const latest = temps[temps.length - 1];
  const z = stdDev ? (latest - mean) / stdDev : 0;
  return { isAnomaly: Math.abs(z) > 2.5, zScore: +z.toFixed(2), mean, stdDev, n };
}
// 4. ETA to critical
function etaToCritical(temps, cfg) {
  const { slope } = linearRegression(temps);
  const latest = temps[temps.length - 1];
  if (Math.abs(slope) < 0.005) return { willCross: false, message: 'Temperature is stable; no crossing predicted.' };
  const target = slope > 0 ? cfg.tempUpper : cfg.tempLower;
  const stepsAway = (target - latest) / slope;
  if (stepsAway < 0) return { willCross: false, message: 'Trending away from the limit.' };
  const etaSeconds = Math.round(stepsAway * 5);
  return { willCross: true, etaSeconds, message: `At this rate, temperature reaches ${target}°C in about ${Math.round(etaSeconds / 60)} min.` };
}
// 5. Hourly pattern learning
function hourlyPatternBaseline(records) {
  const buckets = Array.from({ length: 24 }, () => []);
  for (const r of records) { if (r.tempValid === false || r.temperature == null) continue; buckets[new Date(r.receivedAt).getHours()].push(r.temperature); }
  return buckets.map((vals, hour) => ({ hour, ...runningStats(vals) }));
}
// 6. Pattern-relative anomaly
function patternAnomaly(records, latestTemp) {
  const bucket = hourlyPatternBaseline(records)[new Date().getHours()];
  if (!bucket || bucket.n < 5) return { available: false };
  const z = bucket.stdDev ? (latestTemp - bucket.mean) / bucket.stdDev : 0;
  return { available: true, hour: bucket.hour, expectedMean: +bucket.mean.toFixed(2), zScore: +z.toFixed(2), unusualForThisHour: Math.abs(z) > 2.5 };
}
// 7. Sensor drift detection
function driftDetection(records) {
  const daily = {};
  for (const r of records) { if (r.tempValid === false || r.temperature == null) continue; const day = new Date(r.receivedAt).toISOString().slice(0, 10); (daily[day] = daily[day] || []).push(r.temperature); }
  const days = Object.keys(daily).sort();
  if (days.length < 4) return { available: false };
  const { slope } = linearRegression(days.map(d => runningStats(daily[d]).mean));
  return { available: true, driftPerDay: +slope.toFixed(3), driftSuspected: Math.abs(slope) > 0.15 };
}
// 8. Vibration-temperature correlation (door-open detection)
function vibrationTempCorrelation(records) {
  let flagged = 0;
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1], cur = records[i];
    if ((cur.vibrationCount || 0) >= 3 && prev.tempValid !== false && cur.tempValid !== false && cur.temperature - prev.temperature > 0.5) flagged++;
  }
  return { likelyDoorOpenEvents: flagged };
}
// 9. Reliability / uptime score
function reliabilityScore(records) {
  if (records.length < 2) return { score: 100, missedIntervals: 0 };
  let missed = 0;
  for (let i = 1; i < records.length; i++) if (records[i].receivedAt - records[i - 1].receivedAt > 15000) missed++;
  return { score: Math.max(0, 100 - missed * 2), missedIntervals: missed };
}
// 10. Adaptive threshold advisory
function adaptiveThresholdAdvisory(records, cfg) {
  const stableTemps = records.filter(r => r.state === 'SAFE' && r.tempValid !== false).map(r => r.temperature);
  if (stableTemps.length < 20) return { available: false };
  const { mean, stdDev } = runningStats(stableTemps);
  return { available: true, suggestedLower: +(mean - 2 * stdDev).toFixed(1), suggestedUpper: +(mean + 2 * stdDev).toFixed(1), currentLower: cfg.tempLower, currentUpper: cfg.tempUpper, note: 'Advisory only — observed stable-state variance, not a medical/regulatory limit.' };
}
// 11. Sensor health / predictive maintenance
function sensorHealthScore(deviceId) {
  const faults = db.get('sensorFaultLog').filter({ deviceId }).value();
  const now = Date.now();
  const last30d = faults.filter(f => now - f.timestamp < 30 * 24 * 3600e3);
  const last7d = faults.filter(f => now - f.timestamp < 7 * 24 * 3600e3);
  const score = Math.max(0, Math.min(100, 100 - last30d.length * 3 - last7d.length * 5));
  return { score, faultsLast30d: last30d.length, faultsLast7d: last7d.length, maintenanceRecommended: score < 60, note: 'Heuristic based on recent DHT11 fault frequency, not a manufacturer spec.' };
}
// 12. Tamper / movement suspicion
function tamperCheck(records) {
  if (records.length < 2) return { suspected: false };
  const last = records[records.length - 1], prev = records[records.length - 2];
  const gap = last.receivedAt - prev.receivedAt;
  const suspected = gap > 30000 && (last.vibrationCount || 0) >= 3;
  return { suspected, gapMs: gap, note: suspected ? 'Long silent gap followed by vibration — worth a physical check.' : undefined };
}
// 13. Rapid config-change anomaly (security) — see flagRapidConfigChanges below
// 16. Cold-chain exposure / vaccine stress index (heuristic — NOT a certified potency test)
function coldChainExposureIndex(records) {
  const windowRecords = records.filter(r => Date.now() - r.receivedAt < 7 * 24 * 3600e3);
  let weightedMinutes = 0, rawExcursionMinutes = 0;
  for (let i = 1; i < windowRecords.length; i++) {
    const prev = windowRecords[i - 1], cur = windowRecords[i];
    const minutes = (cur.receivedAt - prev.receivedAt) / 60000;
    if (minutes <= 0 || minutes > 30) continue; // skip huge gaps (offline periods, not excursions)
    if (prev.state === 'WARNING') { weightedMinutes += minutes * 1; rawExcursionMinutes += minutes; }
    if (prev.state === 'CRITICAL') { weightedMinutes += minutes * 3; rawExcursionMinutes += minutes; }
  }
  const score = Math.max(0, 100 - weightedMinutes * 0.5);
  const label = score > 80 ? 'GOOD' : score > 50 ? 'REDUCED CONFIDENCE — inspect before use' : 'DO NOT USE — follow manufacturer/WHO protocol, consult a VVM or lab';
  return {
    score: Math.round(score), label, rawExcursionMinutes7d: Math.round(rawExcursionMinutes), weightedMinutes7d: Math.round(weightedMinutes),
    disclaimer: 'This is a decision-support heuristic based on cumulative time-and-severity out of range. It is NOT a certified vaccine potency test — always follow manufacturer guidance, a physical Vaccine Vial Monitor (VVM), or lab confirmation before administering vaccines.'
  };
}
// 18. Friendly preventive advice generator
function generateAdvice(state, ctx) {
  const tips = [];
  if (state === 'CRITICAL') tips.push('Move vaccines to a backup fridge now and check the door seal.');
  if (state === 'WARNING') tips.push('Check the door is fully closed and the thermostat setting hasn\'t shifted.');
  if (state === 'SENSOR_FAULT') tips.push('The DHT11 may be loose or failing — check the wiring at GPIO 4.');
  if (ctx.drift?.available && ctx.drift.driftSuspected) tips.push('Readings are slowly drifting — consider recalibrating or replacing the sensor.');
  if (ctx.vibrationCorrelation?.likelyDoorOpenEvents > 3) tips.push('The door is being opened often — try to minimize access to keep temperature stable.');
  if (ctx.tamperCheck?.suspected) tips.push('There was a long silent gap followed by movement — worth a quick physical check.');
  if (!tips.length) tips.push('Everything looks stable — no action needed right now.');
  return tips;
}
// 20. Week-over-week comparison
function weekOverWeekComparison(records) {
  const now = Date.now();
  const thisWeek = records.filter(r => now - r.receivedAt < 7 * 24 * 3600e3 && r.tempValid !== false).map(r => r.temperature);
  const lastWeek = records.filter(r => now - r.receivedAt >= 7 * 24 * 3600e3 && now - r.receivedAt < 14 * 24 * 3600e3 && r.tempValid !== false).map(r => r.temperature);
  if (thisWeek.length < 10 || lastWeek.length < 10) return { available: false };
  const a = runningStats(thisWeek).mean, b = runningStats(lastWeek).mean;
  return { available: true, thisWeekMean: +a.toFixed(2), lastWeekMean: +b.toFixed(2), changePerCent: +(((a - b) / b) * 100).toFixed(1) };
}
// 21. Data completeness / confidence
function dataCompleteness(records) {
  if (records.length < 2) return { completenessPct: 100 };
  const expectedSamples = Math.round((records[records.length - 1].receivedAt - records[0].receivedAt) / 5000);
  const pct = expectedSamples > 0 ? Math.min(100, Math.round((records.length / expectedSamples) * 100)) : 100;
  return { completenessPct: pct };
}
// 22. Humidity stability index
function humidityStabilityIndex(records) {
  const hums = records.filter(r => r.humidity != null && r.humidity >= 0).map(r => r.humidity);
  if (hums.length < 5) return { available: false };
  const { mean, stdDev } = runningStats(hums);
  return { available: true, meanHumidity: +mean.toFixed(1), stdDev: +stdDev.toFixed(1), stable: stdDev < 8 };
}
// 25. Stale-config / stale-device detection
function staleDeviceCheck(records) {
  if (!records.length) return { stale: true, lastSeenMinutesAgo: null };
  const lastSeenMs = Date.now() - records[records.length - 1].receivedAt;
  return { stale: lastSeenMs > 60000, lastSeenMinutesAgo: +(lastSeenMs / 60000).toFixed(1) };
}
// 19. Learning mode
function learningModeCheck(records) { return { learningMode: records.length < 30, samplesCollected: records.length, samplesNeeded: 30 }; }
// 26. Natural-language insight summary generator (feeds both dashboard text and voice)
function buildSummary({ latest, trend, eta, anomaly, exposure, advice }) {
  const parts = [];
  parts.push(`Temperature is ${latest.temperature?.toFixed ? latest.temperature.toFixed(1) : latest.temperature} degrees and trending ${trend.direction.toLowerCase()}.`);
  if (eta.willCross) parts.push(eta.message);
  if (anomaly.isAnomaly) parts.push('This reading is statistically unusual for this device.');
  parts.push(`Cold-chain exposure index is ${exposure.score} out of 100, rated ${exposure.label}.`);
  parts.push(advice[0]);
  return parts.join(' ');
}

// ---------------- CONFIG-CHANGE ANOMALY (#13, security) ----------------
let configChangeTimestamps = [];
function flagRapidConfigChanges() {
  const now = Date.now();
  configChangeTimestamps = configChangeTimestamps.filter(t => now - t < 10 * 60 * 1000);
  configChangeTimestamps.push(now);
  if (configChangeTimestamps.length >= 3) sendTelegram('CONFIG_ANOMALY', 'HIGH', 'Security: thresholds changed 3+ times in 10 minutes. Confirm this was authorized.');
}

// ---------------- AUTO IP-BASED APPROXIMATE LOCATION (#23) ----------------
let lastGeoLookupMs = 0;
async function maybeAutoLocateDevice(ip) {
  const cfg = db.get('config').value();
  if (cfg.location?.source === 'MANUAL') return; // manual entry always wins
  if (Date.now() - lastGeoLookupMs < 60 * 60 * 1000) return; // once per hour max
  lastGeoLookupMs = Date.now();
  try {
    const clean = (ip || '').replace('::ffff:', '');
    const r = await fetch(`http://ip-api.com/json/${clean}?fields=status,city,regionName,country,lat,lon`);
    const d = await r.json();
    if (d.status === 'success') {
      db.get('config').assign({ location: { lat: d.lat, lng: d.lon, label: `${d.city}, ${d.regionName}, ${d.country}`, source: 'AUTO_IP', accuracy: 'city-level (approximate — not exact GPS)' } }).write();
    }
  } catch (e) { console.error('[geo] lookup failed', e.message); }
}

// ---------------- SENSORS INGEST ----------------
app.post('/api/sensors', (req, res) => {
  const body = req.body;
  if (!body || !body.deviceId || !body.state) return res.status(400).json({ error: 'deviceId and state required' });

  maybeAutoLocateDevice(req.ip); // fire-and-forget, best-effort

  const riskCalc = computeRiskScore(body.state, body.vibrationCount || 0);
  const record = { ...body, mode: 'REAL', simulated: !!body.simulated, riskScore: riskCalc.score, receivedAt: Date.now() };
  db.get('telemetry').push(record).write();

  const recent = db.get('telemetry').filter({ deviceId: body.deviceId, mode: 'REAL' }).takeRight(2).value();
  const prevState = recent.length > 1 ? recent[0].state : null;

  if (prevState && prevState !== body.state) {
    db.get('events').push({
      id: uuidv4(), timestamp: Date.now(), type: 'STATE_CHANGE', mode: 'REAL', simulated: !!body.simulated,
      severity: body.state, previousState: prevState, newState: body.state,
      reason: `${body.simulated ? '[SIM] ' : ''}State changed from ${prevState} to ${body.state}`, deviceId: body.deviceId
    }).write();

    if (body.state === 'SENSOR_FAULT') db.get('sensorFaultLog').push({ deviceId: body.deviceId, timestamp: Date.now() }).write();

    const alert = alertCopy(body.state, prevState, body.deviceId, body.temperature, riskCalc.score, body.simulated);
    if (alert) sendTelegram(alert.type, alert.priority, alert.msg);
  }

  if (!body.simulated && (body.vibrationCount || 0) >= 6) {
    sendTelegram('VIBRATION', 'HIGH', `${body.deviceId}: unusual vibration burst (${body.vibrationCount} events) — worth a look.`);
  }

  res.json({ ok: true, riskScore: riskCalc.score, riskReasons: riskCalc.reasons });
});

app.get('/api/sensors/latest', (req, res) => {
  const { deviceId } = req.query;
  let q = db.get('telemetry').filter({ mode: 'REAL' });
  if (deviceId) q = q.filter({ deviceId });
  const latest = q.takeRight(1).value()[0] || null;
  if (latest) {
    const risk = computeRiskScore(latest.state, latest.vibrationCount || 0);
    latest.riskScore = risk.score; latest.riskReasons = risk.reasons;
  }
  res.json(latest);
});

// ---------------- HISTORY ----------------
const RANGE_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };
app.get('/api/history', (req, res) => {
  const { range = '24h', deviceId } = req.query;
  const windowStart = Date.now() - (RANGE_MS[range] || RANGE_MS['24h']);
  let results = db.get('telemetry').value().filter(r => r.receivedAt >= windowStart && r.mode === 'REAL');
  if (deviceId) results = results.filter(r => r.deviceId === deviceId);
  res.json({ series: results.map(r => ({ t: r.receivedAt, temperature: r.temperature, humidity: r.humidity, vibrationCount: r.vibrationCount, riskScore: r.riskScore, state: r.state, simulated: !!r.simulated })) });
});

// ---------------- EVENTS / ALERTS ----------------
app.get('/api/events', (req, res) => res.json(db.get('events').value().slice(-300).reverse()));
app.get('/api/alerts', (req, res) => res.json(db.get('events').value().filter(e => ['CRITICAL', 'WARNING', 'SENSOR_FAULT'].includes(e.severity)).slice(-50).reverse()));
app.post('/api/events/:id/acknowledge', authenticate, (req, res) => {
  const entry = db.get('events').find({ id: req.params.id }).value();
  if (!entry) return res.status(404).json({ error: 'not found' });
  db.get('events').find({ id: req.params.id }).assign({ acknowledged: true, acknowledgedBy: req.user.username }).write();
  pushAudit({ actor: req.user.username, action: 'ACKNOWLEDGE_EVENT', details: { eventId: req.params.id } });
  res.json({ ok: true });
});

// ---------------- AI INSIGHTS (bundles all 34 features) ----------------
app.get('/api/ai/insights', (req, res) => {
  const { deviceId } = req.query;
  let recent = db.get('telemetry').value().filter(r => r.mode === 'REAL');
  if (deviceId) recent = recent.filter(r => r.deviceId === deviceId);
  const windowed = recent.slice(-200);
  const temps = windowed.filter(r => r.tempValid !== false).map(r => r.temperature);
  if (temps.length < 3) return res.json({ message: 'Not enough data yet — insights need a few minutes of readings.' });

  const cfg = db.get('config').value();
  const anomaly = anomalyCheck(temps);
  const trend = { direction: trendDirection(temps) };
  const eta = etaToCritical(temps, cfg);
  const drift = driftDetection(recent);
  const vibrationCorrelation = vibrationTempCorrelation(windowed);
  const tamper = tamperCheck(windowed);
  const exposure = coldChainExposureIndex(recent);
  const advice = generateAdvice(windowed[windowed.length - 1].state, { drift, vibrationCorrelation, tamperCheck: tamper });
  const latest = windowed[windowed.length - 1];

  res.json({
    disclaimer: 'Statistical/rule-based analysis, not a trained ML model — every number here is explainable.',
    summary: buildSummary({ latest, trend, eta, anomaly, exposure, advice }),
    trend: { ...trend, statement: `Prediction: temperature may continue ${trend.direction.toLowerCase()} if this trend persists.` },
    baseline: { normalRangeLow: +(anomaly.mean - 2 * anomaly.stdDev).toFixed(2), normalRangeHigh: +(anomaly.mean + 2 * anomaly.stdDev).toFixed(2) },
    anomaly: { isAnomaly: anomaly.isAnomaly, zScore: anomaly.zScore },
    eta, drift, vibrationCorrelation, tamperCheck: tamper,
    hourlyPattern: patternAnomaly(recent, temps[temps.length - 1]),
    reliability: reliabilityScore(windowed),
    adaptiveThreshold: adaptiveThresholdAdvisory(recent, cfg),
    sensorHealth: sensorHealthScore(deviceId || 'VAX-001'),
    coldChainExposure: exposure,
    advice,
    weekOverWeek: weekOverWeekComparison(recent),
    dataCompleteness: dataCompleteness(windowed),
    humidityStability: humidityStabilityIndex(windowed),
    staleDevice: staleDeviceCheck(windowed),
    learningMode: learningModeCheck(recent),
    location: cfg.location,
    vibrationSummary: { totalEventsRecentWindow: windowed.reduce((s, r) => s + (r.vibrationCount || 0), 0) },
    confidence: temps.length >= 30 ? 'HIGH' : temps.length >= 10 ? 'MEDIUM' : 'LOW'
  });
});

// ---------------- SECURITY ----------------
app.get('/api/security/status', authenticate, requireAdmin, (req, res) => {
  const chain = verifyAuditChain();
  const lockedAccounts = Object.entries(failedLogins).filter(([, v]) => v.lockedUntil > Date.now()).map(([k]) => k);
  res.json({ auditChainOk: !chain.tampered, auditEntriesChecked: chain.entriesChecked, lockedAccounts, recentConfigChanges: configChangeTimestamps.length });
});
app.get('/api/audit/verify', authenticate, requireAdmin, (req, res) => res.json(verifyAuditChain()));

// ---------------- CONFIG ----------------
app.get('/api/config', (req, res) => res.json(db.get('config').value()));
app.put('/api/config', authenticate, requireAdmin, (req, res) => {
  const allowed = ['tempLower', 'tempUpper', 'tempWarningBand', 'warningDurationMs', 'criticalDurationMs', 'vibrationSensitivity', 'deviceName'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  const newVersion = (db.get('config.configVersion').value() || 1) + 1;
  db.get('config').assign({ ...updates, configVersion: newVersion }).write();
  pushAudit({ actor: req.user.username, action: 'CONFIG_CHANGE', details: updates });
  flagRapidConfigChanges();
  res.json({ ok: true, config: db.get('config').value() });
});
app.put('/api/config/location', authenticate, requireAdmin, (req, res) => {
  const { lat, lng, label } = req.body || {};
  db.get('config').assign({ location: { lat: lat ?? null, lng: lng ?? null, label: label || '', source: 'MANUAL', accuracy: 'exact (manually entered)' } }).write();
  pushAudit({ actor: req.user.username, action: 'LOCATION_UPDATE', details: { lat, lng, label } });
  res.json({ ok: true, location: db.get('config.location').value() });
});

// ---------------- AUDIT ----------------
app.get('/api/audit', authenticate, (req, res) => res.json(db.get('audit').value().slice(-300).reverse()));

// ---------------- REPORTS + DOWNLOAD (#32) ----------------
app.get('/api/reports', authenticate, (req, res) => {
  const { deviceId, from, to } = req.query;
  const windowFrom = from ? Number(from) : Date.now() - 7 * 24 * 3600e3;
  const windowTo = to ? Number(to) : Date.now();
  let telemetry = db.get('telemetry').value().filter(r => r.receivedAt >= windowFrom && r.receivedAt <= windowTo && r.mode === 'REAL');
  if (deviceId) telemetry = telemetry.filter(r => r.deviceId === deviceId);
  const temps = telemetry.filter(r => r.tempValid !== false).map(r => r.temperature);
  const stats = runningStats(temps);
  res.json({
    deviceId: deviceId || 'ALL', period: { from: windowFrom, to: windowTo },
    temperatureMean: +stats.mean.toFixed(2), temperatureStdDev: +stats.stdDev.toFixed(2), samples: stats.n,
    vibrationEventsTotal: telemetry.reduce((s, r) => s + (r.vibrationCount || 0), 0),
    excursionReadings: telemetry.filter(r => ['WARNING', 'CRITICAL'].includes(r.state)).length,
    coldChainExposure: coldChainExposureIndex(telemetry)
  });
});
app.get('/api/reports/export', authenticate, (req, res) => {
  const { deviceId, from, to } = req.query;
  const windowFrom = from ? Number(from) : Date.now() - 7 * 24 * 3600e3;
  const windowTo = to ? Number(to) : Date.now();
  let rows = db.get('telemetry').value().filter(r => r.receivedAt >= windowFrom && r.receivedAt <= windowTo && r.mode === 'REAL');
  if (deviceId) rows = rows.filter(r => r.deviceId === deviceId);
  const header = 'timestamp,deviceId,temperature,tempValid,humidity,vibrationCount,state,riskScore,simulated\n';
  const csv = header + rows.map(r => [new Date(r.receivedAt).toISOString(), r.deviceId, r.temperature, r.tempValid, r.humidity, r.vibrationCount, r.state, r.riskScore, !!r.simulated].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="vaxguard-report-${Date.now()}.csv"`);
  pushAudit({ actor: req.user.username, action: 'REPORT_EXPORT', details: { deviceId, windowFrom, windowTo } });
  res.send(csv);
});

app.use('/', express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Internal error' }); });

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`VAXGUARD server running on port ${PORT}`));
