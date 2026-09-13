/* VaxGuard frontend — connects to the server over Socket.io, renders live
   state, drives the demo control panel, and provides a browser voice
   assistant. Every button here calls a real backend endpoint. */

const socket = io();

let latestState = null;
let lastSpokenKey = null;
let voiceMuted = false;
let chart = null;

/* ---------------- CHART SETUP ---------------- */

function initChart() {
  const ctx = document.getElementById('riskChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Risk score',
          data: [],
          borderColor: '#f0475a',
          backgroundColor: 'rgba(240,71,90,0.12)',
          tension: 0.3,
          pointRadius: 0,
          fill: true
        },
        {
          label: 'Condition score',
          data: [],
          borderColor: '#5fd3e8',
          backgroundColor: 'transparent',
          borderDash: [4, 3],
          tension: 0.3,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      scales: {
        x: { ticks: { color: '#8fa8bd', maxTicksLimit: 8 }, grid: { color: '#1f3550' } },
        y: { min: 0, max: 100, ticks: { color: '#8fa8bd' }, grid: { color: '#1f3550' } }
      },
      plugins: { legend: { labels: { color: '#8fa8bd', boxWidth: 12 } } }
    }
  });
}

function updateChart(history) {
  const slice = history.slice(-60);
  chart.data.labels = slice.map((h) => new Date(h.timestamp).toLocaleTimeString());
  chart.data.datasets[0].data = slice.map((h) => h.riskScore);
  chart.data.datasets[1].data = slice.map((h) => h.conditionScore);
  chart.update();
}

/* ---------------- RENDER STATE ---------------- */

function el(id) { return document.getElementById(id); }

function renderState(s) {
  latestState = s;
  const reading = s.latest;

  // Mode band
  const band = el('modeband');
  band.classList.toggle('real', s.mode === 'REAL');
  el('modeText').textContent = s.mode === 'REAL'
    ? 'REAL MODE — Live sensor data (DHT11 + SW-420)'
    : 'DEMO MODE — Simulated Data';
  el('graphModeTag').textContent = s.mode === 'REAL' ? 'REAL DATA' : 'DEMO DATA';
  el('wifiPill').textContent = 'WIFI ' + (s.wifiOk ? 'OK' : 'DOWN');
  el('modeToggleBtn').textContent = s.mode === 'REAL' ? 'Switch to DEMO' : 'Switch to REAL';
  el('demoPanel').style.display = s.mode === 'DEMO' ? 'block' : 'none';

  if (!reading) return;

  el('severityLevel').textContent = reading.severity.replace('_', ' ');
  el('severityLevel').className = 'severity-level ' + reading.severity;
  el('severitySub').textContent = `Last updated ${new Date(reading.timestamp).toLocaleTimeString()} · source: ${reading.source}`;

  el('tempValue').textContent = reading.temperature.toFixed(1) + '°C';
  el('humValue').textContent = Math.round(reading.humidity) + '%';
  el('vibValue').textContent = reading.vibration ? 'DETECTED' : 'Normal';

  el('riskScoreText').textContent = reading.riskScore;
  el('riskFill').style.width = reading.riskScore + '%';
  el('conditionScoreText').textContent = reading.conditionScore;
  el('conditionFill').style.width = reading.conditionScore + '%';
  el('confidenceText').textContent = reading.confidence + '%';
  el('confidenceFill').style.width = reading.confidence + '%';

  el('trajectoryLabel').textContent = reading.trend.trend;
  el('trajectoryLabel').className = 'trajectory ' + reading.trend.trend;
  el('predictedRiskText').textContent = 'Predicted risk: ' + reading.trend.predictedRisk;
  el('priorityText').textContent = `Priority: ${reading.priority.priorityLabel} (${reading.priority.priorityScore})`;

  el('explanationText').textContent = reading.explanation + (reading.aiEnhanced ? '  [AI-enhanced]' : '');
  el('correlationText').textContent = reading.correlation || '';
  el('recommendationText').textContent = reading.recommendation;

  updateChart(s.history);
  renderIncidents(s.incidents, s.currentIncidentId);
  renderCriticalPanel(s, reading);
  maybeSpeak(s, reading);
}

function renderCriticalPanel(s, reading) {
  const incident = s.incidents.find((i) => i.id === s.currentIncidentId);
  const panel = el('criticalPanel');
  if (!incident || reading.severityLevel < 4) { panel.style.display = 'none'; return; }

  panel.style.display = 'block';
  el('criticalIncidentId').textContent = incident.id;
  el('cTemp').textContent = reading.temperature.toFixed(1) + '°C';
  el('cVib').textContent = reading.vibration ? 'DETECTED' : 'Normal';
  el('cRisk').textContent = reading.riskScore + '/100';
  el('cCond').textContent = reading.conditionScore + '/100';
  el('cHealth').textContent = reading.sensorHealth + '%';
  el('cConf').textContent = reading.confidence + '%';
  el('cTraj').textContent = reading.trend.trend;
  el('cRecovery').textContent = incident.stage === 'RESOLVED' ? `Recovered (${incident.recoveryDurationSec}s)` : incident.stage;
  el('cReason').textContent = reading.explanation;

  el('telegramStatus').textContent = 'Telegram ' + (s.telegramConfigured ? 'sent' : 'not configured');
  el('voiceStatus').textContent = 'Voice ' + (voiceMuted ? 'muted' : 'announced');
  el('callStatus').textContent = 'Call: ' + (incident.callStatus || s.callState.lastStatus);
  el('ackStatus').textContent = incident.acknowledgedBy ? `Acknowledged by ${incident.acknowledgedBy}` : 'Not acknowledged';

  el('ackBtn').onclick = () => acknowledge(incident.id);
  el('summaryBtn').onclick = () => showSummary(incident.id);
  el('replayBtn').onclick = () => showReplay(incident.id);
}

function renderIncidents(incidents, currentId) {
  const list = el('incidentList');
  list.innerHTML = '';
  incidents.slice().reverse().forEach((inc) => {
    const row = document.createElement('div');
    row.className = 'incident-row';
    row.innerHTML = `<span>${inc.id} · ${inc.mode} · peak ${['NORMAL','INFO','WARNING','HIGH','CRITICAL'][inc.severityPeak]}</span><span>${inc.stage}</span>`;
    row.onclick = () => showReplay(inc.id);
    list.appendChild(row);
  });
}

function renderAudit(entry) {
  const log = el('auditLog');
  const row = document.createElement('div');
  row.className = 'audit-row';
  row.textContent = `${new Date(entry.timestamp).toLocaleTimeString()} [${entry.mode}] ${entry.event}`;
  log.prepend(row);
  while (log.children.length > 80) log.removeChild(log.lastChild);
}

/* ---------------- VOICE ALERTS ---------------- */

function maybeSpeak(s, reading) {
  if (voiceMuted) return;
  if (reading.severityLevel < 2) return;
  const key = reading.timestamp + reading.severity;
  if (key === lastSpokenKey) return;
  lastSpokenKey = key;
  speak(reading.voiceMessage || reading.explanation);
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.0;
  window.speechSynthesis.speak(utter);
}

/* ---------------- VOICE ASSISTANT (Q&A) ---------------- */

function answerQuestion(q) {
  const s = latestState;
  const r = s && s.latest;
  if (!r) return "I don't have any readings yet.";
  const text = q.toLowerCase();

  if (text.includes('real or demo')) return `This data is currently in ${s.mode} mode.`;
  if (text.includes('temperature')) return `The current temperature is ${r.temperature.toFixed(1)} degrees Celsius.`;
  if (text.includes('sensor health')) return `Sensor health is ${r.sensorHealth} percent.`;
  if (text.includes('improving')) return `The risk trajectory is currently ${r.trend.trend.toLowerCase()}.`;
  if (text.includes('vibration')) {
    const count = r.vibCountRecent || 0;
    return `There have been ${count} vibration events in the recent monitoring window.`;
  }
  if (text.includes('why') && text.includes('risk')) return r.explanation;
  if (text.includes('caused') || text.includes('cause')) return r.correlation || r.explanation;
  if (text.includes('what should i do') || text.includes('do now')) return r.recommendation;
  if (text.includes('latest incident')) {
    const inc = s.incidents[s.incidents.length - 1];
    return inc ? `The latest incident is ${inc.id}, currently in stage ${inc.stage}.` : 'There is no incident on record yet.';
  }
  if (text.includes('happening')) return `Current severity is ${r.severity.replace('_', ' ')}. ${r.explanation}`;
  return `Current severity is ${r.severity.replace('_', ' ')} with a risk score of ${r.riskScore} out of 100.`;
}

function startVoiceQuestion() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    const q = prompt('Voice recognition is not supported in this browser. Type your question instead:');
    if (q) respondToQuestion(q);
    return;
  }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.onresult = (e) => respondToQuestion(e.results[0][0].transcript);
  rec.onerror = () => { el('assistantAnswer').textContent = 'Could not hear a question — please try again.'; };
  rec.start();
}

function respondToQuestion(q) {
  const answer = answerQuestion(q);
  el('assistantAnswer').textContent = `Q: ${q}\nA: ${answer}`;
  speak(answer);
}

/* ---------------- API HELPERS ---------------- */

async function postJSON(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return resp.json();
}

async function runDemoCommand(cmd) { await postJSON('/api/demo/' + cmd); }

async function acknowledge(incidentId) {
  const by = prompt('Your name (for the acknowledgement record):', 'Operator') || 'Operator';
  await postJSON(`/api/incidents/${incidentId}/acknowledge`, { by });
}

async function showSummary(incidentId) {
  const resp = await fetch(`/api/summary/${incidentId}`);
  const summary = await resp.json();
  el('incidentDetail').textContent =
`AI INCIDENT SUMMARY ${summary.aiGenerated ? '(AI-generated)' : '(rule-based)'}
${summary.narrative ? summary.narrative + '\n\n' : ''}What happened: ${summary.whatHappened}
When: ${summary.whenItHappened}
How severe: ${summary.howSevere}
What changed: ${summary.whatChanged}
Risk progression: ${summary.riskProgression.join(', ')}
Recovery occurred: ${summary.recoveryOccurred ? 'Yes' : 'No'}${summary.recoveryDurationSec ? ' (' + summary.recoveryDurationSec + 's)' : ''}
Recommended follow-up: ${summary.recommendedFollowUp}`;
}

async function showReplay(incidentId) {
  const resp = await fetch(`/api/incidents/${incidentId}/replay`);
  const replay = await resp.json();
  el('incidentDetail').textContent =
`INCIDENT REPLAY — ${replay.incidentId}
BEFORE (${replay.before.length} events): first temp ${replay.before[0] ? replay.before[0].temperature : '—'}°C
DURING (${replay.during.length} events)
PEAK: ${replay.peak ? `${replay.peak.temperature}°C, risk ${replay.peak.riskScore}, severity ${replay.peak.severity}` : '—'}
RECOVERY (${replay.recovery.length} events)`;
}

/* ---------------- WIRE UP EVENTS ---------------- */

document.querySelectorAll('.demo-btn[data-cmd]').forEach((btn) => {
  btn.addEventListener('click', () => runDemoCommand(btn.dataset.cmd));
});

el('modeToggleBtn').addEventListener('click', () => {
  const newMode = latestState && latestState.mode === 'REAL' ? 'DEMO' : 'REAL';
  postJSON('/api/mode', { mode: newMode });
});

el('testTelegramBtn').addEventListener('click', async () => {
  const r = await postJSON('/api/test/telegram');
  alert(r.ok ? 'Telegram test message sent.' : 'Telegram test failed: ' + (r.reason || 'not configured'));
});

el('testCallBtn').addEventListener('click', async () => {
  const r = await postJSON('/api/test/call');
  alert(r.ok ? 'Test call triggered.' : 'Test call failed: ' + (r.reason || 'not configured'));
});

el('voiceAskBtn').addEventListener('click', startVoiceQuestion);
el('voiceMuteBtn').addEventListener('click', () => {
  voiceMuted = !voiceMuted;
  el('voiceMuteBtn').textContent = voiceMuted ? 'Unmute spoken alerts' : 'Mute spoken alerts';
});

/* ---------------- SOCKET EVENTS ---------------- */

socket.on('state', renderState);
socket.on('audit', renderAudit);

window.addEventListener('DOMContentLoaded', initChart);
