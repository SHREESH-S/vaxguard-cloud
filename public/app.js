/* =========================================================================
   VAXGUARD PRO — Frontend Web Client & WebSocket Controller
   ========================================================================= */

let ws;
let tempChart = null;
let voiceEnabled = false;

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
      console.error("Failed to parse WebSocket message:", e);
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
  document.getElementById('valCondition').innerText = data.conditionScore + "/100";
  document.getElementById('valHealth').innerText = data.sensorHealth + "%";
  document.getElementById('valConfidence').innerText = data.dataConfidence + "%";
  document.getElementById('valAdvisory').innerText = data.advisoryMsg;

  // Mode badge
  const modeBadge = document.getElementById('modeBadge');
  modeBadge.innerText = data.mode + " MODE";
  modeBadge.className = "status-badge " + (data.mode === 'REAL' ? 'real' : 'demo');

  // State badge
  const stateBadge = document.getElementById('stateBadge');
  stateBadge.innerText = data.state;
  stateBadge.className = "status-badge " + (data.state === 'SAFE' ? 'safe' : (data.state === 'WARNING' ? 'warn' : 'crit'));

  // Emergency banner
  const banner = document.getElementById('emergencyBanner');
  if (data.state === 'CRITICAL' || data.state === 'SENSOR_FAULT') {
    banner.classList.remove('hidden');
    document.getElementById('emergencyText').innerText = data.advisoryMsg;
    speakAlert(data.advisoryMsg);
  } else {
    banner.classList.add('hidden');
  }

  // AI Insights
  document.getElementById('insightExplanation').innerText = data.advisoryMsg;
  document.getElementById('insightTrend').innerText = data.trend;
  document.getElementById('insightPredRisk').innerText = data.predictedRisk + "/100";
  document.getElementById('insightAnomaly').innerText = data.anomalyScore + "/100";
  document.getElementById('insightCorrelation').innerText = data.correlationMsg;

  // System Health
  document.getElementById('healthDht').innerText = data.sensorFault ? "FAIL" : "OK";
  document.getElementById('healthWifi').innerText = data.wifiOk ? "Connected" : "Disconnected";
  document.getElementById('healthUptime').innerText = data.uptimeSec + "s";

  // Fetch History & Audit updates
  fetchHistoryAndAudit();
}

function speakAlert(text) {
  if (!('speechSynthesis' in window)) return;
  // Cooldown check to prevent voice spam
  const now = Date.now();
  if (window.lastSpoken && now - window.lastSpoken < 20000) return;
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
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56, 189, 248, 0.1)',
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { grid: { color: '#334155' }, ticks: { color: '#94a3b8' } },
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
      document.getElementById('alertCenterList').innerHTML = alertJson.alerts.map(a =>
        `<div>[${a.timestamp}] <strong>${a.priority}</strong>: ${a.message}</div>`
      ).join('');
    }

    const incidentRes = await fetch('/api/incidents');
    const incidentJson = await incidentRes.json();
    if (incidentJson.ok && incidentJson.incidents.length > 0) {
      document.getElementById('timelineList').innerHTML = incidentJson.incidents.map(i =>
        `<div>[${i.timestamp}] <strong>${i.type}</strong> - ${i.description}</div>`
      ).join('');
    }
  } catch (e) {
    console.error("Failed to fetch history/audit:", e);
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
    const answer = json.ok ? json.answer : "Sorry, I could not process your question.";
    chatHistory.innerHTML += `<div class="chat-msg bot">${answer}</div>`;
    chatHistory.scrollTop = chatHistory.scrollHeight;
    speakAlert(answer);
  } catch (err) {
    chatHistory.innerHTML += `<div class="chat-msg bot">Error connecting to assistant service.</div>`;
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
    const speechToText = event.results[0][0].transcript;
    document.getElementById('chatInput').value = speechToText;
    sendChatMessage();
  };
  recognition.start();
}

async function testTelegramAlert() {
  const res = await fetch('/api/alerts/test', { method: 'POST' });
  const json = await res.json();
  alert(json.ok ? "Test Telegram alert sent successfully!" : "Failed to send test alert.");
}

async function saveSettings() {
  const locationLabel = document.getElementById('cfgLocation').value;
  const max = parseFloat(document.getElementById('cfgMaxTemp').value);
  const min = parseFloat(document.getElementById('cfgMinTemp').value);

  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationLabel, thresholds: { min, max, warnLow: min + 0.8, warnHigh: max - 0.8, vibWarn: 3, vibBreach: 8 } })
  });
  const json = await res.json();
  if (json.ok) {
    document.getElementById('saveMsg').innerText = "Configuration saved successfully!";
    setTimeout(() => document.getElementById('saveMsg').innerText = "", 3000);
  }
}

window.onload = () => {
  initWebSocket();
  initChart();
};
