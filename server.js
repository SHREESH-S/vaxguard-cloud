const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// VAXGUARD PRO - CLOUD SERVER
// ============================================================

// API security key from Render Environment Variables
const API_KEY = process.env.API_KEY;

app.use(express.json({ limit: "100kb" }));

// ============================================================
// DEVICE DATA
// ============================================================

let latestData = {
  device: "VAXGUARD-01",

  status: "OFFLINE",

  temperature: null,
  humidity: null,

  vibration: 0,

  risk: 0,
  predictedRisk: 0,
  anomaly: 0,
  confidence: 100,

  trend: "STABLE",

  advisory: "Waiting for device data",

  correlation: "None",

  fault: false,

  wifiRSSI: null,
  reconnects: 0,

  updatedAt: null
};

// ============================================================
// HISTORY
// ============================================================

let temperatureHistory = [];

let alertHistory = [];

let auditHistory = [];

// Maximum records kept in memory
const MAX_HISTORY = 100;

// ============================================================
// HELPER - ADD TEMPERATURE HISTORY
// ============================================================

function addTemperatureHistory(data) {

  if (typeof data.temperature !== "number") {
    return;
  }

  temperatureHistory.push({
    temperature: data.temperature,
    humidity: data.humidity,
    timestamp: new Date().toISOString()
  });

  if (temperatureHistory.length > MAX_HISTORY) {
    temperatureHistory.shift();
  }
}

// ============================================================
// HELPER - ADD AUDIT LOG
// ============================================================

function addAudit(message, type = "INFO") {

  auditHistory.push({
    timestamp: new Date().toISOString(),
    type: type,
    message: message
  });

  if (auditHistory.length > MAX_HISTORY) {
    auditHistory.shift();
  }
}

// ============================================================
// HOME PAGE
// ============================================================

app.get("/", (req, res) => {

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport"
            content="width=device-width, initial-scale=1.0">

      <title>VAXGUARD PRO</title>
    </head>

    <body>

      <h1>VAXGUARD PRO</h1>

      <p>Vaccine Cold Chain Guardian</p>

      <p>Cloud server is running successfully.</p>

      <p>Device: ${latestData.device}</p>

      <p>Status: ${latestData.status}</p>

    </body>
    </html>
  `);
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {

  res.json({
    ok: true,
    service: "VAXGUARD PRO Cloud",
    status: "ONLINE",
    serverTime: new Date().toISOString()
  });

});

// ============================================================
// ESP32 → CLOUD
// ============================================================

app.post("/api/ingest", (req, res) => {

  // Check API key
  if (req.headers["x-api-key"] !== API_KEY) {

    addAudit(
      "Unauthorized device request rejected",
      "SECURITY"
    );

    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  const previousStatus = latestData.status;

  latestData = {
    ...latestData,
    ...req.body,
    updatedAt: new Date().toISOString()
  };

  addTemperatureHistory(latestData);

  // Record status changes
  if (previousStatus !== latestData.status) {

    alertHistory.push({
      timestamp: latestData.updatedAt,
      status: latestData.status,
      temperature: latestData.temperature,
      risk: latestData.risk,
      message:
        latestData.advisory || "System status changed"
    });

    if (alertHistory.length > MAX_HISTORY) {
      alertHistory.shift();
    }

    addAudit(
      `System status changed: ${previousStatus} → ${latestData.status}`,
      "STATUS"
    );
  }

  console.log(
    "VAXGUARD DATA:",
    latestData
  );

  res.json({
    success: true,
    message: "Data received",
    updatedAt: latestData.updatedAt
  });

});

// ============================================================
// LATEST DATA
// ============================================================

app.get("/api/latest", (req, res) => {

  res.json(latestData);

});

// ============================================================
// TEMPERATURE HISTORY
// ============================================================

app.get("/api/history", (req, res) => {

  res.json({
    success: true,
    data: temperatureHistory
  });

});

// ============================================================
// ALERT HISTORY
// ============================================================

app.get("/api/alerts", (req, res) => {

  res.json({
    success: true,
    data: alertHistory
  });

});

// ============================================================
// AUDIT LOG
// ============================================================

app.get("/api/audit", (req, res) => {

  res.json({
    success: true,
    data: auditHistory
  });

});

// ============================================================
// VAXGUARD PRO - ADVANCED CLOUD DASHBOARD
// ============================================================

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>VAXGUARD PRO | Cloud Dashboard</title>

<style>

*{
  box-sizing:border-box;
  margin:0;
  padding:0;
  font-family:Arial,sans-serif;
}

body{
  background:#0b1220;
  color:#e5e7eb;
}

.header{
  background:#111827;
  padding:18px 25px;
  display:flex;
  justify-content:space-between;
  align-items:center;
  border-bottom:1px solid #263244;
}

.logo{
  font-size:24px;
  font-weight:bold;
}

.logo span{
  color:#22c55e;
}

.connection{
  color:#22c55e;
  font-size:14px;
}

.container{
  padding:25px;
}

.title{
  margin-bottom:20px;
}

.title h1{
  font-size:28px;
}

.title p{
  color:#94a3b8;
  margin-top:5px;
}

.cards{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(210px,1fr));
  gap:18px;
}

.card{
  background:#111827;
  border:1px solid #263244;
  border-radius:14px;
  padding:20px;
}

.card-title{
  color:#94a3b8;
  font-size:14px;
  margin-bottom:10px;
}

.value{
  font-size:32px;
  font-weight:bold;
}

.unit{
  font-size:15px;
  color:#94a3b8;
}

.safe{
  color:#22c55e;
}

.warning{
  color:#f59e0b;
}

.breach{
  color:#ef4444;
}

.grid{
  display:grid;
  grid-template-columns:2fr 1fr;
  gap:18px;
  margin-top:20px;
}

.panel{
  background:#111827;
  border:1px solid #263244;
  border-radius:14px;
  padding:20px;
}

.panel h2{
  margin-bottom:15px;
  font-size:18px;
}

canvas{
  width:100%;
  height:260px;
}

.info{
  display:flex;
  justify-content:space-between;
  padding:12px 0;
  border-bottom:1px solid #263244;
}

.info:last-child{
  border-bottom:none;
}

.label{
  color:#94a3b8;
}

.advisory{
  margin-top:20px;
  padding:18px;
  background:#172033;
  border-left:4px solid #22c55e;
  border-radius:8px;
}

.footer{
  text-align:center;
  color:#64748b;
  padding:25px;
}

@media(max-width:800px){
  .grid{
    grid-template-columns:1fr;
  }

  .container{
    padding:15px;
  }
}

</style>
</head>

<body>

<div class="header">

  <div class="logo">
    🛡️ VAXGUARD <span>PRO</span>
  </div>

  <div class="connection">
    ● CLOUD CONNECTED
  </div>

</div>


<div class="container">

  <div class="title">

    <h1>Vaccine Cold Chain Monitoring</h1>

    <p>
      Real-time intelligent monitoring • Cloud connected
    </p>

  </div>


  <!-- MAIN CARDS -->

  <div class="cards">

    <div class="card">

      <div class="card-title">
        TEMPERATURE
      </div>

      <div class="value">
        <span id="temperature">--</span>
        <span class="unit">°C</span>
      </div>

    </div>


    <div class="card">

      <div class="card-title">
        HUMIDITY
      </div>

      <div class="value">
        <span id="humidity">--</span>
        <span class="unit">%</span>
      </div>

    </div>


    <div class="card">

      <div class="card-title">
        VIBRATION EVENTS
      </div>

      <div class="value">
        <span id="vibration">0</span>
      </div>

    </div>


    <div class="card">

      <div class="card-title">
        RISK SCORE
      </div>

      <div class="value">
        <span id="risk">0</span>
        <span class="unit">%</span>
      </div>

    </div>

  </div>


  <!-- GRAPH + SYSTEM STATUS -->

  <div class="grid">


    <div class="panel">

      <h2>📈 Temperature Trend</h2>

      <canvas id="tempChart"></canvas>

    </div>


    <div class="panel">

      <h2>🛡️ System Status</h2>

      <div class="info">

        <span class="label">Device</span>

        <span id="device">--</span>

      </div>


      <div class="info">

        <span class="label">Status</span>

        <strong id="status">--</strong>

      </div>


      <div class="info">

        <span class="label">Prediction</span>

        <span id="prediction">--</span>

      </div>


      <div class="info">

        <span class="label">Last Update</span>

        <span id="updated">--</span>

      </div>

    </div>

  </div>


  <!-- ADVISORY -->

  <div class="advisory">

    <h2>🤖 VAXGUARD Advisory</h2>

    <p id="advisory">
      Waiting for device data...
    </p>

  </div>


</div>


<div class="footer">

  VAXGUARD PRO • Intelligent Vaccine Cold Chain Guardian

</div>


<script>

let temperatures = [];


// ============================================================
// UPDATE DASHBOARD
// ============================================================

async function updateDashboard(){

  try{

    const response = await fetch("/api/latest");

    const data = await response.json();


    document.getElementById("device").innerText =
      data.device || "--";


    document.getElementById("temperature").innerText =
      data.temperature !== null
      ? Number(data.temperature).toFixed(1)
      : "--";


    document.getElementById("humidity").innerText =
      data.humidity !== null
      ? Number(data.humidity).toFixed(1)
      : "--";


    document.getElementById("vibration").innerText =
      data.vibration ?? 0;


    document.getElementById("risk").innerText =
      data.risk ?? 0;


    const status =
      document.getElementById("status");

    status.innerText =
      data.status || "--";


    status.className = "";

    if(data.status === "SAFE"){
      status.classList.add("safe");
    }

    else if(data.status === "WARNING"){
      status.classList.add("warning");
    }

    else if(data.status === "BREACH"){
      status.classList.add("breach");
    }


    document.getElementById("updated").innerText =
      data.updatedAt
      ? new Date(data.updatedAt).toLocaleTimeString()
      : "--";


    if(data.temperature !== null){

      temperatures.push(
        Number(data.temperature)
      );

      if(temperatures.length > 30){
        temperatures.shift();
      }

      drawChart();

    }

  }

  catch(error){

    console.log("Cloud connection error:",error);

  }

}


// ============================================================
// TEMPERATURE GRAPH
// ============================================================

function drawChart(){

  const canvas =
    document.getElementById("tempChart");

  const ctx =
    canvas.getContext("2d");

  canvas.width =
    canvas.clientWidth * 2;

  canvas.height =
    260 * 2;

  ctx.scale(2,2);

  const width =
    canvas.clientWidth;

  const height = 260;


  ctx.clearRect(
    0,
    0,
    width,
    height
  );


  if(temperatures.length < 2)
    return;


  const min = 0;

  const max = 12;


  // SAFE RANGE

  ctx.fillStyle =
    "rgba(34,197,94,0.08)";

  const safeTop =
    height - ((8-min)/(max-min))*height;

  const safeBottom =
    height - ((2-min)/(max-min))*height;

  ctx.fillRect(
    0,
    safeTop,
    width,
    safeBottom-safeTop
  );


  // GRAPH LINE

  ctx.beginPath();


  temperatures.forEach((temp,index)=>{

    const x =
      index *
      (width/(temperatures.length-1));


    const y =
      height -
      ((temp-min)/(max-min))*height;


    if(index === 0)
      ctx.moveTo(x,y);

    else
      ctx.lineTo(x,y);

  });


  ctx.strokeStyle =
    "#22c55e";

  ctx.lineWidth = 3;

  ctx.stroke();

}


// ============================================================
// AUTO REFRESH
// ============================================================

updateDashboard();

setInterval(
  updateDashboard,
  3000
);

</script>

</body>
</html>
  `);
});
// ============================================================
// PART 3 - ADVANCED MONITORING APIs
// ============================================================

// SYSTEM SUMMARY
app.get("/api/system", (req, res) => {

  const now = Date.now();

  let online = false;

  if (latestData.updatedAt) {
    const lastUpdate =
      new Date(latestData.updatedAt).getTime();

    online = (now - lastUpdate) < 15000;
  }

  res.json({

    device: latestData.device,

    online: online,

    status: latestData.status,

    temperature: latestData.temperature,

    humidity: latestData.humidity,

    vibration: latestData.vibration,

    risk: latestData.risk,

    predictedRisk: latestData.predictedRisk,

    anomaly: latestData.anomaly,

    confidence: latestData.confidence,

    trend: latestData.trend,

    fault: latestData.fault,

    wifiRSSI: latestData.wifiRSSI,

    reconnects: latestData.reconnects,

    updatedAt: latestData.updatedAt

  });

});


// ============================================================
// DASHBOARD STATISTICS
// ============================================================

app.get("/api/stats", (req, res) => {

  let minTemp = null;
  let maxTemp = null;
  let avgTemp = null;

  if (temperatureHistory.length > 0) {

    const values =
      temperatureHistory
        .map(x => Number(x.temperature))
        .filter(x => !isNaN(x));

    if (values.length > 0) {

      minTemp = Math.min(...values);

      maxTemp = Math.max(...values);

      avgTemp =
        values.reduce(
          (sum, value) => sum + value,
          0
        ) / values.length;

    }

  }

  res.json({

    samples: temperatureHistory.length,

    minimumTemperature: minTemp,

    maximumTemperature: maxTemp,

    averageTemperature: avgTemp,

    totalAlerts: alertHistory.length,

    totalAuditEvents: auditHistory.length

  });

});


// ============================================================
// CSV EXPORT
// ============================================================

app.get("/api/export", (req, res) => {

  let csv =
    "Timestamp,Temperature,Humidity\n";

  temperatureHistory.forEach(item => {

    csv +=
      `"${item.timestamp}",` +
      `"${item.temperature}",` +
      `"${item.humidity}"\n`;

  });

  res.setHeader(
    "Content-Type",
    "text/csv"
  );

  res.setHeader(
    "Content-Disposition",
    "attachment; filename=vaxguard-temperature.csv"
  );

  res.send(csv);

});


// ============================================================
// CLEAR HISTORY
// ============================================================

app.post("/api/clear-history", (req, res) => {

  temperatureHistory = [];

  alertHistory = [];

  auditHistory = [];

  addAudit(
    "Dashboard history cleared",
    "SYSTEM"
  );

  res.json({
    success: true,
    message: "History cleared"
  });

});


// ============================================================
// DEVICE STATUS
// ============================================================

app.get("/api/device-status", (req, res) => {

  let online = false;

  if (latestData.updatedAt) {

    const last =
      new Date(latestData.updatedAt).getTime();

    online =
      (Date.now() - last) < 15000;

  }

  res.json({

    device: latestData.device,

    online: online,

    status: latestData.status,

    lastSeen: latestData.updatedAt,

    cloud: "ONLINE"

  });

});


// ============================================================
// ALERT SUMMARY
// ============================================================

app.get("/api/alert-summary", (req, res) => {

  let safe = 0;
  let warning = 0;
  let breach = 0;

  alertHistory.forEach(alert => {

    if (alert.status === "SAFE")
      safe++;

    if (alert.status === "WARNING")
      warning++;

    if (alert.status === "BREACH")
      breach++;

  });

  res.json({

    total: alertHistory.length,

    safe: safe,

    warning: warning,

    breach: breach

  });

});


// ============================================================
// PREDICTIVE MONITORING
// ============================================================

app.get("/api/prediction", (req, res) => {

  const current =
    Number(latestData.temperature);

  const predicted =
    Number(latestData.predictedRisk || 0);

  let message =
    "Conditions stable";

  let level =
    "LOW";

  if (predicted >= 70) {

    message =
      "High probability of cold-chain risk";

    level =
      "HIGH";

  }

  else if (predicted >= 40) {

    message =
      "Environmental conditions require attention";

    level =
      "MEDIUM";

  }

  res.json({

    temperature: current,

    predictedRisk: predicted,

    predictionLevel: level,

    message: message,

    trend:
      latestData.trend || "STABLE"

  });

});


// ============================================================
// SECURITY / API STATUS
// ============================================================

app.get("/api/cloud-status", (req, res) => {

  res.json({

    service: "VAXGUARD PRO",

    cloud: "ONLINE",

    api: "ONLINE",

    security:
      API_KEY ? "ACTIVE" : "NOT CONFIGURED",

    serverTime:
      new Date().toISOString()

  });

});


// ============================================================
// ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {

  console.error(
    "SERVER ERROR:",
    err
  );

  res.status(500).json({

    success: false,

    error: "Internal server error"

  });

});
// ============================================================
// PART 4 - ADVANCED DASHBOARD CONTROLS
// ============================================================

// Dashboard settings
app.get("/api/settings", (req, res) => {

  res.json({
    temperatureSafeMin: 2,
    temperatureSafeMax: 8,
    warningLow: 2.8,
    warningHigh: 7.2,
    vibrationWarning: 6,
    vibrationBreach: 12,
    refreshInterval: 3000
  });

});


// ============================================================
// VOICE ASSISTANT MESSAGE
// ============================================================

app.get("/api/voice", (req, res) => {

  let message = "";

  if (latestData.status === "SAFE") {

    message =
      `VAXGUARD reports safe conditions. ` +
      `Current temperature is ${latestData.temperature ?? "unknown"} degrees Celsius.`;

  }

  else if (latestData.status === "WARNING") {

    message =
      `Warning. VAXGUARD has detected conditions ` +
      `that require attention. ` +
      `Current temperature is ${latestData.temperature ?? "unknown"} degrees Celsius.`;

  }

  else if (latestData.status === "BREACH") {

    message =
      `Critical alert. VAXGUARD has detected a cold chain breach. ` +
      `Immediate inspection is recommended.`;

  }

  else {

    message =
      "VAXGUARD is waiting for device information.";

  }

  res.json({
    message: message
  });

});


// ============================================================
// DASHBOARD PAGE 2 - ADVANCED MONITORING
// ============================================================

app.get("/monitor", (req, res) => {

  res.send(`

<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width,initial-scale=1">

<title>VAXGUARD PRO Monitoring</title>

<style>

*{
  box-sizing:border-box;
  font-family:Arial,sans-serif;
}

body{
  margin:0;
  background:#0b1220;
  color:#e5e7eb;
}

header{
  background:#111827;
  padding:20px;
  border-bottom:1px solid #263244;
}

header h1{
  margin:0;
}

header p{
  color:#94a3b8;
}

.container{
  padding:20px;
  max-width:1400px;
  margin:auto;
}

.grid{
  display:grid;
  grid-template-columns:
    repeat(auto-fit,minmax(220px,1fr));

  gap:16px;
}

.card{
  background:#111827;
  border:1px solid #263244;
  border-radius:14px;
  padding:20px;
}

.label{
  color:#94a3b8;
  font-size:13px;
}

.value{
  font-size:30px;
  font-weight:bold;
  margin-top:8px;
}

.safe{
  color:#22c55e;
}

.warning{
  color:#f59e0b;
}

.breach{
  color:#ef4444;
}

.panel{
  margin-top:20px;
  background:#111827;
  border:1px solid #263244;
  border-radius:14px;
  padding:20px;
}

button{
  border:none;
  border-radius:8px;
  padding:12px 18px;
  margin:5px;
  cursor:pointer;
  background:#1f2937;
  color:white;
}

button:hover{
  background:#374151;
}

.alert{
  padding:12px;
  margin-top:8px;
  border-radius:8px;
  background:#172033;
}

.small{
  color:#94a3b8;
  font-size:13px;
}

</style>

</head>


<body>


<header>

<h1>🛡️ VAXGUARD PRO</h1>

<p>Advanced Cold Chain Intelligence</p>

</header>


<div class="container">


<!-- LIVE DATA -->

<div class="grid">


<div class="card">

<div class="label">
TEMPERATURE
</div>

<div class="value">

<span id="temperature">
--
</span>

°C

</div>

</div>


<div class="card">

<div class="label">
HUMIDITY
</div>

<div class="value">

<span id="humidity">
--
</span>

%

</div>

</div>


<div class="card">

<div class="label">
RISK SCORE
</div>

<div class="value">

<span id="risk">
--
</span>

%

</div>

</div>


<div class="card">

<div class="label">
PREDICTED RISK
</div>

<div class="value">

<span id="prediction">
--
</span>

%

</div>

</div>


<div class="card">

<div class="label">
ANOMALY SCORE
</div>

<div class="value">

<span id="anomaly">
--
</span>

%

</div>

</div>


<div class="card">

<div class="label">
SENSOR CONFIDENCE
</div>

<div class="value">

<span id="confidence">
--
</span>

%

</div>

</div>


</div>


<!-- SYSTEM -->

<div class="panel">

<h2>📡 Device Health</h2>

<p>
Device:
<strong id="device">--</strong>
</p>

<p>
Connection:
<strong id="connection">
Checking...
</strong>
</p>

<p>
Wi-Fi RSSI:
<strong id="wifi">--</strong>
</p>

<p>
Wi-Fi reconnects:
<strong id="reconnects">--</strong>
</p>

<p>
Temperature trend:
<strong id="trend">--</strong>
</p>

</div>


<!-- ADVISORY -->

<div class="panel">

<h2>🧠 Intelligent Advisory</h2>

<p id="advisory">
Waiting for data...
</p>

</div>


<!-- VOICE -->

<div class="panel">

<h2>🔊 Voice Assistant</h2>

<p class="small">
Press the button to hear the current VAXGUARD status.
</p>

<button onclick="speakStatus()">
🔊 Speak Current Status
</button>

</div>


<!-- ALERTS -->

<div class="panel">

<h2>🚨 Recent Alerts</h2>

<div id="alerts">

No alerts yet.

</div>

</div>


<!-- EXPORT -->

<div class="panel">

<h2>📥 Data Management</h2>

<button onclick="downloadCSV()">
Download Temperature CSV
</button>

<button onclick="loadStats()">
View Statistics
</button>

<div id="stats"></div>

</div>


</div>


<script>


// ============================================================
// UPDATE LIVE DATA
// ============================================================

async function updateData(){

  try{

    const response =
      await fetch("/api/latest");

    const data =
      await response.json();


    document.getElementById("temperature")
      .innerText =
      data.temperature != null
      ? Number(data.temperature).toFixed(1)
      : "--";


    document.getElementById("humidity")
      .innerText =
      data.humidity != null
      ? Number(data.humidity).toFixed(1)
      : "--";


    document.getElementById("risk")
      .innerText =
      data.risk ?? 0;


    document.getElementById("prediction")
      .innerText =
      data.predictedRisk ?? 0;


    document.getElementById("anomaly")
      .innerText =
      data.anomaly ?? 0;


    document.getElementById("confidence")
      .innerText =
      data.confidence ?? 0;


    document.getElementById("device")
      .innerText =
      data.device || "--";


    document.getElementById("wifi")
      .innerText =
      data.wifiRSSI ?? "--";


    document.getElementById("reconnects")
      .innerText =
      data.reconnects ?? 0;


    document.getElementById("trend")
      .innerText =
      data.trend || "STABLE";


    document.getElementById("advisory")
      .innerText =
      data.advisory ||
      "System operating normally";


    const connection =
      document.getElementById("connection");


    connection.innerText =
      "● CLOUD ONLINE";

    connection.className =
      "safe";


  }

  catch(error){

    console.log(error);

    document.getElementById("connection")
      .innerText =
      "● CONNECTION ERROR";

  }

}


// ============================================================
// LOAD ALERTS
// ============================================================

async function loadAlerts(){

  try{

    const response =
      await fetch("/api/alerts");

    const result =
      await response.json();


    const container =
      document.getElementById("alerts");


    if(!result.data ||
       result.data.length === 0){

      container.innerHTML =
        "No alerts recorded.";

      return;

    }


    container.innerHTML = "";


    result.data
      .slice()
      .reverse()
      .slice(0,10)
      .forEach(alert => {

        const div =
          document.createElement("div");

        div.className =
          "alert";


        div.innerHTML =

          "<strong>" +
          (alert.status || "EVENT") +
          "</strong><br>" +

          "<span class='small'>" +
          (alert.message || "") +
          "</span><br>" +

          "<span class='small'>" +
          new Date(alert.timestamp)
            .toLocaleString() +
          "</span>";


        container.appendChild(div);

      });

  }

  catch(error){

    console.log(error);

  }

}


// ============================================================
// VOICE ASSISTANT
// ============================================================

async function speakStatus(){

  try{

    const response =
      await fetch("/api/voice");

    const data =
      await response.json();


    if(
      "speechSynthesis" in window
    ){

      const speech =
        new SpeechSynthesisUtterance(
          data.message
        );

      speech.rate = 0.95;

      speech.pitch = 1;

      window.speechSynthesis
        .cancel();

      window.speechSynthesis
        .speak(speech);

    }

  }

  catch(error){

    console.log(error);

  }

}


// ============================================================
// DOWNLOAD CSV
// ============================================================

function downloadCSV(){

  window.location.href =
    "/api/export";

}


// ============================================================
// STATISTICS
// ============================================================

async function loadStats(){

  try{

    const response =
      await fetch("/api/stats");

    const data =
      await response.json();


    document.getElementById("stats")
      .innerHTML = `

        <br>

        Samples:
        <strong>
        ${data.samples}
        </strong>

        <br>

        Minimum:
        <strong>
        ${data.minimumTemperature ?? "--"}
        °C
        </strong>

        <br>

        Maximum:
        <strong>
        ${data.maximumTemperature ?? "--"}
        °C
        </strong>

        <br>

        Average:
        <strong>
        ${
          data.averageTemperature != null
          ? Number(
              data.averageTemperature
            ).toFixed(2)
          : "--"
        }
        °C
        </strong>

        <br>

        Total Alerts:
        <strong>
        ${data.totalAlerts}
        </strong>

      `;

  }

  catch(error){

    console.log(error);

  }

}


// ============================================================
// START
// ============================================================

updateData();

loadAlerts();

setInterval(
  updateData,
  3000
);

setInterval(
  loadAlerts,
  5000
);


</script>


</body>

</html>

  `);

});
