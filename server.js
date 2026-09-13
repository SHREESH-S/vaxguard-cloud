/*
  VaxGuard backend - COMPLETE VERSION
  -----------------------------------
  Responsibilities:
    - Receive sensor packets from ESP32 (/api/ingest)
    - Receive ESP32 heartbeats (/api/heartbeat)
    - Support LIVE and DEMO modes
    - Run explainable risk engine
    - Run temperature trend + early warning engine
    - Track vibration events
    - Track sensor/device health
    - Persist readings/events/settings to JSON
    - Push live updates through Socket.IO
    - Maintain audit history
    - Send Telegram alerts when configured
    - Request automatic emergency calls for CRITICAL/DANGEROUS states
    - Provide manual emergency call endpoint
    - Provide CSV/JSON exports
    - Provide self-test and reports
    - Never fake successful Telegram/call delivery
*/

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// ============================================================================
// BASIC AUTHENTICATION
// ============================================================================

const AUTH_ENABLED = !!(
  process.env.DASHBOARD_USERNAME &&
  process.env.DASHBOARD_PASSWORD &&
  process.env.DASHBOARD_PASSWORD !== 'change-me'
);

function basicAuth(req, res, next) {
  if (!AUTH_ENABLED) {
    return next();
  }

  const header = req.headers.authorization || '';

  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="VaxGuard"');
    return res.status(401).send('Authentication required.');
  }

  try {
    const token = header.split(' ')[1] || '';
    const decoded = Buffer.from(token, 'base64').toString();
    const separator = decoded.indexOf(':');

    if (separator === -1) {
      throw new Error('Invalid authorization header');
    }

    const user = decoded.slice(0, separator);
    const pass = decoded.slice(separator + 1);

    if (
      user === process.env.DASHBOARD_USERNAME &&
      pass === process.env.DASHBOARD_PASSWORD
    ) {
      return next();
    }
  } catch (error) {
    console.error('[AUTH] Authentication error:', error.message);
  }

  res.set('WWW-Authenticate', 'Basic realm="VaxGuard"');
  return res.status(401).send('Authentication required.');
}

app.use(basicAuth);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// DATABASE
// ============================================================================

const DEFAULT_DB = {
  settings: {
    tempMin: 2.0,
    tempMax: 8.0,
    warnMargin: 1.0,

    vibrationSensitivity: 'normal',

    alertCooldownSec: 60,

    voiceAlertsEnabled: true,
    telegramEnabled: true,

    deviceName: 'VaxGuard-01',
    deviceId: 'VaxGuard-01',

    retentionDays: 30
  },

  readings: [],
  events: [],
  vibrationEvents: [],

  devices: {},

  ackState: {}
};

const MAX_READINGS = 5000;
const MAX_EVENTS = 5000;
const MAX_VIBRATION_EVENTS = 1000;

function createDefaultDb() {
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}

function loadDb() {
  try {
    const dataDirectory = path.dirname(DB_FILE);

    if (!fs.existsSync(dataDirectory)) {
      fs.mkdirSync(dataDirectory, {
        recursive: true
      });
    }

    if (!fs.existsSync(DB_FILE)) {
      const freshDb = createDefaultDb();

      fs.writeFileSync(
        DB_FILE,
        JSON.stringify(freshDb, null, 2)
      );

      return freshDb;
    }

    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const saved = JSON.parse(raw);

    const fresh = createDefaultDb();

    return {
      ...fresh,
      ...saved,

      settings: {
        ...fresh.settings,
        ...(saved.settings || {})
      },

      readings: Array.isArray(saved.readings)
        ? saved.readings
        : [],

      events: Array.isArray(saved.events)
        ? saved.events
        : [],

      vibrationEvents: Array.isArray(saved.vibrationEvents)
        ? saved.vibrationEvents
        : [],

      devices: saved.devices || {},
      ackState: saved.ackState || {}
    };
  } catch (error) {
    console.error(
      '[DB] Failed to load database:',
      error.message
    );

    return createDefaultDb();
  }
}

let db = loadDb();

let saveTimer = null;

function saveDb() {
  clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    fs.writeFile(
      DB_FILE,
      JSON.stringify(db, null, 2),
      error => {
        if (error) {
          console.error(
            '[DB] Save failed:',
            error.message
          );
        }
      }
    );
  }, 500);
}

// ============================================================================
// RUNTIME STATE
// ============================================================================

const runtime = {
  mode: 'LIVE',

  temperature: null,
  humidity: null,

  vibration: false,
  previousVibration: false,

  vibrationEventCount: 0,

  sensorValid: false,

  state: 'OFFLINE',

  lastUpdate: null,

  connected: false,

  tempHistory: [],

  consecutiveAbnormal: 0,

  timeOutsideRangeMs: 0,

  lastAbnormalEnter: null,

  lastAlertState: null,
  lastAlertTime: 0,

  recentVibrationTimestamps: [],

  lastCallStatus: 'idle',
  lastCallTime: null,
  lastCallReason: null
};

const OFFLINE_TIMEOUT_MS = 15000;

// Automatic emergency call cooldown.
// This prevents repeated calls during a continuing dangerous condition.
const EMERGENCY_CALL_COOLDOWN_MS = 10 * 60 * 1000;

let lastEmergencyCallTime = 0;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function getCurrentTemperatureState() {
  return runtime.state;
}

function cleanupRuntimeHistory() {
  const now = Date.now();

  runtime.recentVibrationTimestamps =
    runtime.recentVibrationTimestamps.filter(
      timestamp =>
        now - timestamp < 15 * 60 * 1000
    );
}

// ============================================================================
// TEMPERATURE TREND ENGINE
// ============================================================================

function computeTrend() {
  const history = runtime.tempHistory.slice(-6);

  if (history.length < 3) {
    return 'insufficient data';
  }

  const first = history[0].temp;
  const last = history[history.length - 1].temp;

  const difference = last - first;

  if (difference > 0.3) {
    return 'increasing';
  }

  if (difference < -0.3) {
    return 'decreasing';
  }

  return 'stable';
}

// ============================================================================
// RISK ENGINE
// ============================================================================

function computeRisk() {
  const reasons = [];
  let score = 0;

  // Sensor failure is treated as critical because the condition cannot
  // currently be trusted.
  if (!runtime.sensorValid) {
    return {
      score: 100,
      category: 'CRITICAL',
      reasons: [
        'Sensor fault - risk cannot be trusted, treat as critical'
      ]
    };
  }

  const tempMin = Number(db.settings.tempMin);
  const tempMax = Number(db.settings.tempMax);
  const warnMargin = Number(db.settings.warnMargin);

  const temperature = runtime.temperature;

  // --------------------------------------------------------------------------
  // TEMPERATURE DEVIATION
  // --------------------------------------------------------------------------

  if (isNumber(temperature)) {
    let deviation = 0;

    if (temperature < tempMin) {
      deviation = tempMin - temperature;
    } else if (temperature > tempMax) {
      deviation = temperature - tempMax;
    }

    if (deviation > 0) {
      const points = Math.min(
        35,
        Math.round(deviation * 10)
      );

      score += points;

      reasons.push(
        `+${points} temperature deviation (${deviation.toFixed(1)}C outside range)`
      );
    }
  }

  // --------------------------------------------------------------------------
  // TEMPERATURE TREND
  // --------------------------------------------------------------------------

  const trend = computeTrend();

  if (
    trend === 'increasing' &&
    isNumber(temperature) &&
    temperature > tempMax - warnMargin
  ) {
    score += 18;

    reasons.push(
      '+18 increasing temperature trend near/above upper threshold'
    );
  }

  if (
    trend === 'decreasing' &&
    isNumber(temperature) &&
    temperature < tempMin + warnMargin
  ) {
    score += 18;

    reasons.push(
      '+18 decreasing temperature trend near/below lower threshold'
    );
  }

  // --------------------------------------------------------------------------
  // TIME OUTSIDE RANGE
  // --------------------------------------------------------------------------

  if (runtime.timeOutsideRangeMs > 0) {
    const minutes =
      runtime.timeOutsideRangeMs / 60000;

    const points = Math.min(
      20,
      Math.round(minutes * 4)
    );

    if (points > 0) {
      score += points;

      reasons.push(
        `+${points} prolonged excursion (${minutes.toFixed(1)} min outside range)`
      );
    }
  }

  // --------------------------------------------------------------------------
  // VIBRATION FREQUENCY
  // --------------------------------------------------------------------------

  cleanupRuntimeHistory();

  const recentVibration =
    runtime.recentVibrationTimestamps.filter(
      timestamp =>
        Date.now() - timestamp < 5 * 60 * 1000
    );

  if (recentVibration.length > 0) {
    const points = Math.min(
      15,
      recentVibration.length * 4
    );

    score += points;

    reasons.push(
      `+${points} repeated vibration (${recentVibration.length} events in last 5 min)`
    );
  }

  // --------------------------------------------------------------------------
  // CONSECUTIVE ABNORMAL READINGS
  // --------------------------------------------------------------------------

  if (runtime.consecutiveAbnormal >= 3) {
    const points = Math.min(
      10,
      runtime.consecutiveAbnormal
    );

    score += points;

    reasons.push(
      `+${points} recent abnormal events (${runtime.consecutiveAbnormal} consecutive)`
    );
  }

  // --------------------------------------------------------------------------
  // CONNECTIVITY
  // --------------------------------------------------------------------------

  if (!runtime.connected) {
    score += 10;

    reasons.push(
      '+10 device connectivity lost'
    );
  }

  // --------------------------------------------------------------------------
  // FINAL CATEGORY
  // --------------------------------------------------------------------------

  score = Math.max(
    0,
    Math.min(100, score)
  );

  let category = 'SAFE';

  if (score > 80) {
    category = 'CRITICAL';
  } else if (score > 60) {
    category = 'HIGH RISK';
  } else if (score > 40) {
    category = 'MODERATE RISK';
  } else if (score > 20) {
    category = 'LOW RISK';
  }

  return {
    score,
    category,
    reasons
  };
}

// ============================================================================
// CONDITION ADVISORY
// ============================================================================

function computeConditionAdvisory() {
  if (!runtime.sensorValid) {
    return {
      label: 'INSUFFICIENT DATA',

      reason:
        'Sensor fault - cold-chain condition cannot be assessed right now.'
    };
  }

  const risk = computeRisk();

  if (risk.score <= 20) {
    return {
      label: 'GOOD',

      reason:
        'Temperature has remained within the configured range for the monitored period.'
    };
  }

  if (risk.score <= 40) {
    return {
      label: 'WATCH',

      reason:
        'Minor deviation or trend detected. Continue monitoring.'
    };
  }

  if (risk.score <= 70) {
    return {
      label: 'AT RISK',

      reason:
        'Repeated excursions or a sustained adverse trend detected. Inspect cold-chain conditions.'
    };
  }

  return {
    label: 'CRITICAL',

    reason:
      'Significant excursion detected. Inspect cold-chain conditions and follow approved vaccine handling procedures.'
  };
}

// ============================================================================
// EARLY WARNING ENGINE
// ============================================================================

function earlyWarning() {
  const trend = computeTrend();

  const tempMax = Number(db.settings.tempMax);
  const tempMin = Number(db.settings.tempMin);
  const warnMargin = Number(db.settings.warnMargin);

  const temperature = runtime.temperature;

  if (!isNumber(temperature)) {
    return null;
  }

  if (
    trend === 'increasing' &&
    temperature < tempMax &&
    temperature > tempMax - warnMargin * 2
  ) {
    return {
      level: 'EARLY WARNING',

      message:
        'Temperature trending upward',

      detail:
        'Potential threshold crossing predicted.',

      action:
        'Recommended action: inspect cooling conditions.'
    };
  }

  if (
    trend === 'decreasing' &&
    temperature > tempMin &&
    temperature < tempMin + warnMargin * 2
  ) {
    return {
      level: 'EARLY WARNING',

      message:
        'Temperature trending downward',

      detail:
        'Potential low-temperature risk.',

      action:
        'Recommended action: inspect cooling conditions.'
    };
  }

  return null;
}

// ============================================================================
// AUDIT EVENT LOGGER
// ============================================================================

function logEvent(type, severity, extra = {}) {
  const event = {
    id:
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,

    timestamp:
      new Date().toISOString(),

    type,

    severity,

    temperature:
      runtime.temperature,

    humidity:
      runtime.humidity,

    vibration:
      runtime.vibration,

    riskScore:
      extra.riskScore ?? null,

    mode:
      runtime.mode,

    deviceId:
      db.settings.deviceId,

    action:
      extra.action || null,

    alertStatus:
      extra.alertStatus || 'logged',

    acknowledged:
      false,

    ...extra
  };

  db.events.push(event);

  if (db.events.length > MAX_EVENTS) {
    db.events.shift();
  }

  saveDb();

  io.emit('event', event);

  return event;
}

// ============================================================================
// VOICE ALERT TEXT
// ============================================================================

function buildVoiceAlertText(state, risk) {
  const scoreText =
    risk && isNumber(risk.score)
      ? ` Risk score ${risk.score} out of 100.`
      : '';

  const map = {
    WARNING:
      'Warning. Condition is outside the configured safe range.',

    CRITICAL:
      'Critical condition detected.',

    DANGEROUS:
      'Dangerous condition detected. Immediate attention is required.',

    'SENSOR FAULT':
      'Sensor fault detected. Sensor data cannot be trusted.',

    HIGH:
      'Warning. Temperature is outside the configured safe range.',

    LOW:
      'Warning. Temperature is outside the configured safe range.',

    OFFLINE:
      'Warning. VaxGuard device connection has been lost.'
  };

  return (
    (map[state] ||
      `Condition changed to ${state}.`) +
    scoreText
  );
}

// ============================================================================
// TELEGRAM
// ============================================================================

async function sendTelegramAlert(event, risk) {
  if (!db.settings.telegramEnabled) {
    console.log(
      '[Telegram] Disabled in VaxGuard settings.'
    );

    return {
      ok: false,
      status: 'disabled'
    };
  }

  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  const chatId =
    process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log(
      '[Telegram] Not configured - skipping alert.'
    );

    return {
      ok: false,
      status: 'not_configured'
    };
  }

  const text =
    `${event.severity} EVENT\n\n` +
    `Device: ${event.deviceId}\n` +
    `Temperature: ${event.temperature ?? 'N/A'}C\n` +
    `Humidity: ${event.humidity ?? 'N/A'}%\n` +
    `Risk: ${risk.score}/100\n` +
    `Type: ${event.type}\n` +
    `Mode: ${event.mode}\n` +
    `Time: ${event.timestamp}`;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          chat_id: chatId,
          text
        })
      }
    );

    const data =
      await response.json();

    if (!data.ok) {
      console.error(
        '[Telegram] Send failed:',
        data.description
      );

      return {
        ok: false,
        status: 'failed',
        message: data.description
      };
    }

    console.log(
      '[Telegram] Alert successfully accepted by Telegram.'
    );

    return {
      ok: true,
      status: 'sent'
    };
  } catch (error) {
    console.error(
      '[Telegram] Request error:',
      error.message
    );

    return {
      ok: false,
      status: 'failed',
      message: error.message
    };
  }
}

// ============================================================================
// AUTOMATIC EMERGENCY CALL SYSTEM
// ============================================================================

async function triggerEmergencyCall(reason, risk) {
  const webhook =
    process.env.CALL_PROVIDER_WEBHOOK_URL;

  const contact =
    process.env.EMERGENCY_CONTACT_NUMBER;

  // --------------------------------------------------------------------------
  // NOT CONFIGURED
  // --------------------------------------------------------------------------

  if (!webhook || !contact) {
    console.log(
      '[CALL] Not configured - no phone call placed.'
    );

    runtime.lastCallStatus =
      'not_configured';

    runtime.lastCallReason =
      reason;

    io.emit('callStatus', {
      status: 'not_configured',

      message:
        'Emergency calling provider is not configured.',

      reason
    });

    logEvent(
      'Emergency call not configured',
      'CRITICAL',
      {
        riskScore:
          risk?.score ?? null,

        alertStatus:
          'not_configured',

        action:
          'automatic_call_skipped',

        callReason:
          reason
      }
    );

    return {
      ok: false,
      status: 'not_configured'
    };
  }

  // --------------------------------------------------------------------------
  // COOLDOWN
  // --------------------------------------------------------------------------

  const now = Date.now();

  if (
    now - lastEmergencyCallTime <
    EMERGENCY_CALL_COOLDOWN_MS
  ) {
    const remainingSeconds =
      Math.ceil(
        (
          EMERGENCY_CALL_COOLDOWN_MS -
          (now - lastEmergencyCallTime)
        ) / 1000
      );

    console.log(
      `[CALL] Cooldown active. ${remainingSeconds}s remaining.`
    );

    runtime.lastCallStatus =
      'cooldown';

    io.emit('callStatus', {
      status: 'cooldown',

      message:
        `Emergency call cooldown active. ${remainingSeconds}s remaining.`,

      remainingSeconds,

      reason
    });

    return {
      ok: false,

      status: 'cooldown',

      remainingSeconds
    };
  }

  // Reserve the cooldown BEFORE making the request.
  lastEmergencyCallTime = now;

  runtime.lastCallTime =
    new Date(now).toISOString();

  runtime.lastCallReason =
    reason;

  console.log(
    `[CALL] Requesting emergency call to ${contact}`
  );

  try {
    const response =
      await fetch(
        webhook,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json'
          },

          body: JSON.stringify({
            to: contact,

            message:
              `VaxGuard emergency alert. ` +
              `Condition: ${reason}. ` +
              `Risk score: ${
                risk?.score ?? 'unknown'
              } out of 100.`,

            deviceId:
              db.settings.deviceId,

            deviceName:
              db.settings.deviceName,

            condition:
              runtime.state,

            temperature:
              runtime.temperature,

            humidity:
              runtime.humidity,

            mode:
              runtime.mode,

            riskScore:
              risk?.score ?? null,

            timestamp:
              new Date().toISOString()
          })
        }
      );

    // ------------------------------------------------------------------------
    // PROVIDER ACCEPTED REQUEST
    // ------------------------------------------------------------------------

    if (response.ok) {
      runtime.lastCallStatus =
        'requested';

      console.log(
        '[CALL] Provider accepted the call request.'
      );

      logEvent(
        'Emergency call requested',
        'CRITICAL',
        {
          riskScore:
            risk?.score ?? null,

          alertStatus:
            'requested',

          action:
            'automatic_call_requested',

          callReason:
            reason
        }
      );

      io.emit('callStatus', {
        status: 'requested',

        message:
          'Emergency call request accepted by calling provider.',

        reason,

        contact
      });

      return {
        ok: true,
        status: 'requested'
      };
    }

    // ------------------------------------------------------------------------
    // PROVIDER REJECTED REQUEST
    // ------------------------------------------------------------------------

    runtime.lastCallStatus =
      'failed';

    console.error(
      `[CALL] Provider rejected request. HTTP ${response.status}`
    );

    logEvent(
      'Emergency call failed',
      'CRITICAL',
      {
        riskScore:
          risk?.score ?? null,

        alertStatus:
          'failed',

        action:
          'automatic_call_failed',

        callReason:
          reason,

        httpStatus:
          response.status
      }
    );

    io.emit('callStatus', {
      status: 'failed',

      message:
        `Calling provider rejected the request (HTTP ${response.status}).`,

      reason
    });

    return {
      ok: false,
      status: 'failed',
      httpStatus: response.status
    };
  } catch (error) {
    runtime.lastCallStatus =
      'failed';

    console.error(
      '[CALL] Provider request failed:',
      error.message
    );

    logEvent(
      'Emergency call failed',
      'CRITICAL',
      {
        riskScore:
          risk?.score ?? null,

        alertStatus:
          'failed',

        action:
          'automatic_call_failed',

        callReason:
          reason,

        error:
          error.message
      }
    );

    io.emit('callStatus', {
      status: 'failed',

      message:
        `Calling provider request failed: ${error.message}`,

      reason
    });

    return {
      ok: false,

      status: 'failed',

      error:
        error.message
    };
  }
}

// ============================================================================
// ALERT ENGINE
// ============================================================================

function maybeAlert(currentState, risk) {
  const now = Date.now();

  const cooldownMs =
    (Number(db.settings.alertCooldownSec) || 60) *
    1000;

  // Same state = do not repeatedly alert.
  if (
    currentState === runtime.lastAlertState
  ) {
    return null;
  }

  // Critical, dangerous and sensor-fault transitions bypass
  // the normal cooldown.
  const bypassCooldown =
    currentState === 'CRITICAL' ||
    currentState === 'DANGEROUS' ||
    currentState === 'SENSOR FAULT';

  if (
    now - runtime.lastAlertTime <
      cooldownMs &&
    !bypassCooldown
  ) {
    return null;
  }

  runtime.lastAlertState =
    currentState;

  runtime.lastAlertTime =
    now;

  const severityMap = {
    NORMAL: 'INFO',

    LOW: 'WARNING',

    HIGH: 'WARNING',

    WARNING: 'WARNING',

    CRITICAL: 'CRITICAL',

    DANGEROUS: 'DANGEROUS',

    'SENSOR FAULT': 'HIGH',

    OFFLINE: 'HIGH'
  };

  const severity =
    severityMap[currentState] ||
    'INFO';

  // Do NOT claim "sent" here.
  // Telegram and calling happen separately.
  const event = logEvent(
    currentState === 'NORMAL'
      ? 'Temperature recovery'
      : `${currentState} condition`,

    severity,

    {
      riskScore:
        risk.score,

      alertStatus:
        'logged'
    }
  );

  if (severity !== 'INFO') {
    // Telegram is asynchronous.
    sendTelegramAlert(
      event,
      risk
    ).then(result => {
      io.emit('telegramStatus', {
        status:
          result.status,

        eventId:
          event.id
      });
    });

    // Browser voice alert.
    if (
      db.settings.voiceAlertsEnabled
    ) {
      io.emit(
        'voiceAlert',
        buildVoiceAlertText(
          currentState,
          risk
        )
      );
    }

    // Automatic emergency calling.
    if (
      currentState === 'CRITICAL' ||
      currentState === 'DANGEROUS'
    ) {
      triggerEmergencyCall(
        currentState,
        risk
      );
    }
  }

  return event;
}

// ============================================================================
// ESP32 INGEST
// ============================================================================

app.post('/api/ingest', (req, res) => {
  try {
    const body =
      req.body || {};

    const now =
      Date.now();

    // ------------------------------------------------------------------------
    // DEVICE CONNECTION
    // ------------------------------------------------------------------------

    runtime.connected =
      true;

    runtime.lastUpdate =
      now;

    runtime.mode =
      body.mode === 'DEMO'
        ? 'DEMO'
        : 'LIVE';

    // ------------------------------------------------------------------------
    // SENSOR VALIDITY
    // ------------------------------------------------------------------------

    runtime.sensorValid =
      !!body.sensorValid;

    // ------------------------------------------------------------------------
    // VIBRATION
    // ------------------------------------------------------------------------

    const newVibration =
      !!body.vibration;

    runtime.previousVibration =
      runtime.vibration;

    runtime.vibration =
      newVibration;

    if (
      isNumber(
        body.vibrationEventCount
      )
    ) {
      runtime.vibrationEventCount =
        body.vibrationEventCount;
    }

    // ------------------------------------------------------------------------
    // TEMPERATURE
    // ------------------------------------------------------------------------

    if (
      isNumber(
        body.temperature
      )
    ) {
      runtime.temperature =
        body.temperature;

      runtime.tempHistory.push({
        ts: now,

        temp:
          body.temperature
      });

      if (
        runtime.tempHistory.length >
        200
      ) {
        runtime.tempHistory.shift();
      }
    }

    // ------------------------------------------------------------------------
    // HUMIDITY
    // ------------------------------------------------------------------------

    if (
      isNumber(
        body.humidity
      )
    ) {
      runtime.humidity =
        body.humidity;
    }

    // ------------------------------------------------------------------------
    // STATE
    // ------------------------------------------------------------------------

    const state =
      typeof body.state === 'string' &&
      body.state.trim()
        ? body.state.trim().toUpperCase()
        : 'NORMAL';

    runtime.state =
      state;

    // ------------------------------------------------------------------------
    // ABNORMAL CONDITION TRACKING
    // ------------------------------------------------------------------------

    const abnormal =
      state !== 'NORMAL';

    if (abnormal) {
      runtime.consecutiveAbnormal++;

      if (
        !runtime.lastAbnormalEnter
      ) {
        runtime.lastAbnormalEnter =
          now;
      }

      runtime.timeOutsideRangeMs =
        now -
        runtime.lastAbnormalEnter;
    } else {
      runtime.consecutiveAbnormal =
        0;

      runtime.lastAbnormalEnter =
        null;

      runtime.timeOutsideRangeMs =
        0;
    }

    // ------------------------------------------------------------------------
    // NEW VIBRATION EVENT
    // ------------------------------------------------------------------------

    const vibrationStarted =
      runtime.vibration === true &&
      runtime.previousVibration === false;

    if (vibrationStarted) {
      runtime.recentVibrationTimestamps.push(
        now
      );

      cleanupRuntimeHistory();

      db.vibrationEvents.push({
        ts:
          new Date(now).toISOString(),

        temperature:
          runtime.temperature,

        humidity:
          runtime.humidity,

        mode:
          runtime.mode,

        deviceId:
          db.settings.deviceId
      });

      if (
        db.vibrationEvents.length >
        MAX_VIBRATION_EVENTS
      ) {
        db.vibrationEvents.shift();
      }

      logEvent(
        'Vibration event',
        'WARNING',
        {
          alertStatus:
            'logged',

          action:
            'vibration_detected'
        }
      );

      saveDb();
    }

    // ------------------------------------------------------------------------
    // PERSIST SENSOR READING
    // ------------------------------------------------------------------------

    db.readings.push({
      ts:
        new Date(now).toISOString(),

      temperature:
        runtime.temperature,

      humidity:
        runtime.humidity,

      vibration:
        runtime.vibration,

      state,

      mode:
        runtime.mode,

      deviceId:
        db.settings.deviceId
    });

    if (
      db.readings.length >
      MAX_READINGS
    ) {
      db.readings.shift();
    }

    saveDb();

    // ------------------------------------------------------------------------
    // INTELLIGENCE ENGINES
    // ------------------------------------------------------------------------

    const risk =
      computeRisk();

    const condition =
      computeConditionAdvisory();

    const warning =
      earlyWarning();

    // ------------------------------------------------------------------------
    // ALERT ENGINE
    // ------------------------------------------------------------------------

    maybeAlert(
      state,
      risk
    );

    // ------------------------------------------------------------------------
    // DASHBOARD UPDATE
    // ------------------------------------------------------------------------

    broadcastState(
      risk,
      condition,
      warning
    );

    res.json({
      ok: true,

      state,

      mode:
        runtime.mode,

      risk
    });
  } catch (error) {
    console.error(
      '[INGEST] Error:',
      error.message
    );

    res.status(500).json({
      ok: false,

      error:
        error.message
    });
  }
});

// ============================================================================
// ESP32 HEARTBEAT
// ============================================================================

app.post('/api/heartbeat', (req, res) => {
  try {
    const body =
      req.body || {};

    const deviceId =
      body.deviceId ||
      db.settings.deviceId;

    const uptimeMs =
      body.uptimeMs ?? null;

    const now =
      Date.now();

    db.devices[deviceId] = {
      lastHeartbeat:
        new Date(now).toISOString(),

      lastSeen:
        new Date(now).toISOString(),

      uptimeMs,

      ip:
        req.ip
    };

    saveDb();

    io.emit(
      'heartbeat',
      db.devices
    );

    res.json({
      ok: true
    });
  } catch (error) {
    res.status(500).json({
      ok: false,

      error:
        error.message
    });
  }
});

// ============================================================================
// CONNECTIVITY WATCHDOG
// ============================================================================

setInterval(() => {
  if (
    runtime.lastUpdate &&
    Date.now() -
      runtime.lastUpdate >
      OFFLINE_TIMEOUT_MS
  ) {
    if (runtime.connected) {
      runtime.connected =
        false;

      runtime.state =
        'OFFLINE';

      logEvent(
        'Device offline',
        'HIGH',
        {
          alertStatus:
            'logged',

          action:
            'connectivity_lost'
        }
      );

      const risk =
        computeRisk();

      broadcastState(
        risk,

        computeConditionAdvisory(),

        null
      );

      io.emit(
        'voiceAlert',
        'Warning. VaxGuard device connection has been lost.'
      );
    }
  }
}, 3000);

// ============================================================================
// BROADCAST STATE
// ============================================================================

function broadcastState(
  risk,
  condition,
  warning
) {
  io.emit(
    'state',
    {
      mode:
        runtime.mode,

      temperature:
        runtime.temperature,

      humidity:
        runtime.humidity,

      vibration:
        runtime.vibration,

      vibrationEventCount:
        runtime.vibrationEventCount,

      sensorValid:
        runtime.sensorValid,

      state:
        runtime.state,

      connected:
        runtime.connected,

      lastUpdate:
        runtime.lastUpdate,

      trend:
        computeTrend(),

      risk,

      condition,

      earlyWarning:
        warning,

      deviceId:
        db.settings.deviceId,

      settings:
        db.settings,

      callStatus:
        runtime.lastCallStatus,

      lastCallTime:
        runtime.lastCallTime,

      lastCallReason:
        runtime.lastCallReason
    }
  );
}

// ============================================================================
// GET CURRENT STATE
// ============================================================================

app.get('/api/state', (req, res) => {
  const risk =
    computeRisk();

  res.json({
    mode:
      runtime.mode,

    temperature:
      runtime.temperature,

    humidity:
      runtime.humidity,

    vibration:
      runtime.vibration,

    vibrationEventCount:
      runtime.vibrationEventCount,

    sensorValid:
      runtime.sensorValid,

    state:
      runtime.state,

    connected:
      runtime.connected,

    lastUpdate:
      runtime.lastUpdate,

    trend:
      computeTrend(),

    risk,

    condition:
      computeConditionAdvisory(),

    earlyWarning:
      earlyWarning(),

    deviceId:
      db.settings.deviceId,

    settings:
      db.settings,

    devices:
      db.devices,

    callStatus:
      runtime.lastCallStatus,

    lastCallTime:
      runtime.lastCallTime,

    lastCallReason:
      runtime.lastCallReason
  });
});

// ============================================================================
// HISTORY
// ============================================================================

app.get('/api/history', (req, res) => {
  const {
    severity,
    mode,
    from,
    to,
    ackStatus,
    limit
  } = req.query;

  let events =
    db.events.slice();

  if (severity) {
    events =
      events.filter(
        event =>
          event.severity === severity
      );
  }

  if (mode) {
    events =
      events.filter(
        event =>
          event.mode === mode
      );
  }

  if (from) {
    const fromDate =
      new Date(from);

    events =
      events.filter(
        event =>
          new Date(event.timestamp) >=
          fromDate
      );
  }

  if (to) {
    const toDate =
      new Date(to);

    events =
      events.filter(
        event =>
          new Date(event.timestamp) <=
          toDate
      );
  }

  if (
    ackStatus ===
    'acknowledged'
  ) {
    events =
      events.filter(
        event =>
          event.acknowledged
      );
  }

  if (
    ackStatus ===
    'unacknowledged'
  ) {
    events =
      events.filter(
        event =>
          !event.acknowledged
      );
  }

  const requestedLimit =
    parseInt(limit, 10);

  const finalLimit =
    Number.isFinite(
      requestedLimit
    )
      ? Math.min(
          Math.max(
            requestedLimit,
            1
          ),
          5000
        )
      : 500;

  events =
    events
      .slice(-finalLimit)
      .reverse();

  res.json(events);
});

// ============================================================================
// READINGS
// ============================================================================

app.get('/api/readings', (req, res) => {
  const hours =
    parseFloat(req.query.hours) || 24;

  const safeHours =
    Math.max(
      0.01,
      Math.min(hours, 720)
    );

  const cutoff =
    Date.now() -
    safeHours * 3600000;

  const readings =
    db.readings.filter(
      reading =>
        new Date(reading.ts)
          .getTime() >= cutoff
    );

  res.json(readings);
});

// ============================================================================
// VIBRATION EVENTS
// ============================================================================

app.get(
  '/api/vibration-events',
  (req, res) => {
    res.json(
      db.vibrationEvents
        .slice(-500)
        .reverse()
    );
  }
);

// ============================================================================
// ALERT ACTIONS
// ============================================================================

app.post(
  '/api/alerts/:id/:action',
  (req, res) => {
    const {
      id,
      action
    } = req.params;

    const event =
      db.events.find(
        item =>
          item.id === id
      );

    if (!event) {
      return res.status(404).json({
        ok: false,

        error:
          'Event not found'
      });
    }

    if (
      action ===
      'acknowledge'
    ) {
      event.acknowledged =
        true;

      event.userAction =
        'acknowledged';

      db.ackState[id] = {
        acknowledged:
          true,

        timestamp:
          new Date().toISOString()
      };
    } else if (
      action === 'mute'
    ) {
      event.userAction =
        'muted';

      db.ackState[id] = {
        ...(db.ackState[id] || {}),

        muted:
          true,

        timestamp:
          new Date().toISOString()
      };
    } else if (
      action === 'escalate'
    ) {
      event.userAction =
        'escalated';

      db.ackState[id] = {
        ...(db.ackState[id] || {}),

        escalated:
          true,

        timestamp:
          new Date().toISOString()
      };
    } else {
      return res.status(400).json({
        ok: false,

        error:
          'Unknown action'
      });
    }

    saveDb();

    io.emit(
      'eventUpdated',
      event
    );

    res.json({
      ok: true,

      event
    });
  }
);

// ============================================================================
// SETTINGS
// ============================================================================

app.get(
  '/api/settings',
  (req, res) => {
    res.json(
      db.settings
    );
  }
);

app.post(
  '/api/settings',
  (req, res) => {
    const incoming =
      req.body || {};

    // Temperature validation.
    if (
      typeof incoming.tempMin ===
        'number' &&
      typeof incoming.tempMax ===
        'number' &&
      incoming.tempMin >=
        incoming.tempMax
    ) {
      return res.status(400).json({
        ok: false,

        error:
          'tempMin must be less than tempMax'
      });
    }

    // Cooldown validation.
    if (
      incoming.alertCooldownSec !==
        undefined &&
      (
        typeof incoming.alertCooldownSec !==
          'number' ||
        incoming.alertCooldownSec < 0
      )
    ) {
      return res.status(400).json({
        ok: false,

        error:
          'alertCooldownSec must be a non-negative number'
      });
    }

    db.settings = {
      ...db.settings,
      ...incoming
    };

    saveDb();

    logEvent(
      'Settings changed',
      'INFO',
      {
        alertStatus:
          'logged',

        action:
          'settings_updated'
      }
    );

    io.emit(
      'settingsUpdated',
      db.settings
    );

    res.json({
      ok: true,

      settings:
        db.settings
    });
  }
);

// ============================================================================
// CSV EXPORT
// ============================================================================

function csvEscape(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  const text =
    String(value);

  if (
    text.includes(',') ||
    text.includes('"') ||
    text.includes('\n')
  ) {
    return `"${text.replace(
      /"/g,
      '""'
    )}"`;
  }

  return text;
}

app.get(
  '/api/export/csv',
  (req, res) => {
    const rows = [
      [
        'timestamp',
        'temperature',
        'humidity',
        'vibration',
        'state',
        'mode',
        'deviceId'
      ]
        .map(csvEscape)
        .join(',')
    ];

    db.readings.forEach(
      reading => {
        rows.push(
          [
            reading.ts,
            reading.temperature,
            reading.humidity,
            reading.vibration,
            reading.state,
            reading.mode,
            reading.deviceId
          ]
            .map(csvEscape)
            .join(',')
        );
      }
    );

    res.setHeader(
      'Content-Type',
      'text/csv'
    );

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="vaxguard_readings.csv"'
    );

    res.send(
      rows.join('\n')
    );
  }
);

// ============================================================================
// JSON EXPORT
// ============================================================================

app.get(
  '/api/export/json',
  (req, res) => {
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="vaxguard_export.json"'
    );

    res.json({
      exportedAt:
        new Date().toISOString(),

      settings:
        db.settings,

      readings:
        db.readings,

      events:
        db.events,

      vibrationEvents:
        db.vibrationEvents
    });
  }
);

// ============================================================================
// AUDIT CSV
// ============================================================================

app.get(
  '/api/export/audit-csv',
  (req, res) => {
    const rows = [
      [
        'timestamp',
        'eventId',
        'type',
        'severity',
        'temperature',
        'humidity',
        'vibration',
        'riskScore',
        'mode',
        'deviceId',
        'action',
        'alertStatus',
        'acknowledged'
      ]
        .map(csvEscape)
        .join(',')
    ];

    db.events.forEach(
      event => {
        rows.push(
          [
            event.timestamp,
            event.id,
            event.type,
            event.severity,
            event.temperature,
            event.humidity,
            event.vibration,
            event.riskScore,
            event.mode,
            event.deviceId,
            event.action,
            event.alertStatus,
            event.acknowledged
          ]
            .map(csvEscape)
            .join(',')
        );
      }
    );

    res.setHeader(
      'Content-Type',
      'text/csv'
    );

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="vaxguard_audit.csv"'
    );

    res.send(
      rows.join('\n')
    );
  }
);

// ============================================================================
// CLEAR HISTORY
// ============================================================================

app.post(
  '/api/history/clear',
  (req, res) => {
    if (
      req.body?.confirm !== true
    ) {
      return res.status(400).json({
        ok: false,

        error:
          'Confirmation required to clear history.'
      });
    }

    db.events = [];
    db.readings = [];
    db.vibrationEvents = [];

    runtime.tempHistory = [];

    runtime.recentVibrationTimestamps = [];

    saveDb();

    io.emit(
      'historyCleared'
    );

    res.json({
      ok: true
    });
  }
);

// ============================================================================
// TELEGRAM TEST
// ============================================================================

app.post(
  '/api/telegram/test',
  async (req, res) => {
    const token =
      process.env.TELEGRAM_BOT_TOKEN;

    const chatId =
      process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      return res.json({
        ok: false,

        status:
          'not_configured',

        message:
          'Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.'
      });
    }

    try {
      const response =
        await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body: JSON.stringify({
              chat_id:
                chatId,

              text:
                'VaxGuard test alert - Telegram integration is working.'
            })
          }
        );

      const data =
        await response.json();

      if (data.ok) {
        return res.json({
          ok: true,

          status:
            'sent',

          message:
            'Test message accepted by Telegram.'
        });
      }

      return res.json({
        ok: false,

        status:
          'failed',

        message:
          `Telegram error: ${data.description || 'Unknown error'}`
      });
    } catch (error) {
      return res.json({
        ok: false,

        status:
          'failed',

        message:
          `Request failed: ${error.message}`
      });
    }
  }
);

// ============================================================================
// MANUAL EMERGENCY CALL
// ============================================================================

app.post(
  '/api/emergency/call',
  async (req, res) => {
    const risk =
      computeRisk();

    const result =
      await triggerEmergencyCall(
        'Manual emergency call requested',
        risk
      );

    res.json(result);
  }
);

// ============================================================================
// SELF TEST
// ============================================================================

app.post(
  '/api/selftest',
  (req, res) => {
    const results = [];

    // Backend.
    results.push({
      item:
        'Backend',

      status:
        'PASS',

      detail:
        'Server responding.'
    });

    // ESP32.
    results.push({
      item:
        'ESP32 connectivity',

      status:
        runtime.connected
          ? 'PASS'
          : 'FAIL',

      detail:
        runtime.connected
          ? 'Recent data received.'
          : 'No recent data from device.'
    });

    // DHT11.
    results.push({
      item:
        'DHT11 sensor',

      status:
        runtime.sensorValid
          ? 'PASS'
          : 'WARNING',

      detail:
        runtime.sensorValid
          ? 'Valid readings.'
          : 'Sensor invalid or not reporting.'
    });

    // Vibration.
    results.push({
      item:
        'SW-420 vibration',

      status:
        runtime.connected
          ? 'PASS'
          : 'WARNING',

      detail:
        runtime.connected
          ? 'Vibration input available through ESP32.'
          : 'Waiting for ESP32 data.'
    });

    // Telegram.
    const telegramConfigured =
      !!(
        process.env.TELEGRAM_BOT_TOKEN &&
        process.env.TELEGRAM_CHAT_ID
      );

    results.push({
      item:
        'Telegram',

      status:
        telegramConfigured
          ? 'CONFIGURED'
          : 'NOT CONFIGURED',

      detail:
        telegramConfigured
          ? 'Telegram credentials are present.'
          : 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.'
    });

    // Calling.
    const callingConfigured =
      !!(
        process.env.CALL_PROVIDER_WEBHOOK_URL &&
        process.env.EMERGENCY_CONTACT_NUMBER
      );

    results.push({
      item:
        'Emergency calling',

      status:
        callingConfigured
          ? 'CONFIGURED'
          : 'NOT CONFIGURED',

      detail:
        callingConfigured
          ? 'Calling provider webhook and contact are present.'
          : 'Set CALL_PROVIDER_WEBHOOK_URL and EMERGENCY_CONTACT_NUMBER in .env.'
    });

    logEvent(
      'Self-test completed',
      'INFO',
      {
        alertStatus:
          'logged',

        action:
          'self_test'
      }
    );

    res.json({
      results
    });
  }
);

// ============================================================================
// REPORT
// ============================================================================

app.get(
  '/api/report',
  (req, res) => {
    const type =
      req.query.type || 'summary';

    let hours = 24;

    if (
      type === 'weekly'
    ) {
      hours = 168;
    }

    const cutoff =
      Date.now() -
      hours * 3600000;

    const readings =
      db.readings.filter(
        reading =>
          new Date(reading.ts)
            .getTime() >= cutoff
      );

    const events =
      db.events.filter(
        event =>
          new Date(event.timestamp)
            .getTime() >= cutoff
      );

    const temperatures =
      readings
        .map(
          reading =>
            reading.temperature
        )
        .filter(
          temperature =>
            isNumber(temperature)
        );

    const temperatureReport =
      temperatures.length
        ? {
            min:
              Math.min(
                ...temperatures
              ),

            max:
              Math.max(
                ...temperatures
              ),

            avg:
              +(
                temperatures.reduce(
                  (a, b) =>
                    a + b,
                  0
                ) /
                temperatures.length
              ).toFixed(2)
          }
        : null;

    const vibrationCount =
      readings.filter(
        reading =>
          reading.vibration
      ).length;

    const alerts =
      events.filter(
        event =>
          event.severity !== 'INFO'
      ).length;

    const faults =
      events.filter(
        event =>
          event.type
            .toLowerCase()
            .includes('fault')
      ).length;

    const recoveries =
      events.filter(
        event =>
          event.type
            .toLowerCase()
            .includes('recovery')
      ).length;

    res.json({
      type,

      periodHours:
        hours,

      monitoringDurationSamples:
        readings.length,

      temperature:
        temperatureReport,

      vibrationEvents:
        vibrationCount,

      alerts,

      faults,

      recoveries,

      generatedAt:
        new Date().toISOString()
    });
  }
);

// ============================================================================
// SOCKET.IO
// ============================================================================

io.on(
  'connection',
  socket => {
    console.log(
      `[Socket.IO] Dashboard connected: ${socket.id}`
    );

    const risk =
      computeRisk();

    socket.emit(
      'state',
      {
        mode:
          runtime.mode,

        temperature:
          runtime.temperature,

        humidity:
          runtime.humidity,

        vibration:
          runtime.vibration,

        vibrationEventCount:
          runtime.vibrationEventCount,

        sensorValid:
          runtime.sensorValid,

        state:
          runtime.state,

        connected:
          runtime.connected,

        lastUpdate:
          runtime.lastUpdate,

        trend:
          computeTrend(),

        risk,

        condition:
          computeConditionAdvisory(),

        earlyWarning:
          earlyWarning(),

        deviceId:
          db.settings.deviceId,

        settings:
          db.settings,

        callStatus:
          runtime.lastCallStatus,

        lastCallTime:
          runtime.lastCallTime,

        lastCallReason:
          runtime.lastCallReason
      }
    );

    socket.on(
      'disconnect',
      () => {
        console.log(
          `[Socket.IO] Dashboard disconnected: ${socket.id}`
        );
      }
    );
  }
);

// ============================================================================
// START SERVER
// ============================================================================

server.listen(
  PORT,
  () => {
    console.log('');
    console.log(
      '=================================================='
    );
    console.log(
      '              VAXGUARD BACKEND'
    );
    console.log(
      '=================================================='
    );

    console.log(
      `Server: http://localhost:${PORT}`
    );

    console.log(
      `Mode support: LIVE + DEMO`
    );

    console.log(
      `Automatic emergency call: ${
        process.env.CALL_PROVIDER_WEBHOOK_URL &&
        process.env.EMERGENCY_CONTACT_NUMBER
          ? 'CONFIGURED'
          : 'NOT CONFIGURED'
      }`
    );

    console.log(
      `Telegram: ${
        process.env.TELEGRAM_BOT_TOKEN &&
        process.env.TELEGRAM_CHAT_ID
          ? 'CONFIGURED'
          : 'NOT CONFIGURED'
      }`
    );

    console.log(
      `Dashboard authentication: ${
        AUTH_ENABLED
          ? 'ENABLED'
          : 'DISABLED'
      }`
    );

    console.log(
      '=================================================='
    );

    console.log('');
  }
);
