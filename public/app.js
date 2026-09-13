// ============================================================
// VaxGuard dashboard client
// All numbers shown here come from the server's dashboard:update
// payload (see server.js). Nothing is invented client-side.
// ============================================================

const socket = io();
let latest = null;
let charts = {};

// ---------------- Navigation ----------------
const navList = document.getElementById('navList');
const screens = document.querySelectorAll('.screen');
navList.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-screen]');
  if (!li) return;
  document.querySelectorAll('#navList li').forEach(x => x.classList.remove('active'));
  li.classList.add('active');
  const target = li.dataset.screen;
  screens.forEach(s => s.classList.toggle('active', s.id === 'screen-' + target));
  document.getElementById('sidebar').classList.remove('open');
  if (target === 'analytics') loadHistoryCharts();
  if (target === 'audit') loadAudit();
  if (target === 'alerts') loadAlertsTable();
});

document.getElementById('hamburger').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// ---------------- Theme ----------------
const html = document.documentElement;
html.setAttribute('data-theme', localStorage.getItem('vg_theme') || 'dark');
document.getElementById('themeToggle').addEventListener('click', () => {
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('vg_theme', next);
});

// ---------------- Alert drawer ----------------
const drawer = document.getElementById('alertDrawer');
document.getElementById('alertDrawerBtn').addEventListener('click', () => drawer.classList.add('open'));
document.getElementById('closeDrawer').addEventListener('click', () => drawer.classList.remove('open'));
let drawerAlerts = [];
function renderDrawer() {
  const list = document.getElementById('drawerList');
  list.innerHTML = drawerAlerts.slice().reverse().map(a => `
    <div class="drawer-item">
      <strong>${a.severity}</strong> — ${a.message}<br/>
      <span class="small-note">${new Date(a.timestamp).toLocaleString()}</span>
    </div>`).join('') || '<p class="small-note">No alerts yet.</p>';
  document.getElementById('alertCount').textContent = drawerAlerts.filter(a => !a.acknowledged).length;
}

// ---------------- Socket events ----------------
socket.on('connect', () => document.getElementById('connIndicator').textContent = '● connected');
socket.on('disconnect', () => document.getElementById('connIndicator').textContent = '● disconnected');

socket.on('dashboard:update', (payload) => {
  latest = payload;
  render(payload);
});

socket.on('alert:new', (alert) => {
  drawerAlerts.push(alert);
  renderDrawer();
  maybeSpeakAlert(alert);
});
socket.on('alert:updated', (alert) => {
  const i = drawerAlerts.findIndex(a => a.id === alert.id);
  if (i >= 0) drawerAlerts[i] = alert;
  renderDrawer();
});
socket.on('event:new', () => { /* audit list refreshes on demand */ });

fetch('/api/alerts').then(r => r.json()).then(a => { drawerAlerts = a; renderDrawer(); });

// ---------------- Render dashboard ----------------
function render(p) {
  const stateLabel = p.currentState || 'OFFLINE';
  const modePill = document.getElementById('modePill');
  const statePill = document.getElementById('statePill');
  modePill.textContent = 'MODE: ' + p.mode;
  statePill.textContent = 'STATE: ' + stateLabel;
  statePill.className = 'state-pill state-' + stateLabel;

  const dataLabel = p.mode === 'DEMO' ? 'DEMO DATA' : 'REAL SENSOR DATA';

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  // Overview
  set('ov-temp', fmtTemp(p.temperature));
  set('ov-hum', fmtPct(p.humidity));
  set('ov-vib', p.vibration ? 'DETECTED' : 'NONE');
  set('ov-risk', `${p.risk.score}/100 (${p.risk.category})`);
  set('ov-cond', p.advisory.result.replace('_', ' '));
  set('ov-device', p.deviceOnline ? 'ONLINE' : 'OFFLINE');
  set('ov-datalabel', dataLabel);

  // Live monitor
  set('lv-temp', fmtTemp(p.temperature));
  set('lv-hum', fmtPct(p.humidity));
  set('lv-vib', p.vibration ? 'VIBRATION DETECTED' : 'STABLE');
  set('lv-risk', `${p.risk.score}/100`);
  set('lv-health', `${p.sensorHealth.score}%`);
  set('lv-mode', p.mode + ' (' + dataLabel + ')');
  set('lv-updated', new Date(p.serverTime).toLocaleTimeString());
  set('lv-quality', p.sensorHealth.freshness);

  // Risk
  const scoreEl = document.getElementById('risk-score-big');
  if (scoreEl) { scoreEl.textContent = p.risk.score; scoreEl.style.color = riskColor(p.risk.score); }
  set('risk-category', p.risk.category.replace('_', ' '));
  const reasonsEl = document.getElementById('risk-reasons');
  if (reasonsEl) reasonsEl.innerHTML = p.risk.reasons.map(r => `<li>+${r.points} — ${r.reason}</li>`).join('') || '<li>No contributing risk factors currently.</li>';

  // Vibration
  set('vib-1m', p.risk.vibration.countLast1Min);
  set('vib-10m', p.risk.vibration.countLast10Min);
  set('vib-class', p.risk.vibration.classification.replace(/_/g, ' '));
  set('vib-total', p.risk.vibration.totalRecorded);

  // Prediction / early warning
  set('ew-level', p.earlyWarning.level.replace('_', ' '));
  set('ew-message', p.earlyWarning.message);
  set('ew-action', p.earlyWarning.recommendedAction);
  set('ew-label', p.earlyWarning.label);
  set('ew-direction', p.risk.trend.direction);
  set('ew-slope', p.risk.trend.slope);
  set('ew-confidence', p.risk.trend.confidence);

  // Condition advisory
  set('cond-result', p.advisory.result.replace('_', ' '));
  set('cond-reason', p.advisory.reason);
  set('cause-most', p.rootCause.mostLikely);
  set('cause-inspection', p.rootCause.recommendedInspection);
  const causeList = document.getElementById('cause-list');
  if (causeList) causeList.innerHTML = p.rootCause.causes.map(c => `<li>${c}</li>`).join('');
  set('cause-combined', p.rootCause.combinedEvent || '');

  // Sensor health
  const sh = p.sensorHealth;
  const grid = document.getElementById('sensorHealthGrid');
  if (grid) grid.innerHTML = `
    <div class="card"><div class="card-label">DHT11</div><div class="card-value">${sh.dht11}</div></div>
    <div class="card"><div class="card-label">Temperature</div><div class="card-value">${sh.temperatureValid ? 'VALID' : 'INVALID'}</div></div>
    <div class="card"><div class="card-label">Humidity</div><div class="card-value">${sh.humidityValid ? 'VALID' : 'INVALID'}</div></div>
    <div class="card"><div class="card-label">SW-420</div><div class="card-value">${sh.sw420}</div></div>
    <div class="card"><div class="card-label">ESP32</div><div class="card-value">${sh.esp32}</div></div>
    <div class="card"><div class="card-label">Wi-Fi</div><div class="card-value">${sh.wifi}</div></div>
    <div class="card"><div class="card-label">Data freshness</div><div class="card-value">${sh.freshness}</div></div>
    <div class="card"><div class="card-label">Sensor Health Score</div><div class="card-value">${sh.score}%</div></div>
  `;

  // Digital twin / device health
  set('dt-id', p.settings.deviceId);
  set('dt-mode', p.mode);
  set('dt-temp', fmtTemp(p.temperature));
  set('dt-hum', fmtPct(p.humidity));
  set('dt-vib', p.vibration ? 'YES' : 'NO');
  set('dt-risk', `${p.risk.score}/100`);
  set('dt-conn', p.deviceOnline ? 'ONLINE' : 'OFFLINE');
  set('dt-health', `${p.sensorHealth.score}%`);
  set('dt-lastseen', p.lastEsp32Update ? new Date(p.lastEsp32Update).toLocaleString() : 'Never');

  // Network
  set('net-wifi', p.wifi ? 'CONNECTED' : 'DISCONNECTED');
  set('net-server', p.deviceOnline ? 'CONNECTED' : 'DISCONNECTED');
  set('net-heartbeat', p.lastHeartbeat ? new Date(p.lastHeartbeat).toLocaleTimeString() : 'None yet');

  // Emergency panel
  set('em-severity', p.currentState);
  set('em-risk', `${p.risk.score}/100`);
  set('em-temp', fmtTemp(p.temperature));
  set('em-vib', p.vibration ? 'DETECTED' : 'NONE');
  set('em-health', `${p.sensorHealth.score}%`);
  set('em-device', p.deviceOnline ? 'ONLINE' : 'OFFLINE');
  set('em-action', p.earlyWarning.recommendedAction);
  const lastAlert = drawerAlerts[drawerAlerts.length - 1];
  set('em-lastevent', lastAlert ? `${lastAlert.severity}: ${lastAlert.message}` : 'None');
}

function fmtTemp(t) { return (typeof t === 'number' && !Number.isNaN(t)) ? t.toFixed(1) + ' °C' : 'SENSOR FAULT'; }
function fmtPct(h) { return (typeof h === 'number' && !Number.isNaN(h)) ? h.toFixed(0) + ' %' : '--'; }
function riskColor(score) {
  if (score > 80) return 'var(--red)';
  if (score > 40) return 'var(--amber)';
  return 'var(--green)';
}

// ---------------- Charts ----------------
async function loadHistoryCharts() {
  const range = document.getElementById('rangeSelect').value;
  const history = await fetch('/api/history?range=' + range).then(r => r.json());
  const labels = history.map(h => new Date(h.timestamp).toLocaleTimeString());

  buildChart('tempChart', 'Temperature (°C)', labels, history.map(h => h.temperature), '#3aa0ff');
  buildChart('humChart', 'Humidity (%)', labels, history.map(h => h.humidity), '#2ecc71');
  // risk isn't stored per-history-sample; approximate via a rolling call not needed - show flat placeholder note
  buildChart('riskChart', 'Vibration (1 = event)', labels, history.map(h => h.vibration ? 1 : 0), '#f5a623');
}
document.getElementById('rangeSelect').addEventListener('change', loadHistoryCharts);

function buildChart(canvasId, label, labels, data, color) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label, data, borderColor: color, tension: .25, pointRadius: 0 }] },
    options: { responsive: true, scales: { x: { display: false } } }
  });
}

// ---------------- Audit history ----------------
async function loadAudit() {
  const severity = document.getElementById('auditSeverity').value;
  const mode = document.getElementById('auditMode').value;
  const q = new URLSearchParams();
  if (severity) q.set('severity', severity);
  if (mode) q.set('mode', mode);
  const events = await fetch('/api/events?' + q.toString()).then(r => r.json());
  const search = document.getElementById('auditSearch').value.toLowerCase();
  const filtered = search ? events.filter(e => e.message.toLowerCase().includes(search)) : events;
  const tbody = document.querySelector('#auditTable tbody');
  tbody.innerHTML = filtered.slice().reverse().map(e => `
    <tr>
      <td>${new Date(e.timestamp).toLocaleString()}</td>
      <td>${e.type}</td>
      <td>${e.severity || ''}</td>
      <td>${typeof e.temperature === 'number' ? e.temperature.toFixed(1) : ''}</td>
      <td>${e.mode || ''}</td>
      <td>${e.message}</td>
      <td>${e.acknowledged ? '✅' : '—'}</td>
    </tr>`).join('');
}
document.getElementById('auditRefresh').addEventListener('click', loadAudit);
document.getElementById('auditSearch').addEventListener('input', loadAudit);
document.getElementById('auditSeverity').addEventListener('change', loadAudit);
document.getElementById('auditMode').addEventListener('change', loadAudit);
document.getElementById('exportCsvBtn').addEventListener('click', () => window.location = '/api/export/csv');
document.getElementById('exportJsonBtn').addEventListener('click', () => window.location = '/api/export/json');

// ---------------- Alerts table ----------------
async function loadAlertsTable() {
  const alerts = await fetch('/api/alerts').then(r => r.json());
  const tbody = document.querySelector('#alertsTable tbody');
  tbody.innerHTML = alerts.slice().reverse().map(a => `
    <tr>
      <td>${new Date(a.timestamp).toLocaleString()}</td>
      <td>${a.type}</td>
      <td>${a.severity}</td>
      <td>${a.message}</td>
      <td>${a.acknowledged ? 'Acknowledged' : (a.muted ? 'Muted' : 'Active')}</td>
      <td>
        ${!a.acknowledged ? `<button data-ack="${a.id}">Ack</button>` : ''}
        ${!a.muted ? `<button data-mute="${a.id}">Mute</button>` : ''}
      </td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', () => socket.emit('alert:ack', { id: b.dataset.ack, source: 'dashboard' })));
  tbody.querySelectorAll('[data-mute]').forEach(b => b.addEventListener('click', () => socket.emit('alert:mute', { id: b.dataset.mute })));
}
socket.on('alert:new', loadAlertsTable);
socket.on('alert:updated', loadAlertsTable);

// ---------------- Settings ----------------
async function loadSettingsForm() {
  const s = await fetch('/api/settings').then(r => r.json());
  const form = document.getElementById('settingsForm');
  for (const key of Object.keys(s)) {
    const field = form.elements[key];
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = !!s[key];
    else field.value = s[key];
  }
}
loadSettingsForm();

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    deviceName: form.deviceName.value,
    deviceId: form.deviceId.value,
    tempMin: parseFloat(form.tempMin.value),
    tempMax: parseFloat(form.tempMax.value),
    warningMargin: parseFloat(form.warningMargin.value),
    criticalMargin: parseFloat(form.criticalMargin.value),
    alertCooldownMs: parseInt(form.alertCooldownMs.value, 10),
    voiceAlertsEnabled: form.voiceAlertsEnabled.checked,
    telegramEnabled: form.telegramEnabled.checked
  };
  const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await res.json();
  document.getElementById('settingsResult').textContent = res.ok ? 'Settings saved.' : ('Error: ' + result.error);
});

// ---------------- Self-test ----------------
document.getElementById('runSelfTestBtn').addEventListener('click', async () => {
  const results = await fetch('/api/selftest').then(r => r.json());
  const grid = document.getElementById('selfTestGrid');
  grid.innerHTML = Object.entries(results).map(([k, v]) => `
    <div class="card">
      <div class="card-label">${k}</div>
      <div class="card-value" style="color:${v.status === 'PASS' ? 'var(--green)' : v.status === 'FAIL' ? 'var(--red)' : 'var(--amber)'}">${v.status}</div>
      <div class="small-note">${v.detail || ''}</div>
    </div>`).join('');
});

// ---------------- Reports ----------------
document.getElementById('genReportBtn').addEventListener('click', async () => {
  const kind = document.getElementById('reportKind').value;
  const report = await fetch('/api/report/' + kind).then(r => r.json());
  document.getElementById('reportOutput').textContent = JSON.stringify(report, null, 2);
});

// ---------------- Location ----------------
document.getElementById('getLocationBtn').addEventListener('click', () => {
  if (!navigator.geolocation) {
    document.getElementById('loc-status').textContent = 'Location unavailable (browser geolocation not supported).';
    return;
  }
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    await fetch('/api/location', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: latitude, lng: longitude }) });
    document.getElementById('loc-latlng').textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    document.getElementById('loc-status').textContent = 'Location obtained.';
    const link = document.getElementById('openMapLink');
    link.href = `https://www.google.com/maps?q=${latitude},${longitude}`;
    link.style.display = 'inline-block';
  }, (err) => {
    document.getElementById('loc-status').textContent = 'Location unavailable (' + err.message + ').';
  });
});
fetch('/api/location').then(r => r.json()).then(loc => {
  if (loc && loc.lat) {
    document.getElementById('loc-latlng').textContent = `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
    document.getElementById('loc-status').textContent = 'Last known location loaded.';
  } else {
    document.getElementById('loc-status').textContent = 'Location unavailable';
  }
});
if (latest) document.getElementById('loc-device').textContent = latest.settings?.deviceId || '--';
socket.on('dashboard:update', p => { document.getElementById('loc-device').textContent = p.settings.deviceId; });

// ---------------- Emergency panel ----------------
document.getElementById('emTelegramTest').addEventListener('click', async () => {
  const result = await fetch('/api/telegram/test', { method: 'POST' }).then(r => r.json());
  document.getElementById('emCallResult').textContent = result.sent ? 'Telegram test sent successfully.' : ('Telegram not sent: ' + result.reason);
});
document.getElementById('emCallBtn').addEventListener('click', async () => {
  const testMode = document.getElementById('testAlertMode').checked;
  if (testMode) {
    document.getElementById('emCallResult').textContent = 'TEST ALERT MODE is on - no real call attempted.';
    return;
  }
  const result = await fetch('/api/emergency/call', { method: 'POST' }).then(r => r.json());
  document.getElementById('emCallResult').textContent = result.message;
});
document.getElementById('emAckAll').addEventListener('click', () => {
  drawerAlerts.filter(a => !a.acknowledged).forEach(a => socket.emit('alert:ack', { id: a.id, source: 'emergency-panel' }));
});
document.getElementById('emMuteAll').addEventListener('click', () => {
  drawerAlerts.forEach(a => socket.emit('alert:mute', { id: a.id }));
});

// ---------------- Voice assistant ----------------
let recognition = null;
let listening = false;
let voiceAlertsEnabled = true;
let lastSpokenAlertId = null;

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const utter = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.speak(utter);
}

function logTranscript(who, text) {
  const el = document.getElementById('voiceTranscript');
  const line = document.createElement('div');
  line.textContent = `${who}: ${text}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function answerVoiceQuery(q) {
  if (!latest) return "I don't have live data yet.";
  const s = q.toLowerCase();
  if (s.includes('temperature')) return `Temperature is ${fmtTemp(latest.temperature)}, mode is ${latest.mode}.`;
  if (s.includes('safe') || s.includes('vaccine')) return `Cold-chain condition is currently ${latest.advisory.result.replace('_',' ')}. ${latest.advisory.reason}`;
  if (s.includes('risk')) return `Current risk score is ${latest.risk.score} out of 100, classified as ${latest.risk.category.replace('_',' ')}.`;
  if (s.includes('vibration')) return latest.vibration ? 'Yes, vibration is currently detected.' : `No vibration currently detected. ${latest.risk.vibration.countLast10Min} events in the last 10 minutes.`;
  if (s.includes('alert')) return drawerAlerts.length ? `There are ${drawerAlerts.length} alerts. Most recent: ${drawerAlerts[drawerAlerts.length-1].message}` : 'No alerts recorded today.';
  if (s.includes('should i do') || s.includes('recommended')) return latest.earlyWarning.recommendedAction;
  if (s.includes('sensor')) return latest.sensorFault ? 'Sensor fault detected.' : `Sensor is working. Sensor health score is ${latest.sensorHealth.score} percent.`;
  if (s.includes('status') || s.includes('device')) return `Device is ${latest.deviceOnline ? 'online' : 'offline'}, mode is ${latest.mode}, state is ${latest.currentState}.`;
  return "I can answer questions about temperature, risk, vibration, alerts, sensor status, or device status.";
}

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRecognitionImpl) {
  document.getElementById('voiceUnsupported').style.display = 'block';
  document.getElementById('voiceToggle').disabled = true;
} else {
  recognition = new SpeechRecognitionImpl();
  recognition.continuous = false;
  recognition.lang = 'en-US';
  recognition.onresult = (event) => {
    const text = event.results[0][0].transcript;
    logTranscript('You', text);
    const answer = answerVoiceQuery(text);
    logTranscript('VaxGuard', answer);
    speak(answer);
  };
  recognition.onend = () => { listening = false; updateVoiceUI(); };
}

function updateVoiceUI() {
  document.getElementById('voiceStatus').textContent = listening ? 'ON' : 'OFF';
  document.getElementById('voiceToggle').textContent = listening ? '⏹️ Stop Listening' : '🎙️ Start Listening';
}
document.getElementById('voiceToggle').addEventListener('click', () => {
  if (!recognition) return;
  if (listening) { recognition.stop(); }
  else { recognition.start(); listening = true; }
  updateVoiceUI();
});
document.getElementById('voiceAlertsToggle').addEventListener('click', (e) => {
  voiceAlertsEnabled = !voiceAlertsEnabled;
  e.target.textContent = `🔊 Voice Alerts: ${voiceAlertsEnabled ? 'ON' : 'OFF'}`;
});

function maybeSpeakAlert(alert) {
  if (!voiceAlertsEnabled) return;
  if (!['WARNING', 'HIGH', 'CRITICAL', 'DANGEROUS'].includes(alert.severity)) return;
  if (lastSpokenAlertId === alert.id) return;
  lastSpokenAlertId = alert.id;
  speak(alert.message);
}

// initial chart load if analytics tab becomes active later
