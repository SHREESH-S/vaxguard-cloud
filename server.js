// ============================================================================
// COLDCHAIN GUARDIAN — CLOUD COMMAND CENTER
// One Express server: ingest API for any number of physical devices,
// a multi-device dashboard, digital twin view, voice control, incident
// tracking, what-if simulator, audit export, and QR device identity.
//
// Deploy target: Render.com (or any Node host). Single file, as requested.
// Storage: in-memory (fine for a hackathon/demo). Swap the STORE object
// for a real database (Mongo/Postgres) for a production deployment —
// the shape of the data is already structured to make that a drop-in swap.
// ============================================================================

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "64kb" })); // request size limit
app.disable("x-powered-by");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change_me_shared_secret";

// ---------------------------------------------------------------------------
// Very small in-memory rate limiter (no extra dependency required).
// ---------------------------------------------------------------------------
const rateBuckets = new Map();
function rateLimit(req, res, next) {
  const key = req.ip + ":" + req.path;
  const now = Date.now();
  const windowMs = 10000;
  const max = 40;
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + windowMs; }
  bucket.count++;
  rateBuckets.set(key, bucket);
  if (bucket.count > max) return res.status(429).json({ error: "Rate limit exceeded" });
  next();
}
app.use(rateLimit);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

function requireApiKey(req, res, next) {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
}

// ---------------------------------------------------------------------------
// STORE: keyed by deviceId. Every device that has ever POSTed to /api/ingest
// shows up automatically in the command center — this is the multi-device
// fleet architecture. No hardcoded device list.
// ---------------------------------------------------------------------------
const STORE = {}; // deviceId -> { latest, history: [], alerts: [], audit: [], incidents: [], config, configHistory: [] }

function ensureDevice(id) {
  if (!STORE[id]) {
    STORE[id] = {
      latest: null,
      history: [],       // capped ring of recent readings for graphing
      alerts: [],         // state-change events
      audit: [],          // every ingest, for CSV export
      incidents: {},       // incidentId -> incident record
      config: { max: 8.0, min: 2.0, profile: "VACCINE", ack: false },
      configHistory: [],
      lastSeq: null,
      lastSeenAt: null,
    };
  }
  return STORE[id];
}

const HISTORY_CAP = 2000;
const AUDIT_CAP = 5000;

// ---------------------------------------------------------------------------
// INGEST — device pushes its status here every ~4s
// ---------------------------------------------------------------------------
app.post("/api/ingest", requireApiKey, (req, res) => {
  const d = req.body;
  if (!d || typeof d !== "object" || !d.deviceId) {
    return res.status(400).json({ error: "Malformed payload" });
  }
  const dev = ensureDevice(d.deviceId);

  // Data-integrity monitoring: detect duplicate / out-of-order sequence numbers.
  let integrityNote = null;
  if (typeof d.seq === "number" && dev.lastSeq !== null) {
    if (d.seq === dev.lastSeq) integrityNote = "Duplicate packet (seq repeated)";
    else if (d.seq < dev.lastSeq) integrityNote = "Out-of-order packet";
    else if (d.seq > dev.lastSeq + 1) integrityNote = `Gap detected: ${d.seq - dev.lastSeq - 1} packet(s) missing`;
  }
  dev.lastSeq = d.seq ?? dev.lastSeq;
  dev.lastSeenAt = Date.now();

  const record = { ...d, receivedAt: new Date().toISOString(), integrityNote };
  dev.latest = record;

  dev.history.push({ t: record.receivedAt, temp: d.temp, hum: d.hum, vib: d.vib, risk: d.risk, state: d.state });
  if (dev.history.length > HISTORY_CAP) dev.history.shift();

  dev.audit.push(record);
  if (dev.audit.length > AUDIT_CAP) dev.audit.shift();

  // Track alert transitions server-side too (independent record from firmware log)
  const lastAlert = dev.alerts[dev.alerts.length - 1];
  if (!lastAlert || lastAlert.state !== d.state) {
    dev.alerts.push({
      time: new Date().toISOString(),
      state: d.state,
      reason: d.stateReason,
      temp: d.temp,
      incidentId: d.incidentId,
      severity: d.state === "DANGER" ? "CRITICAL" : d.state === "WARNING" ? "WARNING" : d.state === "SENSOR FAULT" ? "FAULT" : "INFO",
    });
  }

  // Maintain incident records for the Incident Investigation Mode screen.
  if (d.incidentId) {
    if (!dev.incidents[d.incidentId]) {
      dev.incidents[d.incidentId] = {
        id: d.incidentId,
        deviceId: d.deviceId,
        openedAt: new Date().toISOString(),
        maxTemp: d.temp,
        minTemp: d.temp,
        vibrationEvents: 0,
        acknowledged: d.incidentAck || false,
        closedAt: null,
      };
    }
    const inc = dev.incidents[d.incidentId];
    inc.maxTemp = Math.max(inc.maxTemp, d.temp);
    inc.minTemp = Math.min(inc.minTemp, d.temp);
    inc.acknowledged = d.incidentAck || inc.acknowledged;
    if (d.state !== "DANGER" && !inc.closedAt) inc.closedAt = new Date().toISOString();
  }

  res.json({ ok: true, integrityNote });
});

// ---------------------------------------------------------------------------
// Device-facing config pull (thresholds + ack flag), and dashboard config push
// ---------------------------------------------------------------------------
app.get("/api/config", requireApiKey, (req, res) => {
  const dev = ensureDevice(req.query.deviceId || "unknown");
  res.json(dev.config);
});

app.post("/api/config/:deviceId", (req, res) => {
  const dev = ensureDevice(req.params.deviceId);
  const { max, min, profile } = req.body;
  if (typeof max === "number" && typeof min === "number") {
    if (max <= min || max - min < 1 || min < -40 || max > 60) {
      return res.status(400).json({ error: "Invalid configuration: check min/max range" });
    }
    dev.config.max = max;
    dev.config.min = min;
  }
  if (profile) dev.config.profile = profile;
  dev.configHistory.push({ time: new Date().toISOString(), config: { ...dev.config } });
  res.json({ ok: true, config: dev.config });
});

app.post("/api/ack/:deviceId", (req, res) => {
  const dev = ensureDevice(req.params.deviceId);
  dev.config.ack = true;
  const openIncident = Object.values(dev.incidents).find((i) => !i.acknowledged && !i.closedAt);
  if (openIncident) openIncident.acknowledged = true;
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Read APIs
// ---------------------------------------------------------------------------
app.get("/api/devices", (req, res) => {
  res.json(Object.keys(STORE).map((id) => ({
    deviceId: id,
    label: STORE[id].latest?.deviceLabel || id,
    state: STORE[id].latest?.state || "UNKNOWN",
    lastSeenAt: STORE[id].lastSeenAt,
    online: STORE[id].lastSeenAt && (Date.now() - STORE[id].lastSeenAt < 15000),
  })));
});

app.get("/api/latest/:deviceId", (req, res) => {
  const dev = STORE[req.params.deviceId];
  if (!dev || !dev.latest) return res.status(404).json({ error: "No data yet for this device" });
  res.json(dev.latest);
});

app.get("/api/history/:deviceId", (req, res) => {
  const dev = STORE[req.params.deviceId];
  if (!dev) return res.status(404).json({ error: "Unknown device" });
  const hours = parseFloat(req.query.hours || "6");
  const cutoff = Date.now() - hours * 3600 * 1000;
  res.json(dev.history.filter((h) => new Date(h.t).getTime() >= cutoff));
});

app.get("/api/alerts/:deviceId", (req, res) => {
  const dev = STORE[req.params.deviceId];
  if (!dev) return res.status(404).json({ error: "Unknown device" });
  res.json(dev.alerts.slice(-100).reverse());
});

app.get("/api/incidents/:deviceId", (req, res) => {
  const dev = STORE[req.params.deviceId];
  if (!dev) return res.status(404).json({ error: "Unknown device" });
  res.json(Object.values(dev.incidents).reverse());
});

app.get("/api/prediction/:deviceId", (req, res) => {
  const dev = STORE[req.params.deviceId];
  if (!dev || !dev.latest) return res.status(404).json({ error: "No data" });
  res.json({
    trend: dev.latest.trend,
    rateOfChange: dev.latest.rateOfChange,
    breachEtaSec: dev.latest.breachEtaSec,
    predictedRisk: dev.latest.predictedRisk,
    note: dev.latest.breachEtaSec > 0
      ? `At the current trend, the threshold may be reached in about ${Math.round(dev.latest.breachEtaSec / 60)} min. This is an estimate, not a guarantee.`
      : "Prediction unavailable — insufficient trend data or temperature is stable.",
  });
});

// What-if simulator — pure calculation, doesn't touch firmware or real data.
app.get("/api/whatif", (req, res) => {
  const current = parseFloat(req.query.current);
  const rate = parseFloat(req.query.rate); // deg C per minute, can be negative
  const threshold = parseFloat(req.query.threshold);
  if ([current, rate, threshold].some((v) => Number.isNaN(v))) {
    return res.status(400).json({ error: "current, rate, threshold (all numbers) required" });
  }
  if (rate === 0) return res.json({ etaMinutes: null, note: "Rate is zero — threshold will not be reached." });
  const etaMinutes = (threshold - current) / rate;
  if (etaMinutes < 0) return res.json({ etaMinutes: null, note: "Moving away from the threshold, not toward it." });
  res.json({ etaMinutes: Math.round(etaMinutes * 10) / 10, note: `Estimated threshold crossing in ~${Math.round(etaMinutes)} min (simulation only — not real sensor data).` });
});

app.get("/api/summary/:deviceId", (req, res) => {
  const dev = STORE[req.params.deviceId];
  if (!dev || !dev.latest) return res.status(404).json({ error: "No data" });
  const l = dev.latest;
  const incidents = Object.values(dev.incidents);
  const vibCorrelated = dev.alerts.filter((a) => a.reason && a.reason.toLowerCase().includes("shock")).length;
  const text = `Device remained within the configured range for ${l.complianceScore?.toFixed(1)}% of monitored time. ` +
    `${incidents.length} incident${incidents.length === 1 ? "" : "s"} recorded` +
    (vibCorrelated ? `, including ${vibCorrelated} associated with a vibration event.` : ".") +
    ` Current reliability score: ${l.reliability}%. Health: ${l.healthGrade}.`;
  res.json({ summary: text, complianceScore: l.complianceScore, incidentCount: incidents.length, reliability: l.reliability });
});

app.get("/api/audit/:deviceId", (req, res) => {
  const dev = STORE[req.params.deviceId];
  if (!dev) return res.status(404).send("Unknown device");
  let csv = "Timestamp,Temp(C),Humidity(%),Vibration,State,Risk,Compliance(%),Incident\n";
  dev.audit.forEach((r) => {
    csv += `${r.timestamp},${r.temp},${r.hum},${r.vib},${r.state},${r.risk},${r.complianceScore},${r.incidentId || ""}\n`;
  });
  res.setHeader("Content-Disposition", `attachment; filename=${req.params.deviceId}_audit.csv`);
  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

// One-click compliance evidence package (JSON — pipe into a PDF tool if needed)
app.get("/api/export/:deviceId", (req, res) => {
  const dev = STORE[req.params.deviceId];
  if (!dev) return res.status(404).json({ error: "Unknown device" });
  res.json({
    deviceId: req.params.deviceId,
    generatedAt: new Date().toISOString(),
    latest: dev.latest,
    incidents: Object.values(dev.incidents),
    alerts: dev.alerts,
    configHistory: dev.configHistory,
    note: "Prototype-generated compliance package. Not a certified regulatory document.",
  });
});

app.get("/api/cloud-status", (req, res) => {
  res.json({ status: "online", devices: Object.keys(STORE).length, uptimeSec: Math.floor(process.uptime()) });
});

app.get("/api/diagnostics", (req, res) => {
  res.json({
    server: "ok",
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    devicesTracked: Object.keys(STORE).length,
    uptimeSec: Math.floor(process.uptime()),
  });
});

// ---------------------------------------------------------------------------
// DASHBOARD (single page, vanilla JS — no build step, works everywhere)
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(DASHBOARD_HTML);
});

app.get("/device/:id", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(DASHBOARD_HTML.replace("__PRESELECT_DEVICE__", req.params.id));
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ColdChain Guardian — Command Center</title>
<style>
:root{--bg:#0a0e1a;--card:#131a2b;--card2:#1a2338;--accent:#38bdf8;--safe:#4ade80;--warn:#fbbf24;--danger:#f87171;--text:#e2e8f0;--muted:#8291ab}
*{box-sizing:border-box}
body{margin:0;font-family:'Segoe UI',system-ui,Arial;background:var(--bg);color:var(--text)}
header{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1f2a44}
header h1{font-size:18px;margin:0;color:var(--accent)}
header .sub{font-size:11px;color:var(--muted)}
nav{display:flex;gap:6px;padding:10px 14px;flex-wrap:wrap;border-bottom:1px solid #1f2a44}
nav button{background:var(--card2);color:var(--muted);border:none;padding:8px 12px;border-radius:8px;font-size:12px;cursor:pointer}
nav button.active{background:var(--accent);color:#031320;font-weight:700}
main{padding:14px;max-width:1100px;margin:0 auto}
.view{display:none}.view.active{display:block}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card{background:var(--card);border:1px solid #1f2a44;border-radius:14px;padding:14px}
.card .label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.card .value{font-size:22px;font-weight:700;margin-top:6px}
.state-badge{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:700;font-size:14px}
.state-SAFE{background:rgba(74,222,128,.15);color:var(--safe)}
.state-WARNING{background:rgba(251,191,36,.15);color:var(--warn)}
.state-DANGER{background:rgba(248,113,113,.15);color:var(--danger);animation:pulse 1s infinite}
.state-OFFLINE,.state-UNKNOWN{background:#2a3752;color:var(--muted)}
.state-FAULT,.state-SENSOR\\ FAULT{background:rgba(248,113,113,.15);color:var(--danger)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
.device-card{cursor:pointer;transition:transform .15s}
.device-card:hover{transform:translateY(-2px)}
.twin-box{position:relative;width:180px;height:140px;margin:20px auto;border-radius:14px;border:3px solid #334;background:linear-gradient(180deg,#0f1830,#0a1120);display:flex;align-items:center;justify-content:center;transition:border-color .4s,box-shadow .4s}
.twin-box .temp-fill{position:absolute;bottom:0;left:0;right:0;background:linear-gradient(180deg,rgba(56,189,248,.05),rgba(56,189,248,.35));transition:height .6s}
.twin-box .lbl{position:relative;z-index:2;text-align:center;font-weight:700}
.twin-box.vib{animation:shake .25s}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.log{background:var(--card2);border-radius:10px;padding:10px;font-size:12px;max-height:320px;overflow-y:auto}
.log div{padding:5px 0;border-bottom:1px solid #223052}
.btn{background:var(--accent);color:#031320;border:none;padding:10px 14px;border-radius:10px;font-weight:700;cursor:pointer}
.btn.secondary{background:#223052;color:var(--text)}
.btn.danger{background:var(--danger);color:#2a0000}
input,select{background:#0e1526;border:1px solid #223052;color:var(--text);padding:8px;border-radius:8px;width:100%;margin:4px 0}
.row{display:flex;gap:8px;flex-wrap:wrap}
.small{font-size:11px;color:var(--muted)}
canvas{width:100%;max-height:220px}
a.link{color:var(--accent);text-decoration:none}
.qr{background:#fff;padding:6px;border-radius:8px;display:inline-block}
.mic-btn{width:60px;height:60px;border-radius:50%;border:none;background:var(--accent);font-size:22px;cursor:pointer}
.mic-btn.listening{background:var(--danger);animation:pulse .8s infinite}
</style>
</head>
<body>
<header>
  <div><h1>❄ ColdChain Guardian</h1><div class="sub">Cloud Command Center — Multi-Device</div></div>
  <div class="small" id="cloudStatus">Cloud: checking...</div>
</header>

<nav>
  <button class="active" onclick="showView('fleet',this)">Command Center</button>
  <button onclick="showView('twin',this)">Digital Twin</button>
  <button onclick="showView('monitor',this)">Live Monitor</button>
  <button onclick="showView('timeline',this)">Exposure Timeline</button>
  <button onclick="showView('incidents',this)">Incidents</button>
  <button onclick="showView('analytics',this)">Analytics</button>
  <button onclick="showView('whatif',this)">What-If</button>
  <button onclick="showView('health',this)">Device Health</button>
  <button onclick="showView('settings',this)">Settings</button>
  <button onclick="showView('voice',this)">Voice</button>
</nav>

<main>

<div class="view active" id="fleet">
  <p class="small">Every device that has posted to <code>/api/ingest</code> appears automatically. Click a card to open it.</p>
  <div class="grid" id="fleetGrid"></div>
</div>

<div class="view" id="twin">
  <div class="row" style="justify-content:space-between;align-items:center">
    <h2 style="margin:4px 0">Digital Twin — <span id="twinDeviceName">-</span></h2>
    <select id="deviceSelect" onchange="selectDevice(this.value)"></select>
  </div>
  <div class="twin-box" id="twinBox"><div class="temp-fill" id="twinFill"></div><div class="lbl"><div id="twinTemp" style="font-size:26px">--°C</div><div id="twinState" class="small">--</div></div></div>
  <div class="grid">
    <div class="card"><div class="label">Vibration</div><div class="value" id="twinVib">--</div></div>
    <div class="card"><div class="label">Compliance</div><div class="value" id="twinCompliance">--</div></div>
    <div class="card"><div class="label">Reliability</div><div class="value" id="twinReliability">--</div></div>
    <div class="card"><div class="label">Data Quality</div><div class="value" id="twinQuality">--</div></div>
  </div>
  <div class="card" style="margin-top:10px">
    <div class="label">QR Device Identity</div>
    <div class="qr" id="qrHolder"></div>
    <div class="small">Scan to open this device's live page directly.</div>
  </div>
</div>

<div class="view" id="monitor">
  <div class="grid">
    <div class="card"><div class="label">Temperature</div><div class="value" id="mTemp">--</div></div>
    <div class="card"><div class="label">Humidity</div><div class="value" id="mHum">--</div></div>
    <div class="card"><div class="label">Risk</div><div class="value" id="mRisk">--</div></div>
    <div class="card"><div class="label">Trend</div><div class="value" id="mTrend">--</div></div>
    <div class="card"><div class="label">RSSI</div><div class="value" id="mRssi">--</div></div>
    <div class="card"><div class="label">Latency</div><div class="value" id="mLatency">--</div></div>
    <div class="card"><div class="label">Sensor Confidence</div><div class="value" id="mConf">--</div></div>
    <div class="card"><div class="label">Anomaly</div><div class="value" id="mAnomaly">--</div></div>
  </div>
  <div class="card" style="margin-top:10px"><div class="label">Temperature Trend</div><canvas id="chart"></canvas></div>
</div>

<div class="view" id="timeline">
  <h2>Vaccine/Reagent Exposure Timeline</h2>
  <div class="log" id="timelineLog">No events yet</div>
</div>

<div class="view" id="incidents">
  <h2>Incident Investigation Mode</h2>
  <div id="incidentList"></div>
  <div class="row" style="margin-top:10px">
    <button class="btn" onclick="ackIncident()">ACKNOWLEDGE INCIDENT</button>
    <button class="btn secondary" onclick="downloadAudit()">📄 Audit CSV</button>
    <button class="btn secondary" onclick="downloadExport()">📦 Compliance Evidence Package</button>
  </div>
  <div class="card" style="margin-top:10px"><div class="label">Executive Summary</div><div id="execSummary" class="small">--</div></div>
</div>

<div class="view" id="analytics">
  <h2>Thermal Stress, Correlation &amp; Anomaly</h2>
  <div class="grid">
    <div class="card"><div class="label">Thermal Stress Index</div><div class="value" id="aStress">--</div></div>
    <div class="card"><div class="label">Event Correlation</div><div class="value" id="aCorr" style="font-size:14px">--</div></div>
    <div class="card"><div class="label">Adaptive Baseline</div><div class="value" id="aBaseline" style="font-size:14px">--</div></div>
    <div class="card"><div class="label">MTTR / MTBI</div><div class="value" id="aMttr" style="font-size:14px">--</div></div>
  </div>
</div>

<div class="view" id="whatif">
  <h2>What-If Simulator</h2>
  <p class="small">Doesn't touch real sensor data — pure calculation for demos.</p>
  <div class="card">
    <label class="small">Current Temperature (°C)</label><input id="wiCurrent" type="number" value="6.0">
    <label class="small">Rate of change (°C/min, negative = falling)</label><input id="wiRate" type="number" value="0.2">
    <label class="small">Threshold (°C)</label><input id="wiThreshold" type="number" value="8.0">
    <button class="btn" onclick="runWhatIf()">Simulate</button>
    <div id="wiResult" class="small" style="margin-top:10px"></div>
  </div>
</div>

<div class="view" id="health">
  <h2>Device Health &amp; Predictive Maintenance</h2>
  <div class="grid">
    <div class="card"><div class="label">Health Grade</div><div class="value" id="hGrade">--</div></div>
    <div class="card"><div class="label">Reconnects</div><div class="value" id="hReconnects">--</div></div>
    <div class="card"><div class="label">Cloud</div><div class="value" id="hCloud">--</div></div>
    <div class="card"><div class="label">Uptime</div><div class="value" id="hUptime">--</div></div>
  </div>
  <div class="card" style="margin-top:10px"><div class="label">Maintenance Recommendation</div><div id="hMaint" class="small">--</div></div>
  <button class="btn secondary" style="margin-top:10px" onclick="runDiagnostics()">RUN SYSTEM DIAGNOSTICS</button>
  <div id="diagResult" class="small" style="margin-top:8px"></div>
</div>

<div class="view" id="settings">
  <h2>Device Configuration</h2>
  <div class="card">
    <label class="small">Profile</label>
    <select id="cfgProfile"><option value="VACCINE">Vaccine cold-chain (2-8C default)</option><option value="REAGENT">Sensitive reagent (custom range)</option></select>
    <label class="small">Min Temp (°C)</label><input id="cfgMin" type="number" step="0.1">
    <label class="small">Max Temp (°C)</label><input id="cfgMax" type="number" step="0.1">
    <button class="btn" onclick="saveConfig()">Save (validated server-side)</button>
    <div id="cfgMsg" class="small" style="margin-top:6px"></div>
  </div>
</div>

<div class="view" id="voice">
  <h2>Voice Assistant — Two-Way</h2>
  <p class="small">Tap the mic and ask things like "what is the temperature", "is it safe", "any alerts", "acknowledge incident", "run diagnostics". It answers out loud using live data — nothing is spoken automatically while idle.</p>
  <div style="text-align:center"><button class="mic-btn" id="micBtn" onclick="toggleListen()">🎤</button></div>
  <div class="log" id="voiceTranscript" style="margin-top:14px">No conversation yet</div>
</div>

</main>

<script>
let selectedDevice = "__PRESELECT_DEVICE__" !== "__PRESELECT_DEVICE__".replace("__","") ? null : "__PRESELECT_DEVICE__";
if (selectedDevice && selectedDevice.indexOf("PRESELECT") >= 0) selectedDevice = null;
let latestData = null;

function showView(id, btn){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b=>b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if(btn) btn.classList.add('active');
}

async function loadFleet(){
  const r = await fetch('/api/devices');
  const devices = await r.json();
  const grid = document.getElementById('fleetGrid');
  const sel = document.getElementById('deviceSelect');
  grid.innerHTML = ''; sel.innerHTML = '';
  devices.forEach(d=>{
    const card = document.createElement('div');
    card.className = 'card device-card';
    card.onclick = ()=>{ selectDevice(d.deviceId); showView('twin', document.querySelectorAll('nav button')[1]); };
    card.innerHTML = '<div class="label">'+d.deviceId+'</div><div class="value">'+d.label+'</div>' +
      '<span class="state-badge state-'+d.state.replace(' ','\\\\ ')+'">'+d.state+'</span>' +
      '<div class="small" style="margin-top:6px">'+(d.online?'🟢 Online':'⚪ Last seen '+(d.lastSeenAt?new Date(d.lastSeenAt).toLocaleTimeString():'never'))+'</div>';
    grid.appendChild(card);
    const opt = document.createElement('option'); opt.value=d.deviceId; opt.innerText=d.deviceId; sel.appendChild(opt);
  });
  if(!selectedDevice && devices.length){ selectedDevice = devices[0].deviceId; }
  if(selectedDevice) document.getElementById('deviceSelect').value = selectedDevice;
}

function selectDevice(id){ selectedDevice = id; refreshAll(); }

async function refreshAll(){
  if(!selectedDevice) return;
  let r;
  try { r = await fetch('/api/latest/'+selectedDevice); } catch(e){ return; }
  if(!r.ok) return;
  const d = await r.json();
  latestData = d;

  // Digital twin
  document.getElementById('twinDeviceName').innerText = d.deviceLabel || selectedDevice;
  document.getElementById('twinTemp').innerText = d.temp + '°C';
  document.getElementById('twinState').innerText = d.state + ' — ' + (d.stateReason||'');
  const fillPct = Math.max(0, Math.min(100, ((d.temp - (d.tempMin-3)) / ((d.tempMax+3)-(d.tempMin-3)))*100));
  document.getElementById('twinFill').style.height = fillPct + '%';
  const box = document.getElementById('twinBox');
  const color = d.state==='SAFE' ? '#4ade80' : d.state==='WARNING' ? '#fbbf24' : '#f87171';
  box.style.borderColor = color; box.style.boxShadow = '0 0 24px '+color+'55';
  document.getElementById('twinVib').innerText = d.vib + ' (' + d.vibSeverity + ')';
  document.getElementById('twinCompliance').innerText = d.complianceScore + '%';
  document.getElementById('twinReliability').innerText = d.reliability + '%';
  document.getElementById('twinQuality').innerText = d.dataQuality + '%';
  document.getElementById('qrHolder').innerHTML = '<img width="120" height="120" src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data='+encodeURIComponent(location.origin+'/device/'+selectedDevice)+'">';

  // Monitor
  document.getElementById('mTemp').innerText = d.temp+'°C';
  document.getElementById('mHum').innerText = d.hum+'%';
  document.getElementById('mRisk').innerText = d.risk+'%';
  document.getElementById('mTrend').innerText = d.trend;
  document.getElementById('mRssi').innerText = d.rssi+' dBm';
  document.getElementById('mLatency').innerText = d.cloudLatencyMs+' ms';
  document.getElementById('mConf').innerText = d.confidence+'%';
  document.getElementById('mAnomaly').innerText = d.anomaly ? ('⚠ '+d.anomalyMsg) : 'None';

  // Timeline
  const alertsR = await fetch('/api/alerts/'+selectedDevice);
  const alerts = await alertsR.json();
  document.getElementById('timelineLog').innerHTML = alerts.map(a=>'<div>['+new Date(a.time).toLocaleString()+'] <b>'+a.state+'</b> — '+(a.reason||'')+'</div>').join('') || 'No events yet';

  // Incidents
  const incR = await fetch('/api/incidents/'+selectedDevice);
  const incs = await incR.json();
  document.getElementById('incidentList').innerHTML = incs.map(i=>
    '<div class="card" style="margin-bottom:8px"><b>'+i.id+'</b> — '+(i.acknowledged?'✅ Acknowledged':'🔴 Unacknowledged')+
    '<div class="small">Max '+i.maxTemp+'°C / Min '+i.minTemp+'°C — opened '+new Date(i.openedAt).toLocaleString()+(i.closedAt?(' — closed '+new Date(i.closedAt).toLocaleString()):' — ONGOING')+'</div></div>'
  ).join('') || '<p class="small">No incidents recorded.</p>';

  const sumR = await fetch('/api/summary/'+selectedDevice);
  if(sumR.ok){ const s = await sumR.json(); document.getElementById('execSummary').innerText = s.summary; }

  // Analytics
  document.getElementById('aStress').innerText = d.thermalStressIndex;
  document.getElementById('aCorr').innerText = d.correlation + ' ('+d.correlationConfidence+')';
  document.getElementById('aBaseline').innerText = 'Mean '+d.baselineMean+'°C, σ '+d.baselineStdDev;
  document.getElementById('aMttr').innerText = 'MTTR '+d.mttrSec+'s / MTBI '+d.mtbiSec+'s';

  // Health
  document.getElementById('hGrade').innerText = d.healthGrade;
  document.getElementById('hReconnects').innerText = d.reconnects;
  document.getElementById('hCloud').innerText = d.cloudReachable ? 'Reachable' : 'Unreachable';
  document.getElementById('hUptime').innerText = Math.floor(d.uptimeSec/60)+' min';
  document.getElementById('hMaint').innerText = d.maintenanceMsg;

  // Settings defaults
  document.getElementById('cfgMin').value = d.tempMin;
  document.getElementById('cfgMax').value = d.tempMax;
  document.getElementById('cfgProfile').value = d.profile;

  document.getElementById('cloudStatus').innerText = 'Cloud: online — '+Object.keys(1).length+' req ok';

  // Chart
  const histR = await fetch('/api/history/'+selectedDevice+'?hours=6');
  const hist = await histR.json();
  drawChart(hist.map(h=>h.temp), d.tempMin, d.tempMax);
}

function drawChart(temps, tmin, tmax){
  const c = document.getElementById('chart'); if(!c || temps.length<2) return;
  const ctx = c.getContext('2d'); c.width = c.clientWidth; c.height = 220;
  ctx.clearRect(0,0,c.width,c.height);
  const lo = tmin-3, hi = tmax+3;
  function y(v){ return c.height - ((v-lo)/(hi-lo))*c.height; }
  ctx.strokeStyle = '#334'; ctx.beginPath(); ctx.moveTo(0,y(tmax)); ctx.lineTo(c.width,y(tmax)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,y(tmin)); ctx.lineTo(c.width,y(tmin)); ctx.stroke();
  ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2; ctx.beginPath();
  temps.forEach((t,i)=>{ const x=(i/(temps.length-1))*c.width; const yy=y(t); i===0?ctx.moveTo(x,yy):ctx.lineTo(x,yy); });
  ctx.stroke();
}

async function ackIncident(){
  await fetch('/api/ack/'+selectedDevice, { method:'POST' });
  alert('Incident acknowledged.');
  refreshAll();
}
function downloadAudit(){ window.location.href = '/api/audit/'+selectedDevice; }
function downloadExport(){ window.open('/api/export/'+selectedDevice, '_blank'); }

async function saveConfig(){
  const max = parseFloat(document.getElementById('cfgMax').value);
  const min = parseFloat(document.getElementById('cfgMin').value);
  const profile = document.getElementById('cfgProfile').value;
  const r = await fetch('/api/config/'+selectedDevice, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({max,min,profile}) });
  const j = await r.json();
  document.getElementById('cfgMsg').innerText = r.ok ? 'Saved. Device will pick this up within ~20s.' : ('Rejected: '+j.error);
}

async function runWhatIf(){
  const current = document.getElementById('wiCurrent').value;
  const rate = document.getElementById('wiRate').value;
  const threshold = document.getElementById('wiThreshold').value;
  const r = await fetch('/api/whatif?current='+current+'&rate='+rate+'&threshold='+threshold);
  const j = await r.json();
  document.getElementById('wiResult').innerText = j.note;
}

async function runDiagnostics(){
  const r = await fetch('/api/diagnostics');
  const j = await r.json();
  document.getElementById('diagResult').innerText = 'Server OK — '+j.devicesTracked+' device(s) tracked, '+j.memoryMB+'MB used, uptime '+j.uptimeSec+'s.';
}

/* ---------------- Voice: two-way (listens AND speaks), on-demand only ---------------- */
let recognizing = false;
let recognizer = null;
function speak(text){
  if(!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}
function logVoice(who, text){
  const el = document.getElementById('voiceTranscript');
  if(el.innerText.trim()==='No conversation yet') el.innerHTML='';
  el.innerHTML += '<div><b>'+who+':</b> '+text+'</div>';
  el.scrollTop = el.scrollHeight;
}
async function handleVoiceCommand(text){
  logVoice('You', text);
  const t = text.toLowerCase();
  let reply = "I didn't understand that. Try: what is the temperature, is it safe, any alerts, acknowledge incident, or run diagnostics.";
  if(!latestData){ speak('No device data yet.'); logVoice('Guardian','No device data yet.'); return; }
  if(t.includes('temperature')){
    reply = 'Current temperature is '+latestData.temp+' degrees Celsius.';
  } else if(t.includes('safe')){
    reply = latestData.state==='SAFE' ? 'Yes, the system is currently safe.' : 'No. Current state is '+latestData.state+'. '+latestData.stateReason;
  } else if(t.includes('risk')){
    reply = 'Current risk score is '+latestData.risk+' percent.';
  } else if(t.includes('alert')){
    reply = latestData.state==='DANGER' ? 'Yes, there is an active critical alert. Incident '+latestData.incidentId : 'No active critical alerts.';
  } else if(t.includes('online')){
    reply = latestData.cloudReachable ? 'The device is online and reporting to the cloud.' : 'The device appears to be offline from the cloud.';
  } else if(t.includes('acknowledge')){
    await fetch('/api/ack/'+selectedDevice, { method:'POST' });
    reply = 'Incident acknowledged.';
  } else if(t.includes('diagnostic')){
    const r = await fetch('/api/diagnostics'); const j = await r.json();
    reply = 'Diagnostics complete. Server is healthy, tracking '+j.devicesTracked+' devices.';
  } else if(t.includes('rising') || t.includes('trend')){
    reply = 'Trend is '+latestData.trend+' at '+latestData.rateOfChange+' degrees per minute.';
  }
  speak(reply);
  logVoice('Guardian', reply);
}
function toggleListen(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR){ alert('Speech recognition not supported in this browser. Try Chrome.'); return; }
  if(recognizing){ recognizer.stop(); return; }
  recognizer = new SR();
  recognizer.lang = 'en-US'; recognizer.continuous = false; recognizer.interimResults = false;
  recognizer.onstart = ()=>{ recognizing = true; document.getElementById('micBtn').classList.add('listening'); };
  recognizer.onend = ()=>{ recognizing = false; document.getElementById('micBtn').classList.remove('listening'); };
  recognizer.onresult = (e)=>{ const text = e.results[0][0].transcript; handleVoiceCommand(text); };
  recognizer.start();
}

loadFleet().then(refreshAll);
setInterval(loadFleet, 8000);
setInterval(refreshAll, 3000);
</script>
</body>
</html>`;

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" }); // never leak stack traces to clients
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ColdChain Guardian cloud server listening on port ${PORT}`);
});
