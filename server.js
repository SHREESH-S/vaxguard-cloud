require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

let twilioLib = null;
try { twilioLib = require('twilio'); } catch (e) {}

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const ENV = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  AI_API_KEY: process.env.AI_API_KEY || '',
  ALERT_CALL_ENABLED: (process.env.ALERT_CALL_ENABLED || 'false').toLowerCase() === 'true',
  ALERT_CALL_NUMBER: process.env.ALERT_CALL_NUMBER || '',
  CALL_PROVIDER_ACCOUNT_SID: process.env.CALL_PROVIDER_ACCOUNT_SID || '',
  CALL_PROVIDER_AUTH_TOKEN: process.env.CALL_PROVIDER_AUTH_TOKEN || '',
  CALL_PROVIDER_NUMBER: process.env.CALL_PROVIDER_NUMBER || '',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || '',
  DEMO_CALL_ENABLED: (process.env.DEMO_CALL_ENABLED || 'false').toLowerCase() === 'true',
  CRITICAL_CONFIRMATION_SECONDS: parseInt(process.env.CRITICAL_CONFIRMATION_SECONDS || CFG.escalation.criticalConfirmationSeconds, 10),
  CALL_COOLDOWN_MINUTES: parseInt(process.env.CALL_COOLDOWN_MINUTES || CFG.escalation.callCooldownMinutes, 10),
  MAX_CALL_ATTEMPTS: parseInt(process.env.MAX_CALL_ATTEMPTS || CFG.escalation.maxCallAttempts, 10),
  DEVICE_KEY: process.env.DEVICE_KEY || ''
};

let twilioClient = null;
if (twilioLib && ENV.CALL_PROVIDER_ACCOUNT_SID && ENV.CALL_PROVIDER_AUTH_TOKEN) {
  try { twilioClient = twilioLib(ENV.CALL_PROVIDER_ACCOUNT_SID, ENV.CALL_PROVIDER_AUTH_TOKEN); }
  catch (e) { console.error('Twilio init failed:', e.message); }
}

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dataFile(name) { return path.join(DATA_DIR, name); }
function loadJSON(name, fallback) {
  try {
    const p = dataFile(name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return fallback; }
}
function saveJSON(name, data) {
  try { fs.writeFileSync(dataFile(name), JSON.stringify(data, null, 2)); }
  catch (e) { console.error('persist failed:', e.message); }
}

const state = {
  mode: CFG.system.defaultMode || 'DEMO',
  wifiOk: true,
  latest: null,
  history: loadJSON('history.json', []),
  audit: loadJSON('audit.json', []),
  incidents: loadJSON('incidents.json', []),
  explanationHistory: loadJSON('explanations.json', []),
  incidentCounter: loadJSON('counter.json', { n: 100 }).n,
  currentIncidentId: null,
  callState: {
    criticalSince: null,
    lastCallAt: null,
    attemptsForCurrentIncident: 0,
    cooldownUntil: null,
    lastStatus: 'CALL READY'
  },
  demoBaseline: { temperature: 5.0, humidity: 55, vibration: false, sensorFault: false },
  vaccineQualityScore: 100,
  livingMyth: "The Guardian awakens...",
  digitalArtifact: { level: 1, title: "Nascent Sentinel", evolution: 0 },
  collectiveInsights: [],
  ritualPrompt: "Daily cold-chain ritual: Verify seals and log baseline.",
  oracleReading: "The sensors speak of calm waters."
};

const callMessages = new Map();

function persistAll() {
  saveJSON('history.json', state.history.slice(-CFG.server.maxHistoryPoints));
  saveJSON('audit.json', state.audit.slice(-2000));
  saveJSON('incidents.json', state.incidents.slice(-500));
  saveJSON('explanations.json', state.explanationHistory.slice(-500));
  saveJSON('counter.json', { n: state.incidentCounter });
}

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const stddev = (arr, m) => {
  if (arr.length < 2) return 0;
  const mean = m !== undefined ? m : avg(arr);
  return Math.sqrt(avg(arr.map((x) => (x - mean) ** 2)));
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const nowIso = () => new Date().toISOString();

const SEVERITY = [
  { level: 0, label: 'NORMAL' },
  { level: 1, label: 'INFORMATION' },
  { level: 2, label: 'WARNING' },
  { level: 3, label: 'HIGH_RISK' },
  { level: 4, label: 'CRITICAL' }
];

function severityFromRisk(riskScore) {
  if (riskScore >= 80) return SEVERITY[4];
  if (riskScore >= 60) return SEVERITY[3];
  if (riskScore >= 40) return SEVERITY[2];
  if (riskScore >= 20) return SEVERITY[1];
  return SEVERITY[0];
}

function countRecentVibrations(windowSeconds) {
  const cutoff = Date.now() - windowSeconds * 1000;
  return state.history.filter((h) => h.vibration && new Date(h.timestamp).getTime() >= cutoff).length;
}

function calcRiskScore(reading, vibCountRecent) {
  const T = CFG.thresholds;
  let risk = 0;
  const t = reading.temperature;
  if (typeof t === 'number') {
    if (t < T.tempMin) risk += Math.min(65, (T.tempMin - t) * 18);
    else if (t > T.tempMax) risk += Math.min(70, (t - T.tempMax) * 15);
  }
  if (reading.vibration) risk += 10;
  if (vibCountRecent >= T.vibrationEventsForCritical) risk += 35;
  else if (vibCountRecent >= T.vibrationEventsForHigh) risk += 22;
  else if (vibCountRecent >= T.vibrationEventsForWarning) risk += 10;
  if (typeof reading.humidity === 'number' &&
      (reading.humidity < T.humidityMin || reading.humidity > T.humidityMax)) {
    risk += 8;
  }
  if (reading.sensorFault) risk += 15;
  return Math.round(clamp(risk, 0, 100));
}

function calcConditionScore(riskScore) {
  return Math.round(clamp(100 - riskScore * 0.95, 0, 100));
}

function calcSensorHealth(reading) {
  let health = 100;
  if (reading.sensorFault) health -= 45;
  if (!state.wifiOk) health -= 15;
  if (state.mode === 'DEMO') health -= 5;
  return Math.round(clamp(health, 0, 100));
}

function calcConfidence(sensorHealth, historyLen) {
  const historyFactor = Math.min(historyLen, 20) / 20 * 30;
  const wifiFactor = state.wifiOk ? 20 : 5;
  return Math.round(clamp(sensorHealth * 0.5 + historyFactor + wifiFactor, 0, 100));
}

function calcTrend() {
  const scores = state.history.slice(-CFG.risk.trendWindow).map((h) => h.riskScore);
  if (scores.length < 3) {
    return { trend: 'STABLE', slope: 0, predictedRisk: scores[scores.length - 1] || 0, confidence: 40 };
  }
  const half = Math.floor(scores.length / 2);
  const firstAvg = avg(scores.slice(0, half));
  const secondAvg = avg(scores.slice(half));
  const diff = secondAvg - firstAvg;
  let trend = 'STABLE';
  if (diff > 5) trend = 'WORSENING';
  else if (diff < -5) trend = 'IMPROVING';
  const predictedRisk = Math.round(clamp(secondAvg + diff, 0, 100));
  const confidence = Math.round(clamp(50 + scores.length * 2, 0, 95));
  return { trend, slope: Number(diff.toFixed(2)), predictedRisk, confidence };
}

function detectAnomaly(latestTemp) {
  const temps = state.history.slice(-CFG.risk.historyWindow).map((h) => h.temperature).filter((x) => typeof x === 'number');
  if (temps.length < 5 || typeof latestTemp !== 'number') return { isAnomaly: false, z: 0 };
  const m = avg(temps);
  const sd = stddev(temps, m) || 0.001;
  const z = (latestTemp - m) / sd;
  return { isAnomaly: Math.abs(z) >= CFG.risk.anomalyZScoreThreshold, z: Number(z.toFixed(2)) };
}

function calcAlertPriority({ severityLevel, magnitude, vibCountRecent, trend, confidence }) {
  let p = severityLevel * 20;
  p += Math.min(15, magnitude * 2);
  p += Math.min(10, vibCountRecent * 2);
  if (trend === 'WORSENING') p += 10;
  if (confidence < 50) p -= 10;
  p = Math.round(clamp(p, 0, 100));
  let label = 'LOW';
  if (p >= 80) label = 'CRITICAL';
  else if (p >= 60) label = 'HIGH';
  else if (p >= 35) label = 'MEDIUM';
  return { priorityScore: p, priorityLabel: label };
}

function correlateEvents() {
  const recent = state.history.slice(-20);
  if (recent.length < 3) return null;
  const vibs = recent.filter((h) => h.vibration).length;
  const last = recent[recent.length - 1];
  if (vibs >= 2 && last && last.riskScore >= 55) {
    return 'Repeated vibration events temporally associated with rising risk. Observed pattern, not confirmed causation.';
  }
  return null;
}

function updateVaccineQuality(reading, severity) {
  if (severity.level >= 4) state.vaccineQualityScore = Math.max(40, state.vaccineQualityScore - 8);
  else if (severity.level >= 3) state.vaccineQualityScore = Math.max(55, state.vaccineQualityScore - 4);
  else if (severity.level >= 2) state.vaccineQualityScore = Math.max(70, state.vaccineQualityScore - 1.5);
  else state.vaccineQualityScore = Math.min(100, state.vaccineQualityScore + 0.3);
  return Math.round(state.vaccineQualityScore);
}

function updateLivingMyth(severity, reading) {
  const myths = {
    0: "The Guardian rests in quiet vigilance. The cold holds true.",
    1: "A whisper of change drifts through the chambers...",
    2: "The Sentinel stirs. Shadows lengthen near the threshold.",
    3: "Storms gather at the gates. The Pantheon watches closely.",
    4: "CRITICAL: The Living Myth ignites! The collective consciousness awakens to defend the precious cargo."
  };
  state.livingMyth = myths[severity.level] || myths[0];
  return state.livingMyth;
}

function evolveDigitalArtifact(severity, quality) {
  const art = state.digitalArtifact;
  art.evolution += (severity.level >= 3 ? 3 : severity.level >= 2 ? 1 : 0.2);
  if (art.evolution > 100) { art.level++; art.evolution = 0; }
  const titles = ["Nascent Sentinel", "Awakened Watcher", "Crystal Guardian", "Mythic Protector", "Pantheon Avatar"];
  art.title = titles[Math.min(art.level - 1, titles.length - 1)];
  return art;
}

function updateOracle(severity, trend) {
  if (severity.level >= 4) state.oracleReading = "Oracle speaks: Immediate action required. The path of recovery is open but narrowing.";
  else if (severity.level >= 3) state.oracleReading = "Oracle whispers of rising heat and unsettled earth. Secure the vessel.";
  else if (trend.trend === 'WORSENING') state.oracleReading = "The currents shift unfavorably. Vigilance is the ritual.";
  else state.oracleReading = "The sensors speak of calm waters and steady cold.";
  return state.oracleReading;
}

function updateRitual(severity) {
  if (severity.level >= 3) state.ritualPrompt = "URGENT RITUAL: Verify power, seal integrity, and relocate if needed. Log every action.";
  else if (severity.level >= 2) state.ritualPrompt = "Preventive Ritual: Check lid seal, confirm setpoint, and reduce door openings.";
  else state.ritualPrompt = "Daily cold-chain ritual: Verify seals, log baseline temperature, and honor the Guardian.";
  return state.ritualPrompt;
}

function addCollectiveInsight(text) {
  state.collectiveInsights.unshift({ ts: nowIso(), text });
  if (state.collectiveInsights.length > 20) state.collectiveInsights.pop();
}

function ruleBasedExplanation(reading, trend) {
  const T = CFG.thresholds;
  const parts = [];
  const prefix = state.mode === 'DEMO' ? 'Demo simulation indicates that' : 'Monitoring data indicates that';
  if (typeof reading.temperature === 'number') {
    if (reading.temperature > T.tempMax) {
      parts.push(`${prefix} the current temperature (${reading.temperature}°C) is above the upper limit of ${T.tempMax}°C.`);
    } else if (reading.temperature < T.tempMin) {
      parts.push(`${prefix} the current temperature (${reading.temperature}°C) is below the lower limit of ${T.tempMin}°C.`);
    } else {
      parts.push(`${prefix} the current temperature (${reading.temperature}°C) is within the configured range.`);
    }
  }
  if (reading.vibration) parts.push('Vibration activity has been detected.');
  if (reading.sensorFault) parts.push('A sensor fault reduces measurement confidence.');
  if (trend.trend === 'WORSENING') parts.push('Recent trend shows risk increasing.');
  else if (trend.trend === 'IMPROVING') parts.push('Recent trend shows risk decreasing.');
  else parts.push('Risk trend is relatively stable.');
  return parts.join(' ');
}

async function callAnthropicEnhance(promptText) {
  if (!ENV.AI_API_KEY) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ENV.AI_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 220,
        messages: [{ role: 'user', content: promptText }]
      }),
      signal: controller.signal
    });
    clearTimeout(t);
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
    return text || null;
  } catch (e) { return null; }
}

async function buildAIExplanation(reading, severity, trend) {
  const base = ruleBasedExplanation(reading, trend);
  if (!ENV.AI_API_KEY) return { text: base, aiEnhanced: false };
  const prompt = `You are the explanation module of VaxGuard vaccine cold-chain monitor. Mode: ${state.mode}. Severity: ${severity.label}. Temp: ${reading.temperature}C. Vibration: ${reading.vibration}. Trend: ${trend.trend}. Write 2-3 short factual sentences for an operator. Never claim vaccines are damaged. If DEMO, clearly say simulated.`;
  const enhanced = await callAnthropicEnhance(prompt);
  return enhanced ? { text: enhanced, aiEnhanced: true } : { text: base, aiEnhanced: false };
}

function buildRecommendation(severity) {
  switch (severity.label) {
    case 'CRITICAL': return 'Inspect immediately and follow your validated cold-chain deviation procedure. Move stock if required.';
    case 'HIGH_RISK': return 'Check the unit soon. Confirm conditions are returning to range.';
    case 'WARNING': return 'Monitor closely. No immediate action if trend improves.';
    case 'INFORMATION': return 'No action required. Continue routine monitoring.';
    default: return 'Conditions normal. Continue routine monitoring.';
  }
}

function buildActionPlan(severity, vibrationInvolved) {
  return {
    whatHappened: `Severity reached ${severity.label} based on risk score.`,
    whatToCheck: vibrationInvolved
      ? 'Check physical stability — was the unit moved, bumped, or opened?'
      : 'Check door seal, power supply, and thermostat.',
    whatToMonitor: 'Temperature, vibration frequency, and risk trend over next readings.',
    whenToEscalate: 'Escalate if condition does not improve within a few cycles.',
    whenRecoveryDetected: 'Recovery when severity returns to NORMAL and stays stable.'
  };
}

function buildVoiceMessage(reading, severity) {
  const demoTag = state.mode === 'DEMO' ? 'demonstration ' : '';
  if (severity.label === 'NORMAL' || severity.label === 'INFORMATION') {
    return `VaxGuard ${demoTag}status. Conditions are normal. Temperature ${reading.temperature.toFixed(1)} degrees.`;
  }
  if (severity.label === 'WARNING') {
    return `VaxGuard ${demoTag}warning. Temperature approaching limit at ${reading.temperature.toFixed(1)} degrees. Please monitor.`;
  }
  if (severity.label === 'HIGH_RISK') {
    return `VaxGuard ${demoTag}high risk alert. Conditions outside preferred range. Inspect soon.`;
  }
  if (reading.vibration) {
    return `VaxGuard ${demoTag}critical alert. Repeated vibration and abnormal conditions detected. Inspect the monitored system immediately.`;
  }
  return `VaxGuard ${demoTag}critical alert. Critical cold-chain condition detected. Inspect the environment now.`;
}

function buildCallMessage(reading, severity) {
  const demoTag = state.mode === 'DEMO' ? 'demonstration ' : '';
  let msg = reading.vibration
    ? `VaxGuard ${demoTag}critical alert. Repeated vibration activity and abnormal environmental conditions detected. Please inspect the monitored system.`
    : `VaxGuard ${demoTag}critical alert. A serious cold-chain condition has been detected. Temperature outside configured limit. Please inspect and follow validated procedure.`;
  msg += ' This is an automated prototype notification and is not a substitute for validated emergency or medical procedures.';
  return msg;
}

async function sendTelegram(reading, severity, riskScore, conditionScore, reasonText) {
  if (!ENV.TELEGRAM_BOT_TOKEN || !ENV.TELEGRAM_CHAT_ID) {
    audit('TELEGRAM_SKIPPED', { reason: 'not configured' });
    return { ok: false, reason: 'not_configured' };
  }
  const text =
`VAXGUARD ${severity.label} ALERT

MODE: ${state.mode}
Severity: ${severity.label}
Temperature: ${reading.temperature}°C
Vibration: ${reading.vibration ? 'DETECTED' : 'NORMAL'}
Risk: ${riskScore}/100
Condition: ${conditionScore}/100
Vaccine Quality Proxy: ${state.vaccineQualityScore}/100

Reason:
${reasonText}

Action:
${buildRecommendation(severity)}

Living Myth: ${state.livingMyth}`;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ENV.TELEGRAM_CHAT_ID, text })
    });
    const ok = resp.ok;
    audit(ok ? 'TELEGRAM_SENT' : 'TELEGRAM_FAILED', { status: resp.status });
    return { ok };
  } catch (e) {
    audit('TELEGRAM_FAILED', { error: e.message });
    return { ok: false, reason: e.message };
  }
}

function callEnabledForCurrentMode() {
  return state.mode === 'DEMO' ? ENV.DEMO_CALL_ENABLED : ENV.ALERT_CALL_ENABLED;
}

async function placeCall(toNumber, incidentKey, messageText, isTest) {
  callMessages.set(incidentKey, { message: messageText, mode: state.mode });
  if (!twilioClient || !ENV.CALL_PROVIDER_NUMBER || !toNumber || !ENV.PUBLIC_BASE_URL) {
    audit('CALL_FAILED', { reason: 'call provider not fully configured', incidentKey, isTest });
    return { ok: false, reason: 'not_configured' };
  }
  try {
    const call = await twilioClient.calls.create({
      to: toNumber,
      from: ENV.CALL_PROVIDER_NUMBER,
      url: `${ENV.PUBLIC_BASE_URL}/voice/twiml/${incidentKey}`
    });
    audit('CALL_TRIGGERED', { sid: call.sid, incidentKey, isTest });
    return { ok: true, sid: call.sid };
  } catch (e) {
    audit('CALL_FAILED', { error: e.message, incidentKey, isTest });
    return { ok: false, reason: e.message };
  }
}

async function attemptCriticalCallEscalation(incident, reading, severity) {
  const cs = state.callState;
  if (!callEnabledForCurrentMode()) { cs.lastStatus = 'CALLING DISABLED'; return; }
  const now = Date.now();
  if (cs.cooldownUntil && now < cs.cooldownUntil) { cs.lastStatus = 'COOLDOWN ACTIVE'; return; }
  if (cs.attemptsForCurrentIncident >= ENV.MAX_CALL_ATTEMPTS) { cs.lastStatus = 'CALL FAILED'; return; }

  cs.lastStatus = 'CALL TRIGGERED';
  const messageText = buildCallMessage(reading, severity);
  const result = await placeCall(ENV.ALERT_CALL_NUMBER, incident.id, messageText, false);
  cs.lastCallAt = nowIso();
  cs.attemptsForCurrentIncident += 1;
  cs.cooldownUntil = now + ENV.CALL_COOLDOWN_MINUTES * 60000;
  cs.lastStatus = result.ok ? 'CALL COMPLETED' : 'CALL FAILED';

  incident.callLog = incident.callLog || [];
  incident.callLog.push({
    timestamp: nowIso(), reason: 'CRITICAL_CONFIRMED', severity: severity.label,
    temperature: reading.temperature, vibration: reading.vibration,
    riskScore: reading.riskScore, result: cs.lastStatus
  });

  if (!result.ok) {
    await sendTelegram(reading, severity, reading.riskScore, reading.conditionScore,
      'Critical event detected but operator call could not be completed.');
  }
  broadcast();
}

function nextIncidentId() {
  state.incidentCounter += 1;
  return `VG-${new Date().getFullYear()}-${String(state.incidentCounter).padStart(6, '0')}`;
}

function getCurrentIncident() {
  if (!state.currentIncidentId) return null;
  return state.incidents.find((i) => i.id === state.currentIncidentId) || null;
}

function manageIncidentLifecycle(severity, reading) {
  let incident = getCurrentIncident();
  if (severity.level >= 2 && !incident) {
    incident = {
      id: nextIncidentId(),
      mode: state.mode,
      openedAt: nowIso(),
      stage: 'OPENED',
      stageHistory: [{ stage: 'OPENED', timestamp: nowIso() }],
      severityPeak: severity.level,
      peakAt: nowIso(),
      events: [],
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedAt: null,
      recoveryDetectedAt: null,
      recoveryDurationSec: null,
      callStatus: 'CALL READY',
      callLog: []
    };
    state.incidents.push(incident);
    state.currentIncidentId = incident.id;
    state.callState.attemptsForCurrentIncident = 0;
    state.callState.criticalSince = null;
    pushStage(incident, 'ACTIVE');
    audit('INCIDENT_OPENED', { incidentId: incident.id, severity: severity.label });
    addCollectiveInsight(`New incident ${incident.id} opened in ${state.mode} mode.`);
  }

  if (incident) {
    if (severity.level > incident.severityPeak) {
      incident.severityPeak = severity.level;
      incident.peakAt = nowIso();
      if (severity.level >= 3 && incident.stage !== 'ESCALATED') pushStage(incident, 'ESCALATED');
    }
    incident.events.push({
      timestamp: nowIso(), temperature: reading.temperature, humidity: reading.humidity,
      vibration: reading.vibration, riskScore: reading.riskScore, conditionScore: reading.conditionScore,
      severity: severity.label
    });
    if (incident.events.length > 300) incident.events.shift();

    if (severity.level <= 1 && incident.severityPeak >= 2) {
      if (incident.stage !== 'RECOVERING' && incident.stage !== 'RESOLVED') {
        pushStage(incident, 'RECOVERING');
        incident.recoveryStartedAt = nowIso();
        audit('INCIDENT_RECOVERING', { incidentId: incident.id });
      }
      if (severity.level === 0 && incident.stage === 'RECOVERING') {
        incident.stage = 'RESOLVED';
        incident.stageHistory.push({ stage: 'RESOLVED', timestamp: nowIso() });
        incident.resolvedAt = nowIso();
        incident.recoveryDetectedAt = nowIso();
        const peakTime = new Date(incident.peakAt).getTime();
        incident.recoveryDurationSec = Math.round((Date.now() - peakTime) / 1000);
        audit('INCIDENT_RESOLVED', { incidentId: incident.id, recoveryDurationSec: incident.recoveryDurationSec });
        state.currentIncidentId = null;
        state.callState.criticalSince = null;
        state.callState.attemptsForCurrentIncident = 0;
        addCollectiveInsight(`Incident ${incident.id} resolved after ${incident.recoveryDurationSec}s.`);
      }
    }
  }
  return incident;
}

function pushStage(incident, stage) {
  incident.stage = stage;
  incident.stageHistory.push({ stage, timestamp: nowIso() });
  audit('INCIDENT_' + stage, { incidentId: incident.id });
}

function audit(event, extra) {
  const entry = Object.assign({ timestamp: nowIso(), mode: state.mode, event }, extra || {});
  state.audit.push(entry);
  if (state.audit.length > 3000) state.audit.shift();
  if (io) io.emit('audit', entry);
  return entry;
}

function recordExplanation(riskBefore, riskAfter, reasonText) {
  const entry = { timestamp: nowIso(), mode: state.mode, riskBefore, riskAfter, reason: reasonText };
  state.explanationHistory.push(entry);
  if (state.explanationHistory.length > 1000) state.explanationHistory.shift();
  return entry;
}

async function processEvent(raw) {
  if (raw.mode) state.mode = raw.mode;
  if (typeof raw.wifiOk === 'boolean') state.wifiOk = raw.wifiOk;

  const reading = {
    timestamp: nowIso(),
    mode: state.mode,
    temperature: typeof raw.temperature === 'number' ? raw.temperature : (state.latest ? state.latest.temperature : 5),
    humidity: typeof raw.humidity === 'number' ? raw.humidity : (state.latest ? state.latest.humidity : 55),
    vibration: !!raw.vibration,
    sensorFault: !!raw.sensorFault,
    source: raw.source || (state.mode === 'DEMO' ? 'DEMO' : 'DHT11+SW420')
  };

  const vibCountRecent = countRecentVibrations(CFG.thresholds.vibrationWindowSeconds);
  const riskBefore = state.latest ? state.latest.riskScore : 0;
  const riskScore = calcRiskScore(reading, vibCountRecent);
  const conditionScore = calcConditionScore(riskScore);
  const sensorHealth = calcSensorHealth(reading);
  const severity = severityFromRisk(riskScore);
  const anomaly = detectAnomaly(reading.temperature);

  reading.riskScore = riskScore;
  reading.conditionScore = conditionScore;
  reading.sensorHealth = sensorHealth;
  reading.severity = severity.label;
  reading.severityLevel = severity.level;
  reading.vibCountRecent = vibCountRecent;
  reading.anomaly = anomaly.isAnomaly;

  state.history.push(reading);
  if (state.history.length > CFG.server.maxHistoryPoints) state.history.shift();

  const confidence = calcConfidence(sensorHealth, state.history.length);
  const trend = calcTrend();
  const priority = calcAlertPriority({
    severityLevel: severity.level,
    magnitude: Math.abs(reading.temperature - (reading.temperature > CFG.thresholds.tempMax ? CFG.thresholds.tempMax : CFG.thresholds.tempMin)),
    vibCountRecent, trend: trend.trend, confidence
  });
  const correlation = correlateEvents();
  const ai = await buildAIExplanation(reading, severity, trend);
  const recommendation = buildRecommendation(severity);
  const actionPlan = buildActionPlan(severity, reading.vibration);

  reading.vaccineQuality = updateVaccineQuality(reading, severity);
  reading.livingMyth = updateLivingMyth(severity, reading);
  reading.digitalArtifact = evolveDigitalArtifact(severity, reading.vaccineQuality);
  reading.oracle = updateOracle(severity, trend);
  reading.ritual = updateRitual(severity);
  reading.confidence = confidence;
  reading.trend = trend;
  reading.priority = priority;
  reading.correlation = correlation;
  reading.explanation = ai.text;
  reading.aiEnhanced = ai.aiEnhanced;
  reading.recommendation = recommendation;
  reading.actionPlan = actionPlan;
  reading.voiceMessage = buildVoiceMessage(reading, severity);

  state.latest = reading;

  audit(severity.level >= 2 ? severity.label + '_EVENT' : 'READING', {
    temperature: reading.temperature, humidity: reading.humidity, vibration: reading.vibration,
    severity: severity.label, riskScore, conditionScore, sensorHealth, confidence,
    reason: ai.text, recommendation
  });

  if (Math.abs(riskScore - riskBefore) >= 15) {
    recordExplanation(riskBefore, riskScore, ai.text);
  }

  const incident = manageIncidentLifecycle(severity, reading);

  if (severity.level >= 2) {
    if (severity.level >= 3) {
      await sendTelegram(reading, severity, riskScore, conditionScore, ai.text);
    }
    if (severity.level === 4 && incident) {
      incident.callStatus = state.callState.lastStatus;
      const cs = state.callState;
      if (cs.criticalSince === null) cs.criticalSince = Date.now();
      const heldSeconds = (Date.now() - cs.criticalSince) / 1000;
      if (heldSeconds >= ENV.CRITICAL_CONFIRMATION_SECONDS) {
        await attemptCriticalCallEscalation(incident, reading, severity);
      } else {
        cs.lastStatus = 'CALL READY';
      }
    }
  } else {
    state.callState.criticalSince = null;
  }

  persistAll();
  broadcast();
  return reading;
}

function currentDemoBase() {
  return state.latest && state.mode === 'DEMO'
    ? { temperature: state.latest.temperature, humidity: state.latest.humidity, vibration: state.latest.vibration, sensorFault: state.latest.sensorFault }
    : Object.assign({}, state.demoBaseline);
}

function demoEventFromCommand(command) {
  const base = currentDemoBase();
  const ev = { mode: 'DEMO', temperature: base.temperature, humidity: base.humidity, vibration: base.vibration, sensorFault: false, wifiOk: true, source: 'DEMO-CMD:' + command };
  switch (command) {
    case 'normal': ev.temperature = 5.0; ev.vibration = false; ev.sensorFault = false; break;
    case 'low': ev.temperature = 1.0; break;
    case 'high': ev.temperature = 8.6; break;
    case 'warning': ev.temperature = 9.4; break;
    case 'danger': case 'critical': ev.temperature = 11.5; ev.vibration = true; break;
    case 'vibration': ev.vibration = true; break;
    case 'novibration': ev.vibration = false; break;
    case 'tempnormal': ev.temperature = 5.0; break;
    case 'templow': ev.temperature = 0.5; break;
    case 'temphigh': ev.temperature = 10.0; break;
    case 'sensorfault': ev.sensorFault = true; break;
    case 'wifi': ev.wifiOk = true; break;
    case 'offline': ev.wifiOk = false; break;
    case 'recovery': case 'reset': ev.temperature = 5.0; ev.vibration = false; ev.sensorFault = false; break;
    default: break;
  }
  state.demoBaseline = { temperature: ev.temperature, humidity: ev.humidity, vibration: ev.vibration, sensorFault: ev.sensorFault };
  return ev;
}

const HELP_TEXT = [
  'normal', 'low', 'high', 'warning', 'danger', 'vibration', 'novibration', 'tempnormal', 'templow',
  'temphigh', 'sensorfault', 'wifi', 'offline', 'recovery', 'critical', 'reset', 'real', 'demo', 'status',
  'scenario1..scenario8', 'calltest', 'help'
];

function runScenario(name) {
  const sequences = {
    scenario1: [{ c: 'normal', d: 0 }],
    scenario2: [{ c: 'tempnormal', d: 0 }, { c: 'high', d: 4000 }, { c: 'warning', d: 8000 }, { c: 'danger', d: 12000 }],
    scenario3: [{ c: 'normal', d: 0 }, { c: 'danger', d: 2000 }],
    scenario4: [{ c: 'vibration', d: 0 }, { c: 'novibration', d: 3000 }, { c: 'vibration', d: 6000 }, { c: 'vibration', d: 9000 }, { c: 'vibration', d: 12000 }],
    scenario5: [{ c: 'vibration', d: 0 }, { c: 'high', d: 3000 }, { c: 'danger', d: 6000 }],
    scenario6: [{ c: 'sensorfault', d: 0 }],
    scenario7: [{ c: 'danger', d: 0 }, { c: 'warning', d: 6000 }, { c: 'recovery', d: 12000 }, { c: 'normal', d: 16000 }],
    scenario8: [{ c: 'offline', d: 0 }, { c: 'wifi', d: 6000 }, { c: 'normal', d: 7000 }]
  };
  const seq = sequences[name];
  if (!seq) return false;
  seq.forEach((step) => {
    setTimeout(() => { processEvent(demoEventFromCommand(step.c)).catch(console.error); }, step.d);
  });
  return true;
}

function ruleBasedIncidentSummary(incident) {
  const events = incident.events || [];
  const risks = events.map((e) => e.riskScore);
  const maxRisk = risks.length ? Math.max(...risks) : 0;
  const minRisk = risks.length ? Math.min(...risks) : 0;
  const recovered = incident.stage === 'RESOLVED';
  return {
    aiGenerated: false,
    whatHappened: `Incident ${incident.id} opened in ${incident.mode} mode and reached peak severity ${SEVERITY[incident.severityPeak].label}.`,
    whenItHappened: incident.openedAt,
    howSevere: `Peak risk: ${maxRisk}/100 (min during: ${minRisk}/100).`,
    whatChanged: `Stages: ${incident.stageHistory.map((s) => s.stage).join(' → ')}.`,
    riskProgression: risks,
    recoveryOccurred: recovered,
    recoveryDurationSec: incident.recoveryDurationSec,
    recommendedFollowUp: recovered
      ? 'Review timeline and confirm no product quality concerns per validated procedure.'
      : 'Incident still open; continue monitoring and follow escalation procedure.'
  };
}

async function buildAIIncidentSummary(incident) {
  const base = ruleBasedIncidentSummary(incident);
  if (!ENV.AI_API_KEY) return base;
  const prompt = `Summarize this VaxGuard incident for an operator in 4-5 short sentences. Data: ${JSON.stringify(base)}. Do not claim medical validation. Mark as AI-generated.`;
  const enhanced = await callAnthropicEnhance(prompt);
  if (enhanced) return Object.assign({}, base, { aiGenerated: true, narrative: enhanced });
  return base;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

function publicState() {
  return {
    mode: state.mode,
    wifiOk: state.wifiOk,
    latest: state.latest,
    history: state.history.slice(-CFG.server.maxHistoryPoints),
    incidents: state.incidents.slice(-30),
    currentIncidentId: state.currentIncidentId,
    callState: state.callState,
    callConfig: {
      realCallEnabled: ENV.ALERT_CALL_ENABLED,
      demoCallEnabled: ENV.DEMO_CALL_ENABLED,
      confirmationSeconds: ENV.CRITICAL_CONFIRMATION_SECONDS,
      cooldownMinutes: ENV.CALL_COOLDOWN_MINUTES,
      maxAttempts: ENV.MAX_CALL_ATTEMPTS
    },
    telegramConfigured: !!(ENV.TELEGRAM_BOT_TOKEN && ENV.TELEGRAM_CHAT_ID),
    aiConfigured: !!ENV.AI_API_KEY,
    explanationHistory: state.explanationHistory.slice(-30),
    collectiveInsights: state.collectiveInsights.slice(0, 10),
    livingMyth: state.livingMyth,
    digitalArtifact: state.digitalArtifact,
    ritualPrompt: state.ritualPrompt,
    oracleReading: state.oracleReading
  };
}

function broadcast() { io.emit('state', publicState()); }

io.on('connection', (socket) => {
  socket.emit('state', publicState());
  socket.emit('help', HELP_TEXT);
});

function requireDeviceKey(req, res, next) {
  if (!ENV.DEVICE_KEY) return next();
  if (req.headers['x-device-key'] === ENV.DEVICE_KEY) return next();
  return res.status(401).json({ ok: false, error: 'invalid device key' });
}

app.get('/api/state', (req, res) => res.json(publicState()));
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit || '200', 10);
  res.json(state.history.slice(-limit));
});
app.get('/api/audit', (req, res) => {
  const limit = parseInt(req.query.limit || '100', 10);
  res.json(state.audit.slice(-limit));
});
app.get('/api/incidents', (req, res) => res.json(state.incidents.slice(-100)));
app.get('/api/incidents/:id', (req, res) => {
  const inc = state.incidents.find((i) => i.id === req.params.id);
  if (!inc) return res.status(404).json({ ok: false, error: 'not found' });
  res.json(inc);
});
app.get('/api/incidents/:id/replay', (req, res) => {
  const inc = state.incidents.find((i) => i.id === req.params.id);
  if (!inc) return res.status(404).json({ ok: false, error: 'not found' });
  const events = inc.events || [];
  const peakIdx = events.reduce((bi, e, i, arr) => (e.riskScore > (arr[bi] ? arr[bi].riskScore : -1) ? i : bi), 0);
  res.json({
    incidentId: inc.id,
    before: events.slice(0, Math.max(1, Math.floor(events.length * 0.25))),
    during: events.slice(Math.floor(events.length * 0.25), peakIdx + 1),
    peak: events[peakIdx] || null,
    recovery: events.slice(peakIdx + 1)
  });
});
app.post('/api/incidents/:id/acknowledge', (req, res) => {
  const inc = state.incidents.find((i) => i.id === req.params.id);
  if (!inc) return res.status(404).json({ ok: false, error: 'not found' });
  inc.acknowledgedBy = req.body.by || 'operator';
  inc.acknowledgedAt = nowIso();
  audit('INCIDENT_ACKNOWLEDGED', { incidentId: inc.id, by: inc.acknowledgedBy });
  broadcast();
  res.json({ ok: true, incident: inc });
});
app.get('/api/summary/:id', async (req, res) => {
  const inc = state.incidents.find((i) => i.id === req.params.id);
  if (!inc) return res.status(404).json({ ok: false, error: 'not found' });
  const summary = await buildAIIncidentSummary(inc);
  res.json(summary);
});
app.post('/api/mode', (req, res) => {
  const m = (req.body.mode || '').toUpperCase();
  if (m !== 'REAL' && m !== 'DEMO') return res.status(400).json({ ok: false, error: 'mode must be REAL or DEMO' });
  state.mode = m;
  audit('MODE_CHANGED', { mode: m });
  broadcast();
  res.json({ ok: true, mode: state.mode });
});
app.post('/api/demo/:command', async (req, res) => {
  const command = req.params.command.toLowerCase();
  if (command === 'help') return res.json({ ok: true, commands: HELP_TEXT });
  if (command === 'status') return res.json({ ok: true, state: publicState() });
  if (command === 'real') { state.mode = 'REAL'; audit('MODE_CHANGED', { mode: 'REAL' }); broadcast(); return res.json({ ok: true, mode: 'REAL' }); }
  if (command === 'demo') { state.mode = 'DEMO'; audit('MODE_CHANGED', { mode: 'DEMO' }); broadcast(); return res.json({ ok: true, mode: 'DEMO' }); }
  if (command.startsWith('scenario')) {
    const started = runScenario(command);
    return res.json({ ok: started });
  }
  if (command === 'calltest' || command === 'test_call' || command === 'testcall') {
    const enabled = state.mode === 'DEMO' ? ENV.DEMO_CALL_ENABLED : true;
    if (!enabled) return res.json({ ok: false, status: 'CALLING DISABLED' });
    const message = 'VaxGuard demonstration test alert. This is a test of the automatic operator call system. No action is required.';
    const result = await placeCall(ENV.ALERT_CALL_NUMBER, 'TEST-' + Date.now(), message, true);
    audit('TEST_CALL', { result: result.ok ? 'CALL COMPLETED' : 'CALL FAILED' });
    return res.json({ ok: result.ok, status: result.ok ? 'CALL COMPLETED' : 'CALL FAILED' });
  }
  const ev = demoEventFromCommand(command);
  const reading = await processEvent(ev);
  res.json({ ok: true, reading });
});
app.post('/api/event', requireDeviceKey, async (req, res) => {
  try {
    const body = req.body || {};
    const raw = {
      mode: (body.mode || state.mode || 'REAL').toUpperCase(),
      temperature: typeof body.temperature === 'number' ? body.temperature : parseFloat(body.temperature),
      humidity: typeof body.humidity === 'number' ? body.humidity : parseFloat(body.humidity),
      vibration: !!body.vibration,
      sensorFault: !!body.sensorFault,
      wifiOk: body.wifiOk !== undefined ? !!body.wifiOk : true,
      source: body.source || 'ESP32'
    };
    const reading = await processEvent(raw);
    res.json({ ok: true, reading });
  } catch (e) {
    console.error('/api/event error:', e.message);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});
app.post('/api/test/telegram', async (req, res) => {
  const reading = state.latest || { temperature: 5, vibration: false, riskScore: 0, conditionScore: 100 };
  const result = await sendTelegram(reading, SEVERITY[1], reading.riskScore || 0, reading.conditionScore || 100, 'This is a VaxGuard system test message.');
  res.json(result);
});
app.post('/api/test/call', async (req, res) => {
  const message = 'VaxGuard test call. This is a system test of the automated calling feature. No action is required.';
  const result = await placeCall(ENV.ALERT_CALL_NUMBER, 'TEST-' + Date.now(), message, true);
  audit('TEST_CALL', { result: result.ok ? 'CALL COMPLETED' : 'CALL FAILED' });
  res.json(result);
});
app.get('/voice/twiml/:key', (req, res) => {
  const entry = callMessages.get(req.params.key);
  const text = entry ? entry.message : 'VaxGuard automated alert. Please check the VaxGuard dashboard for details.';
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">${escapeXml(text)}</Say></Response>`);
});
function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), mode: state.mode }));

process.on('unhandledRejection', (reason) => {
  console.error('[VaxGuard] Unhandled rejection (ignored):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[VaxGuard] Uncaught exception (ignored):', err.message);
});

server.listen(ENV.PORT, () => {
  console.log(`[VaxGuard] server listening on port ${ENV.PORT} | mode=${state.mode}`);
  console.log('[VaxGuard] Automated calls intended for configured responsible operator only.');
});