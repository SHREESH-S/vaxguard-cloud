const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'VAXGUARD_2026_MY_SECRET_1007';

// ===================== IN-MEMORY STORE (Multi-device ready) =====================
const devices = {};          // deviceId -> latest data
const history = {};          // deviceId -> array of readings
const alerts = [];           // global alerts
const auditLog = [];         // audit events
const incidents = [];        // open/closed incidents

const MAX_HISTORY = 500;

// ===================== MIDDLEWARE =====================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(bodyParser.json({ limit: '100kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests' }
});
app.use('/api/', limiter);

// API Key protection for device ingestion only
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// ===================== HELPERS =====================
function addAudit(event, details = '') {
  auditLog.unshift({
    ts: new Date().toISOString(),
    event,
    details
  });
  if (auditLog.length > 200) auditLog.pop();
}

function createIncident(deviceId, data) {
  const id = `INC-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(incidents.length + 1).padStart(3,'0')}`;
  const incident = {
    id,
    deviceId,
    start: new Date().toISOString(),
    end: null,
    status: 'OPEN',
    peakTemp: data.temperature,
    minTemp: data.temperature,
    reason: data.state,
    risk: data.risk,
    acknowledged: false,
    ackBy: null,
    ackAt: null
  };
  incidents.unshift(incident);
  return incident;
}

// ===================== API ROUTES =====================

// Device pushes data here
app.post('/api/ingest', requireApiKey, (req, res) => {
  try {
    const data = req.body;
    const deviceId = data.deviceId || req.headers['x-device-id'] || 'UNKNOWN';

    if (!data.temperature && data.temperature !== 0) {
      return res.status(400).json({ error: 'Missing temperature' });
    }

    const now = new Date().toISOString();
    const record = {
      ...data,
      deviceId,
      receivedAt: now,
      serverTs: Date.now()
    };

    // Store latest
    const prev = devices[deviceId];
    devices[deviceId] = record;

    // History
    if (!history[deviceId]) history[deviceId] = [];
    history[deviceId].unshift(record);
    if (history[deviceId].length > MAX_HISTORY) history[deviceId].pop();

    // Detect state change → create alert / incident
    if (prev && prev.state !== data.state) {
      const alert = {
        id: Date.now(),
        deviceId,
        ts: now,
        from: prev.state,
        to: data.state,
        temperature: data.temperature,
        risk: data.risk,
        message: `State changed: ${prev.state} → ${data.state}`
      };
      alerts.unshift(alert);
      if (alerts.length > 100) alerts.pop();

      if (data.state === 'BREACH' || data.state === 'SENSOR_FAULT') {
        createIncident(deviceId, data);
        addAudit('INCIDENT_OPENED', `${deviceId} - ${data.state}`);
      }
      if (prev.state === 'BREACH' && data.state === 'SAFE') {
        // close latest open incident
        const open = incidents.find(i => i.deviceId === deviceId && i.status === 'OPEN');
        if (open) {
          open.end = now;
          open.status = 'CLOSED';
          addAudit('INCIDENT_CLOSED', open.id);
        }
      }
    }

    addAudit('DATA_INGEST', deviceId);
    res.json({ ok: true, received: now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Latest reading for one or all devices
app.get('/api/latest', (req, res) => {
  const deviceId = req.query.deviceId;
  if (deviceId) {
    return res.json(devices[deviceId] || null);
  }
  res.json(devices);
});

// History
app.get('/api/history', (req, res) => {
  const deviceId = req.query.deviceId || Object.keys(devices)[0];
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const list = history[deviceId] || [];
  res.json(list.slice(0, limit));
});

// Alerts
app.get('/api/alerts', (req, res) => {
  res.json(alerts.slice(0, 50));
});

// Audit log
app.get('/api/audit', (req, res) => {
  res.json(auditLog.slice(0, 100));
});

// Incidents
app.get('/api/incidents', (req, res) => {
  res.json(incidents.slice(0, 30));
});

// Acknowledge incident
app.post('/api/incidents/:id/ack', (req, res) => {
  const inc = incidents.find(i => i.id === req.params.id);
  if (!inc) return res.status(404).json({ error: 'Not found' });
  inc.acknowledged = true;
  inc.ackBy = req.body.by || 'Dashboard User';
  inc.ackAt = new Date().toISOString();
  addAudit('INCIDENT_ACK', inc.id);
  res.json(inc);
});

// Stats / Compliance
app.get('/api/stats', (req, res) => {
  const deviceId = req.query.deviceId || Object.keys(devices)[0];
  const list = history[deviceId] || [];
  if (list.length === 0) return res.json({ compliance: 100, count: 0 });

  let safe = 0;
  let minT = 999, maxT = -999, sum = 0;
  list.forEach(r => {
    if (r.temperature >= 2 && r.temperature <= 8) safe++;
    if (r.temperature < minT) minT = r.temperature;
    if (r.temperature > maxT) maxT = r.temperature;
    sum += r.temperature;
  });

  res.json({
    compliance: ((safe / list.length) * 100).toFixed(1),
    minTemp: minT.toFixed(1),
    maxTemp: maxT.toFixed(1),
    avgTemp: (sum / list.length).toFixed(1),
    totalReadings: list.length,
    openIncidents: incidents.filter(i => i.status === 'OPEN').length
  });
});

// Prediction / What-if (simple estimate)
app.get('/api/prediction', (req, res) => {
  const deviceId = req.query.deviceId || Object.keys(devices)[0];
  const latest = devices[deviceId];
  if (!latest) return res.json({ available: false });

  const rate = latest.rateCperMin || 0;
  let eta = null;
  if (rate > 0.05 && latest.temperature < 8) {
    eta = Math.round(((8 - latest.temperature) / rate) * 60); // seconds
  } else if (rate < -0.05 && latest.temperature > 2) {
    eta = Math.round(((latest.temperature - 2) / (-rate)) * 60);
  }

  res.json({
    available: true,
    currentTemp: latest.temperature,
    rateCperMin: rate,
    trend: latest.trend,
    estimatedSecondsToThreshold: eta,
    note: 'Estimate only – based on recent rate of change'
  });
});

// Device list / status
app.get('/api/devices', (req, res) => {
  const list = Object.keys(devices).map(id => ({
    deviceId: id,
    state: devices[id].state,
    temperature: devices[id].temperature,
    risk: devices[id].risk,
    lastSeen: devices[id].receivedAt,
    online: (Date.now() - devices[id].serverTs) < 30000
  }));
  res.json(list);
});

// Cloud status
app.get('/api/cloud-status', (req, res) => {
  res.json({
    status: 'ONLINE',
    devices: Object.keys(devices).length,
    uptime: process.uptime(),
    time: new Date().toISOString()
  });
});

// CSV Export
app.get('/api/export', (req, res) => {
  const deviceId = req.query.deviceId || Object.keys(devices)[0];
  const list = history[deviceId] || [];
  let csv = 'timestamp,temperature,humidity,vibration,state,risk,trend\n';
  list.forEach(r => {
    csv += `${r.receivedAt},${r.temperature},${r.humidity || ''},${r.vibrationCount || 0},${r.state},${r.risk},${r.trend || ''}\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=vaxguard-${deviceId}.csv`);
  res.send(csv);
});

// ===================== DASHBOARD (Single Page) =====================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VAXGUARD PRO – Cold Chain Command Center</title>
<style>
  :root {
    --bg: #0b0f19;
    --card: #141b2d;
    --border: #1e2a44;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --green: #22c55e;
    --yellow: #eab308;
    --red: #ef4444;
    --blue: #3b82f6;
    --purple: #a855f7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }
  .header {
    background: linear-gradient(90deg, #0f172a, #1e293b);
    padding: 14px 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .logo { font-size: 1.4rem; font-weight: 700; letter-spacing: 1px; }
  .logo span { color: var(--blue); }
  .status-pill {
    padding: 4px 12px;
    border-radius: 20px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .nav {
    display: flex;
    gap: 8px;
    padding: 12px 24px;
    background: #0f172a;
    overflow-x: auto;
    border-bottom: 1px solid var(--border);
  }
  .nav button {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 8px 16px;
    border-radius: 8px;
    cursor: pointer;
    white-space: nowrap;
    font-size: 0.85rem;
  }
  .nav button.active, .nav button:hover {
    background: var(--blue);
    color: white;
    border-color: var(--blue);
  }
  .container { padding: 20px; max-width: 1400px; margin: 0 auto; }
  .grid { display: grid; gap: 16px; }
  .grid-4 { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .grid-2 { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px;
  }
  .card h3 { font-size: 0.85rem; color: var(--muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .big { font-size: 2.4rem; font-weight: 700; }
  .state-SAFE { color: var(--green); }
  .state-WARNING { color: var(--yellow); }
  .state-BREACH, .state-SENSOR_FAULT { color: var(--red); }
  .state-OFFLINE { color: var(--muted); }
  .twin {
    height: 220px;
    background: linear-gradient(145deg, #1e293b, #0f172a);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
  }
  .box {
    width: 120px;
    height: 80px;
    background: #334155;
    border: 3px solid #64748b;
    border-radius: 8px;
    position: relative;
    transition: all 0.4s;
  }
  .box.safe { border-color: var(--green); box-shadow: 0 0 20px rgba(34,197,94,0.4); }
  .box.warn { border-color: var(--yellow); box-shadow: 0 0 20px rgba(234,179,8,0.4); }
  .box.danger { border-color: var(--red); box-shadow: 0 0 25px rgba(239,68,68,0.5); animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.05)} }
  .temp-inside { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); font-weight: 700; font-size: 1.1rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  .btn {
    background: var(--blue);
    color: white;
    border: none;
    padding: 8px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
  }
  .btn:hover { opacity: 0.9; }
  .btn-danger { background: var(--red); }
  .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .muted { color: var(--muted); font-size: 0.8rem; }
  .section { display: none; }
  .section.active { display: block; }
  .voice-btn { position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px; border-radius: 50%; background: var(--purple); border: none; color: white; font-size: 1.4rem; cursor: pointer; box-shadow: 0 4px 20px rgba(168,85,247,0.4); z-index: 200; }
  @media (max-width: 600px) {
    .big { font-size: 1.8rem; }
    .header { flex-direction: column; gap: 8px; }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">VAX<span>GUARD</span> PRO</div>
    <div style="display:flex;gap:12px;align-items:center;">
      <span id="cloudPill" class="status-pill" style="background:#166534;color:#bbf7d0;">CLOUD ONLINE</span>
      <span id="deviceCount" class="muted">0 devices</span>
    </div>
  </div>

  <div class="nav" id="nav">
    <button class="active" data-tab="overview">Overview</button>
    <button data-tab="twin">Digital Twin</button>
    <button data-tab="live">Live Monitor</button>
    <button data-tab="analytics">Analytics</button>
    <button data-tab="prediction">Prediction</button>
    <button data-tab="alerts">Alerts & Incidents</button>
    <button data-tab="health">Device Health</button>
    <button data-tab="audit">Audit Log</button>
    <button data-tab="demo">Demo Mode</button>
  </div>

  <div class="container">
    <!-- OVERVIEW -->
    <div id="overview" class="section active">
      <div class="grid grid-4" style="margin-bottom:20px;">
        <div class="card">
          <h3>Current Temperature</h3>
          <div class="big" id="ovTemp">--.-°C</div>
          <div class="muted" id="ovHum">Humidity: --%</div>
        </div>
        <div class="card">
          <h3>System State</h3>
          <div class="big" id="ovState">--</div>
          <div class="muted" id="ovReason">Waiting for data...</div>
        </div>
        <div class="card">
          <h3>Risk Score</h3>
          <div class="big" id="ovRisk">--%</div>
          <div class="muted">Prototype risk index</div>
        </div>
        <div class="card">
          <h3>Compliance</h3>
          <div class="big" id="ovComp">--%</div>
          <div class="muted">Time inside 2–8°C</div>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <h3>Quick Status</h3>
          <p>Device: <span id="ovDevice">--</span></p>
          <p>Trend: <span id="ovTrend">--</span></p>
          <p>Vibration: <span id="ovVib">--</span></p>
          <p>Sensor Confidence: <span id="ovConf">--%</span></p>
          <p>Last Update: <span id="ovLast">--</span></p>
        </div>
        <div class="card">
          <h3>Advisory</h3>
          <p id="ovAdvisory" style="font-size:1.1rem;line-height:1.5;">Waiting for telemetry...</p>
          <p class="muted" id="ovCorr" style="margin-top:8px;"></p>
        </div>
      </div>
    </div>

    <!-- DIGITAL TWIN -->
    <div id="twin" class="section">
      <div class="card">
        <h3>Digital Twin – Virtual Vaccine Box</h3>
        <div class="twin" id="twinBox">
          <div class="box" id="visualBox">
            <div class="temp-inside" id="twinTemp">--°C</div>
          </div>
          <div style="margin-top:16px;text-align:center;">
            <div id="twinState" style="font-size:1.3rem;font-weight:700;">--</div>
            <div class="muted" id="twinSub">Real-time virtual representation</div>
          </div>
        </div>
      </div>
    </div>

    <!-- LIVE -->
    <div id="live" class="section">
      <div class="grid grid-4">
        <div class="card"><h3>Temperature</h3><div class="big" id="liveTemp">--</div></div>
        <div class="card"><h3>Humidity</h3><div class="big" id="liveHum">--</div></div>
        <div class="card"><h3>Vibration Count</h3><div class="big" id="liveVib">--</div></div>
        <div class="card"><h3>RSSI</h3><div class="big" id="liveRssi">--</div></div>
      </div>
      <div class="card" style="margin-top:16px;">
        <h3>Live Feed</h3>
        <div class="muted">Data refreshes every 4 seconds • <span id="liveIndicator" style="color:var(--green);">● LIVE</span></div>
      </div>
    </div>

    <!-- ANALYTICS -->
    <div id="analytics" class="section">
      <div class="grid grid-2">
        <div class="card">
          <h3>Statistics</h3>
          <p>Min Temp: <span id="anMin">--</span>°C</p>
          <p>Max Temp: <span id="anMax">--</span>°C</p>
          <p>Average: <span id="anAvg">--</span>°C</p>
          <p>Total Readings: <span id="anCount">--</span></p>
          <p>Open Incidents: <span id="anInc">--</span></p>
        </div>
        <div class="card">
          <h3>Export</h3>
          <button class="btn" onclick="window.location='/api/export'">Download CSV Report</button>
          <p class="muted" style="margin-top:10px;">Includes temperature, humidity, vibration, state, risk & trend</p>
        </div>
      </div>
    </div>

    <!-- PREDICTION -->
    <div id="prediction" class="section">
      <div class="card">
        <h3>Predictive Engine (Estimate Only)</h3>
        <p>Current Rate: <span id="predRate">--</span> °C/min</p>
        <p>Trend: <span id="predTrend">--</span></p>
        <p id="predEta" style="font-size:1.2rem;margin:12px 0;">Collecting data...</p>
        <p class="muted">This is a software estimate based on recent temperature slope. Not a guarantee.</p>
      </div>
      <div class="card" style="margin-top:16px;">
        <h3>What-If Simulation</h3>
        <p>Assume temperature rises at <input type="number" id="whatRate" value="0.2" step="0.05" style="width:70px;padding:4px;border-radius:4px;border:1px solid var(--border);background:#0f172a;color:white;"> °C/min</p>
        <button class="btn" style="margin-top:8px;" onclick="runWhatIf()">Calculate Crossing Time</button>
        <p id="whatResult" style="margin-top:12px;font-size:1.1rem;"></p>
      </div>
    </div>

    <!-- ALERTS -->
    <div id="alerts" class="section">
      <div class="card">
        <h3>Recent Alerts</h3>
        <div id="alertList" class="muted">No alerts yet</div>
      </div>
      <div class="card" style="margin-top:16px;">
        <h3>Incidents</h3>
        <div id="incidentList" class="muted">No incidents</div>
      </div>
    </div>

    <!-- HEALTH -->
    <div id="health" class="section">
      <div class="grid grid-2">
        <div class="card">
          <h3>Device Health</h3>
          <p>Status: <span id="hOnline">--</span></p>
          <p>Last Seen: <span id="hLast">--</span></p>
          <p>Sensor Confidence: <span id="hConf">--</span></p>
          <p>Sensor Fault: <span id="hFault">--</span></p>
          <p>Reconnects: <span id="hRecon">--</span></p>
        </div>
        <div class="card">
          <h3>Cloud</h3>
          <p>Server Uptime: <span id="hUptime">--</span> s</p>
          <p>Active Devices: <span id="hDevices">--</span></p>
        </div>
      </div>
    </div>

    <!-- AUDIT -->
    <div id="audit" class="section">
      <div class="card">
        <h3>Audit Log</h3>
        <div id="auditList" style="max-height:400px;overflow-y:auto;" class="muted">Loading...</div>
      </div>
    </div>

    <!-- DEMO -->
    <div id="demo" class="section">
      <div class="card">
        <h3>Demo Mode Controls</h3>
        <p class="muted" style="margin-bottom:12px;">These buttons only affect the cloud display for demonstration. Real device continues normal operation.</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          <button class="btn" onclick="simulate('SAFE',5.2)">SAFE 5.2°C</button>
          <button class="btn" onclick="simulate('WARNING',7.6)">WARNING 7.6°C</button>
          <button class="btn btn-danger" onclick="simulate('BREACH',9.1)">BREACH 9.1°C</button>
          <button class="btn" onclick="simulate('SAFE',5.5)">RECOVERY</button>
          <button class="btn btn-outline" onclick="simulate('SENSOR_FAULT',null)">SENSOR FAULT</button>
        </div>
      </div>
    </div>
  </div>

  <button class="voice-btn" id="voiceBtn" title="Voice Assistant">🎤</button>

<script>
  let currentDevice = null;
  let voiceEnabled = false;

  // Navigation
  document.querySelectorAll('.nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  async function fetchJSON(url) {
    try {
      const r = await fetch(url);
      return await r.json();
    } catch(e) { return null; }
  }

  function updateUI(data) {
    if (!data) return;
    currentDevice = data.deviceId;

    // Overview
    document.getElementById('ovTemp').textContent = (data.temperature ?? '--') + '°C';
    document.getElementById('ovHum').textContent = 'Humidity: ' + (data.humidity ?? '--') + '%';
    const st = data.state || '--';
    document.getElementById('ovState').textContent = st;
    document.getElementById('ovState').className = 'big state-' + st;
    document.getElementById('ovRisk').textContent = (data.risk ?? '--') + '%';
    document.getElementById('ovDevice').textContent = data.deviceId || '--';
    document.getElementById('ovTrend').textContent = data.trend || '--';
    document.getElementById('ovVib').textContent = data.vibrationCount ?? '--';
    document.getElementById('ovConf').textContent = (data.confidence ?? '--') + '%';
    document.getElementById('ovLast').textContent = data.receivedAt ? new Date(data.receivedAt).toLocaleTimeString() : '--';
    document.getElementById('ovAdvisory').textContent = data.advisory || 'No advisory';
    document.getElementById('ovCorr').textContent = data.correlation || '';

    // Twin
    document.getElementById('twinTemp').textContent = (data.temperature ?? '--') + '°C';
    document.getElementById('twinState').textContent = st;
    const box = document.getElementById('visualBox');
    box.className = 'box';
    if (st === 'SAFE') box.classList.add('safe');
    else if (st === 'WARNING') box.classList.add('warn');
    else if (st === 'BREACH' || st === 'SENSOR_FAULT') box.classList.add('danger');

    // Live
    document.getElementById('liveTemp').textContent = (data.temperature ?? '--') + '°C';
    document.getElementById('liveHum').textContent = (data.humidity ?? '--') + '%';
    document.getElementById('liveVib').textContent = data.vibrationCount ?? '--';
    document.getElementById('liveRssi').textContent = (data.rssi ?? '--') + ' dBm';

    // Health
    document.getElementById('hOnline').textContent = (Date.now() - data.serverTs < 30000) ? 'ONLINE' : 'STALE / OFFLINE';
    document.getElementById('hLast').textContent = data.receivedAt ? new Date(data.receivedAt).toLocaleString() : '--';
    document.getElementById('hConf').textContent = (data.confidence ?? '--') + '%';
    document.getElementById('hFault').textContent = data.sensorFault || 'None';
    document.getElementById('hRecon').textContent = data.reconnects ?? 0;
  }

  async function refresh() {
    const devices = await fetchJSON('/api/devices');
    if (devices && devices.length) {
      document.getElementById('deviceCount').textContent = devices.length + ' device(s)';
      const latest = await fetchJSON('/api/latest?deviceId=' + devices[0].deviceId);
      updateUI(latest);
    }

    const stats = await fetchJSON('/api/stats');
    if (stats) {
      document.getElementById('ovComp').textContent = stats.compliance + '%';
      document.getElementById('anMin').textContent = stats.minTemp;
      document.getElementById('anMax').textContent = stats.maxTemp;
      document.getElementById('anAvg').textContent = stats.avgTemp;
      document.getElementById('anCount').textContent = stats.totalReadings;
      document.getElementById('anInc').textContent = stats.openIncidents;
    }

    const pred = await fetchJSON('/api/prediction');
    if (pred && pred.available) {
      document.getElementById('predRate').textContent = (pred.rateCperMin || 0).toFixed(2);
      document.getElementById('predTrend').textContent = pred.trend || '--';
      if (pred.estimatedSecondsToThreshold) {
        const m = Math.floor(pred.estimatedSecondsToThreshold / 60);
        const s = pred.estimatedSecondsToThreshold % 60;
        document.getElementById('predEta').textContent = \`Estimated time to threshold: ~\${m}m \${s}s (estimate only)\`;
      } else {
        document.getElementById('predEta').textContent = 'No imminent threshold crossing predicted';
      }
    }

    const alerts = await fetchJSON('/api/alerts');
    if (alerts) {
      document.getElementById('alertList').innerHTML = alerts.length ? alerts.slice(0,10).map(a =>
        \`<div style="padding:6px 0;border-bottom:1px solid #1e2a44;">\${a.ts.slice(11,19)} | \${a.deviceId} | \${a.message}</div>\`
      ).join('') : 'No alerts yet';
    }

    const incs = await fetchJSON('/api/incidents');
    if (incs) {
      document.getElementById('incidentList').innerHTML = incs.length ? incs.slice(0,8).map(i =>
        \`<div style="padding:8px 0;border-bottom:1px solid #1e2a44;">
          <strong>\${i.id}</strong> – \${i.status} – Peak \${i.peakTemp}°C
          \${i.status==='OPEN' && !i.acknowledged ? \`<button class="btn" style="margin-left:8px;padding:2px 8px;font-size:0.75rem;" onclick="ackIncident('\${i.id}')">ACK</button>\` : ''}
        </div>\`
      ).join('') : 'No incidents';
    }

    const audit = await fetchJSON('/api/audit');
    if (audit) {
      document.getElementById('auditList').innerHTML = audit.slice(0,30).map(a =>
        \`<div>\${a.ts.slice(11,19)} – \${a.event} \${a.details || ''}</div>\`
      ).join('');
    }

    const cloud = await fetchJSON('/api/cloud-status');
    if (cloud) {
      document.getElementById('hUptime').textContent = Math.floor(cloud.uptime);
      document.getElementById('hDevices').textContent = cloud.devices;
    }
  }

  async function ackIncident(id) {
    await fetch('/api/incidents/' + id + '/ack', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({by: 'Dashboard User'})
    });
    refresh();
  }

  function runWhatIf() {
    const rate = parseFloat(document.getElementById('whatRate').value) || 0.2;
    const tempEl = document.getElementById('ovTemp').textContent;
    const temp = parseFloat(tempEl) || 5;
    if (rate <= 0) {
      document.getElementById('whatResult').textContent = 'Rate must be positive for rising simulation';
      return;
    }
    const sec = ((8 - temp) / rate) * 60;
    if (sec <= 0) {
      document.getElementById('whatResult').textContent = 'Already at or above 8°C';
    } else {
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      document.getElementById('whatResult').textContent = \`At +\${rate}°C/min, 8°C estimated in ~\${m} min \${s} sec (simulation only)\`;
    }
  }

  // Simple demo simulation (cloud side only)
  function simulate(state, temp) {
    const fake = {
      deviceId: currentDevice || 'DEMO-01',
      temperature: temp,
      humidity: 55,
      vibrationCount: state === 'BREACH' ? 15 : 2,
      state: state,
      risk: state === 'BREACH' ? 92 : state === 'WARNING' ? 45 : 12,
      trend: state === 'BREACH' ? 'RISING' : 'STABLE',
      confidence: 98,
      advisory: state === 'BREACH' ? 'Critical – inspect immediately' : 'Demo mode',
      correlation: 'Demo correlation',
      receivedAt: new Date().toISOString(),
      serverTs: Date.now()
    };
    // Push to our own ingest (no API key needed for demo from same origin in this simple version)
    fetch('/api/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': '${API_KEY}'
      },
      body: JSON.stringify(fake)
    }).then(() => refresh());
  }

  // Voice Assistant
  const voiceBtn = document.getElementById('voiceBtn');
  voiceBtn.addEventListener('click', () => {
    if (!('speechSynthesis' in window)) {
      alert('Speech not supported in this browser');
      return;
    }
    voiceEnabled = !voiceEnabled;
    voiceBtn.style.background = voiceEnabled ? '#22c55e' : '#a855f7';
    if (voiceEnabled) {
      const u = new SpeechSynthesisUtterance('Voice assistant enabled. Ask me about temperature, risk or alerts.');
      speechSynthesis.speak(u);
    }
  });

  // Simple voice commands via recognition (if available)
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Rec();
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript.toLowerCase();
      let reply = 'I did not understand.';
      if (text.includes('temperature')) reply = 'Current temperature is ' + document.getElementById('ovTemp').textContent;
      else if (text.includes('safe') || text.includes('status')) reply = 'System state is ' + document.getElementById('ovState').textContent;
      else if (text.includes('risk')) reply = 'Risk score is ' + document.getElementById('ovRisk').textContent;
      else if (text.includes('alert')) reply = 'Check the alerts tab for recent events.';
      const u = new SpeechSynthesisUtterance(reply);
      speechSynthesis.speak(u);
    };
    voiceBtn.addEventListener('dblclick', () => {
      if (voiceEnabled) rec.start();
    });
  }

  // Start
  refresh();
  setInterval(refresh, 4000);
</script>
</body>
</html>`);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(\`VAXGUARD PRO Cloud running on port \${PORT}\`);
  console.log(\`API Key required for /api/ingest: \${API_KEY}\`);
  addAudit('SERVER_START', 'VAXGUARD PRO started');
});
