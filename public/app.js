/**
 * VaxGuard X — Frontend Application
 * Real-time dashboard, dual voice systems, risk intelligence
 */

(() => {
  'use strict';

  // ======================== STATE ========================
  const S = {
    sensors: { temperature: null, humidity: null, vibration: false, sensorHealth: true, lastUpdate: null },
    device: { deviceId: 'VaxGuard-01', mode: 'LIVE', online: false, lastSeen: null, uptime: 0 },
    risk: { score: 0, level: 'GOOD', factors: [], trend: 'STABLE', confidence: 'LOW' },
    prediction: { direction: 'STABLE', estimatedCrossing: null, confidence: 'LOW', reason: '' },
    condition: 'INSUFFICIENT_DATA',
    alerts: [],
    incidents: [],
    audit: [],
    history: [],
    settings: {},
    voiceAlertsEnabled: true,
    voiceAlertsUnlocked: false,
    notifUnread: 0,
    charts: {}
  };

  const socket = io({ transports: ['websocket', 'polling'] });

  // ======================== DOM HELPERS ========================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleTimeString();
    } catch { return iso; }
  }

  function fmtUptime(sec) {
    if (sec == null) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
  }

  // ======================== NAVIGATION ========================
  function showView(name) {
    $$('.view').forEach(v => v.classList.remove('active'));
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    const view = $(`#view-${name}`);
    const nav = $(`.nav-item[data-view="${name}"]`);
    if (view) view.classList.add('active');
    if (nav) nav.classList.add('active');
    $('#sidebar')?.classList.remove('open');
  }

  $$('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  $('#menuToggle')?.addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
  });

  // ======================== CHARTS ========================
  function makeChart(canvasId, label, color) {
    const ctx = $(canvasId)?.getContext('2d');
    if (!ctx) return null;
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label,
          data: [],
          borderColor: color,
          backgroundColor: color + '22',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        scales: {
          x: { display: false },
          y: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#8b9aab', font: { size: 10 } }
          }
        },
        plugins: { legend: { display: false } }
      }
    });
  }

  function initCharts() {
    S.charts.cmdTemp = makeChart('#cmdTempChart', 'Temp', '#3b9eff');
    S.charts.liveTemp = makeChart('#liveTempChart', 'Temp', '#3b9eff');
    S.charts.liveHum = makeChart('#liveHumChart', 'Humidity', '#22c55e');
    S.charts.risk = makeChart('#riskChart', 'Risk', '#f97316');
  }

  function pushChart(chart, value, maxPoints = 60) {
    if (!chart || value == null || isNaN(value)) return;
    const labels = chart.data.labels;
    const data = chart.data.datasets[0].data;
    labels.push('');
    data.push(value);
    if (labels.length > maxPoints) {
      labels.shift();
      data.shift();
    }
    chart.update('none');
  }

  // ======================== UI UPDATE ========================
  function updateUI() {
    const t = S.sensors.temperature;
    const h = S.sensors.humidity;

    $('#tempValue').textContent = t != null ? t.toFixed(1) : '—';
    $('#humValue').textContent = h != null ? h.toFixed(0) : '—';
    $('#vibValue').textContent = S.sensors.vibration ? 'DETECTED' : 'IDLE';
    $('#vibValue').style.color = S.sensors.vibration ? 'var(--warning)' : '';

    const cond = S.condition || 'INSUFFICIENT_DATA';
    const condEl = $('#conditionPanel');
    const condVal = $('#conditionValue');
    condVal.textContent = cond.replace(/_/g, ' ');
    condEl.className = 'panel status-hero ' + cond.toLowerCase();
    $('#conditionSub').textContent = S.device.mode === 'DEMO' ? 'DEMO SIMULATION' : (S.device.online ? 'REAL SENSOR' : 'DEVICE OFFLINE');

    $('#riskValue').textContent = S.risk.score;
    $('#riskLevel').textContent = S.risk.level;
    $('#bigRiskScore').textContent = S.risk.score;
    $('#bigRiskLevel').textContent = S.risk.level;
    $('#riskTrend').textContent = 'Trend: ' + (S.risk.trend || 'STABLE');

    const arc = $('#gaugeArc');
    if (arc) {
      const pct = Math.min(100, S.risk.score) / 100;
      const len = 158 * pct;
      arc.style.strokeDasharray = `${len} 158`;
      const colors = { GOOD: '#22c55e', WATCH: '#eab308', WARNING: '#f97316', HIGH: '#ef4444', CRITICAL: '#dc2626' };
      arc.style.stroke = colors[S.risk.level] || '#22c55e';
    }

    const fl = $('#riskFactors');
    if (S.risk.factors && S.risk.factors.length) {
      fl.innerHTML = S.risk.factors.map(f =>
        `<li><span>${f.name}</span><span>+${f.points}</span></li>`
      ).join('');
    } else {
      fl.innerHTML = '<li class="muted">No active risk factors</li>';
    }

    let adv = 'Observed conditions within configured monitoring limits.';
    if (S.risk.score >= 80) adv = 'Critical condition. Inspect cold-chain equipment immediately.';
    else if (S.risk.score >= 60) adv = 'Elevated risk. Verify cooling system and recent handling.';
    else if (S.risk.score >= 40) adv = 'Warning: temperature approaching limits. Monitor closely.';
    else if (S.risk.score >= 20) adv = 'Watch status. Minor deviation detected.';
    if (S.prediction.reason) adv += ' ' + S.prediction.reason;
    $('#advisoryText').textContent = adv;
    $('#riskAction').textContent = adv;
    $('#earlyAdvisory').textContent = adv;

    $('#predDirection').textContent = S.prediction.direction || 'STABLE';
    $('#predConfidence').textContent = S.prediction.confidence || 'LOW';
    $('#predReason').textContent = S.prediction.reason || 'Collecting baseline…';
    $('#predCrossing').textContent = S.prediction.estimatedCrossing
      ? `Estimated threshold crossing: ~${S.prediction.estimatedCrossing} min`
      : '';

    $('#deviceId').textContent = S.device.deviceId || 'VaxGuard-01';
    const modeBadge = $('#modeBadge');
    modeBadge.textContent = S.device.mode || 'LIVE';
    modeBadge.className = 'mode-badge' + (S.device.mode === 'DEMO' ? ' demo' : '');

    $('#devOnline').textContent = S.device.online ? 'Yes' : 'No';
    $('#devLastSeen').textContent = fmtTime(S.device.lastSeen);
    $('#devUptime').textContent = fmtUptime(S.device.uptime);

    $('#dhId').textContent = S.device.deviceId;
    $('#dhOnline').textContent = S.device.online ? 'ONLINE' : 'OFFLINE';
    $('#dhMode').textContent = S.device.mode;
    $('#dhFw').textContent = S.device.firmware || '—';
    $('#dhUptime').textContent = fmtUptime(S.device.uptime);
    $('#dhRssi').textContent = S.device.wifiRssi != null ? S.device.wifiRssi + ' dBm' : '—';
    $('#dhHeap').textContent = S.device.freeHeap != null ? S.device.freeHeap : '—';
    $('#dhLast').textContent = fmtTime(S.device.lastSeen);

    const healthy = S.sensors.sensorHealth !== false;
    $('#sensorHealthBar').style.width = healthy ? '96%' : '35%';
    $('#sensorHealthText').textContent = healthy ? 'Sensors reporting valid data' : 'Sensor fault — check DHT11';
    $('#dhtStatus').textContent = healthy ? 'OK' : 'FAULT';
    $('#dhtLast').textContent = fmtTime(S.sensors.lastUpdate);
    $('#vibStatus').textContent = S.sensors.vibration ? 'ACTIVE' : 'IDLE';

    if (S.sensors.lastUpdate) {
      const age = Math.round((Date.now() - new Date(S.sensors.lastUpdate).getTime()) / 1000);
      $('#dataFreshness').textContent = age < 10 ? 'Fresh (<10s)' : `Last update ${age}s ago`;
    }

    updateTwin();

    const cs = $('#connStatus');
    if (S.device.online) {
      cs.className = 'conn-status online';
      cs.querySelector('.label').textContent = 'Device Online';
    } else {
      cs.className = 'conn-status offline';
      cs.querySelector('.label').textContent = 'Device Offline';
    }

    if (S.risk.level === 'CRITICAL' || S.risk.level === 'HIGH') {
      const ep = $('#emergencyPanel');
      ep.classList.remove('hidden');
      $('#emSeverity').textContent = S.risk.level;
      $('#emTitle').textContent = S.risk.level === 'CRITICAL' ? 'Critical Cold-Chain Excursion' : 'High Risk Condition';
      $('#emTemp').textContent = t != null ? t.toFixed(1) + '°C' : '—';
      $('#emHum').textContent = h != null ? h.toFixed(0) + '%' : '—';
      $('#emRisk').textContent = S.risk.score + '/100';
      $('#emAction').textContent = adv;
    }

    pushChart(S.charts.cmdTemp, t);
    pushChart(S.charts.liveTemp, t);
    pushChart(S.charts.liveHum, h);
    pushChart(S.charts.risk, S.risk.score);
  }

  function updateTwin() {
    const set = (id, state, cls) => {
      const el = $(id);
      if (!el) return;
      el.textContent = state;
      el.parentElement.className = 'twin-node ' + (cls || '');
    };
    set('#twinEspState', S.device.online ? 'ONLINE' : 'OFFLINE', S.device.online ? 'online' : 'fault');
    set('#twinDhtState', S.sensors.sensorHealth ? 'OK' : 'FAULT', S.sensors.sensorHealth ? 'online' : 'fault');
    set('#twinVibState', S.sensors.vibration ? 'ACTIVE' : 'IDLE', S.sensors.vibration ? 'active' : 'online');
    const warning = S.risk.score >= 40 || !S.sensors.sensorHealth;
    set('#twinGreenState', warning ? 'OFF' : 'ON', warning ? '' : 'online');
    set('#twinRedState', warning ? 'ON' : 'OFF', warning ? 'fault' : '');
  }

  // ======================== TABLES ========================
  function refreshAlertsTable() {
    const tb = $('#alertsTable tbody');
    if (!tb) return;
    tb.innerHTML = S.alerts.slice(0, 50).map(a => `
      <tr>
        <td>${fmtTime(a.timestamp)}</td>
        <td><span style="color:var(--${a.severity === 'CRITICAL' ? 'critical' : a.severity === 'HIGH' ? 'high' : 'warning'})">${a.severity}</span></td>
        <td>${a.title}</td>
        <td>${a.temperature != null ? a.temperature.toFixed(1) : '—'}</td>
        <td>${a.riskScore ?? '—'}</td>
        <td>${a.acknowledged ? '✓' : `<button class="btn sm" data-ack="${a.id}">Ack</button>`}</td>
      </tr>
    `).join('') || '<tr><td colspan="6" class="muted">No alerts</td></tr>';

    tb.querySelectorAll('[data-ack]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch('/api/alerts/acknowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: btn.dataset.ack })
        });
      });
    });
  }

  function refreshIncidents() {
    const tb = $('#incidentsTable tbody');
    if (!tb) return;
    tb.innerHTML = S.incidents.slice(0, 30).map(i => `
      <tr>
        <td>${i.id}</td>
        <td>${i.trigger}</td>
        <td>${i.severity}</td>
        <td>${i.status}</td>
        <td>${i.peakTemp != null ? i.peakTemp.toFixed(1) : '—'}</td>
        <td>${fmtTime(i.startTime)}</td>
        <td>${i.status !== 'RESOLVED' && !i.acknowledged ? `<button class="btn sm" data-iack="${i.id}">Ack</button>` : ''}</td>
      </tr>
    `).join('') || '<tr><td colspan="7" class="muted">No incidents</td></tr>';

    tb.querySelectorAll('[data-iack]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch('/api/incidents/acknowledge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: btn.dataset.iack })
        });
      });
    });

    const tl = $('#timelineList');
    const latest = S.incidents[0];
    if (latest && latest.timeline) {
      tl.innerHTML = latest.timeline.map(e =>
        `<li><strong>${fmtTime(e.time)}</strong> — ${e.event}: ${e.detail || ''}</li>`
      ).join('');
    }
  }

  function refreshAudit() {
    const tb = $('#auditTable tbody');
    if (!tb) return;
    tb.innerHTML = S.audit.slice(0, 80).map(a => `
      <tr>
        <td>${fmtTime(a.timestamp)}</td>
        <td>${a.event}</td>
        <td>${JSON.stringify(a.details || {}).slice(0, 60)}</td>
        <td>${a.id}</td>
      </tr>
    `).join('') || '<tr><td colspan="4" class="muted">Empty</td></tr>';
  }

  function refreshLiveTable() {
    const tb = $('#liveTable tbody');
    if (!tb) return;
    tb.innerHTML = S.history.slice(-20).reverse().map(r => `
      <tr>
        <td>${fmtTime(r.timestamp)}</td>
        <td>${r.temperature != null ? r.temperature.toFixed(1) : '—'}</td>
        <td>${r.humidity != null ? r.humidity.toFixed(0) : '—'}</td>
        <td>${r.vibration ? 'YES' : '—'}</td>
        <td>${r.mode || ''}</td>
      </tr>
    `).join('');
  }

  // ======================== SOCKET ========================
  socket.on('connect', () => {
    $('#connStatus .label').textContent = 'Server Connected';
    toast('Connected to VaxGuard server', 'info');
    bootstrap();
  });

  socket.on('disconnect', () => {
    $('#connStatus').className = 'conn-status offline';
    $('#connStatus .label').textContent = 'Server Disconnected';
  });

  socket.on('sensor:update', (payload) => {
    if (payload.sensors) Object.assign(S.sensors, payload.sensors);
    if (payload.device) Object.assign(S.device, payload.device);
    if (payload.risk) S.risk = payload.risk;
    if (payload.prediction) S.prediction = payload.prediction;
    if (payload.condition) S.condition = payload.condition;
    if (payload.sensors) {
      S.history.push({
        temperature: payload.sensors.temperature,
        humidity: payload.sensors.humidity,
        vibration: payload.sensors.vibration,
        timestamp: payload.sensors.lastUpdate || new Date().toISOString(),
        mode: payload.device?.mode
      });
      if (S.history.length > 500) S.history.shift();
    }
    updateUI();
    refreshLiveTable();
  });

  socket.on('risk:update', (r) => { S.risk = r; updateUI(); });
  socket.on('prediction:update', (p) => { S.prediction = p; updateUI(); });

  socket.on('alert:new', (a) => {
    S.alerts.unshift(a);
    S.notifUnread++;
    updateNotifBadge();
    refreshAlertsTable();
    toast(`${a.severity}: ${a.title}`, a.severity === 'CRITICAL' ? 'critical' : 'warning');
    $('#lastEvent').textContent = `${a.severity} — ${a.title}`;
  });

  socket.on('alert:update', () => refreshAlertsTable());
  socket.on('incident:new', (i) => { S.incidents.unshift(i); refreshIncidents(); });
  socket.on('incident:update', (i) => {
    const idx = S.incidents.findIndex(x => x.id === i.id);
    if (idx >= 0) S.incidents[idx] = i;
    else S.incidents.unshift(i);
    refreshIncidents();
  });

  socket.on('audit:new', (e) => {
    S.audit.unshift(e);
    refreshAudit();
  });

  socket.on('vibration:event', () => {
    $('#lastEvent').textContent = 'Vibration event detected';
    toast('Vibration event', 'warning');
  });

  socket.on('device:offline', () => {
    S.device.online = false;
    updateUI();
    toast('Device went offline', 'critical');
  });

  // ======================== VOICE ALERT ENGINE (System B) ========================
  socket.on('voice:alert', (payload) => {
    if (!S.voiceAlertsEnabled) return;
    const log = $('#voiceAlertLog');
    const li = document.createElement('li');
    li.textContent = `[${new Date().toLocaleTimeString()}] ${payload.severity}: ${payload.message}`;
    if (log.querySelector('.muted')) log.innerHTML = '';
    log.prepend(li);

    if (S.voiceAlertsUnlocked && window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(payload.message);
      u.rate = 0.95;
      u.pitch = 1;
      window.speechSynthesis.speak(u);
    }
  });

  $('#enableVoiceAlerts')?.addEventListener('click', () => {
    S.voiceAlertsUnlocked = true;
    const u = new SpeechSynthesisUtterance('VaxGuard voice alerts enabled.');
    window.speechSynthesis?.speak(u);
    $('#voiceAlertStatus').textContent = 'Active — browser audio unlocked';
    toast('Voice alerts enabled');
  });

  $('#testVoiceAlert')?.addEventListener('click', () => {
    S.voiceAlertsUnlocked = true;
    const msg = 'Test alert. This is the VaxGuard autonomous voice alert engine.';
    const u = new SpeechSynthesisUtterance(msg);
    window.speechSynthesis?.speak(u);
    toast('Test voice alert spoken');
  });

  $('#voiceAlertToggle')?.addEventListener('change', (e) => {
    S.voiceAlertsEnabled = e.target.checked;
  });

  $('#voiceCooldown')?.addEventListener('change', async (e) => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertCooldownSec: Number(e.target.value) })
    });
  });

  // ======================== VOICE ASSISTANT (System A) ========================
  let recognition = null;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      $('#voiceStatus').textContent = 'LISTENING';
      $('#micBtn').classList.add('listening');
    };
    recognition.onend = () => {
      $('#voiceStatus').textContent = 'IDLE';
      $('#micBtn').classList.remove('listening');
    };
    recognition.onerror = (e) => {
      $('#voiceStatus').textContent = 'ERROR';
      $('#transcript').textContent = 'Speech recognition error: ' + e.error;
      $('#micBtn').classList.remove('listening');
    };
    recognition.onresult = async (event) => {
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) final += event.results[i][0].transcript;
      }
      if (final) {
        $('#transcript').textContent = final;
        await askVoice(final);
      }
    };
  }

  $('#micBtn')?.addEventListener('click', () => {
    if (!recognition) {
      $('#transcript').textContent = 'Speech recognition not supported in this browser. Use suggested questions or type.';
      return;
    }
    try {
      recognition.start();
    } catch (e) {}
  });

  async function askVoice(question) {
    $('#voiceStatus').textContent = 'THINKING';
    $('#aiResponse').textContent = '…';
    try {
      const res = await fetch('/api/voice/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question })
      });
      const data = await res.json();
      $('#aiResponse').textContent = data.answer || 'No response';
      $('#voiceStatus').textContent = 'RESPONDING';

      const hist = $('#convHistory');
      hist.innerHTML += `<div class="q">You: ${question}</div><div class="a">AI: ${data.answer}</div>`;

      if ($('#speakResponse')?.checked && window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(data.answer);
        u.rate = 1;
        window.speechSynthesis.speak(u);
      }
      setTimeout(() => { $('#voiceStatus').textContent = 'IDLE'; }, 800);
    } catch (err) {
      $('#aiResponse').textContent = 'Failed to reach voice service.';
      $('#voiceStatus').textContent = 'ERROR';
    }
  }

  $$('.chip').forEach(c => {
    c.addEventListener('click', () => askVoice(c.dataset.q));
  });

  $('#clearConv')?.addEventListener('click', () => {
    $('#convHistory').innerHTML = '';
    $('#aiResponse').textContent = '';
    $('#transcript').textContent = 'Click the microphone and ask a question…';
  });

  $('#voiceQuickBtn')?.addEventListener('click', () => showView('voice'));

  // ======================== DEMO ========================
  $$('[data-demo]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const state = btn.dataset.demo;
      await fetch('/api/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'inject', state })
      });
      toast(`Demo state: ${state}`, 'info');
    });
  });

  // ======================== SETTINGS ========================
  $('#saveSettings')?.addEventListener('click', async () => {
    const body = {
      tempMin: Number($('#setTempMin').value),
      tempMax: Number($('#setTempMax').value),
      alertCooldownSec: Number($('#setCooldown').value)
    };
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    $('#tempRange').textContent = `${body.tempMin} – ${body.tempMax}`;
    toast('Settings saved');
  });

  // ======================== TELEGRAM ========================
  $('#tgTest')?.addEventListener('click', async () => {
    const res = await fetch('/api/telegram/test', { method: 'POST' });
    const data = await res.json();
    if (res.ok) toast('Telegram test sent');
    else toast(data.error || 'Telegram failed', 'critical');
  });

  $('#tgToggle')?.addEventListener('change', async (e) => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramEnabled: e.target.checked })
    });
  });

  // ======================== SELF TEST ========================
  $('#runSelfTest')?.addEventListener('click', async () => {
    const res = await fetch('/api/selftest', { method: 'POST' });
    const data = await res.json();
    $('#selfTestOut').textContent = JSON.stringify(data, null, 2);
  });

  // ======================== REPORTS ========================
  $('#genDaily')?.addEventListener('click', () => {
    const t = S.sensors.temperature;
    $('#reportOut').textContent = [
      'VAXGUARD X — DAILY MONITORING SUMMARY',
      `Generated: ${new Date().toISOString()}`,
      `Device: ${S.device.deviceId}`,
      `Mode: ${S.device.mode}`,
      `Current Temp: ${t != null ? t.toFixed(1) : 'N/A'}°C`,
      `Humidity: ${S.sensors.humidity != null ? S.sensors.humidity.toFixed(0) : 'N/A'}%`,
      `Risk Score: ${S.risk.score}/100 (${S.risk.level})`,
      `Condition: ${S.condition}`,
      `Readings this session: ${S.history.length}`,
      `Open incidents: ${S.incidents.filter(i => i.status !== 'RESOLVED').length}`,
      `Alerts: ${S.alerts.length}`,
      '',
      'Note: This is a monitoring prototype summary, not a medical certificate.'
    ].join('\n');
  });

  $('#genIncident')?.addEventListener('click', () => {
    const open = S.incidents.filter(i => i.status !== 'RESOLVED');
    $('#reportOut').textContent = open.length
      ? open.map(i => `${i.id} | ${i.severity} | ${i.trigger} | ${i.status} | peak ${i.peakTemp}`).join('\n')
      : 'No open incidents.';
  });

  // ======================== NOTIFICATIONS ========================
  function updateNotifBadge() {
    const b = $('#notifBadge');
    if (S.notifUnread > 0) {
      b.hidden = false;
      b.textContent = S.notifUnread > 9 ? '9+' : S.notifUnread;
    } else b.hidden = true;
  }

  $('#notifBtn')?.addEventListener('click', () => {
    const d = $('#notifDrawer');
    d.classList.toggle('hidden');
    const list = $('#notifList');
    list.innerHTML = S.alerts.slice(0, 30).map(a =>
      `<li><strong>${a.severity}</strong> ${a.title}<br><small>${fmtTime(a.timestamp)}</small></li>`
    ).join('') || '<li class="muted">No notifications</li>';
    S.notifUnread = 0;
    updateNotifBadge();
  });

  $('#closeNotif')?.addEventListener('click', () => $('#notifDrawer').classList.add('hidden'));

  // ======================== COMMAND PALETTE ========================
  const commands = [
    { label: 'Open Command Center', action: () => showView('command') },
    { label: 'Open Live Monitor', action: () => showView('live') },
    { label: 'Open Risk Center', action: () => showView('risk') },
    { label: 'Open Voice Assistant', action: () => showView('voice') },
    { label: 'Open Alerts', action: () => showView('alerts') },
    { label: 'Open Emergency', action: () => showView('emergency') },
    { label: 'Open Demo Simulator', action: () => showView('demo') },
    { label: 'Open Settings', action: () => showView('settings') },
    { label: 'Run Self-Test', action: () => { showView('selftest'); $('#runSelfTest').click(); } },
    { label: 'Enable Voice Alerts', action: () => { showView('voicealerts'); $('#enableVoiceAlerts').click(); } },
    { label: 'Export History CSV', action: () => { window.location = '/api/export/csv'; } }
  ];

  function openPalette() {
    $('#cmdPalette').classList.remove('hidden');
    $('#cmdInput').value = '';
    $('#cmdInput').focus();
    renderCmdResults('');
  }

  function renderCmdResults(q) {
    const list = $('#cmdResults');
    const filtered = commands.filter(c => c.label.toLowerCase().includes(q.toLowerCase()));
    list.innerHTML = filtered.map((c, i) =>
      `<li data-idx="${i}" class="${i === 0 ? 'active' : ''}">${c.label}</li>`
    ).join('');
    list.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => {
        const cmd = filtered[Number(li.dataset.idx)];
        if (cmd) cmd.action();
        $('#cmdPalette').classList.add('hidden');
      });
    });
  }

  $('#cmdPaletteBtn')?.addEventListener('click', openPalette);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      openPalette();
    }
    if (e.key === 'Escape') {
      $('#cmdPalette').classList.add('hidden');
      $('#notifDrawer').classList.add('hidden');
    }
  });

  $('#cmdInput')?.addEventListener('input', (e) => renderCmdResults(e.target.value));
  $('#cmdInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const active = $('#cmdResults li.active');
      if (active) active.click();
    }
  });

  // ======================== THEME ========================
  $('#themeToggle')?.addEventListener('click', () => {
    document.body.classList.toggle('theme-dark');
    document.body.classList.toggle('theme-light');
  });

  // ======================== SEARCH ========================
  $('#globalSearch')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim().toUpperCase();
    if (!q) return;
    const found = S.incidents.find(i => i.id.includes(q)) ||
                  S.alerts.find(a => a.id.includes(q));
    if (found) {
      toast(`Found: ${found.id || found.title}`);
      if (found.trigger) showView('incidents');
      else showView('alerts');
    } else {
      toast('No matching event ID');
    }
  });

  // ======================== EMERGENCY BUTTONS ========================
  $('#emAck')?.addEventListener('click', async () => {
    const open = S.alerts.find(a => !a.acknowledged && (a.severity === 'CRITICAL' || a.severity === 'HIGH'));
    if (open) {
      await fetch('/api/alerts/acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: open.id })
      });
      toast('Alert acknowledged');
    }
  });

  $('#emMute')?.addEventListener('click', () => {
    S.voiceAlertsEnabled = false;
    $('#voiceAlertToggle').checked = false;
    window.speechSynthesis?.cancel();
    toast('Voice alerts muted');
  });

  // ======================== BOOTSTRAP ========================
  async function bootstrap() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (data.device) Object.assign(S.device, data.device);
      if (data.sensors) Object.assign(S.sensors, data.sensors);
      if (data.risk) S.risk = data.risk;
      if (data.prediction) S.prediction = data.prediction;
      if (data.condition) S.condition = data.condition;
      if (data.settings) {
        S.settings = data.settings;
        $('#tgConfigured').textContent = data.settings.telegramConfigured ? 'YES' : 'NO';
        if (data.settings.tempMin != null) {
          $('#setTempMin').value = data.settings.tempMin;
          $('#setTempMax').value = data.settings.tempMax;
          $('#tempRange').textContent = `${data.settings.tempMin} – ${data.settings.tempMax}`;
        }
      }
      if (data.stats) {
        $('#statReadings').textContent = data.stats.totalReadings || 0;
        $('#statVib').textContent = data.stats.vibrationCount || 0;
        $('#statMax').textContent = data.stats.maxTemp != null ? data.stats.maxTemp.toFixed(1) : '—';
        $('#statMin').textContent = data.stats.minTemp != null ? data.stats.minTemp.toFixed(1) : '—';
        $('#vibCount').textContent = data.stats.vibrationCount || 0;
      }
      updateUI();

      const [hist, alerts, incidents, audit] = await Promise.all([
        fetch('/api/history?limit=100').then(r => r.json()),
        fetch('/api/alerts').then(r => r.json()),
        fetch('/api/incidents').then(r => r.json()),
        fetch('/api/audit').then(r => r.json())
      ]);
      S.history = hist || [];
      S.alerts = alerts || [];
      S.incidents = incidents || [];
      S.audit = audit || [];
      refreshLiveTable();
      refreshAlertsTable();
      refreshIncidents();
      refreshAudit();
    } catch (e) {
      console.warn('Bootstrap error', e);
    }
  }

  // Init
  initCharts();
  updateUI();
})();
