/**
 * VaxGuard X - Backend Server
 * Real-time cold-chain intelligence platform
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ======================== STATE ========================
const state = {
  device: {
    deviceId: 'VaxGuard-01',
    mode: 'LIVE',
    online: false,
    lastSeen: null,
    uptime: 0,
    wifiRssi: null,
    freeHeap: null,
    firmware: '1.0.0',
    ip: null
  },
  sensors: {
    temperature: null,
    humidity: null,
    vibration: false,
    sensorHealth: true,
    lastUpdate: null
  },
  risk: {
    score: 0,
    level: 'GOOD',
    factors: [],
    trend: 'STABLE',
    confidence: 'LOW'
  },
  prediction: {
    direction: 'STABLE',
    estimatedCrossing: null,
    confidence: 'LOW',
    reason: 'Collecting baseline'
  },
  condition: 'INSUFFICIENT_DATA',
  alerts: [],
  incidents: [],
  audit: [],
  history: [],
  vibrationEvents: [],
  settings: {
    tempMin: parseFloat(process.env.TEMP_MIN) || 2.0,
    tempMax: parseFloat(process.env.TEMP_MAX) || 8.0,
    humidityMin: parseFloat(process.env.HUMIDITY_MIN) || 30,
    humidityMax: parseFloat(process.env.HUMIDITY_MAX) || 70,
    voiceAlertsEnabled: true,
    telegramEnabled: true,
    alertCooldownSec: 60,
    demoTestAlerts: false
  },
  voiceAlertState: {
    lastSpoken: {},
    enabled: true
  },
  telegram: {
    configured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    lastSent: {}
  },
  stats: {
    totalReadings: 0,
    excursionCount: 0,
    vibrationCount: 0,
    maxTemp: null,
    minTemp: null
  }
};

const MAX_HISTORY = 2000;
const MAX_AUDIT = 500;
const MAX_ALERTS = 200;

// ======================== MIDDLEWARE ========================
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ======================== HELPERS ========================
function nowISO() {
  return new Date().toISOString();
}

function audit(event, details = {}) {
  const entry = {
    id: 'AUD-' + uuidv4().slice(0, 8).toUpperCase(),
    event,
    details,
    timestamp: nowISO()
  };
  state.audit.unshift(entry);
  if (state.audit.length > MAX_AUDIT) state.audit.pop();
  io.emit('audit:new', entry);
  persistAudit();
  return entry;
}

function persistAudit() {
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'audit.json'), JSON.stringify(state.audit.slice(0, 200), null, 2));
  } catch (e) {}
}

function persistHistory() {
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'history.json'), JSON.stringify(state.history.slice(-500), null, 2));
  } catch (e) {}
}

// ======================== RISK ENGINE ========================
function computeRisk(reading) {
  const factors = [];
  let score = 0;
  const { temperature: t, humidity: h, vibration, sensorHealth } = reading;
  const { tempMin, tempMax } = state.settings;

  if (t === null || t === undefined || isNaN(t)) {
    factors.push({ name: 'No temperature data', points: 25 });
    score += 25;
  } else {
    const mid = (tempMin + tempMax) / 2;
    const range = (tempMax - tempMin) / 2;
    const deviation = Math.abs(t - mid) / range;

    if (t < tempMin || t > tempMax) {
      const over = t > tempMax ? t - tempMax : tempMin - t;
      const pts = Math.min(45, 20 + over * 8);
      factors.push({ name: `Temperature excursion (${t.toFixed(1)}°C)`, points: Math.round(pts) });
      score += pts;
    } else if (deviation > 0.7) {
      const pts = Math.round(12 * deviation);
      factors.push({ name: 'Temperature near limit', points: pts });
      score += pts;
    }

    const recent = state.history.slice(-12).map(r => r.temperature).filter(v => v != null);
    if (recent.length >= 4) {
      const slope = (recent[recent.length - 1] - recent[0]) / recent.length;
      if (Math.abs(slope) > 0.08) {
        const pts = Math.min(20, Math.round(Math.abs(slope) * 80));
        factors.push({ name: slope > 0 ? 'Rising temperature trend' : 'Falling temperature trend', points: pts });
        score += pts;
      }
    }
  }

  if (h != null && (h < state.settings.humidityMin || h > state.settings.humidityMax)) {
    factors.push({ name: 'Humidity out of range', points: 10 });
    score += 10;
  }

  if (vibration) {
    factors.push({ name: 'Vibration event', points: 15 });
    score += 15;
  }

  const recentVib = state.vibrationEvents.filter(e => Date.now() - new Date(e.timestamp).getTime() < 300000);
  if (recentVib.length >= 3) {
    factors.push({ name: 'Repeated vibration activity', points: 12 });
    score += 12;
  }

  if (!sensorHealth) {
    factors.push({ name: 'Sensor health degraded', points: 18 });
    score += 18;
  }

  if (state.sensors.lastUpdate) {
    const age = Date.now() - new Date(state.sensors.lastUpdate).getTime();
    if (age > 30000) {
      factors.push({ name: 'Stale data', points: 15 });
      score += 15;
    }
  }

  score = Math.min(100, Math.round(score));

  let level = 'GOOD';
  if (score >= 80) level = 'CRITICAL';
  else if (score >= 60) level = 'HIGH';
  else if (score >= 40) level = 'WARNING';
  else if (score >= 20) level = 'WATCH';

  let trend = 'STABLE';
  if (state.risk.score > 0) {
    if (score > state.risk.score + 8) trend = 'RISING';
    else if (score < state.risk.score - 8) trend = 'FALLING';
  }

  const confidence = state.history.length < 10 ? 'LOW' : (state.history.length < 40 ? 'MEDIUM' : 'HIGH');

  return { score, level, factors, trend, confidence };
}

// ======================== PREDICTION ========================
function computePrediction() {
  const recent = state.history.slice(-20).map(r => r.temperature).filter(v => v != null && !isNaN(v));
  if (recent.length < 5) {
    return {
      direction: 'STABLE',
      estimatedCrossing: null,
      confidence: 'LOW',
      reason: 'Insufficient trend data — collecting baseline'
    };
  }

  const n = recent.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += recent[i];
    sumXY += i * recent[i];
    sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const current = recent[n - 1];
  const { tempMin, tempMax } = state.settings;

  let direction = 'STABLE';
  let estimatedCrossing = null;
  let reason = 'Temperature stable within monitoring range';
  let confidence = n >= 12 ? 'MEDIUM' : 'LOW';
  if (n >= 18) confidence = 'HIGH';

  if (Math.abs(slope) < 0.02) {
    direction = 'STABLE';
  } else if (slope > 0) {
    direction = 'RISING';
    if (current < tempMax) {
      const steps = (tempMax - current) / slope;
      if (steps > 0 && steps < 120) {
        estimatedCrossing = Math.round(steps * 2);
        reason = `Rising trend detected. Projected upper-limit crossing in ~${estimatedCrossing} min`;
      } else {
        reason = 'Rising trend detected, but threshold crossing not imminent';
      }
    } else {
      reason = 'Temperature already above upper threshold';
    }
  } else {
    direction = 'FALLING';
    if (current > tempMin) {
      const steps = (current - tempMin) / Math.abs(slope);
      if (steps > 0 && steps < 120) {
        estimatedCrossing = Math.round(steps * 2);
        reason = `Falling trend detected. Projected lower-limit crossing in ~${estimatedCrossing} min`;
      } else {
        reason = 'Falling trend detected, but threshold crossing not imminent';
      }
    } else {
      reason = 'Temperature already below lower threshold';
    }
  }

  return { direction, estimatedCrossing, confidence, reason };
}

// ======================== CONDITION ========================
function computeCondition(risk, t) {
  if (t === null || isNaN(t)) return 'INSUFFICIENT_DATA';
  if (risk.score >= 80) return 'CRITICAL';
  if (risk.score >= 50) return 'AT_RISK';
  if (risk.score >= 25) return 'WATCH';
  return 'GOOD';
}

// ======================== ALERT ENGINE ========================
function evaluateAlerts(reading, risk) {
  let severity = 'INFO';
  let title = 'Status Update';
  let message = '';

  if (!reading.sensorHealth) {
    severity = 'HIGH';
    title = 'Sensor Fault';
    message = 'DHT11 sensor is not returning valid data. Check wiring and power.';
  } else if (risk.level === 'CRITICAL') {
    severity = 'CRITICAL';
    title = 'Critical Cold-Chain Condition';
    message = `Temperature ${reading.temperature?.toFixed(1)}°C — risk score ${risk.score}/100. Immediate inspection required.`;
  } else if (risk.level === 'HIGH') {
    severity = 'HIGH';
    title = 'High Risk Detected';
    message = `Elevated risk (${risk.score}/100). Temperature ${reading.temperature?.toFixed(1)}°C.`;
  } else if (risk.level === 'WARNING') {
    severity = 'WARNING';
    title = 'Warning Condition';
    message = `Monitoring limits approaching. Temperature ${reading.temperature?.toFixed(1)}°C.`;
  }

  if (reading.vibration) {
    if (severity === 'INFO' || severity === 'WATCH') {
      severity = 'WARNING';
      title = 'Vibration Event';
      message = 'Physical vibration detected on cold-chain unit.';
    }
  }

  const prevLevel = state.risk.level;
  if ((prevLevel === 'CRITICAL' || prevLevel === 'HIGH' || prevLevel === 'WARNING') &&
      (risk.level === 'GOOD' || risk.level === 'WATCH')) {
    createAlert('INFO', 'Recovery', `Condition recovered. Risk now ${risk.score}/100. Temperature ${reading.temperature?.toFixed(1)}°C.`, reading, risk);
  }

  if (severity !== 'INFO') {
    createAlert(severity, title, message, reading, risk);
  }
}

function createAlert(severity, title, message, reading, risk) {
  const key = `${severity}:${title}`;
  const last = state.voiceAlertState.lastSpoken[key] || 0;
  const cooldown = (state.settings.alertCooldownSec || 60) * 1000;

  if (Date.now() - last < cooldown && severity !== 'CRITICAL') {
    return null;
  }

  const alert = {
    id: 'ALT-' + uuidv4().slice(0, 8).toUpperCase(),
    severity,
    title,
    message,
    temperature: reading.temperature,
    humidity: reading.humidity,
    vibration: reading.vibration,
    riskScore: risk.score,
    deviceId: state.device.deviceId,
    mode: state.device.mode,
    timestamp: nowISO(),
    acknowledged: false,
    source: 'system'
  };

  state.alerts.unshift(alert);
  if (state.alerts.length > MAX_ALERTS) state.alerts.pop();

  state.voiceAlertState.lastSpoken[key] = Date.now();

  io.emit('alert:new', alert);
  audit('ALERT_CREATED', { alertId: alert.id, severity, title });

  if (['WARNING', 'HIGH', 'CRITICAL'].includes(severity)) {
    createOrUpdateIncident(alert, reading, risk);
  }

  if (state.settings.telegramEnabled && state.telegram.configured) {
    sendTelegramAlert(alert);
  }

  io.emit('voice:alert', {
    severity,
    message: generateVoiceMessage(alert),
    alertId: alert.id
  });

  return alert;
}

function generateVoiceMessage(alert) {
  const t = alert.temperature != null ? `${alert.temperature.toFixed(1)} degrees Celsius` : 'unknown';
  switch (alert.severity) {
    case 'CRITICAL':
      return `Critical alert. Temperature is ${t}. Immediate inspection recommended. Risk score ${alert.riskScore}.`;
    case 'HIGH':
      return `High risk alert. Temperature ${t}. Please check the cold-chain unit.`;
    case 'WARNING':
      return `Warning. ${alert.title}. Temperature ${t}.`;
    default:
      return alert.message;
  }
}

// ======================== INCIDENTS ========================
function createOrUpdateIncident(alert, reading, risk) {
  let incident = state.incidents.find(i => i.status !== 'RESOLVED' && i.trigger === alert.title);

  if (!incident) {
    incident = {
      id: 'INC-' + uuidv4().slice(0, 8).toUpperCase(),
      trigger: alert.title,
      severity: alert.severity,
      deviceId: state.device.deviceId,
      temperature: reading.temperature,
      humidity: reading.humidity,
      vibration: reading.vibration,
      riskScore: risk.score,
      startTime: nowISO(),
      endTime: null,
      durationSec: 0,
      status: 'OPEN',
      acknowledged: false,
      actions: [],
      peakTemp: reading.temperature,
      timeline: [{ time: nowISO(), event: 'Incident opened', detail: alert.message }]
    };
    state.incidents.unshift(incident);
    io.emit('incident:new', incident);
    audit('INCIDENT_CREATED', { incidentId: incident.id, severity: alert.severity });
  } else {
    if (reading.temperature != null && (incident.peakTemp == null || reading.temperature > incident.peakTemp)) {
      incident.peakTemp = reading.temperature;
    }
    if (severityRank(alert.severity) > severityRank(incident.severity)) {
      incident.severity = alert.severity;
      incident.timeline.push({ time: nowISO(), event: 'Escalated', detail: `Severity now ${alert.severity}` });
    }
    incident.riskScore = risk.score;
    incident.temperature = reading.temperature;
    io.emit('incident:update', incident);
  }
}

function severityRank(s) {
  return { CRITICAL: 5, HIGH: 4, WARNING: 3, WATCH: 2, INFO: 1, GOOD: 0 }[s] || 0;
}

function checkIncidentRecovery(risk) {
  state.incidents.forEach(inc => {
    if (inc.status !== 'RESOLVED' && (risk.level === 'GOOD' || risk.level === 'WATCH')) {
      inc.status = 'RESOLVED';
      inc.endTime = nowISO();
      inc.durationSec = Math.round((new Date(inc.endTime) - new Date(inc.startTime)) / 1000);
      inc.timeline.push({ time: nowISO(), event: 'Recovered', detail: `Risk returned to ${risk.score}` });
      io.emit('incident:update', inc);
      audit('INCIDENT_RESOLVED', { incidentId: inc.id, durationSec: inc.durationSec });
    }
  });
}

// ======================== TELEGRAM ========================
async function sendTelegramAlert(alert) {
  if (!state.telegram.configured) return;
  const key = alert.severity + alert.title;
  const last = state.telegram.lastSent[key] || 0;
  if (Date.now() - last < 45000) return;

  const text = [
    `*VAXGUARD X — ${alert.severity} ALERT*`,
    `Device: ${alert.deviceId}`,
    `Event: ${alert.title}`,
    `Temperature: ${alert.temperature != null ? alert.temperature.toFixed(1) + '°C' : 'N/A'}`,
    `Humidity: ${alert.humidity != null ? alert.humidity.toFixed(0) + '%' : 'N/A'}`,
    `Vibration: ${alert.vibration ? 'Detected' : 'None'}`,
    `Risk: ${alert.riskScore}/100`,
    `Mode: ${alert.mode}`,
    `Message: ${alert.message}`,
    `Event ID: ${alert.id}`,
    `Time: ${alert.timestamp}`
  ].join('\n');

  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown'
      })
    });
    if (res.ok) {
      state.telegram.lastSent[key] = Date.now();
      audit('TELEGRAM_SENT', { alertId: alert.id, severity: alert.severity });
      io.emit('telegram:sent', { alertId: alert.id });
    } else {
      audit('TELEGRAM_FAILED', { alertId: alert.id, status: res.status });
    }
  } catch (err) {
    audit('TELEGRAM_FAILED', { alertId: alert.id, error: err.message });
  }
}

// ======================== TELEMETRY INGEST ========================
app.post('/api/telemetry', (req, res) => {
  const body = req.body || {};
  const reading = {
    deviceId: body.deviceId || 'VaxGuard-01',
    mode: body.mode || 'LIVE',
    temperature: body.temperature != null ? Number(body.temperature) : null,
    humidity: body.humidity != null ? Number(body.humidity) : null,
    vibration: !!body.vibration,
    sensorHealth: body.sensorHealth !== false,
    timestamp: nowISO(),
    uptime: body.uptime || 0,
    wifiRssi: body.wifiRssi,
    freeHeap: body.freeHeap,
    firmware: body.firmware || '1.0.0'
  };

  state.device.deviceId = reading.deviceId;
  state.device.mode = reading.mode;
  state.device.online = true;
  state.device.lastSeen = reading.timestamp;
  state.device.uptime = reading.uptime;
  state.device.wifiRssi = reading.wifiRssi;
  state.device.freeHeap = reading.freeHeap;
  state.device.firmware = reading.firmware;

  state.sensors.temperature = reading.temperature;
  state.sensors.humidity = reading.humidity;
  state.sensors.vibration = reading.vibration;
  state.sensors.sensorHealth = reading.sensorHealth;
  state.sensors.lastUpdate = reading.timestamp;

  state.history.push({
    temperature: reading.temperature,
    humidity: reading.humidity,
    vibration: reading.vibration,
    timestamp: reading.timestamp,
    mode: reading.mode
  });
  if (state.history.length > MAX_HISTORY) state.history.shift();

  state.stats.totalReadings++;
  if (reading.temperature != null) {
    if (state.stats.maxTemp == null || reading.temperature > state.stats.maxTemp) state.stats.maxTemp = reading.temperature;
    if (state.stats.minTemp == null || reading.temperature < state.stats.minTemp) state.stats.minTemp = reading.temperature;
  }

  if (reading.vibration) {
    state.stats.vibrationCount++;
    state.vibrationEvents.unshift({ timestamp: reading.timestamp, mode: reading.mode });
    if (state.vibrationEvents.length > 100) state.vibrationEvents.pop();
    io.emit('vibration:event', { timestamp: reading.timestamp });
  }

  const risk = computeRisk(reading);
  state.risk = risk;
  state.prediction = computePrediction();
  state.condition = computeCondition(risk, reading.temperature);

  evaluateAlerts(reading, risk);
  checkIncidentRecovery(risk);

  io.emit('sensor:update', {
    sensors: state.sensors,
    device: state.device,
    risk: state.risk,
    prediction: state.prediction,
    condition: state.condition
  });
  io.emit('risk:update', state.risk);
  io.emit('prediction:update', state.prediction);

  if (state.stats.totalReadings % 15 === 0) persistHistory();

  res.json({ ok: true, riskScore: risk.score });
});

// ======================== API ROUTES ========================
app.get('/api/status', (req, res) => {
  const online = state.device.lastSeen && (Date.now() - new Date(state.device.lastSeen).getTime() < 15000);
  state.device.online = online;
  res.json({
    device: state.device,
    sensors: state.sensors,
    risk: state.risk,
    prediction: state.prediction,
    condition: state.condition,
    settings: {
      tempMin: state.settings.tempMin,
      tempMax: state.settings.tempMax,
      voiceAlertsEnabled: state.settings.voiceAlertsEnabled,
      telegramEnabled: state.settings.telegramEnabled,
      telegramConfigured: state.telegram.configured
    },
    stats: state.stats,
    serverTime: nowISO()
  });
});

app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 300, 1000);
  res.json(state.history.slice(-limit));
});

app.get('/api/alerts', (req, res) => {
  res.json(state.alerts.slice(0, 100));
});

app.get('/api/incidents', (req, res) => {
  res.json(state.incidents.slice(0, 50));
});

app.get('/api/audit', (req, res) => {
  res.json(state.audit.slice(0, 100));
});

app.get('/api/risk', (req, res) => {
  res.json(state.risk);
});

app.get('/api/prediction', (req, res) => {
  res.json(state.prediction);
});

app.get('/api/device', (req, res) => {
  res.json(state.device);
});

app.get('/api/sensors', (req, res) => {
  res.json(state.sensors);
});

app.post('/api/alerts/acknowledge', (req, res) => {
  const { id } = req.body;
  const alert = state.alerts.find(a => a.id === id);
  if (alert) {
    alert.acknowledged = true;
    audit('ALERT_ACKNOWLEDGED', { alertId: id });
    io.emit('alert:update', alert);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Alert not found' });
  }
});

app.post('/api/incidents/acknowledge', (req, res) => {
  const { id } = req.body;
  const inc = state.incidents.find(i => i.id === id);
  if (inc) {
    inc.acknowledged = true;
    inc.status = 'ACKNOWLEDGED';
    inc.timeline.push({ time: nowISO(), event: 'Acknowledged', detail: 'Operator acknowledged' });
    audit('INCIDENT_ACKNOWLEDGED', { incidentId: id });
    io.emit('incident:update', inc);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Incident not found' });
  }
});

app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  if (body.tempMin != null) state.settings.tempMin = Number(body.tempMin);
  if (body.tempMax != null) state.settings.tempMax = Number(body.tempMax);
  if (body.voiceAlertsEnabled != null) state.settings.voiceAlertsEnabled = !!body.voiceAlertsEnabled;
  if (body.telegramEnabled != null) state.settings.telegramEnabled = !!body.telegramEnabled;
  if (body.alertCooldownSec != null) state.settings.alertCooldownSec = Number(body.alertCooldownSec);
  if (body.demoTestAlerts != null) state.settings.demoTestAlerts = !!body.demoTestAlerts;
  audit('SETTINGS_CHANGED', body);
  io.emit('settings:update', state.settings);
  res.json({ ok: true, settings: state.settings });
});

app.get('/api/settings', (req, res) => {
  res.json({
    ...state.settings,
    telegramConfigured: state.telegram.configured,
    llmConfigured: !!(process.env.LLM_API_KEY)
  });
});

app.post('/api/demo', (req, res) => {
  const { action, state: demoState } = req.body || {};
  audit('DEMO_COMMAND', { action, demoState });
  if (action === 'inject') {
    const simulated = {
      deviceId: 'VaxGuard-01',
      mode: 'DEMO',
      temperature: demoState === 'CRITICAL' ? 11.5 : demoState === 'HIGH' ? 8.6 : demoState === 'LOW' ? 1.5 : 5.3,
      humidity: 60,
      vibration: demoState === 'VIBRATION' || demoState === 'CRITICAL',
      sensorHealth: true,
      uptime: state.device.uptime || 100,
      wifiRssi: -55,
      freeHeap: 200000,
      firmware: '1.0.0'
    };
    const reading = { ...simulated, timestamp: nowISO() };
    state.device.mode = 'DEMO';
    state.device.online = true;
    state.device.lastSeen = reading.timestamp;
    state.sensors.temperature = reading.temperature;
    state.sensors.humidity = reading.humidity;
    state.sensors.vibration = reading.vibration;
    state.sensors.sensorHealth = true;
    state.sensors.lastUpdate = reading.timestamp;
    state.history.push({ temperature: reading.temperature, humidity: reading.humidity, vibration: reading.vibration, timestamp: reading.timestamp, mode: 'DEMO' });
    const risk = computeRisk(reading);
    state.risk = risk;
    state.prediction = computePrediction();
    state.condition = computeCondition(risk, reading.temperature);
    evaluateAlerts(reading, risk);
    io.emit('sensor:update', { sensors: state.sensors, device: state.device, risk: state.risk, prediction: state.prediction, condition: state.condition });
    return res.json({ ok: true, injected: true, risk });
  }
  res.json({ ok: true, message: 'Use ESP32 serial commands for full hardware demo, or action=inject for UI simulation' });
});

app.post('/api/selftest', (req, res) => {
  audit('SELFTEST_REQUESTED', {});
  res.json({
    ok: true,
    results: {
      backend: 'OK',
      socketio: 'OK',
      telegram: state.telegram.configured ? 'CONFIGURED' : 'NOT_CONFIGURED',
      llm: process.env.LLM_API_KEY ? 'CONFIGURED' : 'NOT_CONFIGURED',
      historyPoints: state.history.length,
      deviceOnline: state.device.online
    }
  });
});

app.post('/api/telegram/test', async (req, res) => {
  if (!state.telegram.configured) {
    return res.status(400).json({ error: 'Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env' });
  }
  const testAlert = {
    id: 'TEST-' + Date.now(),
    severity: 'INFO',
    title: 'Test Alert',
    message: 'This is a VaxGuard X Telegram connectivity test.',
    temperature: state.sensors.temperature,
    humidity: state.sensors.humidity,
    vibration: false,
    riskScore: state.risk.score,
    deviceId: state.device.deviceId,
    mode: state.device.mode,
    timestamp: nowISO()
  };
  await sendTelegramAlert(testAlert);
  res.json({ ok: true });
});

app.post('/api/voice/query', async (req, res) => {
  const { question } = req.body || {};
  if (!question) return res.status(400).json({ error: 'Missing question' });

  const context = {
    temperature: state.sensors.temperature,
    humidity: state.sensors.humidity,
    vibration: state.sensors.vibration,
    riskScore: state.risk.score,
    riskLevel: state.risk.level,
    riskFactors: state.risk.factors,
    condition: state.condition,
    prediction: state.prediction,
    deviceOnline: state.device.online,
    mode: state.device.mode,
    sensorHealth: state.sensors.sensorHealth,
    lastUpdate: state.sensors.lastUpdate,
    recentAlerts: state.alerts.slice(0, 5).map(a => ({ severity: a.severity, title: a.title, time: a.timestamp })),
    openIncidents: state.incidents.filter(i => i.status !== 'RESOLVED').length
  };

  const answer = localVoiceAnswer(question, context);

  if (process.env.LLM_API_KEY) {
    try {
      const llmAnswer = await callLLM(question, context);
      if (llmAnswer) {
        audit('VOICE_QUERY', { question, source: 'llm' });
        return res.json({ answer: llmAnswer, source: 'llm', context });
      }
    } catch (e) {}
  }

  audit('VOICE_QUERY', { question, source: 'local' });
  res.json({ answer, source: 'local', context });
});

function localVoiceAnswer(q, ctx) {
  const lower = q.toLowerCase();

  if (lower.includes('temperature') || lower.includes('temp')) {
    if (ctx.temperature == null) return 'Current temperature data is unavailable. The sensor may be offline or still initializing.';
    return `The current temperature is ${ctx.temperature.toFixed(1)} degrees Celsius. Mode is ${ctx.mode}.`;
  }
  if (lower.includes('humidity')) {
    if (ctx.humidity == null) return 'Humidity reading is currently unavailable.';
    return `Humidity is ${ctx.humidity.toFixed(0)} percent.`;
  }
  if (lower.includes('risk')) {
    const factors = (ctx.riskFactors || []).map(f => f.name).join(', ') || 'none significant';
    return `Current risk score is ${ctx.riskScore} out of 100, level ${ctx.riskLevel}. Main factors: ${factors}.`;
  }
  if (lower.includes('safe') || lower.includes('condition')) {
    return `Observed cold-chain condition is ${ctx.condition.replace('_', ' ')}. Risk level is ${ctx.riskLevel}. This is a monitoring assessment, not a medical validation of vaccine potency.`;
  }
  if (lower.includes('vibration') || lower.includes('shake')) {
    return ctx.vibration ? 'Yes, a vibration event was recently detected.' : 'No vibration is currently detected.';
  }
  if (lower.includes('online') || lower.includes('device') || lower.includes('esp')) {
    return ctx.deviceOnline ? `The device ${state.device.deviceId} is online. Mode: ${ctx.mode}.` : 'The ESP32 device appears offline. No recent heartbeat received.';
  }
  if (lower.includes('sensor health') || lower.includes('sensor')) {
    return ctx.sensorHealth ? 'Sensor health is good. DHT11 is returning valid readings.' : 'Sensor health is degraded. DHT11 may have a wiring or power issue.';
  }
  if (lower.includes('prediction') || lower.includes('trend') || lower.includes('early')) {
    return `Trend direction: ${ctx.prediction.direction}. ${ctx.prediction.reason}. Confidence: ${ctx.prediction.confidence}.`;
  }
  if (lower.includes('alert') || lower.includes('incident')) {
    const open = ctx.openIncidents || 0;
    const last = (ctx.recentAlerts && ctx.recentAlerts[0]) ? ctx.recentAlerts[0].title : 'none recent';
    return `There are ${open} open incidents. Most recent alert: ${last}.`;
  }
  if (lower.includes('summary') || lower.includes('status') || lower.includes('what is happening')) {
    return `Temperature ${ctx.temperature?.toFixed(1) ?? 'N/A'}°C, humidity ${ctx.humidity?.toFixed(0) ?? 'N/A'}%, risk ${ctx.riskScore}/100 (${ctx.riskLevel}), condition ${ctx.condition}, mode ${ctx.mode}, device ${ctx.deviceOnline ? 'online' : 'offline'}.`;
  }
  if (lower.includes('why') && lower.includes('risk')) {
    const factors = (ctx.riskFactors || []).map(f => `${f.name} (+${f.points})`).join('; ') || 'No major factors';
    return `Risk is elevated because: ${factors}.`;
  }

  return `I understood your question about the cold-chain system. Current temperature is ${ctx.temperature?.toFixed(1) ?? 'unavailable'}°C with risk score ${ctx.riskScore}. You can ask about temperature, risk, vibration, prediction, alerts, or device status.`;
}

async function callLLM(question, context) {
  const system = `You are VaxGuard AI Voice Assistant for a cold-chain monitoring prototype.
Sensor telemetry is AUTHORITATIVE. Never invent measurements.
Do not claim medical validation or vaccine potency.
Distinguish measurement vs analysis vs prediction.
Be concise and professional.
Current context: ${JSON.stringify(context)}`;

  const res = await fetch(process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.LLM_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: question }
      ],
      max_tokens: 250,
      temperature: 0.3
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

app.get('/api/export/:type', (req, res) => {
  const type = req.params.type;
  if (type === 'history') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=vaxguard-history.json');
    return res.send(JSON.stringify(state.history, null, 2));
  }
  if (type === 'alerts') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=vaxguard-alerts.json');
    return res.send(JSON.stringify(state.alerts, null, 2));
  }
  if (type === 'audit') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=vaxguard-audit.json');
    return res.send(JSON.stringify(state.audit, null, 2));
  }
  if (type === 'csv') {
    const rows = ['timestamp,temperature,humidity,vibration,mode'];
    state.history.forEach(r => {
      rows.push(`${r.timestamp},${r.temperature ?? ''},${r.humidity ?? ''},${r.vibration ? 1 : 0},${r.mode}`);
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=vaxguard-history.csv');
    return res.send(rows.join('\n'));
  }
  res.status(400).json({ error: 'Unknown export type' });
});

// Offline detection
setInterval(() => {
  if (state.device.lastSeen) {
    const age = Date.now() - new Date(state.device.lastSeen).getTime();
    if (age > 15000 && state.device.online) {
      state.device.online = false;
      io.emit('device:offline', { deviceId: state.device.deviceId, lastSeen: state.device.lastSeen });
      audit('DEVICE_OFFLINE', { lastSeen: state.device.lastSeen });
      createAlert('HIGH', 'Device Offline', 'ESP32 heartbeat lost. Local monitoring may still be active on device.', state.sensors, state.risk);
    }
  }
}, 5000);

// ======================== SOCKET.IO ========================
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('sensor:update', {
    sensors: state.sensors,
    device: state.device,
    risk: state.risk,
    prediction: state.prediction,
    condition: state.condition
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ======================== START ========================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`  VaxGuard X Server running on :${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`========================================\n`);
  audit('SERVER_STARTED', { port: PORT });
});
