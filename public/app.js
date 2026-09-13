// ============================================================================
// VaxGuard dashboard client
// ============================================================================

let latestState = null;

// ---------------------------------------------------------------------------
// NAVIGATION
// ---------------------------------------------------------------------------
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('screen-' + btn.dataset.screen).classList.add('active');
    document.getElementById('sidebar').classList.remove('open');
  });
});

document.getElementById('hamburger').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// ---------------------------------------------------------------------------
// THEME
// ---------------------------------------------------------------------------
const themeToggle = document.getElementById('themeToggle');
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('vaxguard-theme', t);
}
applyTheme(localStorage.getItem('vaxguard-theme') || 'dark');
themeToggle.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

// ---------------------------------------------------------------------------
// SOCKET.IO REAL-TIME
// ---------------------------------------------------------------------------
const socket = io();

socket.on('connect', () => {
  document.getElementById('connPill').textContent = 'SERVER: CONNECTED';
  document.getElementById('connPill').className = 'conn-pill online';
});
socket.on('disconnect', () => {
  document.getElementById('connPill').textContent = 'SERVER: DISCONNECTED';
  document.getElementById('connPill').className = 'conn-pill offline';
});

socket.on('state', (state) => {
  latestState = state;
  renderState(state);
});

socket.on('event', (event) => {
  prependAlertRow(event);
  prependHistoryRow(event);
});

socket.on('eventUpdated', () => {
  loadHistory();
  loadAlerts();
});

socket.on('heartbeat', (devices) => {
  const d = devices[latestState?.deviceId] || Object.values(devices)[0];
  if (d) {
    document.getElementById('net-heartbeat').textContent = new Date(d.lastHeartbeat).toLocaleString();
    document.getElementById('net-uptime').textContent = d.uptimeMs ? formatDuration(d.uptimeMs) : '—';
  }
});

socket.on('voiceAlert', (text) => {
  if (document.getElementById('voiceAlertsToggle').checked) {
    speak(text);
  }
});

// ---------------------------------------------------------------------------
// RENDER STATE ACROSS SCREENS
// ---------------------------------------------------------------------------
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function stateClass(state) {
  if (state === 'NORMAL') return 'normal';
  if (['CRITICAL', 'DANGEROUS', 'SENSOR FAULT', 'OFFLINE'].includes(state)) return 'critical';
  return 'warn';
}

function renderState(s) {
  // topbar
  document.getElementById('modePill').textContent = `MODE: ${s.mode}`;
  document.getElementById('connPill').textContent = s.connected ? 'DEVICE: CONNECTED' : 'DEVICE: OFFLINE';
  document.getElementById('connPill').className = 'conn-pill ' + (s.connected ? 'online' : 'offline');
  document.getElementById('statePill').textContent = `STATE: ${s.state}`;
  document.getElementById('statePill').className = 'state-pill ' + stateClass(s.state);
  document.getElementById('freshness').textContent = s.lastUpdate ? `Last updated: ${new Date(s.lastUpdate).toLocaleTimeString()}` : 'Last updated: —';

  const dataFlag = s.mode === 'DEMO' ? 'DEMO DATA' : 'REAL SENSOR DATA';

  // Overview
  document.getElementById('ov-device').textContent = s.deviceId;
  document.getElementById('ov-mode').textContent = s.mode;
  document.getElementById('ov-temp').textContent = fmtTemp(s.temperature);
  document.getElementById('ov-humidity').textContent = s.humidity != null ? `${s.humidity}%` : '—';
  document.getElementById('ov-vibration').textContent = s.vibration ? 'DETECTED' : 'NONE';
  document.getElementById('ov-risk').textContent = `${s.risk.score}/100 (${s.risk.category})`;
  document.getElementById('ov-condition').textContent = s.condition.label;
  document.getElementById('ov-connectivity').textContent = s.connected ? 'ONLINE' : 'OFFLINE';
  document.getElementById('ov-dataflag').textContent = dataFlag;

  // Live monitor
  document.getElementById('live-temp').textContent = fmtTemp(s.temperature);
  document.getElementById('live-temp-trend').textContent = `Trend: ${s.trend}`;
  document.getElementById('live-hum').textContent = s.humidity != null ? `${s.humidity}%` : '—';
  document.getElementById('live-vib').textContent = s.vibration ? 'VIBRATION DETECTED' : 'No vibration';
  document.getElementById('live-devstatus').textContent = s.connected ? 'ONLINE' : 'OFFLINE';
  document.getElementById('live-sensorhealth').textContent = s.sensorValid ? 'HEALTHY' : 'FAULT';
  document.getElementById('live-freshness').textContent = s.connected ? 'GOOD' : 'STALE';
  document.getElementById('live-connquality').textContent = s.connected ? 'GOOD' : 'LOST';
  document.getElementById('live-lastupdated').textContent = s.lastUpdate ? new Date(s.lastUpdate).toLocaleString() : '—';
  drawGauge(s.risk.score);

  // Risk & AI
  document.getElementById('risk-score').textContent = s.risk.score;
  document.getElementById('risk-category').textContent = s.risk.category;
  const reasonsEl = document.getElementById('risk-reasons');
  reasonsEl.innerHTML = s.risk.reasons.length
    ? s.risk.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')
    : '<li class="muted">No contributing risk factors currently.</li>';
  document.getElementById('risk-condition').textContent = s.condition.label;
  document.getElementById('risk-condition-reason').textContent = s.condition.reason;
  const ew = s.earlyWarning;
  document.getElementById('risk-earlywarning').textContent = ew
    ? `${ew.message}. ${ew.detail} ${ew.action}`
    : 'No early warning at this time.';
  document.getElementById('risk-rootcause').textContent = s.risk.reasons.length
    ? `Most likely contributing factor: ${s.risk.reasons[0].replace(/^\+\d+\s*/, '')}. Recommended inspection: review cooling unit and door seal.`
    : 'Insufficient events to determine a contributing factor.';

  // Vibration
  document.getElementById('vib-status').textContent = s.vibration ? 'VIBRATION DETECTED' : 'IDLE';
  document.getElementById('vib-count').textContent = s.vibrationEventCount;

  // Sensor health
  document.getElementById('sh-dht').textContent = s.sensorValid ? 'CONNECTED' : 'FAULT';
  document.getElementById('sh-sw420').textContent = s.vibration ? 'EVENT DETECTED' : 'CONNECTED / NO EVENT';
  document.getElementById('sh-esp32').textContent = s.connected ? 'ONLINE' : 'OFFLINE';
  document.getElementById('sh-tempvalid').textContent = s.sensorValid ? 'VALID' : 'INVALID';
  document.getElementById('sh-humvalid').textContent = s.sensorValid ? 'VALID' : 'INVALID';
  document.getElementById('sh-freshness').textContent = s.connected ? 'GOOD' : 'STALE';
  const healthScore = (s.sensorValid ? 60 : 0) + (s.connected ? 40 : 0);
  document.getElementById('sh-score').textContent = `${healthScore}%`;

  // Emergency
  document.getElementById('em-severity').textContent = s.risk.category;
  document.getElementById('em-risk').textContent = `${s.risk.score}/100`;
  document.getElementById('em-status').textContent = s.connected ? 'ONLINE' : 'OFFLINE';
  document.getElementById('em-action').textContent = s.condition.reason;

  // settings screen defaults (only fill once fields are empty)
  if (s.settings) fillSettingsIfEmpty(s.settings);
}

function fmtTemp(t) { return t != null ? `${t.toFixed ? t.toFixed(1) : t}°C` : '—'; }
function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

// ---------------------------------------------------------------------------
// RISK GAUGE (simple canvas arc, no extra libs needed)
// ---------------------------------------------------------------------------
function drawGauge(score) {
  const canvas = document.getElementById('riskGauge');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth || 300;
  const h = canvas.height = 160;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h - 10, r = Math.min(w / 2 - 10, 120);

  ctx.lineWidth = 16;
  ctx.strokeStyle = 'rgba(140,163,179,0.25)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI);
  ctx.stroke();

  const pct = Math.max(0, Math.min(100, score)) / 100;
  const color = score > 80 ? '#FF5C68' : score > 60 ? '#FF8A5C' : score > 40 ? '#F5B942' : score > 20 ? '#8FD16E' : '#34D399';
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, Math.PI + pct * Math.PI);
  ctx.stroke();

  ctx.fillStyle = getComputedStyle(document.body).color;
  ctx.font = '600 26px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(String(score), cx, cy - 14);
}

// ---------------------------------------------------------------------------
// ALERTS TABLE
// ---------------------------------------------------------------------------
async function loadAlerts() {
  const res = await fetch('/api/history?limit=100');
  const events = await res.json();
  const tbody = document.querySelector('#alerts-table tbody');
  tbody.innerHTML = '';
  events.filter(e => e.severity !== 'INFO').forEach(e => renderAlertRow(e, tbody));
}

function renderAlertRow(e, tbody) {
  const tr = document.createElement('tr');
  tr.dataset.id = e.id;
  tr.innerHTML = `
    <td>${new Date(e.timestamp).toLocaleString()}</td>
    <td>${escapeHtml(e.type)}</td>
    <td>${e.severity}</td>
    <td>${e.riskScore ?? '—'}</td>
    <td>${e.acknowledged ? 'Acknowledged' : (e.userAction || 'Open')}</td>
    <td>
      <button class="btn" data-act="acknowledge">Acknowledge</button>
      <button class="btn" data-act="mute">Mute</button>
      <button class="btn" data-act="escalate">Escalate</button>
    </td>`;
  tr.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => actOnAlert(e.id, b.dataset.act));
  });
  tbody.prepend(tr);
}

function prependAlertRow(e) {
  if (e.severity === 'INFO') return;
  const tbody = document.querySelector('#alerts-table tbody');
  renderAlertRow(e, tbody);
}

async function actOnAlert(id, action) {
  await fetch(`/api/alerts/${id}/${action}`, { method: 'POST' });
  loadAlerts();
}

// ---------------------------------------------------------------------------
// AUDIT HISTORY
// ---------------------------------------------------------------------------
async function loadHistory() {
  const severity = document.getElementById('histSeverity').value;
  const mode = document.getElementById('histMode').value;
  const ack = document.getElementById('histAck').value;
  const params = new URLSearchParams();
  if (severity) params.set('severity', severity);
  if (mode) params.set('mode', mode);
  if (ack) params.set('ackStatus', ack);
  params.set('limit', 300);
  const res = await fetch('/api/history?' + params.toString());
  const events = await res.json();
  const tbody = document.querySelector('#history-table tbody');
  tbody.innerHTML = '';
  events.forEach(e => renderHistoryRow(e, tbody));
}

function renderHistoryRow(e, tbody) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${new Date(e.timestamp).toLocaleString()}</td>
    <td>${escapeHtml(e.type)}</td>
    <td>${e.severity}</td>
    <td>${e.temperature != null ? e.temperature + '°C' : '—'}</td>
    <td>${e.vibration ? 'Yes' : 'No'}</td>
    <td>${e.mode}</td>
    <td>${e.acknowledged ? 'Yes' : 'No'}</td>`;
  tbody.appendChild(tr);
}
function prependHistoryRow(e) {
  const tbody = document.querySelector('#history-table tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${new Date(e.timestamp).toLocaleString()}</td>
    <td>${escapeHtml(e.type)}</td>
    <td>${e.severity}</td>
    <td>${e.temperature != null ? e.temperature + '°C' : '—'}</td>
    <td>${e.vibration ? 'Yes' : 'No'}</td>
    <td>${e.mode}</td>
    <td>${e.acknowledged ? 'Yes' : 'No'}</td>`;
  tbody.prepend(tr);
}

document.getElementById('histFilterBtn').addEventListener('click', loadHistory);
document.getElementById('exportCsvBtn').addEventListener('click', () => window.open('/api/export/csv'));
document.getElementById('exportJsonBtn').addEventListener('click', () => window.open('/api/export/json'));
document.getElementById('clearHistBtn').addEventListener('click', async () => {
  if (!confirm('This will permanently clear all stored readings and audit history. Continue?')) return;
  await fetch('/api/history/clear', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true })
  });
  loadHistory();
  loadAlerts();
});

// ---------------------------------------------------------------------------
// VIBRATION TABLE
// ---------------------------------------------------------------------------
async function loadVibrationEvents() {
  const res = await fetch('/api/vibration-events');
  const events = await res.json();
  const tbody = document.querySelector('#vib-table tbody');
  tbody.innerHTML = events.map(e => `<tr><td>${new Date(e.ts).toLocaleString()}</td><td>${e.temperature ?? '—'}</td><td>${e.mode}</td></tr>`).join('');
  const fiveMinAgo = Date.now() - 5 * 60000;
  document.getElementById('vib-recent').textContent = events.filter(e => new Date(e.ts).getTime() > fiveMinAgo).length;
}
setInterval(loadVibrationEvents, 8000);

// ---------------------------------------------------------------------------
// ANALYTICS / CHARTS
// ---------------------------------------------------------------------------
let charts = {};
function makeChart(id, label, color) {
  const ctx = document.getElementById(id).getContext('2d');
  return new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: 'transparent', tension: 0.25, pointRadius: 0 }] },
    options: {
      responsive: true,
      animation: false,
      scales: { x: { ticks: { maxTicksLimit: 8 } } },
      plugins: { legend: { display: false } }
    }
  });
}

function initCharts() {
  charts.temp = makeChart('tempChart', 'Temperature (°C)', '#5FD3E0');
  charts.hum = makeChart('humChart', 'Humidity (%)', '#8FD16E');
  charts.risk = makeChart('riskChart', 'Risk score', '#FF8A5C');
  charts.vib = makeChart('vibChart', 'Vibration events', '#FF5C68');
}

async function loadCharts() {
  const hours = document.getElementById('rangeSelect').value;
  const res = await fetch(`/api/readings?hours=${hours}`);
  const readings = await res.json();

  const labels = readings.map(r => new Date(r.ts).toLocaleTimeString());
  charts.temp.data.labels = labels;
  charts.temp.data.datasets[0].data = readings.map(r => r.temperature);
  charts.temp.update();

  charts.hum.data.labels = labels;
  charts.hum.data.datasets[0].data = readings.map(r => r.humidity);
  charts.hum.update();

  // approximate risk history via simple recompute proxy: show vibration flags for now,
  // real-time risk score is on the Live/Risk screens; here we chart event counts.
  const vibBuckets = {};
  readings.forEach(r => { if (r.vibration) { const k = new Date(r.ts).toLocaleTimeString(); vibBuckets[k] = (vibBuckets[k] || 0) + 1; } });
  charts.vib.data.labels = Object.keys(vibBuckets);
  charts.vib.data.datasets[0].data = Object.values(vibBuckets);
  charts.vib.update();

  const histRes = await fetch('/api/history?limit=200');
  const events = (await histRes.json()).slice().reverse().filter(e => e.riskScore != null);
  charts.risk.data.labels = events.map(e => new Date(e.timestamp).toLocaleTimeString());
  charts.risk.data.datasets[0].data = events.map(e => e.riskScore);
  charts.risk.update();

  const dataTag = readings.length && readings[0].mode === 'DEMO' ? 'DEMO DATA' : 'REAL DATA';
  document.getElementById('chartDataTag').textContent = dataTag;
}

document.getElementById('refreshCharts').addEventListener('click', loadCharts);
document.getElementById('rangeSelect').addEventListener('change', loadCharts);

// ---------------------------------------------------------------------------
// VOICE ASSISTANT
// ---------------------------------------------------------------------------
let recognition = null;
let listening = false;
const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const utter = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.speak(utter);
}

function answerVoiceQuery(query) {
  const q = query.toLowerCase();
  const s = latestState;
  if (!s) return "I don't have current data yet.";

  if (q.includes('temperature')) return `The current temperature is ${fmtTemp(s.temperature)}, mode ${s.mode}.`;
  if (q.includes('vaccine') && q.includes('safe')) return `Cold-chain condition is currently rated ${s.condition.label}. ${s.condition.reason}`;
  if (q.includes('risk')) return `The current risk score is ${s.risk.score} out of 100, categorized as ${s.risk.category}.`;
  if (q.includes('vibration')) return s.vibration ? 'Yes, vibration is currently detected.' : `No vibration currently detected. Total events so far: ${s.vibrationEventCount}.`;
  if (q.includes('alert')) return "Check the Alerts Center screen for today's alerts.";
  if (q.includes('what should i do') || q.includes('recommended action')) return s.earlyWarning ? s.earlyWarning.action : s.condition.reason;
  if (q.includes('sensor')) return s.sensorValid ? 'The sensor is working normally.' : 'The sensor is reporting a fault.';
  if (q.includes('status') || q.includes('device')) return `Device is ${s.connected ? 'online' : 'offline'}, mode ${s.mode}, state ${s.state}.`;
  return "I can answer questions about temperature, risk, vibration, alerts, sensor status, and device status.";
}

document.getElementById('voiceToggle').addEventListener('click', () => {
  if (!SpeechRecognitionImpl) {
    document.getElementById('voiceStatus').textContent = 'Browser speech recognition unavailable.';
    return;
  }
  if (!listening) {
    recognition = new SpeechRecognitionImpl();
    recognition.continuous = false;
    recognition.lang = 'en-US';
    recognition.onresult = (ev) => {
      const text = ev.results[0][0].transcript;
      const answer = answerVoiceQuery(text);
      const t = document.getElementById('voiceTranscript');
      t.textContent += `You: ${text}\nVaxGuard: ${answer}\n\n`;
      speak(answer);
    };
    recognition.onend = () => {
      listening = false;
      document.getElementById('voiceStatus').textContent = 'VOICE ASSISTANT: OFF';
      document.getElementById('voiceToggle').textContent = '🎙 Start listening';
    };
    recognition.start();
    listening = true;
    document.getElementById('voiceStatus').textContent = 'VOICE ASSISTANT: ON';
    document.getElementById('voiceToggle').textContent = '⏹ Stop listening';
  } else {
    recognition.stop();
  }
});

// ---------------------------------------------------------------------------
// EMERGENCY SCREEN
// ---------------------------------------------------------------------------
document.getElementById('getLocationBtn').addEventListener('click', () => {
  if (!navigator.geolocation) {
    document.getElementById('em-location').textContent = 'Location unavailable.';
    return;
  }
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude, longitude } = pos.coords;
    document.getElementById('em-location').textContent = `Lat ${latitude.toFixed(5)}, Lon ${longitude.toFixed(5)}`;
    const mapLink = document.getElementById('mapLink');
    mapLink.href = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
    mapLink.style.display = 'inline-block';
  }, () => {
    document.getElementById('em-location').textContent = 'Location unavailable.';
  });
});

document.getElementById('telegramTestBtn').addEventListener('click', async () => {
  const res = await fetch('/api/telegram/test', { method: 'POST' });
  const data = await res.json();
  document.getElementById('em-callresult').textContent = data.message;
});

document.getElementById('emergencyCallBtn').addEventListener('click', async () => {
  const testMode = document.getElementById('testAlertMode').checked;
  if (testMode) {
    document.getElementById('em-callresult').textContent = 'Test alert mode is ON - no real call attempted. Turn off test alert mode to place a real request.';
    return;
  }
  const res = await fetch('/api/emergency/call', { method: 'POST' });
  const data = await res.json();
  document.getElementById('em-callresult').textContent = data.message;
});

// ---------------------------------------------------------------------------
// REPORTS
// ---------------------------------------------------------------------------
document.getElementById('genReportBtn').addEventListener('click', async () => {
  const type = document.getElementById('reportType').value;
  const res = await fetch(`/api/report?type=${type}`);
  const report = await res.json();
  document.getElementById('reportOutput').innerHTML = `
    <table class="kv-table">
      <tr><td>Report type</td><td>${report.type}</td></tr>
      <tr><td>Period</td><td>${report.periodHours} hours</td></tr>
      <tr><td>Samples</td><td>${report.monitoringDurationSamples}</td></tr>
      <tr><td>Temperature min/avg/max</td><td>${report.temperature ? `${report.temperature.min} / ${report.temperature.avg} / ${report.temperature.max} °C` : 'No data'}</td></tr>
      <tr><td>Vibration events</td><td>${report.vibrationEvents}</td></tr>
      <tr><td>Alerts</td><td>${report.alerts}</td></tr>
      <tr><td>Faults</td><td>${report.faults}</td></tr>
      <tr><td>Recoveries</td><td>${report.recoveries}</td></tr>
      <tr><td>Generated</td><td>${new Date(report.generatedAt).toLocaleString()}</td></tr>
    </table>`;
});

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------
let settingsFilled = false;
function fillSettingsIfEmpty(settings) {
  if (settingsFilled) return;
  document.getElementById('set-devicename').value = settings.deviceName || '';
  document.getElementById('set-tempmin').value = settings.tempMin;
  document.getElementById('set-tempmax').value = settings.tempMax;
  document.getElementById('set-margin').value = settings.warnMargin;
  document.getElementById('set-cooldown').value = settings.alertCooldownSec;
  document.getElementById('set-vibsens').value = settings.vibrationSensitivity;
  document.getElementById('set-telegram').checked = !!settings.telegramEnabled;
  document.getElementById('set-voicealerts').checked = !!settings.voiceAlertsEnabled;
  settingsFilled = true;
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    deviceName: document.getElementById('set-devicename').value,
    tempMin: parseFloat(document.getElementById('set-tempmin').value),
    tempMax: parseFloat(document.getElementById('set-tempmax').value),
    warnMargin: parseFloat(document.getElementById('set-margin').value),
    alertCooldownSec: parseInt(document.getElementById('set-cooldown').value),
    vibrationSensitivity: document.getElementById('set-vibsens').value,
    telegramEnabled: document.getElementById('set-telegram').checked,
    voiceAlertsEnabled: document.getElementById('set-voicealerts').checked
  };
  const res = await fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const data = await res.json();
  document.getElementById('settingsSaved').textContent = data.ok ? 'Saved.' : `Error: ${data.error}`;
});

// ---------------------------------------------------------------------------
// SELF TEST
// ---------------------------------------------------------------------------
document.getElementById('runSelfTestBtn').addEventListener('click', async () => {
  const res = await fetch('/api/selftest', { method: 'POST' });
  const data = await res.json();
  const tbody = document.querySelector('#selftest-table tbody');
  tbody.innerHTML = data.results.map(r => `<tr><td>${r.item}</td><td>${r.status}</td><td>${r.detail}</td></tr>`).join('');
});

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------
initCharts();
loadCharts();
loadAlerts();
loadHistory();
loadVibrationEvents();
