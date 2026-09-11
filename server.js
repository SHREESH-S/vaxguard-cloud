// ============================================================
// VAXGUARD PRO - CLOUD SERVER
// Vaccine Cold Chain Monitoring Dashboard
// ============================================================

const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// ------------------------------------------------------------
// MIDDLEWARE
// ------------------------------------------------------------

app.use(express.json({ limit: "100kb" }));

// ------------------------------------------------------------
// VAXGUARD DATA
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// HISTORY
// ------------------------------------------------------------

let temperatureHistory = [];
let alertHistory = [];
let auditHistory = [];

const MAX_HISTORY = 100;

// ------------------------------------------------------------
// HELPER FUNCTIONS
// ------------------------------------------------------------

function addTemperatureHistory(data) {
  if (data.temperature === null || data.temperature === undefined) {
    return;
  }

  temperatureHistory.push({
    temperature: Number(data.temperature),
    humidity:
      data.humidity !== null && data.humidity !== undefined
        ? Number(data.humidity)
        : null,
    vibration: Number(data.vibration || 0),
    risk: Number(data.risk || 0),
    status: data.status || "UNKNOWN",
    time: new Date().toISOString()
  });

  if (temperatureHistory.length > MAX_HISTORY) {
    temperatureHistory.shift();
  }
}

function addAudit(message, type = "INFO") {
  auditHistory.unshift({
    time: new Date().toISOString(),
    type: type,
    message: message
  });

  if (auditHistory.length > MAX_HISTORY) {
    auditHistory.pop();
  }
}

function addAlert(status, temperature, vibration) {
  alertHistory.unshift({
    time: new Date().toISOString(),
    status: status,
    temperature: temperature,
    vibration: vibration
  });

  if (alertHistory.length > MAX_HISTORY) {
    alertHistory.pop();
  }
}

function calculateRisk(data) {
  let risk = Number(data.risk || 0);

  if (data.temperature !== null && data.temperature !== undefined) {
    const temp = Number(data.temperature);

    if (temp < 2 || temp > 8) {
      risk = Math.max(risk, 90);
    } else if (temp < 2.8 || temp > 7.2) {
      risk = Math.max(risk, 40);
    }
  }

  if (Number(data.vibration || 0) >= 12) {
    risk = Math.max(risk, 85);
  } else if (Number(data.vibration || 0) >= 6) {
    risk = Math.max(risk, 40);
  }

  return Math.min(100, Math.max(0, Math.round(risk)));
}

function getStatusFromRisk(risk) {
  if (risk >= 80) return "BREACH";
  if (risk >= 40) return "WARNING";
  return "SAFE";
}

// ------------------------------------------------------------
// API - DEVICE INGEST
// ------------------------------------------------------------

app.post("/api/ingest", (req, res) => {
  try {
    if (!API_KEY) {
      console.error("API_KEY is not configured on Render.");
      return res.status(500).json({
        success: false,
        error: "Server API key is not configured"
      });
    }

    const receivedKey = req.headers["x-api-key"];

    if (receivedKey !== API_KEY) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized"
      });
    }

    const previousStatus = latestData.status;

    const incoming = req.body || {};

    latestData = {
      ...latestData,
      ...incoming
    };

    // Convert numerical values safely
    if (latestData.temperature !== null) {
      latestData.temperature = Number(latestData.temperature);
    }

    if (latestData.humidity !== null) {
      latestData.humidity = Number(latestData.humidity);
    }

    latestData.vibration = Number(latestData.vibration || 0);

    // Calculate cloud risk
    latestData.risk = calculateRisk(latestData);

    // If device didn't send a status, calculate one
    if (!incoming.status) {
      latestData.status = getStatusFromRisk(latestData.risk);
    }

    latestData.updatedAt = new Date().toISOString();

    // Save history
    addTemperatureHistory(latestData);

    // Detect status changes
    if (previousStatus !== latestData.status) {
      addAlert(
        latestData.status,
        latestData.temperature,
        latestData.vibration
      );

      addAudit(
        `Device status changed from ${previousStatus} to ${latestData.status}`,
        latestData.status === "BREACH" ? "CRITICAL" : "ALERT"
      );
    }

    addAudit(
      `Data received from ${latestData.device}`,
      "DATA"
    );

    console.log(
      "VAXGUARD DATA:",
      JSON.stringify(latestData)
    );

    res.json({
      success: true,
      message: "Data received successfully",
      updatedAt: latestData.updatedAt
    });

  } catch (error) {
    console.error("INGEST ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});

// ------------------------------------------------------------
// API - LATEST DATA
// ------------------------------------------------------------

app.get("/api/latest", (req, res) => {
  res.json(latestData);
});

// ------------------------------------------------------------
// API - TEMPERATURE HISTORY
// ------------------------------------------------------------

app.get("/api/history", (req, res) => {
  res.json({
    success: true,
    history: temperatureHistory
  });
});

// ------------------------------------------------------------
// API - ALERT HISTORY
// ------------------------------------------------------------

app.get("/api/alerts", (req, res) => {
  res.json({
    success: true,
    alerts: alertHistory
  });
});

// ------------------------------------------------------------
// API - AUDIT LOG
// ------------------------------------------------------------

app.get("/api/audit", (req, res) => {
  res.json({
    success: true,
    audit: auditHistory
  });
});

// ------------------------------------------------------------
// API - SYSTEM
// ------------------------------------------------------------

app.get("/api/system", (req, res) => {
  res.json({
    server: "VAXGUARD PRO Cloud",
    status: "ONLINE",
    device: latestData.device,
    deviceStatus: latestData.status,
    historyRecords: temperatureHistory.length,
    alerts: alertHistory.length,
    auditRecords: auditHistory.length,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ------------------------------------------------------------
// API - STATISTICS
// ------------------------------------------------------------

app.get("/api/stats", (req, res) => {
  const temps = temperatureHistory
    .map(x => Number(x.temperature))
    .filter(x => Number.isFinite(x));

  let minimum = null;
  let maximum = null;
  let average = null;

  if (temps.length > 0) {
    minimum = Math.min(...temps);
    maximum = Math.max(...temps);

    average =
      temps.reduce((sum, value) => sum + value, 0) /
      temps.length;

    average = Number(average.toFixed(2));
  }

  res.json({
    success: true,
    records: temps.length,
    minimumTemperature: minimum,
    maximumTemperature: maximum,
    averageTemperature: average,
    alerts: alertHistory.length
  });
});

// ------------------------------------------------------------
// API - PREDICTION
// ------------------------------------------------------------

app.get("/api/prediction", (req, res) => {
  const prediction =
    Number(latestData.predictedRisk || latestData.risk || 0);

  let message = "Conditions are stable.";

  if (prediction >= 80) {
    message = "High probability of cold-chain breach.";
  } else if (prediction >= 40) {
    message = "Warning: conditions require attention.";
  }

  res.json({
    success: true,
    predictedRisk: prediction,
    trend: latestData.trend || "STABLE",
    advisory: latestData.advisory || message,
    message: message
  });
});

// ------------------------------------------------------------
// API - DEVICE STATUS
// ------------------------------------------------------------

app.get("/api/device-status", (req, res) => {
  let online = false;

  if (latestData.updatedAt) {
    const lastUpdate =
      new Date(latestData.updatedAt).getTime();

    const difference =
      Date.now() - lastUpdate;

    // Consider device online if data arrived within 15 seconds
    online = difference <= 15000;
  }

  res.json({
    success: true,
    online: online,
    status: online ? latestData.status : "OFFLINE",
    device: latestData.device,
    lastUpdate: latestData.updatedAt
  });
});

// ------------------------------------------------------------
// API - ALERT SUMMARY
// ------------------------------------------------------------

app.get("/api/alert-summary", (req, res) => {
  let safe = 0;
  let warning = 0;
  let breach = 0;

  for (const alert of alertHistory) {
    if (alert.status === "SAFE") safe++;
    if (alert.status === "WARNING") warning++;
    if (alert.status === "BREACH") breach++;
  }

  res.json({
    success: true,
    safe: safe,
    warning: warning,
    breach: breach,
    total: alertHistory.length
  });
});

// ------------------------------------------------------------
// API - CLOUD STATUS
// ------------------------------------------------------------

app.get("/api/cloud-status", (req, res) => {
  res.json({
    success: true,
    cloud: "ONLINE",
    server: "VAXGUARD PRO",
    platform: "Render",
    timestamp: new Date().toISOString()
  });
});

// ------------------------------------------------------------
// API - SETTINGS
// ------------------------------------------------------------

app.get("/api/settings", (req, res) => {
  res.json({
    success: true,
    temperature: {
      safeMinimum: 2,
      safeMaximum: 8,
      warningMinimum: 2.8,
      warningMaximum: 7.2
    },
    vibration: {
      warning: 6,
      breach: 12
    },
    device: latestData.device
  });
});

// ------------------------------------------------------------
// API - EXPORT CSV
// ------------------------------------------------------------

app.get("/api/export", (req, res) => {
  let csv =
    "Time,Temperature,Humidity,Vibration,Risk,Status\n";

  for (const item of temperatureHistory) {
    csv +=
      `"${item.time}",` +
      `"${item.temperature}",` +
      `"${item.humidity ?? ""}",` +
      `"${item.vibration}",` +
      `"${item.risk}",` +
      `"${item.status}"\n`;
  }

  res.setHeader(
    "Content-Type",
    "text/csv"
  );

  res.setHeader(
    "Content-Disposition",
    "attachment; filename=vaxguard-history.csv"
  );

  res.send(csv);
});

// ------------------------------------------------------------
// API - CLEAR HISTORY
// ------------------------------------------------------------

app.post("/api/clear-history", (req, res) => {
  temperatureHistory = [];
  alertHistory = [];
  auditHistory = [];

  addAudit(
    "History cleared from dashboard",
    "SYSTEM"
  );

  res.json({
    success: true,
    message: "History cleared"
  });
});

// ============================================================
// MAIN DASHBOARD
// ============================================================

app.get("/", (req, res) => {

  res.send(`
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width, initial-scale=1.0">

<title>VAXGUARD PRO</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, Helvetica, sans-serif;
  background: #0b1120;
  color: #f8fafc;
}

.header {
  padding: 22px;
  background: #111827;
  border-bottom: 1px solid #263244;
}

.header h1 {
  margin: 0;
  font-size: 28px;
}

.header p {
  margin: 7px 0 0;
  color: #94a3b8;
}

.container {
  max-width: 1400px;
  margin: auto;
  padding: 20px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 15px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.device {
  color: #94a3b8;
}

.status {
  padding: 9px 16px;
  border-radius: 20px;
  font-weight: bold;
  background: #334155;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.card {
  background: #111827;
  border: 1px solid #263244;
  border-radius: 16px;
  padding: 20px;
  box-shadow: 0 8px 25px rgba(0,0,0,.2);
}

.card-title {
  color: #94a3b8;
  font-size: 14px;
  margin-bottom: 12px;
}

.value {
  font-size: 34px;
  font-weight: bold;
}

.unit {
  font-size: 16px;
  color: #94a3b8;
}

.section {
  margin-top: 20px;
}

.section h2 {
  font-size: 20px;
  margin-bottom: 12px;
}

canvas {
  width: 100%;
  height: 280px;
  background: #0f172a;
  border-radius: 12px;
}

.advisory {
  font-size: 17px;
  line-height: 1.6;
  color: #cbd5e1;
}

.buttons {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

button,
.button {
  border: none;
  border-radius: 10px;
  padding: 12px 17px;
  cursor: pointer;
  background: #2563eb;
  color: white;
  font-weight: bold;
  text-decoration: none;
}

button:hover,
.button:hover {
  opacity: .85;
}

.footer {
  text-align: center;
  padding: 25px;
  color: #64748b;
  font-size: 13px;
}

.alert {
  padding: 12px;
  border-radius: 10px;
  margin-top: 8px;
  background: #1e293b;
}

.small {
  color: #94a3b8;
  font-size: 13px;
}

</style>

</head>

<body>

<div class="header">

  <h1>🧊 VAXGUARD PRO</h1>

  <p>
    Intelligent Vaccine Cold-Chain Monitoring System
  </p>

</div>

<div class="container">

  <div class="topbar">

    <div>
      <div class="device">
        Device: <b id="device">VAXGUARD-01</b>
      </div>

      <div class="small" id="lastUpdate">
        Waiting for device...
      </div>
    </div>

    <div class="status" id="status">
      OFFLINE
    </div>

  </div>


  <!-- SENSOR CARDS -->

  <div class="grid">

    <div class="card">

      <div class="card-title">
        TEMPERATURE
      </div>

      <div class="value">
        <span id="temperature">--</span>
        <span class="unit">°C</span>
      </div>

      <div class="small">
        Safe range: 2°C – 8°C
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
        VIBRATION
      </div>

      <div class="value">
        <span id="vibration">0</span>
      </div>

      <div class="small">
        Shock / movement monitoring
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


  <!-- ADVISORY -->

  <div class="section">

    <h2>🤖 Intelligent Advisory</h2>

    <div class="card">

      <div class="advisory" id="advisory">
        Waiting for sensor data...
      </div>

      <br>

      <div class="small">
        Trend:
        <b id="trend">STABLE</b>
      </div>

      <div class="small">
        Correlation:
        <b id="correlation">None</b>
      </div>

    </div>

  </div>


  <!-- GRAPH -->

  <div class="section">

    <h2>📈 Temperature History</h2>

    <div class="card">

      <canvas id="chart"
              width="1000"
              height="280">
      </canvas>

    </div>

  </div>


  <!-- SYSTEM -->

  <div class="section">

    <h2>🖥 System Health</h2>

    <div class="grid">

      <div class="card">

        <div class="card-title">
          Wi-Fi RSSI
        </div>

        <div class="value">
          <span id="wifi">--</span>
        </div>

      </div>


      <div class="card">

        <div class="card-title">
          RECONNECTS
        </div>

        <div class="value">
          <span id="reconnects">0</span>
        </div>

      </div>


      <div class="card">

        <div class="card-title">
          SENSOR CONFIDENCE
        </div>

        <div class="value">
          <span id="confidence">100</span>%
        </div>

      </div>


      <div class="card">

        <div class="card-title">
          SENSOR FAULT
        </div>

        <div class="value">
          <span id="fault">NO</span>
        </div>

      </div>

    </div>

  </div>


  <!-- ALERTS -->

  <div class="section">

    <h2>🚨 Recent Alerts</h2>

    <div class="card" id="alerts">
      No alerts yet.
    </div>

  </div>


  <!-- BUTTONS -->

  <div class="section">

    <div class="buttons">

      <a
        class="button"
        href="/api/export">
        Download CSV
      </a>

      <button onclick="loadData()">
        Refresh
      </button>

    </div>

  </div>

</div>


<div class="footer">

  VAXGUARD PRO • Cloud Monitoring Platform

</div>


<script>

let historyData = [];


function setStatus(status) {

  const element =
    document.getElementById("status");

  element.textContent = status || "UNKNOWN";

}


async function loadData() {

  try {

    const response =
      await fetch("/api/latest");

    const data =
      await response.json();


    document.getElementById("device")
      .textContent =
      data.device || "VAXGUARD-01";


    document.getElementById("temperature")
      .textContent =
      data.temperature === null ||
      data.temperature === undefined
      ? "--"
      : Number(data.temperature).toFixed(1);


    document.getElementById("humidity")
      .textContent =
      data.humidity === null ||
      data.humidity === undefined
      ? "--"
      : Number(data.humidity).toFixed(1);


    document.getElementById("vibration")
      .textContent =
      Number(data.vibration || 0);


    document.getElementById("risk")
      .textContent =
      Number(data.risk || 0);


    document.getElementById("trend")
      .textContent =
      data.trend || "STABLE";


    document.getElementById("advisory")
      .textContent =
      data.advisory ||
      "Monitoring conditions normally.";


    document.getElementById("correlation")
      .textContent =
      data.correlation || "None";


    document.getElementById("wifi")
      .textContent =
      data.wifiRSSI === null ||
      data.wifiRSSI === undefined
      ? "--"
      : data.wifiRSSI + " dBm";


    document.getElementById("reconnects")
      .textContent =
      Number(data.reconnects || 0);


    document.getElementById("confidence")
      .textContent =
      Number(data.confidence ?? 100);


    document.getElementById("fault")
      .textContent =
      data.fault ? "YES" : "NO";


    setStatus(
      data.status || "OFFLINE"
    );


    if (data.updatedAt) {

      document.getElementById("lastUpdate")
        .textContent =
        "Last update: " +
        new Date(data.updatedAt)
          .toLocaleString();

    }


  } catch (error) {

    console.error(error);

  }

}


async function loadHistory() {

  try {

    const response =
      await fetch("/api/history");

    const data =
      await response.json();

    historyData =
      data.history || [];

    drawChart();

  } catch (error) {

    console.error(error);

  }

}


async function loadAlerts() {

  try {

    const response =
      await fetch("/api/alerts");

    const data =
      await response.json();

    const alerts =
      data.alerts || [];

    const container =
      document.getElementById("alerts");


    if (alerts.length === 0) {

      container.textContent =
        "No alerts yet.";

      return;

    }


    container.innerHTML = "";


    alerts.slice(0, 8)
      .forEach(alert => {

        const item =
          document.createElement("div");

        item.className = "alert";

        item.innerHTML =
          "<b>" +
          alert.status +
          "</b> — " +
          (alert.temperature ?? "--") +
          "°C — Vibration " +
          (alert.vibration ?? 0) +
          "<br><span class='small'>" +
          new Date(alert.time)
            .toLocaleString() +
          "</span>";

        container.appendChild(item);

      });


  } catch (error) {

    console.error(error);

  }

}


function drawChart() {

  const canvas =
    document.getElementById("chart");

  const ctx =
    canvas.getContext("2d");


  const width =
    canvas.width;

  const height =
    canvas.height;


  ctx.clearRect(
    0,
    0,
    width,
    height
  );


  // Background

  ctx.fillStyle =
    "#0f172a";

  ctx.fillRect(
    0,
    0,
    width,
    height
  );


  if (historyData.length < 2) {

    ctx.fillStyle =
      "#94a3b8";

    ctx.font =
      "16px Arial";

    ctx.fillText(
      "Waiting for temperature history...",
      30,
      40
    );

    return;

  }


  const values =
    historyData
      .map(x => Number(x.temperature))
      .filter(x => Number.isFinite(x));


  if (values.length < 2) return;


  const minTemp = 0;
  const maxTemp = 10;


  // Safe zone 2-8°C

  const safeTop =
    height -
    ((8 - minTemp) /
      (maxTemp - minTemp)) *
    height;

  const safeBottom =
    height -
    ((2 - minTemp) /
      (maxTemp - minTemp)) *
    height;


  ctx.fillStyle =
    "rgba(34,197,94,0.12)";

  ctx.fillRect(
    0,
    safeTop,
    width,
    safeBottom - safeTop
  );


  // Grid

  ctx.strokeStyle =
    "#334155";

  ctx.lineWidth = 1;


  for (let t = 0; t <= 10; t += 2) {

    const y =
      height -
      ((t - minTemp) /
        (maxTemp - minTemp)) *
      height;


    ctx.beginPath();

    ctx.moveTo(0, y);

    ctx.lineTo(width, y);

    ctx.stroke();


    ctx.fillStyle =
      "#64748b";

    ctx.font =
      "12px Arial";

    ctx.fillText(
      t + "°C",
      8,
      y - 5
    );

  }


  // Temperature line

  ctx.strokeStyle =
    "#38bdf8";

  ctx.lineWidth = 3;

  ctx.beginPath();


  values.forEach((temp, index) => {

    const x =
      (index /
        (values.length - 1)) *
      width;


    const y =
      height -
      ((temp - minTemp) /
        (maxTemp - minTemp)) *
      height;


    if (index === 0) {

      ctx.moveTo(x, y);

    } else {

      ctx.lineTo(x, y);

    }

  });


  ctx.stroke();


  // Latest point

  const last =
    values[values.length - 1];


  const lastX = width;

  const lastY =
    height -
    ((last - minTemp) /
      (maxTemp - minTemp)) *
    height;


  ctx.fillStyle =
    "#ffffff";

  ctx.beginPath();

  ctx.arc(
    lastX,
    lastY,
    5,
    0,
    Math.PI * 2
  );

  ctx.fill();

}


// ----------------------------------------------------------
// AUTO REFRESH
// ----------------------------------------------------------

loadData();
loadHistory();
loadAlerts();

setInterval(
  loadData,
  3000
);

setInterval(
  loadHistory,
  5000
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

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {

  res.json({
    status: "healthy",
    service: "VAXGUARD PRO",
    timestamp: new Date().toISOString()
  });

});

// ============================================================
// 404 HANDLER
// ============================================================

app.use((req, res) => {

  res.status(404).json({
    success: false,
    error: "Endpoint not found"
  });

});

// ============================================================
// ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {

  console.error("SERVER ERROR:", err);

  res.status(500).json({
    success: false,
    error: "Internal server error"
  });

});

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `VAXGUARD PRO Cloud Server running on port ${PORT}`
    );

  }
);
