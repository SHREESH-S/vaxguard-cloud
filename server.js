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
    location: { lat: null, lng: null, label: '' }
  },
  payments: []
}).write();
// NOTE: Render free tier disk is EPHEMERAL — db.json resets on redeploy.

// ---------------- SECURITY: TAMPER-EVIDENT AUDIT LOG ----------------
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
    const recomputed = crypto.createHash('sha256').update(payload).digest('hex');
    if (recomputed !== e.hash) return { tampered: true, brokenAt: e.id, entriesChecked: entries.length };
    prevHash = e.hash;
  }
  return { tampered: false, brokenAt: null, entriesChecked: entries.length };
}

// ---------------- AUTH (with brute-force lockout) ----------------
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_INSECURE_DEFAULT';
const failedLogins = {}; // username -> { count, lockedUntil }

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid/expired token' }); }
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

function alertCopy(state, prevState, deviceId, temp, riskScore) {
  if (state === 'CRITICAL') return { type: 'CRITICAL', priority: 'CRITICAL', msg: `${deviceId}: Cold chain breach. Temp=${temp}°C, Risk=${riskScore}. Act now.` };
  if (state === 'WARNING') return { type: 'WARNING', priority: 'HIGH', msg: `${deviceId}: Temperature has been out of range for a while (${temp}°C). Worth checking.` };
  if (state === 'SENSOR_FAULT') return { type: 'FAULT', priority: 'WARNING', msg: `${deviceId}: Temperature sensor isn't responding. Readings paused until it's back.` };
  if (['SAFE', 'RECOVERY'].includes(state) && ['CRITICAL', 'WARNING'].includes(prevState)) {
    return { type: 'RECOVERY', priority: 'INFO', msg: `${deviceId}: All good again — back to ${state.toLowerCase()} range.` };
  }
  return null;
}

// ================= AI / STATISTICS LAYER (explainable, rule-based) =================

function linearRegression(series) {
  const n = series.length; if (n < 2) return { slope: 0, intercept: series[0] || 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += series[i]; sumXY += i * series[i]; sumXX += i * i; }
  const denom = (n * sumXX - sumX * sumX) || 1;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}
function runningStats(series) {
  let n = 0, mean = 0, M2 = 0;
  for (const x of series) { n++; const d = x - mean; mean += d / n; M2 += d * (x - mean); }
  return { mean, stdDev: Math.sqrt(n > 1 ? M2 / (n - 1) : 0), n };
}
function computeRiskScore(state, vibrationCount) {
  let score = 0; const reasons = [];
  if (state === 'WATCH') { score += 30; reasons.push('Temperature nearing configured band edge'); }
  if (state === 'WARNING') { score += 60; reasons.push('Temperature outside band, persisting'); }
  if (state === 'CRITICAL') { score += 90; reasons.push('Temperature critically out of range'); }
  if (state === 'SENSOR_FAULT') { score += 40; reasons.push('DHT11 sensor fault reduces confidence'); }
  if (vibrationCount >= 6) { score += 15; reasons.push('Abnormal vibration frequency detected'); }
  return { score: Math.min(100, score), reasons };
}
function trendDirection(temps) {
  const { slope } = linearRegression(temps);
  return slope > 0.02 ? 'RISING' : slope < -0.02 ? 'FALLING' : 'STABLE';
}
function anomalyCheck(temps) {
  const { mean, stdDev, n } = runningStats(temps);
  const latest = temps[temps.length - 1];
  const z = stdDev ? (latest - mean) / stdDev : 0;
  return { isAnomaly: Math.abs(z) > 2.5, zScore: +z.toFixed(2), mean, stdDev, n };
}
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
function hourlyPatternBaseline(records) {
  const buckets = Array.from({ length: 24 }, () => []);
  for (const r of records) {
    if (r.tempValid === false || r.temperature == null || isNaN(r.temperature)) continue;
    buckets[new Date(r.receivedAt).getHours()].push(r.temperature);
  }
  return buckets.map((vals, hour) => ({ hour, ...runningStats(vals) }));
}
function patternAnomaly(records, latestTemp) {
  const baseline = hourlyPatternBaseline(records);
  const bucket = baseline[new Date().getHours()];
  if (!bucket || bucket.n < 5) return { available: false };
  const z = bucket.stdDev ? (latestTemp - bucket.mean) / bucket.stdDev : 0;
  return { available: true, hour: bucket.hour, expectedMean: +bucket.mean.toFixed(2), zScore: +z.toFixed(2), unusualForThisHour: Math.abs(z) > 2.5 };
}
function driftDetection(records) {
  const daily = {};
  for (const r of records) {
    if (r.tempValid === false || r.temperature == null) continue;
    const day = new Date(r.receivedAt).toISOString().slice(0, 10);
    (daily[day] = daily[day] || []).push(r.temperature);
  }
  const days = Object.keys(daily).sort();
  if (days.length < 4) return { available: false };
  const { slope } = linearRegression(days.map(d => runningStats(daily[d]).mean));
  return { available: true, driftPerDay: +slope.toFixed(3), driftSuspected: Math.abs(slope) > 0.15 };
}
function vibrationTempCorrelation(records) {
  let flagged = 0;
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1], cur = records[i];
    if ((cur.vibrationCount || 0) >= 3 && prev.tempValid !== false && cur.tempValid !== false && cur.temperature - prev.temperature > 0.5) flagged++;
  }
  return { likelyDoorOpenEvents: flagged };
}
function reliabilityScore(records) {
  if (records.length < 2) return { score: 100, missedIntervals: 0 };
  let missed = 0;
  for (let i = 1; i < records.length; i++) if (records[i].receivedAt - records[i - 1].receivedAt > 15000) missed++;
  return { score: Math.max(0, 100 - missed * 2), missedIntervals: missed };
}
function adaptiveThresholdAdvisory(records, cfg) {
  const stableTemps = records.filter(r => r.state === 'SAFE' && r.tempValid !== false).map(r => r.temperature);
  if (stableTemps.length < 20) return { available: false };
  const { mean, stdDev } = runningStats(stableTemps);
  return {
    available: true,
    suggestedLower: +(mean - 2 * stdDev).toFixed(1), suggestedUpper: +(mean + 2 * stdDev).toFixed(1),
    currentLower: cfg.tempLower, currentUpper: cfg.tempUpper,
    note: 'Advisory only — observed stable-state variance, not a medical/regulatory limit.'
  };
}
// Sensor health / predictive maintenance — fault frequency decay model
function sensorHealthScore(deviceId) {
  const faults = db.get('sensorFaultLog').filter({ deviceId }).value();
  const now = Date.now();
  const last30d = faults.filter(f => now - f.timestamp < 30 * 24 * 3600e3);
  const last7d = faults.filter(f => now - f.timestamp < 7 * 24 * 3600e3);
  const score = Math.max(0, Math.min(100, 100 - last30d.length * 3 - last7d.length * 5));
  return {
    score, faultsLast30d: last30d.length, faultsLast7d: last7d.length,
    maintenanceRecommended: score < 60,
    note: 'Heuristic based on recent DHT11 fault frequency, not a manufacturer spec.'
  };
}
// Tamper / possible-movement heuristic — big connectivity gap + a vibration burst around it
function tamperCheck(records) {
  if (records.length < 2) return { suspected: false };
  const last = records[records.length - 1], prev = records[records.length - 2];
  const gap = last.receivedAt - prev.receivedAt;
  const suspected = gap > 30000 && (last.vibrationCount || 0) >= 3;
  return { suspected, gapMs: gap, note: suspected ? 'Long silent gap followed by vibration — worth a physical check.' : undefined };
}

// ---------------- CONFIG-CHANGE ANOMALY (security) ----------------
let configChangeTimestamps = [];
function flagRapidConfigChanges() {
  const now = Date.now();
  configChangeTimestamps = configChangeTimestamps.filter(t => now - t < 10 * 60 * 1000);
  configChangeTimestamps.push(now);
  if (configChangeTimestamps.length >= 3) {
    sendTelegram('CONFIG_ANOMALY', 'HIGH', 'Security: thresholds changed 3+ times in 10 minutes. Confirm this was authorized.');
    return true;
  }
  return false;
}

// ---------------- DEMO MODE STATE MACHINE ----------------
const demoTrackers = {};
function evaluateDemoState(deviceId, tempValid, temp, cfg) {
  const now = Date.now();
  const t = demoTrackers[deviceId] || (demoTrackers[deviceId] = { current: 'SAFE', wasOutOfRange: false, since: 0 });
  if (!tempValid) return t.current;
  const hysteresis = 0.3;
  const outOfRange = (temp < cfg.tempLower - hysteresis) || (temp > cfg.tempUpper + hysteresis);
  const inWatchBand = !outOfRange && ((temp < cfg.tempLower + cfg.tempWarningBand) || (temp > cfg.tempUpper - cfg.tempWarningBand));
  if (outOfRange) {
    if (!t.wasOutOfRange) { t.since = now; t.wasOutOfRange = true; }
    const duration = now - t.since;
    t.current = duration >= cfg.criticalDurationMs ? 'CRITICAL' : duration >= cfg.warningDurationMs ? 'WARNING' : 'WATCH';
  } else {
    if (t.wasOutOfRange) { t.wasOutOfRange = false; t.current = 'RECOVERY'; }
    else t.current = inWatchBand ? 'WATCH' : 'SAFE';
  }
  return t.current;
}

// ---------------- SENSORS INGEST (REAL hardware) ----------------
app.post('/api/sensors', (req, res) => {
  const body = req.body;
  if (!body || !body.deviceId || !body.state) return res.status(400).json({ error: 'deviceId and state required' });

  const riskCalc = computeRiskScore(body.state, body.vibrationCount || 0);
  const record = { ...body, mode: 'REAL', riskScore: riskCalc.score, receivedAt: Date.now() };
  db.get('telemetry').push(record).write();

  const recent = db.get('telemetry').filter({ deviceId: body.deviceId, mode: 'REAL' }).takeRight(2).value();
  const prevState = recent.length > 1 ? recent[0].state : null;

  if (prevState && prevState !== body.state) {
    db.get('events').push({
      id: uuidv4(), timestamp: Date.now(), type: 'STATE_CHANGE', mode: 'REAL',
      severity: body.state, previousState: prevState, newState: body.state,
      reason: `State changed from ${prevState} to ${body.state}`, deviceId: body.deviceId
    }).write();

    if (body.state === 'SENSOR_FAULT') db.get('sensorFaultLog').push({ deviceId: body.deviceId, timestamp: Date.now() }).write();

    const alert = alertCopy(body.state, prevState, body.deviceId, body.temperature, riskCalc.score);
    if (alert) sendTelegram(alert.type, alert.priority, alert.msg);
  }

  if ((body.vibrationCount || 0) >= 6) {
    sendTelegram('VIBRATION', 'HIGH', `${body.deviceId}: unusual vibration burst (${body.vibrationCount} events) — worth a look.`);
  }

  res.json({ ok: true, riskScore: riskCalc.score, riskReasons: riskCalc.reasons });
});

// ---------------- DEMO MODE INGEST — Telegram fires only on CRITICAL, clearly labeled ----------------
app.post('/api/demo/telemetry', (req, res) => {
  const { deviceId = 'VAX-001', temperature, humidity = 50 } = req.body || {};
  if (temperature == null || isNaN(temperature)) return res.status(400).json({ error: 'temperature required' });
  const cfg = db.get('config').value();
  const vibrationCount = req.body.vibrationCount ?? Math.floor(Math.random() * 2);
  const prevState = demoTrackers[deviceId]?.current || 'SAFE';
  const state = evaluateDemoState(deviceId, true, temperature, cfg);
  const riskCalc = computeRiskScore(state, vibrationCount);

  const record = {
    deviceId, mode: 'DEMO', temperature, tempValid: true, humidity, vibrationCount,
    state, riskScore: riskCalc.score, firmwareVersion: 'demo', receivedAt: Date.now(),
    sensorHealth: { dht11: 'ONLINE', sw420: 'ONLINE' }
  };
  db.get('telemetry').push(record).write();

  if (prevState !== state) {
    db.get('events').push({
      id: uuidv4(), timestamp: Date.now(), type: 'STATE_CHANGE', mode: 'DEMO',
      severity: state, previousState: prevState, newState: state,
      reason: `[DEMO] State changed from ${prevState} to ${state}`, deviceId
    }).write();
  }
  if (state === 'CRITICAL') {
    sendTelegram('DEMO_CRITICAL', 'CRITICAL', `[DEMO/TEST] ${deviceId}: simulated CRITICAL reading (${temperature}°C). This is a demo, not real hardware.`);
  }

  res.json({ ok: true, state, riskScore: riskCalc.score, riskReasons: riskCalc.reasons });
});

app.get('/api/sensors/latest', (req, res) => {
  const { deviceId, mode = 'REAL' } = req.query;
  let q = db.get('telemetry').filter({ mode });
  if (deviceId) q = q.filter({ deviceId });
  const latest = q.takeRight(1).value()[0] || null;
  if (latest) {
    const risk = computeRiskScore(latest.state, latest.vibrationCount || 0);
    latest.riskScore = risk.score;
    latest.riskReasons = risk.reasons;
  }
  res.json(latest);
});

// ---------------- HISTORY ----------------
const RANGE_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };
app.get('/api/history', (req, res) => {
  const { range = '24h', deviceId, mode = 'REAL' } = req.query;
  const windowStart = Date.now() - (RANGE_MS[range] || RANGE_MS['24h']);
  let results = db.get('telemetry').value().filter(r => r.receivedAt >= windowStart && r.mode === mode);
  if (deviceId) results = results.filter(r => r.deviceId === deviceId);
  res.json({ series: results.map(r => ({ t: r.receivedAt, temperature: r.temperature, humidity: r.humidity, vibrationCount: r.vibrationCount, riskScore: r.riskScore, state: r.state })) });
});

// ---------------- EVENTS / ALERTS ----------------
app.get('/api/events', (req, res) => {
  const { mode } = req.query;
  let list = db.get('events').value();
  if (mode) list = list.filter(e => e.mode === mode);
  res.json(list.slice(-300).reverse());
});
app.get('/api/alerts', (req, res) => {
  const { mode = 'REAL' } = req.query;
  res.json(db.get('events').value().filter(e => e.mode === mode && ['CRITICAL', 'WARNING', 'SENSOR_FAULT'].includes(e.severity)).slice(-50).reverse());
});
app.post('/api/events/:id/acknowledge', authenticate, (req, res) => {
  const entry = db.get('events').find({ id: req.params.id }).value();
  if (!entry) return res.status(404).json({ error: 'not found' });
  db.get('events').find({ id: req.params.id }).assign({ acknowledged: true, acknowledgedBy: req.user.username }).write();
  pushAudit({ actor: req.user.username, action: 'ACKNOWLEDGE_EVENT', details: { eventId: req.params.id } });
  res.json({ ok: true });
});

// ---------------- AI INSIGHTS ----------------
app.get('/api/ai/insights', (req, res) => {
  const { deviceId, mode = 'REAL' } = req.query;
  let recent = db.get('telemetry').value().filter(r => r.mode === mode);
  if (deviceId) recent = recent.filter(r => r.deviceId === deviceId);
  const windowed = recent.slice(-200);
  const temps = windowed.filter(r => r.tempValid !== false).map(r => r.temperature);
  if (temps.length < 3) return res.json({ message: 'Not enough data yet — insights need a few minutes of readings.' });

  const cfg = db.get('config').value();
  const anomaly = anomalyCheck(temps);

  res.json({
    disclaimer: 'Statistical/rule-based analysis, not a trained ML model — every number here is explainable.',
    trend: { direction: trendDirection(temps), statement: `Prediction: temperature may continue ${trendDirection(temps).toLowerCase()} if this trend persists.` },
    baseline: { normalRangeLow: +(anomaly.mean - 2 * anomaly.stdDev).toFixed(2), normalRangeHigh: +(anomaly.mean + 2 * anomaly.stdDev).toFixed(2) },
    anomaly: { isAnomaly: anomaly.isAnomaly, zScore: anomaly.zScore },
    eta: etaToCritical(temps, cfg),
    hourlyPattern: patternAnomaly(recent, temps[temps.length - 1]),
    drift: driftDetection(recent),
    vibrationCorrelation: vibrationTempCorrelation(windowed),
    reliability: reliabilityScore(windowed),
    adaptiveThreshold: adaptiveThresholdAdvisory(recent, cfg),
    sensorHealth: mode === 'REAL' ? sensorHealthScore(deviceId || 'VAX-001') : { note: 'Sensor health is only tracked for real hardware.' },
    tamperCheck: tamperCheck(windowed),
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
  db.get('config').assign({ location: { lat: lat ?? null, lng: lng ?? null, label: label || '' } }).write();
  pushAudit({ actor: req.user.username, action: 'LOCATION_UPDATE', details: { lat, lng, label } });
  res.json({ ok: true, location: db.get('config.location').value() });
});

// ---------------- AUDIT ----------------
app.get('/api/audit', authenticate, (req, res) => res.json(db.get('audit').value().slice(-300).reverse()));

// ---------------- REPORTS ----------------
app.get('/api/reports', authenticate, (req, res) => {
  const { deviceId, from, to, mode = 'REAL' } = req.query;
  const windowFrom = from ? Number(from) : Date.now() - 7 * 24 * 3600e3;
  const windowTo = to ? Number(to) : Date.now();
  let telemetry = db.get('telemetry').value().filter(r => r.receivedAt >= windowFrom && r.receivedAt <= windowTo && r.mode === mode);
  if (deviceId) telemetry = telemetry.filter(r => r.deviceId === deviceId);
  const temps = telemetry.filter(r => r.tempValid !== false).map(r => r.temperature);
  const stats = runningStats(temps);
  res.json({
    deviceId: deviceId || 'ALL', period: { from: windowFrom, to: windowTo },
    temperatureMean: +stats.mean.toFixed(2), temperatureStdDev: +stats.stdDev.toFixed(2), samples: stats.n,
    vibrationEventsTotal: telemetry.reduce((s, r) => s + (r.vibrationCount || 0), 0),
    excursionReadings: telemetry.filter(r => ['WARNING', 'CRITICAL'].includes(r.state)).length
  });
});

// ---------------- PAYMENTS (architecture only) ----------------
const PLANS = {
  FREE_DEMO: { name: 'Free Demo', priceINR: 0 },
  STUDENT: { name: 'Student', priceINR: 199 },
  PRO: { name: 'Pro', priceINR: 999 },
  ENTERPRISE: { name: 'Enterprise', priceINR: null }
};
app.get('/api/payments/plans', (req, res) => res.json(PLANS));
app.post('/api/payments/create-order', authenticate, (req, res) => {
  const { plan } = req.body || {};
  if (!PLANS[plan]) return res.status(400).json({ error: 'unknown plan' });
  const order = { id: uuidv4(), username: req.user.username, plan, amountINR: PLANS[plan].priceINR, status: 'PENDING', createdAt: Date.now() };
  db.get('payments').push(order).write();
  res.json({ order, note: 'Wire order.id into your payment provider SDK (Razorpay/Stripe) checkout, confirm via signed webhook.' });
});
app.post('/api/payments/webhook', (req, res) => {
  const { orderId, status } = req.body || {};
  if (!db.get('payments').find({ id: orderId }).value()) return res.status(404).json({ error: 'not found' });
  db.get('payments').find({ id: orderId }).assign({ status, updatedAt: Date.now() }).write();
  res.json({ ok: true });
});

app.use('/', express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Internal error' }); });

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`VAXGUARD server running on port ${PORT}`));
