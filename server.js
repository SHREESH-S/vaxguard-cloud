const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Change this before deploying online
const API_KEY = "process.env.API_KEY";

app.use(express.json());

let latestData = {
  device: "VAXGUARD-01",
  status: "OFFLINE",
  temperature: null,
  humidity: null,
  vibration: 0,
  risk: 0,
  updatedAt: null
};

// --------------------------------------------------
// HOME
// --------------------------------------------------
app.get("/", (req, res) => {
  res.send(`
    <h1>VAXGUARD Cloud Server</h1>
    <p>Server is running successfully.</p>
    <p>Device: ${latestData.device}</p>
    <p>Status: ${latestData.status}</p>
  `);
});

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "VAXGUARD Cloud",
    time: new Date().toISOString()
  });
});

// --------------------------------------------------
// ESP32 SENDS DATA HERE
// --------------------------------------------------
app.post("/api/ingest", (req, res) => {

  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  latestData = {
    ...latestData,
    ...req.body,
    updatedAt: new Date().toISOString()
  };

  console.log("VAXGUARD DATA RECEIVED:");
  console.log(latestData);

  res.json({
    success: true,
    message: "Data received",
    updatedAt: latestData.updatedAt
  });
});

// --------------------------------------------------
// WEBSITE GETS LATEST DATA
// --------------------------------------------------
app.get("/api/latest", (req, res) => {
  res.json(latestData);
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------
app.listen(PORT, () => {
  console.log(`VAXGUARD Cloud Server running on port ${PORT}`);
});
