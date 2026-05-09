// ════════════════════════════════════════
// 銀安 APP - Railway 雲端伺服器
// ════════════════════════════════════════

const http  = require('http');
const https = require('https');
const PORT  = process.env.PORT || 3000;

const LINE_TOKEN = 'ltvwoo7FoPeILJfjVxxu6xt60G2vaULO0BmYqmGYOVK+iSx1NuzMHfTlEZIQ267yXHXeEghmxmBKua4LsxnkLhsJvYws4KPD776VfKT8Ir1YoVnapDYgl/ONE77ld9TM0ihr0xis+/Uai5Lb0WKvVQdB04t89/1O/w1cDnyilFU=';

// 緊急聯絡人（從 APP 同步過來，也可在此直接設定）
let savedContacts = [];

// ── LINE 發送 ─────────────────────────────────────
function sendLINE(userId, message) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ to: userId, messages: [{ type: 'text', text: message }] });
    const opts = {
      hostname: 'api.line.me', path: '/v2/bot/message/push', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_TOKEN}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`  LINE → ${userId.slice(0,8)}… ${res.statusCode === 200 ? '✅ 成功' : `❌ 失敗(${res.statusCode}): ${data}`}`);
        resolve(res.statusCode === 200);
      });
    });
    req.on('error', e => { console.log(`  LINE 連線錯誤: ${e.message}`); resolve(false); });
    req.write(body); req.end();
  });
}

// 廣播給特定類型的聯絡人
async function broadcast(contacts, notifyType, message) {
  const targets = contacts.filter(c => (c.notifyTypes || ['sos']).includes(notifyType) && c.userId);
  if (targets.length === 0) {
    console.log(`  ⚠️  沒有設定 ${notifyType} 通知的聯絡人`);
    return;
  }
  for (const c of targets) {
    console.log(`  📲 發送給 ${c.name}（${c.relation || ''}）`);
    await sendLINE(c.userId, message);
  }
}

// ── 工具函式 ──────────────────────────────────────
let memDB = { profile: null, sos_logs: [], med_logs: [], stress_logs: [], plans: [], bp_logs: [], assessment_logs: [] };
function loadDB() { return memDB; }
function saveDB(d) { memDB = d; }

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
  });
}
function ts(r) { return { ...r, _id: Date.now(), _ts: new Date().toISOString() }; }
function now() { return new Date().toLocaleString('zh-TW', { timeZone:'Asia/Taipei', hour12:false }); }

function printSummary(db) {
  console.log(`\n📊 資料庫 | 👤${db.profile?.name||'無'} | 🆘${db.sos_logs.length} | 💊${db.med_logs.length} | 🧠${db.stress_logs.length} | 📅${db.plans.length} | 👥聯絡人${savedContacts.length}\n`);
}

// ── Server ────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];

  // 健康檢查
  if (req.method === 'GET' && url === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: '銀安APP', contacts: savedContacts.length }));
    return;
  }

  if (req.method === 'GET' && url === '/data') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, data: loadDB(), contacts: savedContacts }));
    return;
  }

  // 同步聯絡人
  if (req.method === 'POST' && url === '/contacts') {
    const body = await readBody(req);
    savedContacts = body.contacts || [];
    console.log(`👥 [${now()}] 聯絡人更新: ${savedContacts.length} 位`);
    savedContacts.forEach(c => console.log(`   ${c.name} (${c.relation}) → ${c.userId?.slice(0,12)}… 通知:${(c.notifyTypes||[]).join(',')}`));
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 🆘 SOS
  if (req.method === 'POST' && url === '/sos') {
    const body = await readBody(req);
    const db = loadDB();
    db.sos_logs.push(ts(body));
    saveDB(db);
    const gpsTag = body.gps_real ? '📍 真實GPS' : '⚠️ 預設位置';
    const mapsUrl = body.lat ? `https://maps.google.com/?q=${body.lat},${body.lng}` : '';
    console.log(`\n🆘🆘🆘 SOS！[${now()}] 使用者:${body.user}`);
    console.log(`  ${gpsTag}: ${body.location}`);
    if (mapsUrl) console.log(`  地圖: ${mapsUrl}`);

    // 使用 APP 傳來的聯絡人，或 server 已儲存的
    const contacts = body.contacts?.length ? body.contacts : savedContacts;
    if (contacts.length > 0) {
      const msg = [`🆘【銀安APP 緊急求助】`, ``, `📋 照護對象：${body.user}`, `⏰ 時間：${now()}`, `📍 位置：${body.location}`, mapsUrl ? `🗺️ ${mapsUrl}` : '', ``, `請立即確認照護對象狀況！`].filter(Boolean).join('\n');
      broadcast(contacts, 'sos', msg);
    } else {
      console.log('  ⚠️  尚未設定緊急聯絡人');
    }
    printSummary(db);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 💊 用藥
  if (req.method === 'POST' && url === '/med') {
    const body = await readBody(req);
    const db = loadDB();
    db.med_logs.push(ts(body));
    saveDB(db);
    console.log(`💊 [${now()}] ${body.user} 服藥:${body.name}`);
    printSummary(db);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 🧠 壓力
  if (req.method === 'POST' && url === '/stress') {
    const body = await readBody(req);
    const db = loadDB();
    db.stress_logs.push(ts(body));
    saveDB(db);
    console.log(`🧠 [${now()}] ${body.user} 壓力:${body.emoji}(${body.level})`);
    if (body.level === 'red') {
      const contacts = savedContacts;
      const msg = [`⚠️【銀安APP 壓力警示】`, ``, `📋 照護對象：${body.user}`, `⏰ 時間：${now()}`, `🧠 狀態：壓力偏高 ${body.emoji}`, body.note ? `📝 備註：${body.note}` : '', ``, `請關心照護對象的狀況。`].filter(Boolean).join('\n');
      broadcast(contacts, 'stress', msg);
    }
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ❤️ 血壓
  if (req.method === 'POST' && url === '/bp') {
    const body = await readBody(req);
    const db = loadDB();
    if (!db.bp_logs) db.bp_logs = [];
    db.bp_logs.push(ts(body));
    saveDB(db);
    console.log(`❤️  [${now()}] ${body.user} 血壓:${body.sys}/${body.dia}`);
    if (body.sys >= 180 || body.dia >= 120) {
      const msg = `🚨【銀安APP 血壓危象】\n\n📋 照護對象：${body.user}\n⏰ 時間：${now()}\n❤️ 血壓：${body.sys}/${body.dia} mmHg\n\n請立即協助就醫！`;
      broadcast(savedContacts, 'bp', msg);
    }
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 📋 個人評估
  if (req.method === 'POST' && url === '/profile') {
    const body = await readBody(req);
    const db = loadDB();
    if (body.event === 'completed') {
      db.sos_logs=[]; db.med_logs=[]; db.stress_logs=[]; db.plans=[]; db.assessment_logs=[];
    }
    db.profile = ts(body);
    db.assessment_logs.push(ts({ ...body, event: body.event||'saved' }));
    saveDB(db);
    console.log(`✅ [${now()}] 評估:${body.name} 風險:${body.risk}`);
    printSummary(db);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 📅 喘息計畫
  if (req.method === 'POST' && url === '/plans') {
    const body = await readBody(req);
    const db = loadDB();
    db.plans = body.plans || [];
    saveDB(db);
    console.log(`📅 [${now()}] 喘息計畫:${db.plans.length}筆`);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 📲 LINE 測試
  if (req.method === 'POST' && url === '/line-test') {
    const body = await readBody(req);
    const contacts = body.contacts?.length ? body.contacts : savedContacts;
    if (contacts.length === 0) { res.writeHead(200); res.end(JSON.stringify({ ok: false, message: '無聯絡人' })); return; }
    const msg = `📲【銀安APP 測試訊息】\n\n✅ 您已成功加入緊急聯絡人名單\n\n當 ${body.user||'照護對象'} 按下 SOS 時，您會收到即時通知。\n\n⏰ 測試時間：${now()}`;
    let allOk = true;
    for (const c of contacts) {
      if (c.userId) { const ok = await sendLINE(c.userId, msg); if (!ok) allOk = false; }
    }
    res.writeHead(200);
    res.end(JSON.stringify({ ok: allOk }));
    return;
  }

  // LINE Webhook（取得 User ID）
  if (req.method === 'POST' && url === '/webhook') {
    const body = await readBody(req);
    for (const event of (body.events||[])) {
      const userId = event.source?.userId;
      if (userId) {
        console.log(`\n👤 LINE User ID: ${userId}`);
        if (event.type === 'follow' || event.type === 'message') {
          await sendLINE(userId, `👋 您好！\n\n您的 LINE User ID 是：\n${userId}\n\n請將此 ID 提供給照顧者，在銀安APP 的「緊急聯絡人」設定中填入，即可接收 SOS 等緊急通知。`);
        }
      }
    }
    res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
  }

  // 清空
  if (req.method === 'POST' && url === '/clear') {
    memDB = { profile:null, sos_logs:[], med_logs:[], stress_logs:[], plans:[], bp_logs:[], assessment_logs:[] };
    console.log('🗑️  資料清空');
    res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
  }

  res.writeHead(404); res.end(JSON.stringify({ ok: false, message: '404' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║       銀安 APP  Railway 伺服器         ║');
  console.log('╠═══════════════════════════════════════╣');
  console.log(`║  PORT: ${String(PORT).padEnd(31)}║`);
  console.log(`║  LINE Token: 已設定                   ║`);
  console.log('╚═══════════════════════════════════════╝');
  console.log('');
  console.log('Webhook URL:');
  console.log('  https://yinan-app-production.up.railway.app/webhook');
  console.log('');
  printSummary(loadDB());
});
