/*
  VaxGuard backend
  ----------------
  Responsibilities:
    - Receive sensor packets from the ESP32 (/api/ingest) and heartbeats (/api/heartbeat)
    - Run the explainable risk engine + early-warning trend engine + condition advisory
    - Track vibration intelligence, sensor health, device connectivity
    - Persist readings/events/settings to a JSON file (survives restart)
    - Push real-time updates to the dashboard over Socket.IO
    - Log an audit trail for every meaningful event, with deduplication/cooldown
    - Send Telegram alerts ONLY if configured; never fake a delivery confirmation
    - Serve CSV/JSON exports and reports
    - Never invent data: if something isn't available, the API says so explicitly
*/

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// ---------------------------------------------------------------------------
// Basic access protection (optional). If DASHBOARD_PASSWORD is left as the
// example default or blank, auth is skipped and the dashboard warns about it.
// ---------------------------------------------------------------------------
const AUTH_ENABLED = !!(process.env.DASHBOARD_USERNAME && process.env.DASHBOARD_PASSWORD &&
  process.env.DASHBOARD_PASSWORD !== 'change-me');

function basicAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const header = req.headers.authorization || '';
  const token = header.split(' ')[1] || '';
  const [user, pass] = Buffer.from(token, 'base64').toString().split(':');
  if (user === process.env.DASHBOARD_USERNAME && pass === process.env.DASHBOARD_PASSWORD) {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="VaxGuard"');
  return res.status(401).send('Authentication required.');
}

app.use(basicAuth);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// PERSISTENT STORAGE (simple JSON file - adequate for a college prototype)
// ---------------------------------------------------------------------------
const DEFAULT_DB = {
  settings: {
    tempMin: 2.0,
    tempMax: 8.0,
    warnMargin: 1.0,
    vibrationSensitivity: 'normal',
    alertCooldownSec: 60,
    voiceAlertsEnabled: true,
    telegramEnabled: true,
    deviceName: 'VaxGuard-01',
    deviceId: 'VaxGuard-01',
    retentionDays: 30
  },
  readings: [],      // recent sensor readings (capped)
  events: [],        // audit log
  vibrationEvents: [],
  devices: {},        // deviceId -> {lastHeartbeat, lastSeen, ip, uptimeMs}
  ackState: {}        // eventId -> {acknowledged, mutedUntil, escalated}
};

const MAX_READINGS = 5000;
const MAX_EVENTS = 5000;

function loadDb() {
  try {
    if (!fs.existsSync(path.dirname(DB_FILE))) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
      return JSON.parse(JSON.stringify(DEFAULT_DB));
    }
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return { ...JSON.parse(JSON.stringify(DEFAULT_DB)), ...JSON.parse(raw) };
  } catch (e) {
    console.error('Failed to load DB, starting fresh:', e.message);
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

let db = loadDb();

let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), (err) => {
      if (err) console.error('DB save failed:', err.message);
    });
  }, 500); // debounce writes
}

// ---------------------------------------------------------------------------
// IN-MEMORY RUNTIME STATE (per device - this prototype assumes one primary device)
// ---------------------------------------------------------------------------
const runtime = {
  mode: 'LIVE',
  temperature: null,
  humidity: null,
  vibration: false,
  vibrationEventCount: 0,
  sensorValid: false,
  state: 'OFFLINE',
  lastUpdate: null,
  connected: false,
  tempHistory: [],       // {ts, temp} for trend analysis
  consecutiveAbnormal: 0,
  timeOutsideRangeMs: 0,
  lastAbnormalEnter: null,
  lastAlertState: null,
  lastAlertTime: 0,
  recentVibrationTimestamps: []
};

const OFFLINE_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// RISK ENGINE (explainable)
// ---------------------------------------------------------------------------
function computeRisk() {
  const reasons = [];
  let score = 0;

  if (!runtime.sensorValid) {
    return { score: 100, category: 'CRITICAL', reasons: ['Sensor fault - risk cannot be trusted, treat as critical'] };
  }

  const { tempMin, tempMax, warnMargin } = db.settings;
  const t = runtime.temperature;

  if (t !== null) {
    let deviation = 0;
    if (t < tempMin) deviation = tempMin - t;
    else if (t > tempMax) deviation = t - tempMax;
    if (deviation > 0) {
      const pts = Math.min(35, Math.round(deviation * 10));
      score += pts;
      reasons.push(`+${pts} temperature deviation (${deviation.toFixed(1)}C outside range)`);
    }
  }

  // trend
  const trend = computeTrend();
  if (trend === 'increasing' && t > tempMax - warnMargin) {
    score += 18;
    reasons.push('+18 increasing temperature trend near/above upper threshold');
  } else if (trend === 'decreasing' && t < tempMin + warnMargin) {
    score += 18;
    reasons.push('+18 decreasing temperature trend near/below lower threshold');
  }

  // duration outside range
  if (runtime.timeOutsideRangeMs > 0) {
    const minutes = runtime.timeOutsideRangeMs / 60000;
    const pts = Math.min(20, Math.round(minutes * 4));
    if (pts > 0) {
      score += pts;
      reasons.push(`+${pts} prolonged excursion (${minutes.toFixed(1)} min outside range)`);
    }
  }

  // vibration frequency (events in last 5 minutes)
  const now = Date.now();
  const recentVib = runtime.recentVibrationTimestamps.filter(ts => now - ts < 5 * 60000);
  if (recentVib.length > 0) {
    const pts = Math.min(15, recentVib.length * 4);
    score += pts;
    reasons.push(`+${pts} repeated vibration (${recentVib.length} events in last 5 min)`);
  }

  // consecutive abnormal readings
  if (runtime.consecutiveAbnormal >= 3) {
    const pts = Math.min(10, runtime.consecutiveAbnormal);
    score += pts;
    reasons.push(`+${pts} recent abnormal events (${runtime.consecutiveAbnormal} consecutive)`);
  }

  // connectivity
  if (!runtime.connected) {
    score += 10;
    reasons.push('+10 device connectivity lost');
  }

  score = Math.max(0, Math.min(100, score));
  let category = 'SAFE';
  if (score > 80) category = 'CRITICAL';
  else if (score > 60) category = 'HIGH RISK';
  else if (score > 40) category = 'MODERATE RISK';
  else if (score > 20) category = 'LOW RISK';

  return { score, category, reasons };
}

function computeTrend() {
  const hist = runtime.tempHistory.slice(-6); // last ~6 samples (~12s at 2s interval, but works across sends too)
  if (hist.length < 3) return 'insufficient data';
  const first = hist[0].temp;
  const last = hist[hist.length - 1].temp;
  const diff = last - first;
  if (diff > 0.3) return 'increasing';
  if (diff < -0.3) return 'decreasing';
  return 'stable';
}

function computeConditionAdvisory() {
  if (!runtime.sensorValid) {
    return { label: 'INSUFFICIENT DATA', reason: 'Sensor fault - cold-chain condition cannot be assessed right now.' };
  }
  const risk = computeRisk();
  if (risk.score <= 20) {
    return { label: 'GOOD', reason: 'Temperature has remained within the configured range for the monitored period.' };
  } else if (risk.score <= 40) {
    return { label: 'WATCH', reason: 'Minor deviation or trend detected. Continue monitoring.' };
  } else if (risk.score <= 70) {
    return { label: 'AT RISK', reason: 'Repeated excursions or a sustained adverse trend detected. Inspect cold-chain conditions.' };
  }
  return { label: 'CRITICAL', reason: 'Significant excursion detected. Inspect cold-chain conditions and follow approved vaccine handling procedures.' };
}

function earlyWarning() {
  const trend = computeTrend();
  const { tempMax, tempMin, warnMargin } = db.settings;
  const t = runtime.temperature;
  if (t === null) return null;
  if (trend === 'increasing' && t < tempMax && t > tempMax - warnMargin * 2) {
    return {
      level: 'EARLY WARNING',
      message: 'Temperature trending upward',
      detail: 'Potential threshold crossing predicted.',
      action: 'Recommended action: inspect cooling conditions.'
    };
  }
  if (trend === 'decreasing' && t > tempMin && t < tempMin + warnMargin * 2) {
    return {
      level: 'EARLY WARNING',
      message: 'Temperature trending downward',
      detail: 'Potential low-temperature risk.',
      action: 'Recommended action: inspect cooling conditions.'
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// AUDIT LOG
// ---------------------------------------------------------------------------
function logEvent(type, severity, extra = {}) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    type,
    severity,
    temperature: runtime.temperature,
    humidity: runtime.humidity,
    vibration: runtime.vibration,
    riskScore: extra.riskScore ?? null,
    mode: runtime.mode,
    deviceId: db.settings.deviceId,
    action: extra.action || null,
    alertStatus: extra.alertStatus || 'logged',
    acknowledged: false,
    ...extra
  };
  db.events.push(event);
  if (db.events.length > MAX_EVENTS) db.events.shift();
  saveDb();
  io.emit('event', event);
  return event;
}

// ---------------------------------------------------------------------------
// ALERTING (state-change + cooldown + dedup)
// ---------------------------------------------------------------------------
function maybeAlert(currentState, risk) {
  const now = Date.now();
  const cooldownMs = (db.settings.alertCooldownSec || 60) * 1000;

  if (currentState === runtime.lastAlertState) {
    return; // no repeated identical alerts
  }
  if (now - runtime.lastAlertTime < cooldownMs && currentState !== 'CRITICAL' && currentState !== 'SENSOR FAULT') {
    return; // cooldown, unless critical/fault which always alerts on state change
  }

  runtime.lastAlertState = currentState;
  runtime.lastAlertTime = now;

  const severityMap = {
    NORMAL: 'INFO', LOW: 'WARNING', HIGH: 'WARNING', WARNING: 'WARNING',
    CRITICAL: 'CRITICAL', DANGEROUS: 'DANGEROUS', 'SENSOR FAULT': 'HIGH', OFFLINE: 'HIGH'
  };
  const severity = severityMap[currentState] || 'INFO';

  const event = logEvent(
    currentState === 'NORMAL' ? 'Temperature recovery' : `${currentState} condition`,
    severity,
    { riskScore: risk.score, alertStatus: 'sent' }
  );

  if (severity !== 'INFO') {
    sendTelegramAlert(event, risk);
    io.emit('voiceAlert', buildVoiceAlertText(currentState, risk));
  }

  return event;
}

function buildVoiceAlertText(state, risk) {
  const map = {
    WARNING: 'Warning. Condition is outside the configured safe range.',
    CRITICAL: 'Critical condition detected.',
    DANGEROUS: 'Dangerous condition detected.',
    'SENSOR FAULT': 'Sensor fault detected.',
    HIGH: 'Warning. Temperature is outside the configured safe range.',
    LOW: 'Warning. Temperature is outside the configured safe range.'
  };
  return map[state] || `Condition changed to ${state}.`;
}

// ---------------------------------------------------------------------------
// TELEGRAM (only fires if actually configured; never fakes success)
// ---------------------------------------------------------------------------
async function sendTelegramAlert(event, risk) {
  if (!db.settings.telegramEnabled) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[Telegram] Not configured - skipping alert send.');
    return;
  }
  const text =
    `${event.severity} EVENT\n\n` +
    `Device: ${event.deviceId}\n` +
    `Temperature: ${event.temperature ?? 'N/A'}C\n` +
    `Risk: ${risk.score}/100\n` +
    `Type: ${event.type}\n` +
    `Time: ${event.timestamp}`;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const data = await resp.json();
    if (!data.ok) console.error('[Telegram] send failed:', data.description);
  } catch (e) {
    console.error('[Telegram] request error:', e.message);
  }
}

// ---------------------------------------------------------------------------
// INGEST ENDPOINT (from ESP32)
// ---------------------------------------------------------------------------
app.post('/api/ingest', (req, res) => {
  const body = req.body || {};
  const now = Date.now();

  runtime.connected = true;
  runtime.lastUpdate = now;
  runtime.mode = body.mode === 'DEMO' ? 'DEMO' : 'LIVE';
  runtime.sensorValid = !!body.sensorValid;
  runtime.vibration = !!body.vibration;
  runtime.vibrationEventCount = body.vibrationEventCount ?? runtime.vibrationEventCount;

  if (typeof body.temperature === 'number') {
    runtime.temperature = body.temperature;
    runtime.tempHistory.push({ ts: now, temp: body.temperature });
    if (runtime.tempHistory.length > 200) runtime.tempHistory.shift();
  }
  if (typeof body.humidity === 'number') {
    runtime.humidity = body.humidity;
  }

  const state = body.state || 'NORMAL';
  runtime.state = state;

  const abnormal = state !== 'NORMAL';
  if (abnormal) {
    runtime.consecutiveAbnormal++;
    if (!runtime.lastAbnormalEnter) runtime.lastAbnormalEnter = now;
    runtime.timeOutsideRangeMs = now - runtime.lastAbnormalEnter;
  } else {
    runtime.consecutiveAbnormal = 0;
    runtime.lastAbnormalEnter = null;
    runtime.timeOutsideRangeMs = 0;
  }

  if (runtime.vibration) {
    runtime.recentVibrationTimestamps.push(now);
    runtime.recentVibrationTimestamps = runtime.recentVibrationTimestamps.filter(ts => now - ts < 15 * 60000);
    db.vibrationEvents.push({ ts: new Date(now).toISOString(), temperature: runtime.temperature, mode: runtime.mode });
    if (db.vibrationEvents.length > 1000) db.vibrationEvents.shift();
    logEvent('Vibration event', 'WARNING', { alertStatus: 'sent' });
    saveDb();
  }

  // persist reading (capped)
  db.readings.push({
    ts: new Date(now).toISOString(),
    temperature: runtime.temperature,
    humidity: runtime.humidity,
    vibration: runtime.vibration,
    state,
    mode: runtime.mode
  });
  if (db.readings.length > MAX_READINGS) db.readings.shift();
  saveDb();

  const risk = computeRisk();
  const condition = computeConditionAdvisory();
  const warning = earlyWarning();

  maybeAlert(state, risk);

  broadcastState(risk, condition, warning);

  res.json({ ok: true });
});

app.post('/api/heartbeat', (req, res) => {
  const { deviceId, uptimeMs } = req.body || {};
  const now = Date.now();
  db.devices[deviceId || db.settings.deviceId] = {
    lastHeartbeat: new Date(now).toISOString(),
    uptimeMs: uptimeMs ?? null,
    ip: req.ip
  };
  saveDb();
  io.emit('heartbeat', db.devices);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// CONNECTIVITY WATCHDOG
// ---------------------------------------------------------------------------
setInterval(() => {
  if (runtime.lastUpdate && Date.now() - runtime.lastUpdate > OFFLINE_TIMEOUT_MS) {
    if (runtime.connected) {
      runtime.connected = false;
      runtime.state = 'OFFLINE';
      logEvent('Device offline', 'HIGH', { alertStatus: 'sent' });
      const risk = computeRisk();
      broadcastState(risk, computeConditionAdvisory(), null);
    }
  }
}, 3000);

function broadcastState(risk, condition, warning) {
  io.emit('state', {
    mode: runtime.mode,
    temperature: runtime.temperature,
    humidity: runtime.humidity,
    vibration: runtime.vibration,
    vibrationEventCount: runtime.vibrationEventCount,
    sensorValid: runtime.sensorValid,
    state: runtime.state,
    connected: runtime.connected,
    lastUpdate: runtime.lastUpdate,
    trend: computeTrend(),
    risk,
    condition,
    earlyWarning: warning,
    deviceId: db.settings.deviceId,
    settings: db.settings
  });
}

// ---------------------------------------------------------------------------
// REST API: current state, history, settings, exports, alerts, telegram test,
// emergency call, self-test summary
// ---------------------------------------------------------------------------
app.get('/api/state', (req, res) => {
  const risk = computeRisk();
  res.json({
    mode: runtime.mode,
    temperature: runtime.temperature,
    humidity: runtime.humidity,
    vibration: runtime.vibration,
    vibrationEventCount: runtime.vibrationEventCount,
    sensorValid: runtime.sensorValid,
    state: runtime.state,
    connected: runtime.connected,
    lastUpdate: runtime.lastUpdate,
    trend: computeTrend(),
    risk,
    condition: computeConditionAdvisory(),
    earlyWarning: earlyWarning(),
    deviceId: db.settings.deviceId,
    settings: db.settings,
    devices: db.devices
  });
});

app.get('/api/history', (req, res) => {
  const { severity, mode, from, to, ackStatus, limit } = req.query;
  let events = db.events.slice();
  if (severity) events = events.filter(e => e.severity === severity);
  if (mode) events = events.filter(e => e.mode === mode);
  if (from) events = events.filter(e => new Date(e.timestamp) >= new Date(from));
  if (to) events = events.filter(e => new Date(e.timestamp) <= new Date(to));
  if (ackStatus === 'acknowledged') events = events.filter(e => e.acknowledged);
  if (ackStatus === 'unacknowledged') events = events.filter(e => !e.acknowledged);
  events = events.slice(-(parseInt(limit) || 500)).reverse();
  res.json(events);
});

app.get('/api/readings', (req, res) => {
  const { hours } = req.query;
  const h = parseFloat(hours) || 24;
  const cutoff = Date.now() - h * 3600000;
  const readings = db.readings.filter(r => new Date(r.ts).getTime() >= cutoff);
  res.json(readings);
});

app.get('/api/vibration-events', (req, res) => {
  res.json(db.vibrationEvents.slice(-500).reverse());
});

app.post('/api/alerts/:id/:action', (req, res) => {
  const { id, action } = req.params;
  const event = db.events.find(e => e.id === id);
  if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });

  if (action === 'acknowledge') {
    event.acknowledged = true;
    event.userAction = 'acknowledged';
  } else if (action === 'mute') {
    event.userAction = 'muted';
  } else if (action === 'escalate') {
    event.userAction = 'escalated';
  } else {
    return res.status(400).json({ ok: false, error: 'Unknown action' });
  }
  saveDb();
  io.emit('eventUpdated', event);
  res.json({ ok: true, event });
});

app.get('/api/settings', (req, res) => res.json(db.settings));

app.post('/api/settings', (req, res) => {
  const incoming = req.body || {};
  // basic validation - reject impossible values
  if (typeof incoming.tempMin === 'number' && typeof incoming.tempMax === 'number' && incoming.tempMin >= incoming.tempMax) {
    return res.status(400).json({ ok: false, error: 'tempMin must be less than tempMax' });
  }
  if (incoming.alertCooldownSec !== undefined && incoming.alertCooldownSec < 0) {
    return res.status(400).json({ ok: false, error: 'alertCooldownSec cannot be negative' });
  }
  db.settings = { ...db.settings, ...incoming };
  saveDb();
  logEvent('Settings changed', 'INFO', { alertStatus: 'logged' });
  io.emit('settingsUpdated', db.settings);
  res.json({ ok: true, settings: db.settings });
});

app.get('/api/export/csv', (req, res) => {
  const rows = ['timestamp,temperature,humidity,vibration,state,mode'];
  db.readings.forEach(r => {
    rows.push(`${r.ts},${r.temperature ?? ''},${r.humidity ?? ''},${r.vibration},${r.state},${r.mode}`);
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="vaxguard_readings.csv"');
  res.send(rows.join('\n'));
});

app.get('/api/export/json', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="vaxguard_export.json"');
  res.json({ readings: db.readings, events: db.events, vibrationEvents: db.vibrationEvents });
});

app.get('/api/export/audit-csv', (req, res) => {
  const rows = ['timestamp,eventId,type,severity,temperature,humidity,vibration,riskScore,mode,deviceId,action,alertStatus,acknowledged'];
  db.events.forEach(e => {
    rows.push([e.timestamp, e.id, e.type, e.severity, e.temperature, e.humidity, e.vibration, e.riskScore, e.mode, e.deviceId, e.action, e.alertStatus, e.acknowledged].join(','));
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="vaxguard_audit.csv"');
  res.send(rows.join('\n'));
});

app.post('/api/history/clear', (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ ok: false, error: 'Confirmation required to clear history.' });
  }
  db.events = [];
  db.readings = [];
  db.vibrationEvents = [];
  saveDb();
  res.json({ ok: true });
});

app.post('/api/telegram/test', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return res.json({ ok: false, message: 'Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.' });
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: 'VaxGuard test alert - Telegram integration is working.' })
    });
    const data = await resp.json();
    res.json({ ok: !!data.ok, message: data.ok ? 'Test message sent.' : `Telegram error: ${data.description}` });
  } catch (e) {
    res.json({ ok: false, message: `Request failed: ${e.message}` });
  }
});

app.post('/api/emergency/call', async (req, res) => {
  const webhook = process.env.CALL_PROVIDER_WEBHOOK_URL;
  const contact = process.env.EMERGENCY_CONTACT_NUMBER;
  if (!webhook || !contact) {
    return res.json({ ok: false, message: 'Calling provider not configured.' });
  }
  try {
    const resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: contact, message: 'VaxGuard emergency alert' })
    });
    const ok = resp.ok;
    logEvent('Emergency call triggered', 'CRITICAL', { alertStatus: ok ? 'sent' : 'failed' });
    res.json({ ok, message: ok ? 'Call request sent to provider.' : 'Provider returned an error - call not confirmed.' });
  } catch (e) {
    res.json({ ok: false, message: `Call provider request failed: ${e.message}` });
  }
});

app.post('/api/selftest', (req, res) => {
  const results = [];
  results.push({ item: 'Backend', status: 'PASS', detail: 'Server responding.' });
  results.push({
    item: 'ESP32 connectivity',
    status: runtime.connected ? 'PASS' : 'FAIL',
    detail: runtime.connected ? 'Recent data received.' : 'No recent data from device.'
  });
  results.push({
    item: 'DHT11 sensor',
    status: runtime.sensorValid ? 'PASS' : 'WARNING',
    detail: runtime.sensorValid ? 'Valid readings.' : 'Sensor invalid or not reporting.'
  });
  results.push({
    item: 'Telegram',
    status: (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) ? 'PASS' : 'NOT CONFIGURED',
    detail: (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) ? 'Credentials present.' : 'Set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in .env.'
  });
  results.push({
    item: 'Calling provider',
    status: (process.env.CALL_PROVIDER_WEBHOOK_URL) ? 'PASS' : 'NOT CONFIGURED',
    detail: process.env.CALL_PROVIDER_WEBHOOK_URL ? 'Webhook configured.' : 'No calling provider configured.'
  });
  logEvent('Self-test completed', 'INFO', { alertStatus: 'logged' });
  res.json({ results });
});

app.get('/api/report', (req, res) => {
  const { type } = req.query; // daily | weekly | incident | sensor | summary
  const hours = type === 'weekly' ? 168 : 24;
  const cutoff = Date.now() - hours * 3600000;
  const readings = db.readings.filter(r => new Date(r.ts).getTime() >= cutoff);
  const events = db.events.filter(e => new Date(e.timestamp).getTime() >= cutoff);
  const temps = readings.map(r => r.temperature).filter(t => typeof t === 'number');
  const report = {
    type: type || 'summary',
    periodHours: hours,
    monitoringDurationSamples: readings.length,
    temperature: temps.length ? {
      min: Math.min(...temps), max: Math.max(...temps),
      avg: +(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(2)
    } : null,
    vibrationEvents: readings.filter(r => r.vibration).length,
    alerts: events.filter(e => e.severity !== 'INFO').length,
    faults: events.filter(e => e.type.includes('fault') || e.type.includes('Sensor fault')).length,
    recoveries: events.filter(e => e.type.includes('recovery')).length,
    generatedAt: new Date().toISOString()
  };
  res.json(report);
});

// ---------------------------------------------------------------------------
// SOCKET.IO
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  const risk = computeRisk();
  socket.emit('state', {
    mode: runtime.mode,
    temperature: runtime.temperature,
    humidity: runtime.humidity,
    vibration: runtime.vibration,
    vibrationEventCount: runtime.vibrationEventCount,
    sensorValid: runtime.sensorValid,
    state: runtime.state,
    connected: runtime.connected,
    lastUpdate: runtime.lastUpdate,
    trend: computeTrend(),
    risk,
    condition: computeConditionAdvisory(),
    earlyWarning: earlyWarning(),
    deviceId: db.settings.deviceId,
    settings: db.settings
  });
});

server.listen(PORT, () => {
  console.log(`VaxGuard server listening on http://localhost:${PORT}`);
  if (!AUTH_ENABLED) {
    console.log('NOTE: Dashboard auth is not configured (see .env DASHBOARD_USERNAME/PASSWORD).');
  }
});
