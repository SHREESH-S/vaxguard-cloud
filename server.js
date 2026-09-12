const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const ADMIN_PIN = process.env.ADMIN_PIN || '2468'; // change via env var in production

const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);
db.defaults({
  telemetry: [], events: [], audit: [],
  demo: { active: false, level: 'OFF' },
  config: {
    tempLower: 2.0, tempUpper: 8.0, tempWarningBand: 1.0,
    warningDurationMs: 20000, criticalDurationMs: 60000,
    deviceName: 'VaxGuard Unit 1', configVersion: 1,
    location: { lat: null, lng: null, label: '', source: null, accuracy: null }
  }
}).write();

function requirePin(req, res, next) {
  if ((req.body && req.body.pin) === ADMIN_PIN || req.query.pin === ADMIN_PIN) return next();
  return res.status(403).json({ error: 'Invalid admin PIN' });
}
function pushAudit({ actor, action, details }) {
  const last = db.get('audit').last().value();
  const prevHash = last ? last.hash : '0';
  const timestamp = Date.now();
  const payload = JSON.stringify({ actor: actor||null, action, details: details||null, timestamp, prevHash });
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const entry = { id: uuidv4(), timestamp, actor: actor||null, action, details: details||null, prevHash, hash };
  db.get('audit').push(entry).write();
  return entry;
}
function verifyAuditChain() {
  const entries = db.get('audit').value();
  let prevHash = '0';
  for (const e of entries) {
    const payload = JSON.stringify({ actor: e.actor, action: e.action, details: e.details, timestamp: e.timestamp, prevHash });
    if (crypto.createHash('sha256').update(payload).digest('hex') !== e.hash) return { tampered: true, brokenAt: e.id, entriesChecked: entries.length };
    prevHash = e.hash;
  }
  return { tampered: false, brokenAt: null, entriesChecked: entries.length };
}

// ---------------- TELEGRAM ----------------
const lastAlertByType = {};
const COOLDOWN_MS = { WARNING: 60000, CRITICAL: 20000, INFO: 300000 };
async function sendTelegram(type, priority, message) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const now = Date.now();
  if (now - (lastAlertByType[type]||0) < (COOLDOWN_MS[priority]||60000)) return;
  lastAlertByType[type] = now;
  const icon = priority==='CRITICAL'?'🔴':priority==='INFO'?'🟢':'🟡';
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: chatId, text: `${icon} VaxGuard ${priority}\n${message}` })
    });
  } catch(e) { console.error('[telegram]', e.message); }
}

// ---------------- STAT HELPERS ----------------
function runningStats(s){let n=0,m=0,M2=0;for(const x of s){n++;const d=x-m;m+=d/n;M2+=d*(x-m);}return{mean:m,stdDev:Math.sqrt(n>1?M2/(n-1):0),n};}
function linreg(s){const n=s.length;if(n<2)return{slope:0};let sx=0,sy=0,sxy=0,sxx=0;for(let i=0;i<n;i++){sx+=i;sy+=s[i];sxy+=i*s[i];sxx+=i*i;}return{slope:(n*sxy-sx*sy)/((n*sxx-sx*sx)||1)};}

// ================= 40+ AI / ANALYTICS FEATURES (rule-based, explainable) =================
function f01_riskScore(state, vib) {
  let score=0; const reasons=[];
  if (state==='WATCH'){score+=25;reasons.push('Near band edge');}
  if (state==='WARNING'){score+=60;reasons.push('Outside safe band');}
  if (state==='CRITICAL'){score+=90;reasons.push('Critically out of range');}
  if (state==='SENSOR_FAULT'){score+=40;reasons.push('Sensor fault');}
  if (vib>=6){score+=15;reasons.push('Abnormal vibration frequency');}
  return {score:Math.min(100,score),reasons};
}
function f02_trend(temps){const{slope}=linreg(temps);return slope>0.02?'RISING':slope<-0.02?'FALLING':'STABLE';}
function f03_anomaly(temps){const{mean,stdDev,n}=runningStats(temps);const latest=temps[temps.length-1];const z=stdDev?(latest-mean)/stdDev:0;return{isAnomaly:Math.abs(z)>2.5,zScore:+z.toFixed(2),mean,stdDev,n};}
function f04_eta(temps,cfg){const{slope}=linreg(temps);const latest=temps[temps.length-1];if(Math.abs(slope)<0.005)return{willCross:false,message:'Stable; no crossing predicted.'};const target=slope>0?cfg.tempUpper:cfg.tempLower;const steps=(target-latest)/slope;if(steps<0)return{willCross:false,message:'Trending away from limit.'};const etaSec=Math.round(steps*2);return{willCross:true,etaSeconds:etaSec,message:`At this rate, reaches ${target}°C in ~${Math.round(etaSec/60)} min.`};}
function f05_hourlyBaseline(records){const b=Array.from({length:24},()=>[]);for(const r of records){if(r.tempValid===false||r.temperature==null)continue;b[new Date(r.receivedAt).getHours()].push(r.temperature);}return b.map((v,h)=>({hour:h,...runningStats(v)}));}
function f06_patternAnomaly(records,latest){const bucket=f05_hourlyBaseline(records)[new Date().getHours()];if(!bucket||bucket.n<5)return{available:false};const z=bucket.stdDev?(latest-bucket.mean)/bucket.stdDev:0;return{available:true,expectedMean:+bucket.mean.toFixed(2),zScore:+z.toFixed(2),unusualForHour:Math.abs(z)>2.5};}
function f07_drift(records){const daily={};for(const r of records){if(r.tempValid===false||r.temperature==null)continue;const d=new Date(r.receivedAt).toISOString().slice(0,10);(daily[d]=daily[d]||[]).push(r.temperature);}const days=Object.keys(daily).sort();if(days.length<3)return{available:false};const{slope}=linreg(days.map(d=>runningStats(daily[d]).mean));return{available:true,driftPerDay:+slope.toFixed(3),driftSuspected:Math.abs(slope)>0.15};}
function f08_vibTempCorrelation(records){let flagged=0;for(let i=1;i<records.length;i++){const p=records[i-1],c=records[i];if((c.vibrationCount||0)>=3&&p.tempValid!==false&&c.tempValid!==false&&c.temperature-p.temperature>0.5)flagged++;}return{likelyDoorOpenEvents:flagged};}
function f09_reliability(records){if(records.length<2)return{score:100,missedIntervals:0};let missed=0;for(let i=1;i<records.length;i++)if(records[i].receivedAt-records[i-1].receivedAt>10000)missed++;return{score:Math.max(0,100-missed*2),missedIntervals:missed};}
function f10_adaptiveThreshold(records,cfg){const stable=records.filter(r=>r.state==='SAFE'&&r.tempValid!==false).map(r=>r.temperature);if(stable.length<20)return{available:false};const{mean,stdDev}=runningStats(stable);return{available:true,suggestedLower:+(mean-2*stdDev).toFixed(1),suggestedUpper:+(mean+2*stdDev).toFixed(1),note:'Advisory only.'};}
function f11_sensorHealth(records){const faults=records.filter(r=>r.state==='SENSOR_FAULT');const now=Date.now();const d30=faults.filter(f=>now-f.receivedAt<30*864e5).length;const d7=faults.filter(f=>now-f.receivedAt<7*864e5).length;const score=Math.max(0,Math.min(100,100-d30*3-d7*5));return{score,faultsLast7d:d7,faultsLast30d:d30,maintenanceRecommended:score<60};}
function f12_tamperCheck(records){if(records.length<2)return{suspected:false};const last=records[records.length-1],prev=records[records.length-2];const gap=last.receivedAt-prev.receivedAt;const suspected=gap>20000&&(last.vibrationCount||0)>=3;return{suspected,gapMs:gap,note:suspected?'Long silent gap followed by vibration.':undefined};}
function f13_coldChainQuality(records){const win=records.filter(r=>Date.now()-r.receivedAt<7*864e5);let wMin=0,rawMin=0;for(let i=1;i<win.length;i++){const p=win[i-1],c=win[i];const m=(c.receivedAt-p.receivedAt)/60000;if(m<=0||m>15)continue;if(p.state==='WARNING'){wMin+=m;rawMin+=m;}if(p.state==='CRITICAL'){wMin+=m*3;rawMin+=m;}}const score=Math.max(0,Math.round(100-wMin*0.5));const label=score>80?'GOOD':score>50?'REDUCED CONFIDENCE':'DO NOT USE — INSPECT / VVM / LAB CHECK';return{score,label,rawExcursionMinutes7d:Math.round(rawMin),disclaimer:'ESTIMATE ONLY — heuristic, not a certified vaccine potency test. Confirm with a physical VVM or lab test before use.'};}
function f14_advice(state,ctx){const t=[];if(state==='CRITICAL')t.push('Move vaccines to backup fridge now; check door seal.');if(state==='WARNING')t.push('Check door is closed and thermostat hasn\'t shifted.');if(state==='SENSOR_FAULT')t.push('DHT11 may be loose — check wiring at GPIO4.');if(ctx.drift?.driftSuspected)t.push('Sensor drifting — consider recalibration.');if(ctx.vibrationCorrelation?.likelyDoorOpenEvents>3)t.push('Door opened often — minimize access.');if(ctx.tamperCheck?.suspected)t.push('Long silent gap + movement — physical check advised.');if(!t.length)t.push('Everything stable — no action needed.');return t;}
function f15_weekOverWeek(records){const now=Date.now();const tw=records.filter(r=>now-r.receivedAt<7*864e5&&r.tempValid!==false).map(r=>r.temperature);const lw=records.filter(r=>now-r.receivedAt>=7*864e5&&now-r.receivedAt<14*864e5&&r.tempValid!==false).map(r=>r.temperature);if(tw.length<10||lw.length<10)return{available:false};const a=runningStats(tw).mean,b=runningStats(lw).mean;return{available:true,thisWeekMean:+a.toFixed(2),lastWeekMean:+b.toFixed(2),changePct:+(((a-b)/b)*100).toFixed(1)};}
function f16_dataCompleteness(records){if(records.length<2)return{pct:100};const expected=Math.round((records[records.length-1].receivedAt-records[0].receivedAt)/2000);const pct=expected>0?Math.min(100,Math.round((records.length/expected)*100)):100;return{pct};}
function f17_humidityStability(records){const h=records.filter(r=>r.humidity!=null&&r.humidity>=0).map(r=>r.humidity);if(h.length<5)return{available:false};const{mean,stdDev}=runningStats(h);return{available:true,meanHumidity:+mean.toFixed(1),stdDev:+stdDev.toFixed(1),stable:stdDev<8};}
function f18_staleDevice(records){if(!records.length)return{stale:true};const ms=Date.now()-records[records.length-1].receivedAt;return{stale:ms>30000,lastSeenSecAgo:Math.round(ms/1000)};}
function f19_learningMode(records){return{learningMode:records.length<30,samplesCollected:records.length,samplesNeeded:30};}
function f20_summary({latest,trend,eta,anomaly,quality,advice}){const p=[];p.push(`Temperature ${latest.temperature?.toFixed?latest.temperature.toFixed(1):latest.temperature}°C, trending ${trend.toLowerCase()}.`);if(eta.willCross)p.push(eta.message);if(anomaly.isAnomaly)p.push('This reading is statistically unusual.');p.push(`Cold-chain quality estimate: ${quality.score}/100 (${quality.label}).`);p.push(advice[0]);return p.join(' ');}
function f21_excursionCount(records){return records.filter(r=>['WARNING','CRITICAL'].includes(r.state)).length;}
function f22_meanTimeBetweenFaults(records){const faults=records.filter(r=>r.state==='SENSOR_FAULT');if(faults.length<2)return{available:false};let total=0;for(let i=1;i<faults.length;i++)total+=faults[i].receivedAt-faults[i-1].receivedAt;return{available:true,avgHours:+((total/(faults.length-1))/3.6e6).toFixed(1)};}
function f23_vibrationBurstDetector(records){const now=Date.now();const recent=records.filter(r=>now-r.receivedAt<600000);const totalVib=recent.reduce((s,r)=>s+(r.vibrationCount||0),0);return{burstActive:totalVib>=15,totalVibrationLast10Min:totalVib};}
function f24_temperatureVolatility(temps){if(temps.length<3)return{available:false};let diffs=[];for(let i=1;i<temps.length;i++)diffs.push(Math.abs(temps[i]-temps[i-1]));return{available:true,avgSwing:+runningStats(diffs).mean.toFixed(3)};}
function f25_forecastNext5Min(temps){const{slope}=linreg(temps);const latest=temps[temps.length-1];return{forecastTemp:+(latest+slope*150).toFixed(2),basis:'linear extrapolation, short-horizon estimate'};}
function f26_deviceUptimeScore(records){const stale=f18_staleDevice(records);return{uptimePct:stale.stale?0:Math.min(100,f09_reliability(records).score)};}
function f27_confidenceLevel(n){return n>=30?'HIGH':n>=10?'MEDIUM':'LOW';}
function f28_seasonalDayComparison(records){const now=new Date();const today=now.getDay();const sameDay=records.filter(r=>new Date(r.receivedAt).getDay()===today&&r.tempValid!==false).map(r=>r.temperature);if(sameDay.length<10)return{available:false};return{available:true,meanForThisWeekday:+runningStats(sameDay).mean.toFixed(2)};}
function f29_rapidConfigChangeFlag(timestamps){const now=Date.now();const recent=timestamps.filter(t=>now-t<600000);return{suspicious:recent.length>=3,changesLast10Min:recent.length};}
function f30_batteryPlaceholder(){return{available:false,note:'Hardware telemetry unavailable — no battery sensor wired.'};}
function f31_irPlaceholder(){return{available:false,note:'Hardware telemetry unavailable — IR sensor not wired to a GPIO.'};}
function f32_deviceHealthComposite(sensorHealth,reliability,dataCompleteness){return{score:Math.round((sensorHealth.score+reliability.score+dataCompleteness.pct)/3)};}
function f33_alertFatigueGuard(events){const now=Date.now();const last15m=events.filter(e=>now-e.timestamp<900000);return{highVolume:last15m.length>10,alertsLast15Min:last15m.length};}
function f34_recoveryTimeTracker(records){let lastBad=null,recoveries=[];for(const r of records){if(['WARNING','CRITICAL'].includes(r.state))lastBad=r.receivedAt;if(r.state==='RECOVERY'&&lastBad)recoveries.push(r.receivedAt-lastBad);}if(!recoveries.length)return{available:false};return{available:true,avgRecoveryMinutes:+((runningStats(recoveries).mean)/60000).toFixed(1)};}
function f35_falsePositiveRateEstimate(events){const total=events.length;if(total<5)return{available:false};const acknowledged=events.filter(e=>e.acknowledged).length;return{available:true,acknowledgedPct:+((acknowledged/total)*100).toFixed(0)};}
function f36_energyEventCorrelation(records){return f08_vibTempCorrelation(records);} // door-open proxy reused
function f37_deviceLocationConfidence(cfg){return{source:cfg.location.source||'NONE',accuracy:cfg.location.accuracy||'unknown',confidence:cfg.location.source==='MANUAL'?'HIGH':cfg.location.source==='AUTO_IP'?'LOW (city-level, not GPS)':'NONE'};}
function f38_modeIntegrityCheck(records){const mixed=records.some((r,i)=>i>0&&r.simulated!==records[i-1].simulated&&(Date.now()-r.receivedAt<5000));return{modeConsistent:!mixed};}
function f39_criticalStreakCounter(records){let streak=0,max=0;for(const r of records){if(r.state==='CRITICAL'){streak++;max=Math.max(max,streak);}else streak=0;}return{longestCriticalStreak:max};}
function f40_overallSystemGrade(risk,quality,sensorHealth,reliability){const avg=(100-risk+quality.score+sensorHealth.score+reliability.score)/4;const grade=avg>85?'A':avg>70?'B':avg>50?'C':'D';return{score:Math.round(avg),grade};}
function f41_naturalLanguageRootCause(latest,ctx){if(latest.state==='CRITICAL')return 'Temperature has been outside the safe band long enough to trigger CRITICAL — likely a door left open, power loss, or thermostat failure.';if(latest.state==='WARNING')return 'Temperature drifted outside the safe band and has stayed there past the warning threshold.';if(latest.state==='SENSOR_FAULT')return 'The DHT11 sensor stopped returning valid readings — check wiring or replace the sensor.';return 'No active issue — conditions are within the configured safe range.';}
function f42_voiceAlertPriority(state){return state==='CRITICAL'?'urgent':state==='WARNING'||state==='SENSOR_FAULT'?'elevated':'normal';}

let configChangeTimestamps = [];

// ---------------- DEMO CONTROL (web-driven) ----------------
app.post('/api/demo', (req, res) => {
  const { level } = req.body || {};
  const valid = ['NORMAL','WARN','HIGH','LOW','VIBRATION','FAULT','OFF'];
  if (!valid.includes(level)) return res.status(400).json({ error: 'level must be one of ' + valid.join(', ') });
  db.set('demo', level==='OFF' ? { active:false, level:'OFF' } : { active:true, level }).write();
  pushAudit({ actor:'web', action:'DEMO_CHANGE', details:{ level } });
  res.json({ ok:true, demo: db.get('demo').value() });
});
app.get('/api/demo', (req,res)=>res.json(db.get('demo').value()));

// ---------------- SENSORS INGEST ----------------
app.post('/api/sensors', (req, res) => {
  const body = req.body;
  if (!body || !body.deviceId || !body.state) return res.status(400).json({ error:'deviceId and state required' });
  const risk = f01_riskScore(body.state, body.vibrationCount||0);
  const record = { ...body, riskScore: risk.score, receivedAt: Date.now() };
  db.get('telemetry').push(record).write();
  if (db.get('telemetry').size().value() > 8000) db.get('telemetry').shift().write();

  const recent = db.get('telemetry').filter({ deviceId: body.deviceId }).takeRight(2).value();
  const prevState = recent.length>1 ? recent[0].state : null;
  if (prevState && prevState !== body.state) {
    db.get('events').push({ id: uuidv4(), timestamp: Date.now(), severity: body.state, previousState: prevState,
      newState: body.state, simulated: !!body.simulated, deviceId: body.deviceId,
      reason: `${body.simulated?'[DEMO] ':''}State changed from ${prevState} to ${body.state}` }).write();
    if (body.state==='CRITICAL') sendTelegram('CRITICAL','CRITICAL',`${body.deviceId}: CRITICAL — ${body.temperature}°C.${body.simulated?' [DEMO]':''}`);
    if (body.state==='WARNING') sendTelegram('WARNING','WARNING',`${body.deviceId}: drifting out of range (${body.temperature}°C).${body.simulated?' [DEMO]':''}`);
    if (['SAFE','RECOVERY'].includes(body.state) && ['CRITICAL','WARNING'].includes(prevState))
      sendTelegram('RECOVERY','INFO',`${body.deviceId}: back to normal.${body.simulated?' [DEMO]':''}`);
  }
  res.json({ ok:true, riskScore: risk.score, riskReasons: risk.reasons });
});

app.get('/api/sensors/latest', (req,res)=>{
  const { deviceId } = req.query;
  let q = db.get('telemetry'); if (deviceId) q = q.filter({ deviceId });
  const latest = q.takeRight(1).value()[0] || null;
  if (latest) { const r = f01_riskScore(latest.state, latest.vibrationCount||0); latest.riskScore=r.score; latest.riskReasons=r.reasons; }
  res.json(latest);
});

const RANGE_MS = { '1h':3600e3,'6h':6*3600e3,'24h':24*3600e3,'7d':7*24*3600e3 };
app.get('/api/history', (req,res)=>{
  const { range='1h', deviceId } = req.query;
  const start = Date.now() - (RANGE_MS[range]||RANGE_MS['1h']);
  let results = db.get('telemetry').value().filter(r=>r.receivedAt>=start);
  if (deviceId) results = results.filter(r=>r.deviceId===deviceId);
  res.json({ series: results.map(r=>({ t:r.receivedAt, temperature:r.temperature, humidity:r.humidity, vibrationCount:r.vibrationCount, state:r.state, simulated:!!r.simulated })) });
});

app.get('/api/events', (req,res)=>res.json(db.get('events').value().slice(-300).reverse()));
app.get('/api/alerts', (req,res)=>res.json(db.get('events').value().filter(e=>['WARNING','CRITICAL','SENSOR_FAULT'].includes(e.severity)).slice(-50).reverse()));
app.post('/api/events/:id/acknowledge', requirePin, (req,res)=>{
  const e = db.get('events').find({ id:req.params.id }).value();
  if (!e) return res.status(404).json({ error:'not found' });
  db.get('events').find({ id:req.params.id }).assign({ acknowledged:true }).write();
  pushAudit({ actor:'admin', action:'ACK_EVENT', details:{ id:req.params.id } });
  res.json({ ok:true });
});

// ---------------- AI INSIGHTS: bundles all 40+ features ----------------
app.get('/api/ai/insights', (req,res)=>{
  const { deviceId } = req.query;
  let recent = db.get('telemetry').value(); if (deviceId) recent = recent.filter(r=>r.deviceId===deviceId);
  const windowed = recent.slice(-300);
  const temps = windowed.filter(r=>r.tempValid!==false).map(r=>r.temperature);
  if (temps.length < 3) return res.json({ message:'Not enough data yet — collecting readings.' });

  const cfg = db.get('config').value();
  const latest = windowed[windowed.length-1];
  const anomaly = f03_anomaly(temps);
  const trend = f02_trend(temps);
  const eta = f04_eta(temps, cfg);
  const drift = f07_drift(recent);
  const vibCorr = f08_vibTempCorrelation(windowed);
  const tamper = f12_tamperCheck(windowed);
  const quality = f13_coldChainQuality(recent);
  const advice = f14_advice(latest.state, { drift, vibrationCorrelation:vibCorr, tamperCheck:tamper });
  const risk = f01_riskScore(latest.state, latest.vibrationCount||0);
  const sensorHealth = f11_sensorHealth(recent);
  const reliability = f09_reliability(windowed);
  const completeness = f16_dataCompleteness(windowed);
  const events = db.get('events').value();

  res.json({
    disclaimer: 'Rule-based statistical analysis — every number is explainable, not a trained black-box model.',
    mode: latest.simulated ? 'DEMO' : 'REAL',
    summary: f20_summary({ latest, trend, eta, anomaly, quality, advice }),
    rootCause: f41_naturalLanguageRootCause(latest, {}),
    voicePriority: f42_voiceAlertPriority(latest.state),
    riskScore: risk.score, riskReasons: risk.reasons,
    trend: { direction: trend },
    anomaly, eta, drift, vibrationCorrelation: vibCorr, tamperCheck: tamper,
    hourlyPattern: f06_patternAnomaly(recent, temps[temps.length-1]),
    reliability, adaptiveThreshold: f10_adaptiveThreshold(recent, cfg),
    sensorHealth, coldChainQuality: quality, advice,
    weekOverWeek: f15_weekOverWeek(recent), dataCompleteness: completeness,
    humidityStability: f17_humidityStability(windowed), staleDevice: f18_staleDevice(windowed),
    learningMode: f19_learningMode(recent), excursionCount: f21_excursionCount(windowed),
    meanTimeBetweenFaults: f22_meanTimeBetweenFaults(recent), vibrationBurst: f23_vibrationBurstDetector(recent),
    volatility: f24_temperatureVolatility(temps), forecast5Min: f25_forecastNext5Min(temps),
    uptime: f26_deviceUptimeScore(windowed), confidence: f27_confidenceLevel(temps.length),
    seasonalComparison: f28_seasonalDayComparison(recent), rapidConfigChange: f29_rapidConfigChangeFlag(configChangeTimestamps),
    battery: f30_batteryPlaceholder(), irSensor: f31_irPlaceholder(),
    deviceHealth: f32_deviceHealthComposite(sensorHealth, reliability, completeness),
    alertFatigue: f33_alertFatigueGuard(events), recoveryTime: f34_recoveryTimeTracker(windowed),
    falsePositiveRate: f35_falsePositiveRateEstimate(events), location: f37_deviceLocationConfidence(cfg),
    modeIntegrity: f38_modeIntegrityCheck(windowed), criticalStreak: f39_criticalStreakCounter(windowed),
    systemGrade: f40_overallSystemGrade(risk.score, quality, sensorHealth, reliability)
  });
});

// ---------------- LOCATION ----------------
let lastGeoLookupMs = 0;
async function maybeAutoLocate(ip) {
  const cfg = db.get('config').value();
  if (cfg.location?.source === 'MANUAL') return;
  if (Date.now() - lastGeoLookupMs < 3600000) return;
  lastGeoLookupMs = Date.now();
  try {
    const clean = (ip||'').replace('::ffff:','');
    const r = await fetch(`http://ip-api.com/json/${clean}?fields=status,city,regionName,country,lat,lon`);
    const d = await r.json();
    if (d.status === 'success') db.get('config').assign({ location:{ lat:d.lat, lng:d.lon, label:`${d.city}, ${d.regionName}, ${d.country}`, source:'AUTO_IP', accuracy:'city-level (approximate)' } }).write();
  } catch(e) {}
}
app.get('/api/location', async (req,res)=>{ await maybeAutoLocate(req.ip); res.json(db.get('config.location').value()); });
app.put('/api/config/location', requirePin, (req,res)=>{
  const { lat, lng, label } = req.body || {};
  db.get('config').assign({ location:{ lat:lat??null, lng:lng??null, label:label||'', source:'MANUAL', accuracy:'exact (manual)' } }).write();
  pushAudit({ actor:'admin', action:'LOCATION_UPDATE', details:{ lat, lng, label } });
  res.json({ ok:true, location: db.get('config.location').value() });
});

// ---------------- CONFIG ----------------
app.get('/api/config', (req,res)=>res.json(db.get('config').value()));
app.put('/api/config', requirePin, (req,res)=>{
  const allowed = ['tempLower','tempUpper','tempWarningBand','warningDurationMs','criticalDurationMs','deviceName'];
  const updates = {}; for (const k of allowed) if (req.body[k]!==undefined) updates[k]=req.body[k];
  const v = (db.get('config.configVersion').value()||1)+1;
  db.get('config').assign({ ...updates, configVersion:v }).write();
  pushAudit({ actor:'admin', action:'CONFIG_CHANGE', details: updates });
  configChangeTimestamps.push(Date.now());
  res.json({ ok:true, config: db.get('config').value() });
});

// ---------------- AUDIT ----------------
app.get('/api/audit', requirePin, (req,res)=>res.json(db.get('audit').value().slice(-300).reverse()));
app.get('/api/audit/verify', requirePin, (req,res)=>res.json(verifyAuditChain()));

// ---------------- VOICE ASSISTANT (text Q&A backend, speech handled client-side) ----------------
app.post('/api/voice/query', (req,res)=>{
  const q = (req.body?.question||'').toLowerCase();
  const deviceId = req.body?.deviceId || 'VAX-001';
  const latest = db.get('telemetry').filter({ deviceId }).takeRight(1).value()[0];
  if (!latest) return res.json({ answer: "I don't have any data yet." });
  const risk = f01_riskScore(latest.state, latest.vibrationCount||0);
  let answer;
  if (q.includes('temperature')) answer = `Temperature is ${latest.temperature?.toFixed(1)} degrees.`;
  else if (q.includes('humidity')) answer = `Humidity is ${latest.humidity>=0?latest.humidity.toFixed(0):'unknown'} percent.`;
  else if (q.includes('vibration')) answer = `${latest.vibrationCount||0} vibration events in the current window.`;
  else if (q.includes('safe') || q.includes('okay')) answer = latest.state==='SAFE' ? 'Yes, everything is safe.' : `Currently in ${latest.state} state.`;
  else if (q.includes('risk')) answer = `Risk score is ${risk.score} out of 100. ${risk.reasons.join('. ')}`;
  else if (q.includes('why')) answer = f41_naturalLanguageRootCause(latest, {});
  else answer = `Current state is ${latest.state}.`;
  res.json({ answer, priority: f42_voiceAlertPriority(latest.state) });
});

app.use('/', express.static(path.join(__dirname, 'public')));
app.use((err,req,res,next)=>{ console.error(err); res.status(500).json({ error:'Internal error' }); });

const PORT = process.env.PORT || 4000;
app.listen(PORT, ()=>console.log(`VAXGUARD server running on port ${PORT}`));
