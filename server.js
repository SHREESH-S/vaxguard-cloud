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
