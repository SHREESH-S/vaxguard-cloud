/* =========================================================================
   VAXGUARD PRO v4.0 — Frontend Controller & WebSocket Client
   ========================================================================= */

let ws;
let tempChart = null;

function switchScreen(screenId, event) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('screen-' + screenId).classList.add('active');
  if (event) event.target.classList.add('active');
  if (screenId === 'graph' && tempChart) {
    tempChart.update();
  }
}

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(protocol + window.host);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      updateDashboard(data);
    } catch (e) {
      console.error("WS Parse error:", e);
    }
  };

  ws.onclose = () => {
    setTimeout(initWebSocket, 3000);
  };
}

function updateDashboard(data) {
  document.getElementById('locationLabel').innerText = data.locationLabel || "Pharmacy Main Unit A";
  document.getElementById('valTemp').innerText = data.temperature.toFixed(1) + " °C";
  document.getElementById('valHum').innerText = data.humidity.toFixed(1) + " %";
  document.getElementById('valVib').innerText = data.vibration ? "⚠️ DETECTED" : "Normal";
  document.getElementById('valState').innerText = data.state;
  document.getElementById('valRisk').innerText = data.riskScore + "/100";
  document.getElementById('valPotency').innerText = data.potencyRetention + "%";
  document.getElementById('valComp').innerText = data.compressorHealth + "%";
  document.getElementById('valConfidence').innerText = data.dataConfidence + "%";
  document.getElementById('valAdvisory').innerText = data.advisoryMsg;

  document.getElementById('vibRealState').innerText = data.vibration ? "⚠️ SHOCK DETECTED" : "Normal";
  document.getElementById('vibLog').innerText = data.vibration ? "Mechanical shock pulse registered via SW-420 sensor." : "Stable mechanical profile.";

  document.getElementById('aiTrend').innerText = data.trend;
  document.getElementById('aiPredRisk').innerText = data.predictedRisk + "/100";
  document.getElementById('aiAnomaly').innerText = data.anomalyScore + "/100";
  document.getElementById('aiCorrelation').innerText = data.correlationMsg;

  const modeBadge = document.getElementById('modeBadge');
  modeBadge.innerText = data.mode + " MODE";
  modeBadge.className = "status-badge " + (data.mode === 'REAL' ? 'real' : 'demo');

  const stateBadge = document.getElementById('stateBadge');
  stateBadge.innerText = data.state;
  stateBadge.className = "status-badge " + (data.state === 'SAFE' ? 'safe' : (data.state === 'WARNING' ? 'warn' : 'crit'));

  const banner = document.getElementById('emergencyBanner');
  if (data.state === 'CRITICAL' || data.state === 'SENSOR_FAULT') {
    banner.classList.remove('hidden');
    document.getElementById('emergencyText').innerText = data.advisoryMsg;
    speakAlert(data.advisoryMsg);
  } else {
    banner.classList.add('hidden');
  }

  fetchHistoryAndAudit();
}

function speakAlert(text) {
  if (!('speechSynthesis' in window)) return;
  const now = Date.now();
  if (window.lastSpoken && now - window.lastSpoken < 25000) return;
  window.lastSpoken = now;
  const utter = new SpeechSynthesisUtterance(text);
  speechSynthesis.speak(utter);
}

function initChart() {
  const ctx = document.getElementById('tempChart').getContext('2d');
  tempChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Temperature (°C)',
        data: [],
        borderColor: '#0ea5e9',
        backgroundColor: 'rgba(14, 165, 233, 0.1)',
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { grid: { color: '#1e293b' }, ticks: { color: '#94a3b8' } },
        x: { grid: { display: false }, ticks: { color: '#94a3b8' } }
      }
    }
  });
}

async function fetchHistoryAndAudit() {
  try {
    const res = await fetch('/api/history');
    const json = await res.json();
    if (json.ok && tempChart) {
      tempChart.data.labels = json.history.map(h => new Date(h.time).toLocaleTimeString());
      tempChart.data.datasets[0].data = json.history.map(h => h.temp);
      tempChart.update('none');
    }

    const analyticsRes = await fetch('/api/analytics');
    const analyticsJson = await analyticsRes.json();
    if (analyticsJson.ok) {
      document.getElementById('statMin').innerText = analyticsJson.analytics.min.toFixed(1);
      document.getElementById('statMax').innerText = analyticsJson.analytics.max.toFixed(1);
      document.getElementById('statAvg').innerText = analyticsJson.analytics.avg.toFixed(1);
    }

    const alertRes = await fetch('/api/alerts');
    const alertJson = await alertRes.json();
    if (alertJson.ok && alertJson.alerts.length > 0) {
      document.getElementById('alertList').innerHTML = alertJson.alerts.map(a =>
        `<div>[${a.timestamp}] <strong>${a.priority}</strong>: ${a.message}</div>`
      ).join('');
    }

    const auditRes = await fetch('/api/audit');
    const auditJson = await auditRes.json();
    if (auditJson.ok && auditJson.audit.length > 0) {
      document.getElementById('auditTableBody').innerHTML = auditJson.audit.map(r =>
        `<tr><td>${r.timestamp}</td><td>${r.temp.toFixed(1)}</td><td>${r.humidity.toFixed(1)}</td><td>${r.vibration ? 'Yes' : 'No'}</td><td>${r.state}</td><td>${r.risk}</td><td>${r.mode}</td></tr>`
      ).join('');
    }
  } catch (e) {
    console.error("Fetch error:", e);
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const q = input.value.trim();
  if (!q) return;

  const chatHistory = document.getElementById('chatHistory');
  chatHistory.innerHTML += `<div class="chat-msg user">${q}</div>`;
  input.value = '';
  chatHistory.scrollTop = chatHistory.scrollHeight;

  try {
    const res = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q })
    });
    const json = await res.json();
    const answer = json.ok ? json.answer : "Assistant unavailable.";
    chatHistory.innerHTML += `<div class="chat-msg bot">${answer}</div>`;
    chatHistory.scrollTop = chatHistory.scrollHeight;
    speakAlert(answer);
  } catch (err) {
    chatHistory.innerHTML += `<div class="chat-msg bot">Error reaching AI assistant.</div>`;
  }
}

function startVoiceRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert("Speech recognition is not supported in this browser.");
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.onresult = (event) => {
    document.getElementById('chatInput').value = event.results[0][0].transcript;
    sendChatMessage();
  };
  recognition.start();
}

window.onload = () => {
  initWebSocket();
  initChart();
};
