/* =========================================================================
   VAXGUARD PRO - Node.js Express & WebSocket Backend
   ========================================================================= */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Load configuration
let config = {};
try {
  const configPath = path.join(__dirname, 'config.json');
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  config = {
    deviceId: "VAXGUARD-001",
    locationLabel: "Pharmacy Main Storage Unit A",
    thresholds: { min: 2.0, max: 8.0, warnLow: 2.8, warnHigh: 7.2, vibWarn: 3, vibBreach: 8 },
    samplingIntervalMs: 5000,
    cooldownMs: 15000
  };
}

// In-Memory State & Ring Buffers
let systemState = {
  deviceId: config.deviceId || "VAXGUARD-001",
  locationLabel: config.locationLabel || "Pharmacy Unit A",
  mode: "REAL",
  temperature: 5.0,
  humidity: 55.0,
  vibration: false,
  sensorFault: false,
  wifiOk: true,
  state: "SAFE",
  riskScore: 5,
  conditionScore: 95,
  sensorHealth: 100,
  dataConfidence: 98,
  trend: "STABLE",
  predictedRisk: 5,
  anomalyScore: 0,
  breachCountdownSec: -1,
  advisoryMsg: "Conditions are stable within optimal monitoring range.",
  correlationMsg: "No vibration or environmental anomalies detected.",
  alertPriority: "INFO",
  uptimeSec: 0,
  lastUpdate: Date.now()
};

const BOOT_TIME = Date.now();
const MAX_HISTORY = 100;
const MAX_ALERTS = 50;
const MAX_AUDIT = 150;

let tempHistory = [];
let alertHistory = [];
let auditTrail = [];
let incidentTimeline = [];
let offlineQueue = [];
let lastAlertTimestamp = 0;

// Telegram Config from Environment Variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const DEVICE_KEY = process.env.DEVICE_KEY || "vaxguard-secret-key-2026";

// Broadcast to all WebSocket clients
function broadcastWS(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Telegram Alert Sender
async function sendTelegramAlert(priority, message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const text = `🚨 *VAXGUARD ALERT* [${priority}]\n\n` +
                 `Device: ${systemState.deviceId} (${systemState.locationLabel})\n` +
                 `State: *${systemState.state}* | Risk: ${systemState.riskScore}/100\n` +
                 `Temp: ${systemState.temperature.toFixed(1)}°C | Humidity: ${systemState.humidity.toFixed(1)}%\n` +
                 `Vibration: ${systemState.vibration ? 'DETECTED' : 'NORMAL'}\n\n` +
                 `_Details:_ ${message}`;

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'Markdown' })
    });
  } catch (err) {
    console.error("[Telegram] Failed to send alert:", err.message);
  }
}

// AI Scoring & State Engine
function evaluateTelemetry(data) {
  systemState.mode = data.mode || systemState.mode;
  systemState.temperature = typeof data.temperature === 'number' ? data.temperature : systemState.temperature;
  systemState.humidity = typeof data.humidity === 'number' ? data.humidity : systemState.humidity;
  systemState.vibration = !!data.vibration;
  systemState.sensorFault = !!data.sensorFault;
  systemState.wifiOk = data.wifiOk !== undefined ? !!data.wifiOk : true;
  systemState.uptimeSec = Math.floor((Date.now() - BOOT_TIME) / 1000);
  systemState.lastUpdate = Date.now();

  const tMin = config.thresholds.min;
  const tMax = config.thresholds.max;
  const wLow = config.thresholds.warnLow;
  const wHigh = config.thresholds.warnHigh;

  // Track Temperature History for Trend & Prediction
  tempHistory.push({ time: systemState.lastUpdate, temp: systemState.temperature });
  if (tempHistory.length > 20) tempHistory.shift();

  // Calculate Trend
  if (tempHistory.length >= 5) {
    const recent = tempHistory.slice(-5);
    const slope = (recent[recent.length - 1].temp - recent[0].temp) / recent.length;
    if (slope > 0.05) systemState.trend = "RISING";
    else if (slope < -0.05) systemState.trend = "FALLING";
    else systemState.trend = "STABLE";
  }

  // Sensor Health & Confidence
  if (systemState.sensorFault) {
    systemState.sensorHealth = 30;
    systemState.dataConfidence = 40;
    systemState.state = "SENSOR_FAULT";
    systemState.riskScore = 85;
  } else {
    systemState.sensorHealth = 100;
    systemState.dataConfidence = 96;

    // State Evaluation
    if (systemState.temperature < tMin || systemState.temperature > tMax || systemState.vibration) {
      systemState.state = "CRITICAL";
      systemState.riskScore = systemState.vibration ? 90 : 75;
    } else if (systemState.temperature <= wLow || systemState.temperature >= wHigh) {
      systemState.state = "WARNING";
      systemState.riskScore = 40;
    } else {
      systemState.state = "SAFE";
      systemState.riskScore = 10;
    }
  }

  systemState.conditionScore = Math.max(0, 100 - systemState.riskScore);
  systemState.predictedRisk = Math.min(100, systemState.riskScore + (systemState.trend === "RISING" && systemState.temperature > 6 ? 15 : 0));
  systemState.anomalyScore = Math.min(100, Math.abs(systemState.temperature - 5.0) * 15);

  // Friendly Advisory & Correlation
  if (systemState.state === "CRITICAL") {
    systemState.advisoryMsg = systemState.vibration ? "Severe shock and temperature excursion detected. Inspect storage container immediately." : "Storage temperature is outside validated cold-chain limits. Move contents to backup unit.";
    systemState.correlationMsg = systemState.vibration ? "Vibration event correlates with environmental excursion risk." : "Temperature excursion verified by continuous sensor telemetry.";
    systemState.alertPriority = "CRITICAL";
  } else if (systemState.state === "WARNING") {
    systemState.advisoryMsg = "Temperature is drifting toward boundary limits. Check door seal and cooling unit.";
    systemState.correlationMsg = "Stable vibration profile; thermal drift observed.";
    systemState.alertPriority = "WARNING";
  } else if (systemState.state === "SENSOR_FAULT") {
    systemState.advisoryMsg = "Sensor communication interrupted. Check wiring on GPIO 4 (DHT11).";
    systemState.correlationMsg = "Telemetry loss detected.";
    systemState.alertPriority = "CRITICAL";
  } else {
    systemState.advisoryMsg = "Conditions are currently within optimal monitoring range. Continue routine observation.";
    systemState.correlationMsg = "No anomalies detected.";
    systemState.alertPriority = "INFO";
  }

  // Audit Logging
  const auditRow = {
    timestamp: new Date().toISOString(),
    temp: systemState.temperature,
    humidity: systemState.humidity,
    vibration: systemState.vibration,
    state: systemState.state,
    risk: systemState.riskScore,
    condition: systemState.conditionScore,
    health: systemState.sensorHealth,
    mode: systemState.mode
  };
  auditTrail.unshift(auditRow);
  if (auditTrail.length > MAX_AUDIT) auditTrail.pop();

  // Alert Trigger with Cooldown
  const now = Date.now();
  if ((systemState.state === "CRITICAL" || systemState.state === "WARNING" || systemState.state === "SENSOR_FAULT") &&
      (now - lastAlertTimestamp > (config.cooldownMs || 15000))) {
    lastAlertTimestamp = now;
    const alertMsg = {
      timestamp: new Date().toLocaleTimeString(),
      priority: systemState.alertPriority,
      state: systemState.state,
      message: systemState.advisoryMsg
    };
    alertHistory.unshift(alertMsg);
    if (alertHistory.length > MAX_ALERTS) alertHistory.pop();

    incidentTimeline.unshift({
      timestamp: new Date().toLocaleString(),
      type: systemState.state,
      description: systemState.advisoryMsg
    });

    sendTelegramAlert(systemState.alertPriority, systemState.advisoryMsg);
  }

  broadcastWS(systemState);
}

// REST API Endpoints
app.get('/api/status', (req, res) => {
  res.json({ ok: true, systemState });
});

app.get('/api/history', (req, res) => {
  res.json({ ok: true, history: tempHistory });
});

app.get('/api/alerts', (req, res) => {
  res.json({ ok: true, alerts: alertHistory });
});

app.get('/api/incidents', (req, res) => {
  res.json({ ok: true, incidents: incidentTimeline });
});

app.get('/api/analytics', (req, res) => {
  const temps = tempHistory.map(h => h.temp);
  const min = temps.length ? Math.min(...temps) : 5.0;
  const max = temps.length ? Math.max(...temps) : 5.0;
  const avg = temps.length ? (temps.reduce((a, b) => a + b, 0) / temps.length) : 5.0;
  res.json({ ok: true, analytics: { min, max, avg, count: temps.length, trend: systemState.trend } });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    health: {
      dht11: systemState.sensorFault ? "FAIL" : "OK",
      sw420: "OK",
      esp32: "CONNECTED",
      wifi: systemState.wifiOk ? "CONNECTED" : "DISCONNECTED",
      server: "ONLINE",
      uptimeSec: systemState.uptimeSec,
      confidence: systemState.dataConfidence
    }
  });
});

app.get('/api/config', (req, res) => {
  res.json({ ok: true, config });
});

app.post('/api/config', (req, res) => {
  const newConfig = req.body;
  if (newConfig.thresholds) config.thresholds = newConfig.thresholds;
  if (newConfig.locationLabel) {
    config.locationLabel = newConfig.locationLabel;
    systemState.locationLabel = config.locationLabel;
  }
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
  res.json({ ok: true, config });
});

app.post('/api/device-data', (req, res) => {
  const key = req.headers['x-device-key'];
  if (DEVICE_KEY && key !== DEVICE_KEY && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ ok: false, error: 'Unauthorized device key' });
  }
  evaluateTelemetry(req.body);
  res.json({ ok: true, state: systemState.state, severityLevel: systemState.state === 'SAFE' ? 0 : (systemState.state === 'WARNING' ? 2 : 4) });
});

app.post('/api/alerts/test', (req, res) => {
  sendTelegramAlert("INFO", "Manual test alert triggered from dashboard.");
  res.json({ ok: true, message: "Test alert dispatched" });
});

app.post('/api/assistant', (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ ok: false, error: 'Missing question' });

  const q = question.toLowerCase();
  let answer = "";

  if (q.includes('temperature') || q.includes('temp')) {
    answer = `The current storage temperature is ${systemState.temperature.toFixed(1)}°C, with a humidity of ${systemState.humidity.toFixed(1)}%.`;
  } else if (q.includes('risk') || q.includes('why')) {
    answer = `Current system risk is evaluated at ${systemState.riskScore}/100. ${systemState.advisoryMsg}`;
  } else if (q.includes('safe') || q.includes('status')) {
    answer = `System status is currently ${systemState.state}. Condition score is ${systemState.conditionScore}/100.`;
  } else if (q.includes('vibration') || q.includes('shock')) {
    answer = `Vibration sensor status: ${systemState.vibration ? 'Vibration detected!' : 'Normal, no abnormal vibration.'}`;
  } else if (q.includes('sensor') || q.includes('health')) {
    answer = `Sensor health score is ${systemState.sensorHealth}% with ${systemState.dataConfidence}% data confidence. DHT11 and SW420 operational status is nominal.`;
  } else if (q.includes('what should') || q.includes('action')) {
    answer = `Recommended action: ${systemState.advisoryMsg}`;
  } else {
    answer = `Based on live telemetry for ${systemState.deviceId} at ${systemState.locationLabel}, the system state is ${systemState.state} with a temperature of ${systemState.temperature.toFixed(1)}°C. ${systemState.advisoryMsg}`;
  }

  res.json({ ok: true, answer });
});

app.get('/api/export/csv', (req, res) => {
  let csv = "Timestamp,Temperature(C),Humidity(%),Vibration,State,RiskScore,ConditionScore,SensorHealth,Mode\n";
  auditTrail.forEach(row => {
    csv += `${row.timestamp},${row.temp},${row.humidity},${row.vibration},${row.state},${row.risk},${row.condition},${row.health},${row.mode}\n`;
  });
  res.header('Content-Type', 'text/csv');
  res.attachment('vaxguard-audit-report.csv');
  res.send(csv);
});

app.get('/api/export/json', (req, res) => {
  res.header('Content-Type', 'application/json');
  res.attachment('vaxguard-audit-report.json');
  res.send(JSON.stringify({ deviceId: systemState.deviceId, auditTrail, alertHistory }, null, 2));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[VaxGuard Cloud] Server running on port ${PORT}`);
});
