/* =========================================================================
   VAXGUARD PRO — Node.js Express & WebSocket Server
   ========================================================================= */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let systemState = {
  deviceId: "VAXGUARD-001",
  locationLabel: "Pharmacy Main Storage Unit A",
  mode: "REAL",
  temperature: 5.0,
  humidity: 55.0,
  vibration: false,
  sensorFault: false,
  wifiOk: true,
  state: "NORMAL",
  riskScore: 10,
  conditionScore: 90,
  sensorHealth: 100,
  dataConfidence: 98,
  trend: "STABLE",
  predictedRisk: 12,
  anomalyScore: 0,
  potencyRetention: 99.8,
  advisoryMsg: "Cold-chain environment is fully optimal.",
  alertPriority: "INFO",
  uptimeSec: 0,
  lastUpdate: Date.now()
};

const BOOT_TIME = Date.now();
const MAX_HISTORY = 120;
const MAX_ALERTS = 50;
const MAX_AUDIT = 200;

let tempHistory = [];
let alertHistory = [];
let auditTrail = [];
let incidentTimeline = [];
let lastAlertTimestamp = 0;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

function broadcastWS(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

async function sendTelegramAlert(priority, message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const text = `🚨 *VAXGUARD PRO ALERT* [${priority}]\n\nDevice: ${systemState.deviceId}\nState: *${systemState.state}* | Risk: ${systemState.riskScore}/100\nTemp: ${systemState.temperature.toFixed(1)}°C\n\n_Advisory:_ ${message}`;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' })
    });
  } catch (err) {
    console.error("[Telegram] Dispatch error:", err.message);
  }
}

function evaluateTelemetry(data) {
  systemState.mode = data.mode || systemState.mode;
  systemState.temperature = typeof data.temperature === 'number' ? data.temperature : systemState.temperature;
  systemState.humidity = typeof data.humidity === 'number' ? data.humidity : systemState.humidity;
  systemState.vibration = !!data.vibration;
  systemState.sensorFault = !!data.sensorFault;
  systemState.wifiOk = data.wifiOk !== undefined ? !!data.wifiOk : true;
  systemState.uptimeSec = Math.floor((Date.now() - BOOT_TIME) / 1000);
  systemState.lastUpdate = Date.now();

  tempHistory.push({ time: systemState.lastUpdate, temp: systemState.temperature });
  if (tempHistory.length > MAX_HISTORY) tempHistory.shift();

  if (tempHistory.length >= 5) {
    const recent = tempHistory.slice(-5);
    const slope = (recent[recent.length - 1].temp - recent[0].temp) / recent.length;
    systemState.trend = slope > 0.05 ? "RISING" : (slope < -0.05 ? "FALLING" : "STABLE");
  }

  if (systemState.sensorFault) {
    systemState.state = "SENSOR FAULT";
    systemState.riskScore = 85;
    systemState.sensorHealth = 30;
    systemState.advisoryMsg = "Sensor hardware communication failure. Check wiring.";
    systemState.alertPriority = "CRITICAL";
  } else {
    systemState.sensorHealth = 100;
    if (systemState.temperature < 2.0) {
      systemState.state = "LOW";
      systemState.riskScore = 65;
      systemState.advisoryMsg = "Temperature below safe threshold (Freezing risk).";
      systemState.alertPriority = "WARNING";
    } else if (systemState.temperature > 8.0) {
      systemState.state = "HIGH";
      systemState.riskScore = 75;
      systemState.advisoryMsg = "Temperature above safe limit (Excursion risk).";
      systemState.alertPriority = "CRITICAL";
    } else if (systemState.vibration) {
      systemState.state = "WARNING";
      systemState.riskScore = 50;
      systemState.advisoryMsg = "Mechanical vibration/shock event detected.";
      systemState.alertPriority = "WARNING";
    } else {
      systemState.state = "NORMAL";
      systemState.riskScore = 10;
      systemState.advisoryMsg = "Cold-chain environment fully optimal.";
      systemState.alertPriority = "INFO";
    }
  }

  systemState.conditionScore = Math.max(0, 100 - systemState.riskScore);
  systemState.potencyRetention = Math.max(20, Number((99.9 - Math.max(0, systemState.temperature - 8.0) * 10).toFixed(1)));

  auditTrail.unshift({
    timestamp: new Date().toISOString(),
    temp: systemState.temperature,
    humidity: systemState.humidity,
    vibration: systemState.vibration,
    state: systemState.state,
    risk: systemState.riskScore,
    mode: systemState.mode
  });
  if (auditTrail.length > MAX_AUDIT) auditTrail.pop();

  const now = Date.now();
  if (systemState.alertPriority !== "INFO" && (now - lastAlertTimestamp > 15000)) {
    lastAlertTimestamp = now;
    alertHistory.unshift({ timestamp: new Date().toLocaleTimeString(), priority: systemState.alertPriority, state: systemState.state, message: systemState.advisoryMsg });
    if (alertHistory.length > MAX_ALERTS) alertHistory.pop();
    sendTelegramAlert(systemState.alertPriority, systemState.advisoryMsg);
  }

  broadcastWS(systemState);
}

app.get('/api/status', (req, res) => res.json({ ok: true, systemState }));
app.get('/api/history', (req, res) => res.json({ ok: true, history: tempHistory }));
app.get('/api/alerts', (req, res) => res.json({ ok: true, alerts: alertHistory }));
app.get('/api/audit', (req, res) => res.json({ ok: true, audit: auditTrail }));
app.get('/api/analytics', (req, res) => {
  const temps = tempHistory.map(h => h.temp);
  res.json({ ok: true, analytics: { min: temps.length ? Math.min(...temps) : 5, max: temps.length ? Math.max(...temps) : 5, avg: temps.length ? (temps.reduce((a,b)=>a+b,0)/temps.length) : 5, trend: systemState.trend } });
});

app.post('/api/device-data', (req, res) => {
  evaluateTelemetry(req.body);
  res.json({ ok: true, state: systemState.state });
});

app.post('/api/assistant', (req, res) => {
  const q = (req.body.question || "").toLowerCase();
  let answer = `System is currently in ${systemState.state} state at ${systemState.temperature.toFixed(1)}°C. ${systemState.advisoryMsg}`;
  if (q.includes('temp')) answer = `Current storage temperature is ${systemState.temperature.toFixed(1)}°C.`;
  else if (q.includes('risk')) answer = `Current risk score is ${systemState.riskScore} out of 100.`;
  else if (q.includes('vibration')) answer = systemState.vibration ? "Vibration event detected!" : "No recent vibration detected.";
  res.json({ ok: true, answer });
});

app.get('/api/export/csv', (req, res) => {
  let csv = "Timestamp,Temperature(C),Humidity(%),Vibration,State,RiskScore,Mode\n";
  auditTrail.forEach(r => { csv += `${r.timestamp},${r.temp},${r.humidity},${r.vibration},${r.state},${r.risk},${r.mode}\n`; });
  res.header('Content-Type', 'text/csv');
  res.attachment('vaxguard-audit-report.csv');
  res.send(csv);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[VaxGuard Cloud] Server online on port ${PORT}`));
