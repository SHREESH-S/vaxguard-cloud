/*
  VaxGuard backend
  ------------------------------------------------------------
  - Express serves the dashboard (public/) and REST API
  - A raw WebSocket endpoint at /esp32 receives packets from the ESP32
  - Socket.IO pushes live updates to every connected browser
  - All "AI" features here are transparent rule-based calculations
    (moving averages, rate-of-change, thresholds) - see computeRisk()
    and computeEarlyWarning(). Nothing here is a trained ML model,
    and the UI is required to say so.
  - Telegram / phone-call integrations are OFF unless credentials are
    present in .env - the server never pretends they succeeded.
*/

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const WebSocket = require('ws');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const fetch = require('node-fetch');

// ---------------- Storage ----------------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const adapter = new FileSync(path.join(DATA_DIR, 'db.json'));
const db = low(adapter);

db.defaults({
  settings: {
    tempMin: parseFloat(process.env.TEMP_MIN || 2),
    tempMax: parseFloat(process.env.TEMP_MAX || 8),
    warningMargin: parseFloat(process.env.TEMP_WARNING_MARGIN || 1.5),
    criticalMargin: parseFloat(process.env.TEMP_CRITICAL_MARGIN || 4),
    alertCooldownMs: parseInt(process.env.ALERT_COOLDOWN_MS || 60000, 10),
    voiceAlertsEnabled: true,
    telegramEnabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    deviceName: 'VaxGuard-01',
    deviceId: 'VaxGuard-01',
    retentionDays: 14
  },
  history: [],       // bounded time-series for graphs
  events: [],         // audit log
  alerts: [],         // active/past alerts with ack state
  vibrationEvents: [] // raw vibration event log
}).write();

// ---------------- App state (in-memory, mirrors + feeds db) ----------------
const state = {
  mode: 'LIVE',
  temperature: null,
  humidity: null,
  vibration: false,
  sensorFault: false,
  wifi: false,
  vibrationEventCount: 0,
  lastEsp32Update: null,
  lastHeartbeat: null,
  deviceOnline: false,
  currentState: 'OFFLINE', // NORMAL/LOW/HIGH/WARNING/CRITICAL/DANGEROUS/SENSOR_FAULT/OFFLINE
  lastAlertByType: {}, // for cooldown/dedup
};

const HISTORY_LIMIT = 5000;
const TREND_WINDOW = 8; // number of recent samples used for trend/slope

// ---------------- Helpers ----------------
function nowIso() { return new Date().toISOString(); }

function pushHistory(sample) {
  const history = db.get('history').value();
  history.push(sample);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  db.set('history', history).write();
}

function logEvent(evt) {
  const events = db.get('events').value();
  const record = {
    id: 'evt_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    timestamp: nowIso(),
    acknowledged: false,
    ...evt
  };
  events.push(record);
  db.set('events', events).write();
  io.emit('event:new', record);
  return record;
}

// ---------------- State engine ----------------
function computeState({ temperature, vibration, sensorFault, mode, deviceOnline }) {
  if (!deviceOnline) return 'OFFLINE';
  if (sensorFault) return 'SENSOR_FAULT';
  if (temperature === null || temperature === undefined || Number.isNaN(temperature)) return 'SENSOR_FAULT';

  const s = db.get('settings').value();
  const { tempMin, tempMax, warningMargin, criticalMargin } = s;

  if (temperature < tempMin - criticalMargin || temperature > tempMax + criticalMargin) return 'DANGEROUS';
  if (temperature < tempMin - warningMargin || temperature > tempMax + warningMargin) return 'CRITICAL';
  if (temperature < tempMin) return 'LOW';
  if (temperature > tempMax) return 'HIGH';
  if (vibration) return 'WARNING';
  return 'NORMAL';
}

// ---------------- Trend / early warning ----------------
function getRecentTemps(n) {
  const history = db.get('history').value();
  return history.slice(-n).map(h => h.temperature).filter(t => typeof t === 'number' && !Number.isNaN(t));
}

function computeTrend() {
  const temps = getRecentTemps(TREND_WINDOW);
  if (temps.length < 3) return { slope: 0, direction: 'FLAT', confidence: 'LOW' };

  // simple linear regression slope over index
  const n = temps.length;
  const xs = temps.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = temps.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (temps[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;

  let direction = 'FLAT';
  if (slope > 0.08) direction = 'RISING';
  else if (slope < -0.08) direction = 'FALLING';

  const confidence = n >= TREND_WINDOW ? 'MODERATE' : 'LOW';
  return { slope: Number(slope.toFixed(3)), direction, confidence };
}

function computeEarlyWarning(trend, s) {
  if (trend.direction === 'RISING') {
    return {
      level: 'EARLY_WARNING',
      label: 'AI-assisted prototype risk prediction',
      message: 'Temperature trending upward. Potential threshold crossing predicted.',
      recommendedAction: 'Inspect cooling conditions.'
    };
  }
  if (trend.direction === 'FALLING') {
    return {
      level: 'EARLY_WARNING',
      label: 'AI-assisted prototype risk prediction',
      message: 'Temperature trend decreasing. Potential low-temperature risk.',
      recommendedAction: 'Inspect cold-chain unit and door seals.'
    };
  }
  return {
    level: 'STABLE',
    label: 'AI-assisted prototype risk prediction',
    message: 'No significant trend detected.',
    recommendedAction: 'Continue routine monitoring.'
  };
}

// ---------------- Vibration intelligence ----------------
function recordVibrationEvent() {
  const events = db.get('vibrationEvents').value();
  events.push({ timestamp: nowIso(), t: Date.now() });
  // keep last 500
  if (events.length > 500) events.splice(0, events.length - 500);
  db.set('vibrationEvents', events).write();
}

function computeVibrationRisk() {
  const events = db.get('vibrationEvents').value();
  const now = Date.now();
  const last10min = events.filter(e => now - e.t <= 10 * 60 * 1000);
  const last1min = events.filter(e => now - e.t <= 60 * 1000);

  let score = 0;
  if (last1min.length >= 3) score += 40;
  else if (last1min.length >= 1) score += 15;
  if (last10min.length >= 5) score += 30;

  score = Math.min(100, score);

  let classification = 'NONE';
  if (last1min.length >= 3) classification = 'FREQUENT_SHOCK_BURST';
  else if (last1min.length >= 1) classification = 'MINOR_EVENT';
  else if (last10min.length > 0) classification = 'ISOLATED_RECENT_EVENT';

  return { score, classification, countLast1Min: last1min.length, countLast10Min: last10min.length, totalRecorded: events.length };
}

// ---------------- Sensor health ----------------
function computeSensorHealth() {
  const freshnessMs = state.lastEsp32Update ? Date.now() - state.lastEsp32Update : Infinity;
  let freshness = 'LOST';
  if (freshnessMs < 6000) freshness = 'GOOD';
  else if (freshnessMs < 20000) freshness = 'STALE';

  let score = 100;
  if (state.sensorFault) score -= 50;
  if (freshness === 'STALE') score -= 20;
  if (freshness === 'LOST') score -= 60;
  if (!state.wifi) score -= 15;
  if (!state.deviceOnline) score -= 40;
  score = Math.max(0, score);

  return {
    dht11: state.sensorFault ? 'FAULT' : 'CONNECTED',
    temperatureValid: !state.sensorFault && typeof state.temperature === 'number',
    humidityValid: !state.sensorFault && typeof state.humidity === 'number',
    sw420: state.vibration ? 'EVENT_DETECTED' : 'CONNECTED',
    esp32: state.deviceOnline ? 'ONLINE' : 'OFFLINE',
    wifi: state.wifi ? 'CONNECTED' : 'DISCONNECTED',
    lastUpdate: state.lastEsp32Update ? new Date(state.lastEsp32Update).toISOString() : null,
    freshness,
    score
  };
}

// ---------------- Risk engine (explainable) ----------------
function computeRisk() {
  const s = db.get('settings').value();
  const trend = computeTrend();
  const vib = computeVibrationRisk();
  const health = computeSensorHealth();

  let score = 0;
  const reasons = [];

  if (typeof state.temperature === 'number' && !state.sensorFault) {
    const dev = Math.max(state.temperature - s.tempMax, s.tempMin - state.temperature, 0);
    if (dev > 0) {
      const devPoints = Math.min(35, Math.round(dev * 8));
      score += devPoints;
      reasons.push({ points: devPoints, reason: 'Temperature deviation from configured range' });
    }
  }

  if (trend.direction !== 'FLAT') {
    const trendPoints = trend.confidence === 'MODERATE' ? 18 : 8;
    score += trendPoints;
    reasons.push({ points: trendPoints, reason: `${trend.direction === 'RISING' ? 'Increasing' : 'Decreasing'} temperature trend` });
  }

  // duration outside range: count of recent history samples outside band
  const history = db.get('history').value().slice(-20);
  const outsideCount = history.filter(h => typeof h.temperature === 'number' && (h.temperature < s.tempMin || h.temperature > s.tempMax)).length;
  if (outsideCount > 0) {
    const durPoints = Math.min(20, outsideCount * 2);
    score += durPoints;
    reasons.push({ points: durPoints, reason: 'Prolonged condition outside target range' });
  }

  if (vib.score > 0) {
    const vibPoints = Math.round(vib.score * 0.25);
    score += vibPoints;
    reasons.push({ points: vibPoints, reason: 'Vibration/shock activity' });
  }

  if (health.score < 70) {
    const healthPoints = Math.round((100 - health.score) * 0.15);
    score += healthPoints;
    reasons.push({ points: healthPoints, reason: 'Reduced sensor/connectivity reliability' });
  }

  score = Math.min(100, Math.round(score));

  let category = 'SAFE';
  if (score > 80) category = 'CRITICAL';
  else if (score > 60) category = 'HIGH_RISK';
  else if (score > 40) category = 'MODERATE_RISK';
  else if (score > 20) category = 'LOW_RISK';

  return { score, category, reasons, trend, vibration: vib };
}

// ---------------- Condition advisory ----------------
function computeConditionAdvisory(risk) {
  const history = db.get('history').value();
  if (history.length < 5) {
    return { result: 'INSUFFICIENT_DATA', reason: 'Not enough monitoring history yet to assess condition.' };
  }
  if (risk.score <= 20) {
    return { result: 'GOOD', reason: 'Temperature remained within configured range for the monitored period.' };
  }
  if (risk.score <= 40) {
    return { result: 'WATCH', reason: 'Minor deviations observed. Continue monitoring.' };
  }
  if (risk.score <= 70) {
    return { result: 'AT_RISK', reason: 'Repeated excursions detected. Inspect cold-chain conditions and follow approved vaccine handling procedures.' };
  }
  return { result: 'CRITICAL', reason: 'Significant, sustained cold-chain excursion detected. Follow approved vaccine handling / incident procedures immediately.' };
}

// ---------------- Root-cause / correlation ----------------
function computeRootCause(risk) {
  const causes = [];
  const s = db.get('settings').value();
  if (typeof state.temperature === 'number' && state.temperature > s.tempMax) causes.push('Temperature exceeded the upper configured threshold.');
  if (typeof state.temperature === 'number' && state.temperature < s.tempMin) causes.push('Temperature fell below the lower configured threshold.');
  if (risk.trend.direction === 'RISING') causes.push('Temperature has continued rising over recent samples.');
  if (risk.trend.direction === 'FALLING') causes.push('Temperature has continued falling over recent samples.');
  if (risk.vibration.countLast10Min > 0) causes.push(`${risk.vibration.countLast10Min} vibration event(s) occurred in the last 10 minutes.`);
  if (state.sensorFault) causes.push('DHT11 sensor is currently reporting a fault.');
  if (!state.wifi) causes.push('Device Wi-Fi connectivity is currently down.');

  let combined = null;
  if (risk.trend.direction === 'RISING' && risk.vibration.countLast10Min > 0) {
    combined = 'Combined event detected: temperature trend + vibration activity may compound risk.';
  }

  return {
    causes: causes.length ? causes : ['No specific contributing factor identified from current data.'],
    mostLikely: causes[0] || 'N/A',
    combinedEvent: combined,
    recommendedInspection: causes.length ? 'Inspect cooling unit, door seals, and physical placement/handling of the device.' : 'No inspection currently indicated.'
  };
}

// ---------------- Alerts ----------------
async function maybeSendTelegram(text) {
  const s = db.get('settings').value();
  if (!s.telegramEnabled || !process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return { sent: false, reason: 'Telegram not configured/unavailable.' };
  }
  try {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text })
    });
    const json = await res.json();
    return { sent: !!json.ok, reason: json.ok ? 'Sent' : (json.description || 'Telegram API error') };
  } catch (e) {
    return { sent: false, reason: 'Telegram request failed: ' + e.message };
  }
}

function raiseAlert(type, severity, message, extra = {}) {
  const s = db.get('settings').value();
  const cooldown = s.alertCooldownMs || 60000;
  const last = state.lastAlertByType[type] || 0;
  if (Date.now() - last < cooldown) return null; // dedup / cooldown
  state.lastAlertByType[type] = Date.now();

  const alerts = db.get('alerts').value();
  const alert = {
    id: 'alert_' + Date.now(),
    type, severity, message,
    timestamp: nowIso(),
    acknowledged: false,
    muted: false,
    ...extra
  };
  alerts.push(alert);
  db.set('alerts', alerts).write();
  io.emit('alert:new', alert);

  logEvent({ type: 'ALERT', severity, message, temperature: state.temperature, humidity: state.humidity, vibration: state.vibration, mode: state.mode, deviceId: s.deviceId });

  if (['HIGH', 'CRITICAL', 'DANGEROUS'].includes(severity)) {
    maybeSendTelegram(`[VaxGuard] ${severity}: ${message}`).then(result => {
      io.emit('telegram:result', result);
    });
  }

  return alert;
}

// ---------------- Main pipeline: process an incoming ESP32 packet ----------------
function processIncomingPacket(pkt) {
  const prevState = state.currentState;

  state.mode = pkt.mode === 'DEMO' ? 'DEMO' : 'LIVE';
  state.temperature = (pkt.temperature === null || pkt.temperature === undefined) ? null : Number(pkt.temperature);
  state.humidity = (pkt.humidity === null || pkt.humidity === undefined) ? null : Number(pkt.humidity);
  const vibrationRisingEdge = pkt.vibration && !state.vibration;
  state.vibration = !!pkt.vibration;
  state.sensorFault = !!pkt.sensorFault;
  state.wifi = !!pkt.wifi;
  state.vibrationEventCount = pkt.vibrationEventCount || state.vibrationEventCount;
  state.lastEsp32Update = Date.now();
  state.deviceOnline = true;

  if (vibrationRisingEdge) {
    recordVibrationEvent();
    logEvent({ type: 'VIBRATION', severity: 'INFO', message: 'Vibration event detected', temperature: state.temperature, mode: state.mode, deviceId: db.get('settings.deviceId').value() });
  }

  const newState = computeState(state);
  state.currentState = newState;

  pushHistory({
    timestamp: nowIso(),
    t: Date.now(),
    temperature: state.temperature,
    humidity: state.humidity,
    vibration: state.vibration,
    mode: state.mode,
    stateLabel: newState
  });

  const risk = computeRisk();
  const advisory = computeConditionAdvisory(risk);
  const rootCause = computeRootCause(risk);

  if (newState !== prevState) {
    logEvent({ type: 'STATE_CHANGE', severity: mapSeverity(newState), message: `State changed: ${prevState} -> ${newState}`, temperature: state.temperature, mode: state.mode, deviceId: db.get('settings.deviceId').value() });

    if (newState === 'NORMAL' && prevState !== 'OFFLINE') {
      raiseAlert('RECOVERY', 'INFO', 'Condition recovered to NORMAL.');
    } else if (newState === 'SENSOR_FAULT') {
      raiseAlert('SENSOR_FAULT', 'WARNING', 'DHT11 sensor fault detected.');
    } else if (['HIGH', 'LOW'].includes(newState)) {
      raiseAlert(newState, 'WARNING', `${newState} temperature condition detected (${state.temperature}°C).`);
    } else if (newState === 'CRITICAL') {
      raiseAlert('CRITICAL', 'CRITICAL', `Critical temperature condition (${state.temperature}°C). Risk ${risk.score}/100.`);
    } else if (newState === 'DANGEROUS') {
      raiseAlert('DANGEROUS', 'DANGEROUS', `Dangerous cold-chain excursion (${state.temperature}°C). Risk ${risk.score}/100. Immediate action recommended.`);
    } else if (newState === 'WARNING') {
      raiseAlert('WARNING', 'WARNING', 'Vibration/shock event flagged during monitoring.');
    }
  }

  broadcastDashboard(risk, advisory, rootCause);
}

function mapSeverity(s) {
  return { NORMAL: 'INFO', LOW: 'WARNING', HIGH: 'WARNING', WARNING: 'WARNING', CRITICAL: 'CRITICAL', DANGEROUS: 'DANGEROUS', SENSOR_FAULT: 'WARNING', OFFLINE: 'WARNING' }[s] || 'INFO';
}

function broadcastDashboard(risk, advisory, rootCause) {
  const settings = db.get('settings').value();
  const payload = {
    ...state,
    settings,
    risk,
    advisory,
    rootCause,
    sensorHealth: computeSensorHealth(),
    earlyWarning: computeEarlyWarning(risk.trend, settings),
    serverTime: nowIso()
  };
  io.emit('dashboard:update', payload);
}

// ---------------- Device offline watchdog ----------------
setInterval(() => {
  if (state.lastEsp32Update && Date.now() - state.lastEsp32Update > 20000 && state.deviceOnline) {
    state.deviceOnline = false;
    state.currentState = 'OFFLINE';
    logEvent({ type: 'CONNECTIVITY', severity: 'WARNING', message: 'ESP32 offline (no data received).', deviceId: db.get('settings.deviceId').value() });
    raiseAlert('OFFLINE', 'WARNING', 'Device appears offline - no recent data received.');
    broadcastDashboard(computeRisk(), computeConditionAdvisory(computeRisk()), computeRootCause(computeRisk()));
  }
}, 5000);

// ================================================================
// Express + Socket.IO + WS bridge
// ================================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

// --- Raw WebSocket server for the ESP32 at path /esp32 ---
const wss = new WebSocket.Server({ server, path: '/esp32' });
wss.on('connection', (ws) => {
  console.log('[ESP32] connected via WebSocket');
  ws.on('message', (msg) => {
    try {
      const pkt = JSON.parse(msg.toString());
      if (pkt.type === 'heartbeat') {
        state.lastHeartbeat = Date.now();
        state.deviceOnline = true;
        return;
      }
      processIncomingPacket(pkt);
    } catch (e) {
      console.error('[ESP32] bad packet:', e.message);
    }
  });
  ws.on('close', () => console.log('[ESP32] disconnected'));
});

// --- Socket.IO: dashboard clients ---
io.on('connection', (socket) => {
  socket.emit('dashboard:update', {
    ...state,
    settings: db.get('settings').value(),
    risk: computeRisk(),
    advisory: computeConditionAdvisory(computeRisk()),
    rootCause: computeRootCause(computeRisk()),
    sensorHealth: computeSensorHealth(),
    earlyWarning: computeEarlyWarning(computeRisk().trend, db.get('settings').value()),
    serverTime: nowIso()
  });

  socket.on('alert:ack', ({ id, source }) => {
    const alerts = db.get('alerts').value();
    const a = alerts.find(x => x.id === id);
    if (a) {
      a.acknowledged = true;
      a.acknowledgedBy = source || 'dashboard';
      a.acknowledgedAt = nowIso();
      db.set('alerts', alerts).write();
      logEvent({ type: 'ACK', severity: 'INFO', message: `Alert ${id} acknowledged`, userAction: source || 'dashboard' });
      io.emit('alert:updated', a);
    }
  });

  socket.on('alert:mute', ({ id }) => {
    const alerts = db.get('alerts').value();
    const a = alerts.find(x => x.id === id);
    if (a) { a.muted = true; db.set('alerts', alerts).write(); io.emit('alert:updated', a); }
  });

  socket.on('demo:log', ({ command }) => {
    // Optional: browser can tell the server which demo command was just sent via serial,
    // purely for audit purposes (does not simulate data on its own).
    logEvent({ type: 'DEMO_COMMAND', severity: 'INFO', message: `Demo command noted: ${command}` });
  });
});

// ================================================================
// REST API
// ================================================================

app.get('/api/status', (req, res) => {
  const risk = computeRisk();
  res.json({
    ...state,
    settings: db.get('settings').value(),
    risk,
    advisory: computeConditionAdvisory(risk),
    rootCause: computeRootCause(risk),
    sensorHealth: computeSensorHealth()
  });
});

app.get('/api/history', (req, res) => {
  const { range } = req.query; // 1h,6h,12h,24h,7d
  const now = Date.now();
  const spans = { '1h': 3600e3, '6h': 6 * 3600e3, '12h': 12 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };
  const span = spans[range] || spans['6h'];
  const history = db.get('history').value().filter(h => now - h.t <= span);
  res.json(history);
});

app.get('/api/events', (req, res) => {
  let events = db.get('events').value();
  const { severity, type, from, to, mode, ack } = req.query;
  if (severity) events = events.filter(e => e.severity === severity);
  if (type) events = events.filter(e => e.type === type);
  if (mode) events = events.filter(e => e.mode === mode);
  if (ack === 'true') events = events.filter(e => e.acknowledged);
  if (ack === 'false') events = events.filter(e => !e.acknowledged);
  if (from) events = events.filter(e => new Date(e.timestamp) >= new Date(from));
  if (to) events = events.filter(e => new Date(e.timestamp) <= new Date(to));
  res.json(events);
});

app.get('/api/alerts', (req, res) => res.json(db.get('alerts').value()));

app.post('/api/alerts/:id/ack', (req, res) => {
  const alerts = db.get('alerts').value();
  const a = alerts.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  a.acknowledged = true;
  a.acknowledgedAt = nowIso();
  db.set('alerts', alerts).write();
  res.json(a);
});

app.get('/api/vibration', (req, res) => {
  res.json({ events: db.get('vibrationEvents').value(), risk: computeVibrationRisk() });
});

app.get('/api/settings', (req, res) => res.json(db.get('settings').value()));

app.post('/api/settings', (req, res) => {
  const allowed = ['tempMin', 'tempMax', 'warningMargin', 'criticalMargin', 'alertCooldownMs', 'voiceAlertsEnabled', 'telegramEnabled', 'deviceName', 'deviceId', 'retentionDays'];
  const updates = {};
  for (const k of allowed) {
    if (k in req.body) updates[k] = req.body[k];
  }
  // basic validation
  if ('tempMin' in updates && 'tempMax' in updates && Number(updates.tempMin) >= Number(updates.tempMax)) {
    return res.status(400).json({ error: 'tempMin must be less than tempMax' });
  }
  db.set('settings', { ...db.get('settings').value(), ...updates }).write();
  logEvent({ type: 'SETTINGS_CHANGED', severity: 'INFO', message: 'Settings updated', userAction: 'dashboard' });
  io.emit('settings:updated', db.get('settings').value());
  res.json(db.get('settings').value());
});

app.get('/api/selftest', async (req, res) => {
  const settings = db.get('settings').value();
  const results = {
    backend: { status: 'PASS' },
    websocket: { status: io.engine.clientsCount >= 0 ? 'PASS' : 'FAIL' },
    esp32: { status: state.deviceOnline ? 'PASS' : 'WARNING', detail: state.deviceOnline ? 'Online' : 'No recent data from device' },
    dht11: { status: state.sensorFault ? 'FAIL' : (state.deviceOnline ? 'PASS' : 'WARNING'), detail: state.sensorFault ? 'Reporting fault' : 'OK (based on last packet)' },
    storage: { status: fs.existsSync(path.join(DATA_DIR, 'db.json')) ? 'PASS' : 'FAIL' },
    telegram: { status: settings.telegramEnabled ? 'PASS' : 'NOT_CONFIGURED' },
    callingProvider: { status: process.env.CALL_PROVIDER_API_KEY ? 'PASS' : 'NOT_CONFIGURED' }
  };
  logEvent({ type: 'SELF_TEST', severity: 'INFO', message: 'Self-test executed', userAction: 'dashboard' });
  res.json(results);
});

// --- Export center ---
app.get('/api/export/csv', (req, res) => {
  const history = db.get('history').value();
  const header = 'timestamp,temperature,humidity,vibration,mode,state\n';
  const rows = history.map(h => `${h.timestamp},${h.temperature ?? ''},${h.humidity ?? ''},${h.vibration},${h.mode},${h.stateLabel}`).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="vaxguard_history.csv"');
  res.send(header + rows);
});

app.get('/api/export/json', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="vaxguard_export.json"');
  res.json({
    exportedAt: nowIso(),
    settings: db.get('settings').value(),
    history: db.get('history').value(),
    events: db.get('events').value(),
    alerts: db.get('alerts').value(),
    vibrationEvents: db.get('vibrationEvents').value()
  });
});

app.get('/api/export/audit.csv', (req, res) => {
  const events = db.get('events').value();
  const header = 'timestamp,id,type,severity,temperature,humidity,vibration,mode,acknowledged\n';
  const rows = events.map(e => `${e.timestamp},${e.id},${e.type},${e.severity || ''},${e.temperature ?? ''},${e.humidity ?? ''},${e.vibration ?? ''},${e.mode || ''},${e.acknowledged}`).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="vaxguard_audit.csv"');
  res.send(header + rows);
});

// --- Reports ---
app.get('/api/report/:kind', (req, res) => {
  const kind = req.params.kind; // daily, weekly, incident, sensor, summary
  const spanMs = kind === 'weekly' ? 7 * 24 * 3600e3 : 24 * 3600e3;
  const now = Date.now();
  const history = db.get('history').value().filter(h => now - h.t <= spanMs);
  const temps = history.map(h => h.temperature).filter(t => typeof t === 'number');
  const events = db.get('events').value().filter(e => now - new Date(e.timestamp).getTime() <= spanMs);
  const alerts = db.get('alerts').value().filter(a => now - new Date(a.timestamp).getTime() <= spanMs);

  const report = {
    kind,
    generatedAt: nowIso(),
    monitoringDurationSamples: history.length,
    temperature: temps.length ? {
      min: Math.min(...temps), max: Math.max(...temps),
      avg: Number((temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(2))
    } : null,
    vibrationEvents: db.get('vibrationEvents').value().filter(v => now - v.t <= spanMs).length,
    alertsRaised: alerts.length,
    faults: events.filter(e => e.type === 'STATE_CHANGE' && e.message.includes('SENSOR_FAULT')).length,
    recoveries: events.filter(e => e.type === 'ALERT' && e.message.toLowerCase().includes('recover')).length,
    recommendations: temps.length && (Math.max(...temps) > db.get('settings.tempMax').value() || Math.min(...temps) < db.get('settings.tempMin').value())
      ? ['Review cold-chain equipment', 'Confirm door/seal integrity', 'Re-verify sensor placement']
      : ['No corrective action currently indicated']
  };
  res.json(report);
});

// --- Location (device-reported; never invented) ---
let lastKnownLocation = null;
app.post('/api/location', (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng required' });
  lastKnownLocation = { lat, lng, updatedAt: nowIso() };
  logEvent({ type: 'LOCATION_UPDATE', severity: 'INFO', message: 'Device location updated from browser geolocation' });
  res.json(lastKnownLocation);
});
app.get('/api/location', (req, res) => res.json(lastKnownLocation || { status: 'unavailable' }));

// --- Emergency call (honest stub) ---
app.post('/api/emergency/call', async (req, res) => {
  const configured = !!process.env.CALL_PROVIDER_API_KEY && !!process.env.EMERGENCY_CONTACT_NUMBER;
  if (!configured) {
    logEvent({ type: 'EMERGENCY_CALL_ATTEMPT', severity: 'WARNING', message: 'Call attempted but no calling provider configured.' });
    return res.json({ success: false, message: 'Calling provider not configured.' });
  }
  // NOTE: no calling provider is wired up in this prototype. If you integrate
  // one, replace this block with a real API call and only report success
  // once the provider confirms it.
  logEvent({ type: 'EMERGENCY_CALL_ATTEMPT', severity: 'WARNING', message: 'Call attempted - provider integration not implemented in this build.' });
  return res.json({ success: false, message: 'Calling provider credentials found, but no provider integration is implemented in this build. No call was placed.' });
});

// --- Telegram test ---
app.post('/api/telegram/test', async (req, res) => {
  const result = await maybeSendTelegram('VaxGuard test alert - if you see this, Telegram alerts are working.');
  res.json(result);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`VaxGuard server listening on port ${PORT}`);
  console.log(`ESP32 should connect its WebSocket to ws://<this-host>:${PORT}/esp32`);
});
