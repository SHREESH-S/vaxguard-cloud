const socket = io();

let latestState = null;

function el(id) {
  return document.getElementById(id);
}

function renderState(s) {
  latestState = s;
  const reading = s.latest;

  // Mode
  el('modeText').textContent = s.mode === 'REAL' 
    ? 'REAL MODE — Live Sensors' 
    : 'DEMO MODE — Simulated Data';
  
  el('modeband').style.background = s.mode === 'REAL' ? '#064e3b' : '#1e293b';
  el('wifiPill').textContent = s.wifiOk ? 'WIFI OK' : 'WIFI DOWN';

  // Show/hide demo panel
  el('demoPanel').style.display = s.mode === 'DEMO' ? 'block' : 'none';

  if (!reading) return;

  // Severity
  el('severityLevel').textContent = reading.severity || 'NORMAL';
  el('severitySub').textContent = `Updated: ${new Date(reading.timestamp).toLocaleTimeString()} | Source: ${reading.source || '—'}`;

  // Values
  el('tempValue').textContent = (reading.temperature?.toFixed(1) || '--') + ' °C';
  el('humValue').textContent = (reading.humidity ? Math.round(reading.humidity) : '--') + ' %';
  el('vibValue').textContent = reading.vibration ? 'DETECTED' : 'Normal';
  el('riskValue').textContent = reading.riskScore ?? '--';

  // Text
  el('explanationText').textContent = reading.explanation || '';
  el('recommendationText').textContent = reading.recommendation || '';
  el('mythText').textContent = reading.livingMyth || s.livingMyth || '';
}

// Demo buttons
document.querySelectorAll('.demo-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const cmd = btn.dataset.cmd;
    try {
      await fetch('/api/demo/' + cmd, { method: 'POST' });
    } catch (e) {
      console.error(e);
    }
  });
});

// Mode toggle
el('modeToggleBtn').addEventListener('click', async () => {
  if (!latestState) return;
  const newMode = latestState.mode === 'REAL' ? 'DEMO' : 'REAL';
  try {
    await fetch('/api/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: newMode })
    });
  } catch (e) {
    console.error(e);
  }
});

// Socket
socket.on('state', renderState);

// Initial load
fetch('/api/state')
  .then(r => r.json())
  .then(renderState)
  .catch(console.error);