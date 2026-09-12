const express = require('express');
const cors = require('cors');
const path = require('path');
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
  telemetry: [],
  events: [],
  demo: { active: false, level: 'OFF' },
  config: {
    tempLower: 2.0, tempUpper: 8.0, tempWarningBand: 1.0,
    warningDurationMs: 20000, criticalDurationMs: 60000,
    deviceName: 'VaxGuard Unit 1', configVersion: 1
  }
}).write();

// ---------------- TELEGRAM (optional, safe no-op if not configured) ----------------
const lastAlertByType = {};
const COOLDOWN_MS = { WARNING: 60 * 1000, CRITICAL: 20 * 1000, INFO: 5 * 60 * 1000 };
async function sendTelegram(type, priority, message) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const now = Date.now();
  if (now - (lastAlertByType[type] || 0) < (COOLDOWN_MS[priority] || 60000)) return;
  lastAlertByType[type] = now;
  const icon = priority === 'CRITICAL' ? '🔴' : priority === 'INFO' ? '🟢' : '🟡';
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `${icon} VaxGuard ${priority}\n${message}` })
    });
  } catch (e) { console.error('[telegram] failed:', e.message); }
}

// ---------------- STATS HELPERS ----------------
function runningStats(series) {
  let n = 0, mean = 0, M2 = 0;
  for (const x of series) { n++; const d = x - mean; mean += d / n; M2 += d * (x - mean); }
  return { mean, stdDev: Math.sqrt(n > 1 ? M2 / (n - 1) : 0), n };
}
function linearRegression(series) {
  const n = series.length; if (n < 2) return { slope: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += series[i]; sumXY += i * series[i]; sumXX += i * i; }
  return { slope: (n * sumXY - sumX * sumY) / ((n * sumXX - sumX * sumX) || 1) };
}
function trendDirection(temps) {
  const { slope } = linearRegression(temps);
  return slope > 0.02 ? 'RISING' : slope < -0.02 ? 'FALLING' : 'STABLE';
}
function computeRiskScore(state, vibrationCount) {
  let score = 0; const reasons = [];
  if (state === 'WATCH') { score += 25; reasons.push('Temperature nearing band edge'); }
  if (state === 'WARNING') { score += 60; reasons.push('Temperature outside safe band'); }
  if (state === 'CRITICAL') { score += 90; reasons.push('Temperature critically out of range'); }
  if (state === 'SENSOR_FAULT') { score += 40; reasons.push('DHT11 sensor fault'); }
  if (vibrationCount >= 6) { score += 15; reasons.push('Abnormal vibration frequency'); }
  return { score: Math.min(100, score), reasons };
}
// Cold-chain "quality estimate" — heuristic only, clearly labeled, never claims medical certainty
function coldChainQualityEstimate(records) {
  const windowRecords = records.filter(r => Date.now() - r.receivedAt < 7 * 24 * 3600e3);
  let weightedMinutes = 0;
  for (let i = 1; i < windowRecords.length; i++) {
    const prev = windowRecords[i - 1], cur = windowRecords[i];
    const minutes = (cur.receivedAt - prev.receivedAt) / 60000;
    if (minutes <= 0 || minutes > 15) continue;
    if (prev.state === 'WARNING') weightedMinutes += minutes * 1;
    if (prev.state === 'CRITICAL') weightedMinutes += minutes * 3;
  }
  const score = Math.max(0, Math.round(100 - weightedMinutes * 0.5));
  const label = score > 80 ? 'GOOD' : score > 50 ? 'REDUCED CONFIDENCE' : 'DO NOT USE — INSPECT / VVM / LAB CHECK';
  return {
    score, label,
    disclaimer: 'ESTIMATE ONLY — a decision-support heuristic based on time-and-severity out of range. NOT a certified vaccine potency test. Always confirm with a physical Vaccine Vial Monitor or lab test before use.'
  };
}

// ---------------- DEMO CONTROL ----------------
// Website sets this; ESP32 polls it every ~1s
app.post('/api/demo', (req, res) => {
  const { level } = req.body || {};
  const valid = ['NORMAL', 'WARN', 'HIGH', 'LOW', 'OFF'];
  if (!valid.includes(level)) return res.status(400).json({ error: 'level must be one of ' + valid.join(', ') });
  if (level === 'OFF') {
    db.set('demo', { active: false, level: 'OFF' }).write();
  } else {
    db.set('demo', { active: true, level }).write();
  }
  res.json({ ok: true, demo: db.get('demo').value() });
});
app.get('/api/demo', (req, res) => res.json(db.get('demo').value()));

// ---------------- SENSORS INGEST ----------------
app.post('/api/sensors', (req, res) => {
  const body = req.body;
  if (!body || !body.deviceId || !body.state) return res.status(400).json({ error: 'deviceId and state required' });

  const riskCalc = computeRiskScore(body.state, body.vibrationCount || 0);
  const record = { ...body, riskScore: riskCalc.score, receivedAt: Date.now() };
  db.get('telemetry').push(record).write();
  // keep db lean
  if (db.get('telemetry').size().value() > 5000) db.get('telemetry').shift().write();

  const recent = db.get('telemetry').filter({ deviceId: body.deviceId }).takeRight(2).value();
  const prevState = recent.length > 1 ? recent[0].state : null;

  if (prevState && prevState !== body.state) {
    db.get('events').push({
      id: uuidv4(), timestamp: Date.now(), severity: body.state,
      previousState: prevState, newState: body.state, simulated: !!body.simulated,
      reason: `${body.simulated ? '[DEMO] ' : ''}State changed from ${prevState} to ${body.state}`,
      deviceId: body.deviceId
    }).write();

    if (body.state === 'CRITICAL') sendTelegram('CRITICAL', 'CRITICAL', `${body.deviceId}: CRITICAL — temp ${body.temperature}°C. Act now.${body.simulated ? ' [DEMO TEST]' : ''}`);
    if (body.state === 'WARNING') sendTelegram('WARNING', 'WARNING', `${body.deviceId}: Temperature drifting out of range (${body.temperature}°C).${body.simulated ? ' [DEMO TEST]' : ''}`);
    if (['SAFE', 'RECOVERY'].includes(body.state) && ['CRITICAL', 'WARNING'].includes(prevState)) {
      sendTelegram('RECOVERY', 'INFO', `${body.deviceId}: Back to normal range.${body.simulated ? ' [DEMO TEST]' : ''}`);
    }
  }
  res.json({ ok: true, riskScore: riskCalc.score, riskReasons: riskCalc.reasons });
});

app.get('/api/sensors/latest', (req, res) => {
  const { deviceId } = req.query;
  let q = db.get('telemetry');
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
const RANGE_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };
app.get('/api/history', (req, res) => {
  const { range = '1h', deviceId } = req.query;
  const windowStart = Date.now() - (RANGE_MS[range] || RANGE_MS['1h']);
  let results = db.get('telemetry').value().filter(r => r.receivedAt >= windowStart);
  if (deviceId) results = results.filter(r => r.deviceId === deviceId);
  res.json({
    series: results.map(r => ({
      t: r.receivedAt, temperature: r.temperature, humidity: r.humidity,
      vibrationCount: r.vibrationCount, state: r.state, simulated: !!r.simulated
    }))
  });
});

// ---------------- EVENTS / ALERTS ----------------
app.get('/api/events', (req, res) => res.json(db.get('events').value().slice(-200).reverse()));
app.get('/api/alerts', (req, res) => res.json(
  db.get('events').value().filter(e => ['WARNING', 'CRITICAL', 'SENSOR_FAULT'].includes(e.severity)).slice(-50).reverse()
));

// ---------------- AI INSIGHTS ----------------
app.get('/api/ai/insights', (req, res) => {
  const { deviceId } = req.query;
  let recent = db.get('telemetry').value();
  if (deviceId) recent = recent.filter(r => r.deviceId === deviceId);
  const windowed = recent.slice(-200);
  const temps = windowed.filter(r => r.tempValid !== false).map(r => r.temperature);
  if (temps.length < 3) return res.json({ message: 'Not enough data yet — collecting readings.' });

  const stats = runningStats(temps);
  const latest = windowed[windowed.length - 1];
  const trend = trendDirection(temps);
  const quality = coldChainQualityEstimate(recent);
  const risk = computeRiskScore(latest.state, latest.vibrationCount || 0);

  res.json({
    disclaimer: 'Rule-based statistical analysis — every number here is explainable, not a trained black-box model.',
    mode: latest.simulated ? 'DEMO' : 'REAL',
    trend: { direction: trend },
    baseline: { mean: +stats.mean.toFixed(2), stdDev: +stats.stdDev.toFixed(2) },
    riskScore: risk.score,
    riskReasons: risk.reasons,
    coldChainQuality: quality,
    confidence: temps.length >= 30 ? 'HIGH' : temps.length >= 10 ? 'MEDIUM' : 'LOW'
  });
});

// ---------------- CONFIG ----------------
app.get('/api/config', (req, res) => res.json(db.get('config').value()));
app.put('/api/config', (req, res) => {
  const allowed = ['tempLower', 'tempUpper', 'tempWarningBand', 'warningDurationMs', 'criticalDurationMs', 'deviceName'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  const newVersion = (db.get('config.configVersion').value() || 1) + 1;
  db.get('config').assign({ ...updates, configVersion: newVersion }).write();
  res.json({ ok: true, config: db.get('config').value() });
});

app.use('/', express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Internal error' }); });

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`VAXGUARD server running on port ${PORT}`));
