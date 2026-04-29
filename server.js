// ════════════════════════════════════════
// 銀安 APP - Railway 雲端伺服器
// ════════════════════════════════════════

const http = require('http');
const PORT = process.env.PORT || 3000;

let memDB = { profile: null, sos_logs: [], med_logs: [], stress_logs: [], plans: [], assessment_logs: [] };
function loadDB() { return memDB; }
function saveDB(data) { memDB = data; }

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { resolve({}); }
    });
  });
}

function withTimestamp(record) {
  return { ...record, _id: Date.now(), _ts: new Date().toISOString() };
}

function printSummary(db) {
  console.log('\n📊 目前資料庫狀態:');
  console.log('  👤 個人評估:', db.profile ? `${db.profile.name} (風險:${db.profile.risk})` : '尚無');
  console.log('  🆘 SOS 紀錄:', db.sos_logs.length, '筆');
  console.log('  💊 用藥紀錄:', db.med_logs.length, '筆');
  console.log('  🧠 壓力燈號:', db.stress_logs.length, '筆');
  console.log('  📅 喘息計畫:', db.plans.length, '筆');
  console.log('');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: '銀安APP Server', status: 'running' }));
    return;
  }

  if (req.method === 'GET' && url === '/data') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, data: loadDB() }));
    return;
  }

  if (req.method === 'POST' && url === '/profile') {
    const body = await readBody(req);
    const db = loadDB();
    if (body.event === 'completed') {
      db.sos_logs = []; db.med_logs = []; db.stress_logs = [];
      db.plans = []; db.assessment_logs = [];
      console.log('🔄 新 Demo 開始，舊資料已清空');
    }
    db.profile = withTimestamp(body);
    db.assessment_logs.push(withTimestamp({ ...body, event: body.event || 'saved' }));
    saveDB(db);
    console.log(`✅ [${new Date().toLocaleTimeString()}] 個人評估: ${body.name} 風險:${body.risk} 分數:${body.score}`);
    printSummary(db);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: '個人評估已儲存' }));
    return;
  }

  if (req.method === 'POST' && url === '/sos') {
    const body = await readBody(req);
    const db = loadDB();
    db.sos_logs.push(withTimestamp(body));
    saveDB(db);
    const gpsTag = body.gps_real ? '📍 真實GPS' : '⚠️  預設位置（使用者未開放GPS）';
    const mapsUrl = body.lat ? ` → https://maps.google.com/?q=${body.lat},${body.lng}` : '';
    console.log(`🆘 [${new Date().toLocaleTimeString()}] SOS！使用者: ${body.user}`);
    console.log(`   ${gpsTag}: ${body.location}${mapsUrl}`);
    printSummary(db);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: 'SOS 已紀錄' }));
    return;
  }

  if (req.method === 'POST' && url === '/med') {
    const body = await readBody(req);
    const db = loadDB();
    db.med_logs.push(withTimestamp(body));
    saveDB(db);
    console.log(`💊 [${new Date().toLocaleTimeString()}] 服藥: ${body.name} ${body.dose}`);
    printSummary(db);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: '用藥已紀錄' }));
    return;
  }

  if (req.method === 'POST' && url === '/stress') {
    const body = await readBody(req);
    const db = loadDB();
    db.stress_logs.push(withTimestamp(body));
    saveDB(db);
    console.log(`🧠 [${new Date().toLocaleTimeString()}] 壓力: ${body.emoji} 等級:${body.level}`);
    printSummary(db);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: '壓力狀態已紀錄' }));
    return;
  }

  if (req.method === 'POST' && url === '/plans') {
    const body = await readBody(req);
    const db = loadDB();
    db.plans = body.plans || [];
    saveDB(db);
    console.log(`📅 [${new Date().toLocaleTimeString()}] 喘息計畫更新: ${db.plans.length} 筆`);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: '喘息計畫已同步' }));
    return;
  }

  if (req.method === 'POST' && url === '/clear') {
    memDB = { profile: null, sos_logs: [], med_logs: [], stress_logs: [], plans: [], assessment_logs: [] };
    console.log('🗑️  資料庫已清空');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: '資料已清空' }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, message: '找不到此路由' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║        銀安 APP  Railway 伺服器         ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  🌐 PORT: ${String(PORT).padEnd(30)}║`);
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  printSummary(loadDB());
});
