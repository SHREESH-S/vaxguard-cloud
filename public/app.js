let ws;
let tempChart = null;

function switchScreen(screenId, event) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('screen-' + screenId).classList.add('active');
  if (event) event.target.classList.add('active');
  if (screenId === 'graph' && tempChart) tempChart.update();
}

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(protocol + window.host);
  ws.onmessage = (event) => {
    try {
      updateDashboard(JSON.parse(event.data));
    } catch (e) { console.error(e); }
  };
  ws.onclose = () => setTimeout(initWebSocket, 3000);
}

function updateDashboard(data) {
  document.getElementById('valTemp').innerText = data.temperature.toFixed(1) + " °C";
  document.getElementById('valHum').innerText = data.humidity.toFixed(1) + " %";
  document.getElementById('valVib').innerText = data.vibration ? "⚠️ SHOCK DETECTED" : "Normal";
  document.getElementById('valRisk').innerText = data.riskScore + "/100";
  document.getElementById('valAdvisory').innerText = data.advisoryMsg;
  document.getElementById('aiTrend').innerText = data.trend;
  document.getElementById('aiPotency').innerText = data.potencyRetention + "%";

  const modeBadge = document.getElementById('modeBadge');
  modeBadge.innerText = data.mode;
  modeBadge.className = "status-badge " + (data.mode === 'REAL' ? 'real' : 'demo');

  const stateBadge = document.getElementById('stateBadge');
  stateBadge.innerText = data.state;

  fetchHistoryAndAudit();
}

function initChart() {
  const ctx = document.getElementById('tempChart').getContext('2d');
  tempChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Temperature (°C)', data: [], borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,0.1)', fill: true }] },
    options: { responsive: true, maintainAspectRatio: false }
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
    const auditRes = await fetch('/api/audit');
    const auditJson = await auditRes.json();
    if (auditJson.ok) {
      document.getElementById('auditTableBody').innerHTML = auditJson.audit.map(r =>
        `<tr><td>${r.timestamp}</td><td>${r.temp.toFixed(1)}</td><td>${r.humidity.toFixed(1)}</td><td>${r.vibration ? 'Yes' : 'No'}</td><td>${r.state}</td><td>${r.risk}</td><td>${r.mode}</td></tr>`
      ).join('');
    }
  } catch (e) { console.error(e); }
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const q = input.value.trim();
  if (!q) return;
  const chatHistory = document.getElementById('chatHistory');
  chatHistory.innerHTML += `<div class="chat-msg user">${q}</div>`;
  input.value = '';
  try {
    const res = await fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) });
    const json = await res.json();
    chatHistory.innerHTML += `<div class="chat-msg bot">${json.answer}</div>`;
  } catch (e) { chatHistory.innerHTML += `<div class="chat-msg bot">Error reaching AI assistant.</div>`; }
}

function startVoiceRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return alert("Speech recognition not supported.");
  const recognition = new SpeechRecognition();
  recognition.onresult = (e) => { document.getElementById('chatInput').value = e.results[0][0].transcript; sendChatMessage(); };
  recognition.start();
}

window.onload = () => { initWebSocket(); initChart(); };
