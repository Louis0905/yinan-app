// ════════════════════════════════════════
// 銀安 APP - 本機資料伺服器
// 使用方式：node server.js
// ════════════════════════════════════════

const http = require('http');
let memDB = { profile: null, sos_logs: [], med_logs: [], stress_logs: [], plans: [], assessment_logs: [] };
function loadDB() { return memDB; }
function saveDB(data) { memDB = data; }

// ── 讀取 request body ────────────────────────────
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

// ── 加時間戳 ─────────────────────────────────────
function withTimestamp(record) {
  return { ...record, _id: Date.now(), _ts: new Date().toISOString() };
}

// ── 印出資料摘要 ──────────────────────────────────
function printSummary(db) {
  console.log('\n📊 目前資料庫狀態:');
  console.log('  👤 個人評估:', db.profile ? `${db.profile.name} (風險:${db.profile.risk})` : '尚無');
  console.log('  🆘 SOS 紀錄:', db.sos_logs.length, '筆');
  console.log('  💊 用藥紀錄:', db.med_logs.length, '筆');
  console.log('  🧠 壓力燈號:', db.stress_logs.length, '筆');
  console.log('  📅 喘息計畫:', db.plans.length, '筆');
  console.log('');
}

// ── HTTP Server ───────────────────────────────────
const server = http.createServer(async (req, res) => {

  // CORS headers（讓 HTML 檔案可以直接呼叫）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  // OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200); res.end(); return;
  }

  const url = req.url.split('?')[0];

  // ─────────────────────────────────────────────────
  //  GET /data  →  回傳所有資料
  // ─────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/data') {
    const db = loadDB();
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, data: db }));
    return;
  }

  // ─────────────────────────────────────────────────
  //  POST /profile  →  儲存個人評估
  // ─────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/profile') {
    const body = await readBody(req);
    const db = loadDB();
    // 新的問卷完成時，清空舊的操作紀錄，只保留新評估
    if (body.event === 'completed') {
      db.sos_logs = [];
      db.med_logs = [];
      db.stress_logs = [];
      db.plans = [];
      db.assessment_logs = [];
      console.log('🔄 新 Demo 開始，舊資料已清空');
    }
    db.profile = withTimestamp(body);
    db.assessment_logs.push(withTimestamp({ ...body, event: body.event || 'saved' }));
    saveDB(db);
    console.log(`✅ [${new Date().toLocaleTimeString()}] 個人評估已儲存: ${body.name} 風險:${body.risk} 分數:${body.score}`);
    printSummary(db);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: '個人評估已儲存' }));
    return;
  }

  // ─────────────────────────────────────────────────
  //  POST /sos  →  SOS 求助紀錄
  // ─────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/sos') {
    const body = await readBody(req);
    const db = loadDB();
    db.sos_logs.push(withTimestamp(body));
    saveDB(db);
    console.log(`🆘 [${new Date().toLocaleTimeString()}] SOS 求助！使用者: ${body.user} 位置: ${body.location}`);
    printSummary(db);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: 'SOS 已紀錄' }));
    return;
  }

  // ─────────────────────────────────────────────────
  //  POST /med  →  用藥紀錄
  // ─────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/med') {
    const body = await readBody(req);
    const db = loadDB();
    db.med_logs.push(withTimestamp(body));
    saveDB(db);
    console.log(`💊 [${new Date().toLocaleTimeString()}] 服藥紀錄: ${body.name} ${body.dose} ${body.timing}`);
    printSummary(db);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: '用藥已紀錄' }));
    return;
  }

  // ─────────────────────────────────────────────────
  //  POST /stress  →  壓力燈號
  // ─────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/stress') {
    const body = await readBody(req);
    const db = loadDB();
    db.stress_logs.push(withTimestamp(body));
    saveDB(db);
    console.log(`🧠 [${new Date().toLocaleTimeString()}] 壓力記錄: ${body.emoji} 等級:${body.level}`);
    printSummary(db);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: '壓力狀態已紀錄' }));
    return;
  }

  // ─────────────────────────────────────────────────
  //  POST /plans  →  喘息計畫（整份同步）
  // ─────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/plans') {
    const body = await readBody(req);
    const db = loadDB();
    db.plans = body.plans || [];
    saveDB(db);
    console.log(`📅 [${new Date().toLocaleTimeString()}] 喘息計畫更新: ${db.plans.length} 筆`);
    printSummary(db);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: '喘息計畫已同步' }));
    return;
  }

  // ─────────────────────────────────────────────────
  //  DELETE /clear  →  清空所有資料
  // ─────────────────────────────────────────────────
  if (req.method === 'POST' && url === '/clear') {
    const init = { profile: null, sos_logs: [], med_logs: [], stress_logs: [], plans: [], assessment_logs: [] };
    saveDB(init);
    console.log('🗑️  資料庫已清空');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: '資料已清空' }));
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, message: '找不到此路由' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║        銀安 APP  本機伺服器             ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  🌐 伺服器位址: http://localhost:${PORT}   ║`);
  console.log(`║  📁 資料檔案:   yinan_data.json         ║`);
  console.log('║  ⌨️  停止伺服器: Ctrl + C               ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  printSummary(loadDB());
});