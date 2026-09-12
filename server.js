require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
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
  config: {
    tempLower: 2.0, tempUpper: 8.0, tempWarningBand: 1.0,
    warningDurationMs: 60000, criticalDurationMs: 180000,
    vibrationSensitivity: 3,
    deviceName: "VaxGuard Unit 1", configVersion: 1
  },
  payments: []
}).write();
// NOTE: Render free tier has an EPHEMERAL disk — db.json resets on redeploy.
// Fine for a demo; swap for MongoDB Atlas free tier for permanent storage.

// ---------------- AUTH ----------------
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_INSECURE_DEFAULT';

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
  const user = db.get('users').find({ username }).value();
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: '4h' });
  db.get('audit').push({ id: uuidv4(), timestamp: Date.now(), actor: username, action: 'LOGIN' }).write();
  res.json({ token, role: user.role });
});

// One-time bootstrap — self-disables once an admin exists, safe to leave in
app.post('/api/auth/bootstrap-admin', async (req, res) => {
  if (db.get('users').value().length > 0) return res.status(403).json({ error: 'Admin already exists' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const passwordHash = await bcrypt.hash(password, 10);
  db.get('users').push({ username, passwordHash, role: 'admin' }).write();
  res.json({ ok: true });
});

// ---------------- TELEGRAM (dedup + cooldown, no spam) ----------------
const lastAlertByType = {};
const COOLDOWN_MS = { WARNING: 5 * 60 * 1000, HIGH: 2 * 60 * 1000, CRITICAL: 30 * 1000, INFO: 15 * 60 * 1000 };

async function sendTelegram(eventType, priority, message) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const now = Date.now();
  if (now - (lastAlertByType[eventType] || 0) < (COOLDOWN_MS[priority] || COOLDOWN_MS.WARNING)) return;
  lastAlertByType[eventType] = now;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `🛡️ VAXGUARD ${priority}\n${message}` })
    });
  } catch (e) { console.error('[telegram] failed:', e.message); }
}

// ---------------- AI HELPERS (real, explainable statistics) ----------------
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
function computeRiskScore(state, vibrationCount) {
  let score = 0;
  const reasons = [];
  if (state === 'WATCH') { score += 30; reasons.push('Temperature nearing configured band edge'); }
  if (state === 'WARNING') { score += 60; reasons.push('Temperature outside band, persisting'); }
  if (state === 'CRITICAL') { score += 90; reasons.push('Temperature critically out of range'); }
  if (state === 'SENSOR_FAULT') { score += 40; reasons.push('DHT11 sensor fault reduces confidence'); }
  if (vibrationCount >= 6) { score += 15; reasons.push('Abnormal vibration frequency detected'); }
  return { score: Math.min(100, score), reasons };
}

// ---------------- SENSORS INGEST (ESP32 posts here) ----------------
app.post('/api/sensors', (req, res) => {
  const body = req.body;
  if (!body || !body.deviceId || !body.state) return res.status(400).json({ error: 'deviceId and state required' });

  const riskCalc = computeRiskScore(body.state, body.vibrationCount || 0);
  const record = { ...body, riskScore: riskCalc.score, receivedAt: Date.now() };
  db.get('telemetry').push(record).write();

  const recent = db.get('telemetry').filter({ deviceId: body.deviceId, mode: body.mode || 'REAL' }).takeRight(2).value();
  const prevState = recent.length > 1 ? recent[0].state : null;

  if (prevState && prevState !== body.state) {
    db.get('events').push({
      id: uuidv4(), timestamp: Date.now(), type: 'STATE_CHANGE',
      severity: body.state, previousState: prevState, newState: body.state,
      reason: `State changed from ${prevState} to ${body.state}`, deviceId: body.deviceId
    }).write();

    if (body.state === 'CRITICAL') sendTelegram('CRITICAL', 'CRITICAL', `${body.deviceId}: CRITICAL. Temp=${body.temperature}°C, Risk=${riskCalc.score}`);
    else if (body.state === 'WARNING') sendTelegram('WARNING', 'HIGH', `${body.deviceId}: WARNING state persisting.`);
    else if (body.state === 'SENSOR_FAULT') sendTelegram('FAULT', 'WARNING', `${body.deviceId}: DHT11 sensor fault.`);
    else if (['SAFE', 'RECOVERY'].includes(body.state) && ['CRITICAL', 'WARNING'].includes(prevState)) {
      sendTelegram('RECOVERY', 'INFO', `${body.deviceId}: recovered to ${body.state}.`);
    }
  }

  // High vibration burst gets its own alert, independent of temperature state
  if ((body.vibrationCount || 0) >= 6) {
    sendTelegram('VIBRATION', 'HIGH', `${body.deviceId}: abnormal vibration burst (${body.vibrationCount} events).`);
  }

  res.json({ ok: true, riskScore: riskCalc.score, riskReasons: riskCalc.reasons });
});

app.get('/api/sensors/latest', (req, res) => {
  const { deviceId } = req.query;
  let q = db.get('telemetry');
  if (deviceId) q = q.filter({ deviceId });
  res.json(q.takeRight(1).value()[0] || null);
});

// ---------------- HISTORY ----------------
const RANGE_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };
app.get('/api/history', (req, res) => {
  const { range = '24h', deviceId, mode = 'REAL' } = req.query;
  const windowEnd = Date.now(), windowStart = windowEnd - (RANGE_MS[range] || RANGE_MS['24h']);
  let results = db.get('telemetry').value().filter(r => r.receivedAt >= windowStart && r.mode === mode);
  if (deviceId) results = results.filter(r => r.deviceId === deviceId);
  res.json({
    series: results.map(r => ({
      t: r.receivedAt, temperature: r.temperature, humidity: r.humidity,
      vibrationCount: r.vibrationCount, riskScore: r.riskScore, state: r.state
    }))
  });
});

// ---------------- EVENTS / ALERTS ----------------
app.get('/api/events', (req, res) => res.json(db.get('events').value().slice(-300).reverse()));
app.get('/api/alerts', (req, res) => {
  res.json(db.get('events').value().filter(e => ['CRITICAL', 'WARNING', 'SENSOR_FAULT'].includes(e.severity)).slice(-50).reverse());
});
app.post('/api/events/:id/acknowledge', authenticate, (req, res) => {
  const entry = db.get('events').find({ id: req.params.id }).value();
  if (!entry) return res.status(404).json({ error: 'not found' });
  db.get('events').find({ id: req.params.id }).assign({ acknowledged: true, acknowledgedBy: req.user.username }).write();
  res.json({ ok: true });
});

// ---------------- PREDICTIONS (AI-style, explainable) ----------------
app.get('/api/predictions', (req, res) => {
  const { deviceId, mode = 'REAL' } = req.query;
  let recent = db.get('telemetry').value().filter(r => r.mode === mode);
  if (deviceId) recent = recent.filter(r => r.deviceId === deviceId);
  recent = recent.slice(-100);
  const temps = recent.filter(r => r.tempValid !== false).map(r => r.temperature);
  if (temps.length < 3) return res.json({ message: 'Not enough data yet.' });

  const { slope } = linearRegression(temps);
  const direction = slope > 0.02 ? 'RISING' : slope < -0.02 ? 'FALLING' : 'STABLE';
  const { mean, stdDev, n } = runningStats(temps);
  const latest = temps[temps.length - 1];
  const z = stdDev ? (latest - mean) / stdDev : 0;
  const vibrationTotal = recent.reduce((s, r) => s + (r.vibrationCount || 0), 0);

  res.json({
    disclaimer: 'Statistical estimate based on recent trend, not a guaranteed outcome.',
    trend: { direction, statement: `Prediction: temperature may continue ${direction.toLowerCase()} if this trend persists.` },
    baseline: { normalRangeLow: +(mean - 2 * stdDev).toFixed(2), normalRangeHigh: +(mean + 2 * stdDev).toFixed(2) },
    anomaly: { isAnomaly: Math.abs(z) > 2.5, zScore: +z.toFixed(2) },
    vibrationSummary: { totalEventsRecentWindow: vibrationTotal },
    confidence: n >= 30 ? 'HIGH' : n >= 10 ? 'MEDIUM' : 'LOW'
  });
});

// ---------------- CONFIG ----------------
app.get('/api/config', (req, res) => res.json(db.get('config').value()));
app.put('/api/config', authenticate, requireAdmin, (req, res) => {
  const allowed = ['tempLower', 'tempUpper', 'tempWarningBand', 'warningDurationMs', 'criticalDurationMs', 'vibrationSensitivity', 'deviceName'];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  const newVersion = (db.get('config.configVersion').value() || 1) + 1;
  db.get('config').assign({ ...updates, configVersion: newVersion }).write();
  db.get('audit').push({ id: uuidv4(), timestamp: Date.now(), actor: req.user.username, action: 'CONFIG_CHANGE', details: updates }).write();
  res.json({ ok: true, config: db.get('config').value() });
});

// ---------------- AUDIT ----------------
app.get('/api/audit', authenticate, (req, res) => res.json(db.get('audit').value().slice(-300).reverse()));

// ---------------- REPORTS ----------------
app.get('/api/reports', authenticate, (req, res) => {
  const { deviceId, from, to } = req.query;
  const windowFrom = from ? Number(from) : Date.now() - 7 * 24 * 3600e3;
  const windowTo = to ? Number(to) : Date.now();
  let telemetry = db.get('telemetry').value().filter(r => r.receivedAt >= windowFrom && r.receivedAt <= windowTo);
  if (deviceId) telemetry = telemetry.filter(r => r.deviceId === deviceId);
  const temps = telemetry.filter(r => r.tempValid !== false).map(r => r.temperature);
  const stats = runningStats(temps);
  const vibrationTotal = telemetry.reduce((s, r) => s + (r.vibrationCount || 0), 0);
  res.json({
    deviceId: deviceId || 'ALL', period: { from: windowFrom, to: windowTo },
    temperatureMean: stats.mean, temperatureStdDev: stats.stdDev, samples: stats.n,
    vibrationEventsTotal: vibrationTotal
  });
});

// ---------------- PAYMENTS (architecture only — no card data ever touches this server) ----------------
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

// ---------------- Serve dashboard (voice assistant + payment UI built in) ----------------
app.use('/', express.static(path.join(__dirname, '..', 'frontend')));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Internal error' }); });

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`VAXGUARD server running on port ${PORT}`));
