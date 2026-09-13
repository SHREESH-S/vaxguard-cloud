require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const fetch = require('node-fetch');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const ENV = {
  PORT: process.env.PORT || 3000,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  DEVICE_KEY: process.env.DEVICE_KEY || '',
  ALERT_CALL_ENABLED: false,
  DEMO_CALL_ENABLED: false
};

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(name, fallback) {
  try {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return fallback; }
}

function saveJSON(name, data) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2));
  } catch (e) {}
}

const state = {
  mode: 'DEMO',
  wifiOk: true,
  latest: null,
  history: loadJSON('history.json', []),
  audit: loadJSON('audit.json', []),
  incidents: loadJSON('incidents.json', []),
  vaccineQualityScore: 100,
  livingMyth: "The Guardian awakens...",
  digitalArtifact: { level: 1, title: "Nascent Sentinel", evolution: 0 }
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const nowIso = () => new Date().toISOString();

function severityFromRisk(risk) {
  if (risk >= 80) return { level: 4, label: 'CRITICAL' };
  if (risk >= 60) return { level: 3, label: 'HIGH_RISK' };
  if (risk >= 40) return { level: 2, label: 'WARNING' };
  if (risk >= 20) return { level: 1, label: 'INFORMATION' };
  return { level: 0, label: 'NORMAL' };
}

function calcRiskScore(reading) {
  const T = CFG.thresholds;
  let risk = 0;
  if (reading.temperature < T.tempMin) risk += 50;
  else if (reading.temperature > T.tempMax) risk += 55;
  if (reading.vibration) risk += 25;
  if (reading.sensorFault) risk += 20;
  return Math.round(clamp(risk, 0, 100));
}

function processEvent(raw) {
  if (raw.mode) state.mode = raw.mode;

  const reading = {
    timestamp: nowIso(),
    mode: state.mode,
    temperature: typeof raw.temperature === 'number' ? raw.temperature : 5,
    humidity: typeof raw.humidity === 'number' ? raw.humidity : 55,
    vibration: !!raw.vibration,
    sensorFault: !!raw.sensorFault,
    source: raw.source || 'ESP32'
  };

  const riskScore = calcRiskScore(reading);
  const severity = severityFromRisk(riskScore);
  const conditionScore = Math.round(100 - riskScore * 0.9);

  reading.riskScore = riskScore;
  reading.conditionScore = conditionScore;
  reading.severity = severity.label;
  reading.severityLevel = severity.level;
  reading.confidence = 85;
  reading.explanation = `Temperature is ${reading.temperature}°C. Vibration: ${reading.vibration ? 'Detected' : 'Normal'}.`;
  reading.recommendation = severity.level >= 3 ? 'Inspect the unit immediately.' : 'Continue monitoring.';
  reading.voiceMessage = `VaxGuard alert. Severity ${severity.label}. Temperature ${reading.temperature} degrees.`;
  reading.vaccineQuality = state.vaccineQualityScore;
  reading.livingMyth = state.livingMyth;

  state.latest = reading;
  state.history.push(reading);
  if (state.history.length > 300) state.history.shift();

  saveJSON('history.json', state.history);

  if (severity.level >= 3 && ENV.TELEGRAM_BOT_TOKEN && ENV.TELEGRAM_CHAT_ID) {
    const text = `VAXGUARD ${severity.label}\nTemp: ${reading.temperature}°C\nVibration: ${reading.vibration}\nRisk: ${riskScore}`;
    fetch(`https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ENV.TELEGRAM_CHAT_ID, text })
    }).catch(() => {});
  }

  broadcast();
  return reading;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

function publicState() {
  return {
    mode: state.mode,
    wifiOk: state.wifiOk,
    latest: state.latest,
    history: state.history.slice(-100),
    livingMyth: state.livingMyth,
    digitalArtifact: state.digitalArtifact
  };
}

function broadcast() {
  io.emit('state', publicState());
}

io.on('connection', (socket) => {
  socket.emit('state', publicState());
});

app.get('/api/state', (req, res) => res.json(publicState()));
app.get('/api/health', (req, res) => res.json({ ok: true, mode: state.mode }));

app.post('/api/event', (req, res) => {
  try {
    const body = req.body || {};
    const reading = processEvent(body);
    res.json({ ok: true, reading });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/demo/:command', (req, res) => {
  const cmd = req.params.command.toLowerCase();
  let ev = { mode: 'DEMO', temperature: 5, humidity: 55, vibration: false, sensorFault: false };

  if (cmd === 'normal') ev.temperature = 5;
  else if (cmd === 'low') ev.temperature = 1;
  else if (cmd === 'high') ev.temperature = 9;
  else if (cmd === 'warning') ev.temperature = 9.5;
  else if (cmd === 'danger' || cmd === 'critical') { ev.temperature = 12; ev.vibration = true; }
  else if (cmd === 'vibration') ev.vibration = true;
  else if (cmd === 'novibration') ev.vibration = false;
  else if (cmd === 'sensorfault') ev.sensorFault = true;
  else if (cmd === 'recovery' || cmd === 'reset') { ev.temperature = 5; ev.vibration = false; }

  const reading = processEvent(ev);
  res.json({ ok: true, reading });
});

app.post('/api/mode', (req, res) => {
  const m = (req.body.mode || '').toUpperCase();
  if (m === 'REAL' || m === 'DEMO') {
    state.mode = m;
    broadcast();
  }
  res.json({ ok: true, mode: state.mode });
});

server.listen(ENV.PORT, () => {
  console.log(`VaxGuard server running on port ${ENV.PORT}`);
});