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
