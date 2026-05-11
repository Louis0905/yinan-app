// ════════════════════════════════════════
// 銀安 APP - Railway 雲端伺服器
// ════════════════════════════════════════

const http  = require('http');
const https = require('https');
const PORT  = process.env.PORT || 3000;

const LINE_TOKEN = 'ltvwoo7FoPeILJfjVxxu6xt60G2vaULO0BmYqmGYOVK+iSx1NuzMHfTlEZIQ267yXHXeEghmxmBKua4LsxnkLhsJvYws4KPD776VfKT8Ir1YoVnapDYgl/ONE77ld9TM0ihr0xis+/Uai5Lb0WKvVQdB04t89/1O/w1cDnyilFU=';

// ── 自架 AI 設定 ──────────────────────────────────
const AI_API_KEY  = 'Louis@0905';
const AI_BASE_URL = 'http://60.251.180.157:8000/v1';
const AI_MODEL    = 'gpt-oss-20b-MXFP4-Q8';

async function callAI(systemPrompt, userContent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  }
      ],
      temperature: 0.7,
      max_tokens: 1500
    });

    // 解析 URL
    const url = new URL(AI_BASE_URL + '/chat/completions');
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (content) resolve(content);
          else reject(new Error('AI 回應格式錯誤: ' + data));
        } catch(e) { reject(new Error('AI 解析失敗: ' + data)); }
      });
    });
    req.on('error', e => reject(e));
    req.write(body);
    req.end();
  });
}

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

  if (req.method === 'POST' && url === '/sos') {
    const body = await readBody(req);
    const db = loadDB();
    db.sos_logs.push(ts(body));
    saveDB(db);
    const gpsTag = body.gps_real ? '📍 真實GPS' : '⚠️ GPS未開放';
    const mapsUrl = body.gps_real && body.lat ? `https://maps.google.com/?q=${body.lat},${body.lng}` : null;
    console.log(`\n🆘🆘🆘 SOS！[${now()}] 使用者:${body.user}`);
    console.log(`  ${gpsTag}: ${body.location}`);
    if (mapsUrl) console.log(`  地圖: ${mapsUrl}`);

    const contacts = body.contacts?.length ? body.contacts : savedContacts;
    if (contacts.length > 0) {
      const lines = [
        `🆘【銀安APP 緊急求助】`,
        ``,
        `📋 照護對象：${body.user}`,
        `⏰ 時間：${now()}`,
      ];
      if (body.gps_real && body.lat) {
        lines.push(`📍 位置：${body.lat}, ${body.lng}`);
        lines.push(`🗺️ ${mapsUrl}`);
      } else {
        lines.push(`📍 位置：無法取得（請聯繫確認）`);
      }
      lines.push(``, `請立即確認照護對象狀況！`);
      broadcast(contacts, 'sos', lines.join('\n'));
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

  if (req.method === 'POST' && url === '/webhook') {
    const body = await readBody(req);
    for (const event of (body.events||[])) {
      const userId = event.source?.userId;
      if (userId && (event.type === 'follow' || event.type === 'message')) {
        console.log(`\n👤 LINE User ID: ${userId}`);
        // 發送含按鈕的訊息（Flex Message）
        const flexMsg = {
          to: userId,
          messages: [{
            type: 'flex',
            altText: '歡迎加入銀安APP！',
            contents: {
              type: 'bubble',
              hero: {
                type: 'box',
                layout: 'vertical',
                contents: [{
                  type: 'text',
                  text: '🏥 銀安APP',
                  size: 'xxl',
                  weight: 'bold',
                  color: '#ffffff',
                  align: 'center'
                }],
                backgroundColor: '#3182CE',
                paddingAll: '20px'
              },
              body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'md',
                contents: [
                  { type: 'text', text: '👋 歡迎加入銀安APP！', weight: 'bold', size: 'lg', color: '#1a202c' },
                  { type: 'text', text: '您已成功加入緊急通知名單', size: 'sm', color: '#718096', margin: 'sm' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: '① 填入「通知 ID」（接收 SOS 用）', weight: 'bold', size: 'sm', color: '#4a5568', margin: 'lg' },
                  {
                    type: 'box', layout: 'vertical',
                    backgroundColor: '#EBF8FF', cornerRadius: '8px', paddingAll: '10px', margin: 'sm',
                    contents: [
                      { type: 'text', text: userId, size: 'xs', color: '#2b6cb0', wrap: true, weight: 'bold' }
                    ],
                    action: { type: 'clipboard', clipboardText: userId }
                  },
                  {
                    type: 'button', style: 'secondary', height: 'sm', margin: 'sm',
                    label: '📋 點此複製通知 ID',
                    action: { type: 'clipboard', clipboardText: userId },
                    color: '#EBF8FF'
                  },
                  { type: 'text', text: '👆 點此複製「通知 ID」', size: 'xs', color: '#718096', wrap: true, margin: 'xs', align: 'center' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: '② 查詢「LINE ID」（直接對話用）', weight: 'bold', size: 'sm', color: '#4a5568', margin: 'lg' },
                  {
                    type: 'box', layout: 'vertical',
                    backgroundColor: '#F0FFF4', cornerRadius: '8px', paddingAll: '10px', margin: 'sm',
                    contents: [
                      { type: 'text', text: 'LINE → 設定 → 個人檔案 → LINE ID', size: 'xs', color: '#276749', wrap: true, weight: 'bold' }
                    ]
                  },
                  { type: 'text', text: '將以上兩個 ID 都提供給照顧者，填入緊急聯絡人設定後，可接收 SOS 通知 & 直接傳訊息。', size: 'xs', color: '#718096', wrap: true, margin: 'md' }
                ]
              },
              footer: {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [
                  {
                    type: 'button',
                    style: 'primary',
                    color: '#3182CE',
                    action: {
                      type: 'uri',
                      label: '🏠 開啟銀安APP',
                      uri: 'https://louis0905.github.io/yinan-app/'
                    }
                  },
                  {
                    type: 'button',
                    style: 'secondary',
                    action: {
                      type: 'message',
                      label: '📋 再次查看我的 User ID',
                      text: '查看 User ID'
                    }
                  }
                ]
              }
            }
          }]
        };
        // 發送 Flex Message
        const flexBody = JSON.stringify(flexMsg);
        await new Promise((resolve) => {
          const opts = {
            hostname: 'api.line.me', path: '/v2/bot/message/push', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}`, 'Content-Length': Buffer.byteLength(flexBody) }
          };
          const req2 = https.request(opts, (res2) => {
            let d = '';
            res2.on('data', c => d += c);
            res2.on('end', () => { console.log(`  歡迎訊息 ${res2.statusCode === 200 ? '✅' : '❌ ' + d}`); resolve(); });
          });
          req2.on('error', () => resolve());
          req2.write(flexBody); req2.end();
        });
      }
    }
    res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
  }

  // 🤖 AI 照護日誌生成
  if (req.method === 'POST' && url === '/ai-journal') {
    const body = await readBody(req);
    const { text, profile, date } = body;
    if (!text) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: '請提供日誌內容' })); return; }

    console.log(`\n🤖 [${now()}] AI 日誌生成 (${text.length} 字)`);

    const systemPrompt = `你是一位專業的長照照護記錄助理。
請將照顧者提供的口語記錄整理成結構化的照護日誌報表，使用繁體中文。
格式要求：
1. 簡潔清楚，方便家屬閱讀
2. 自動分類：身體狀況、情緒狀態、飲食記錄、活動記錄、異常事項、待追蹤事項
3. 沒有提到的項目不要留空白格，直接略過
4. 結尾加上「照顧者建議」（如有需要）
5. 輸出格式為純文字，用 emoji 輔助分類`;

    const userContent = `照護對象：${profile?.name || '長輩'}
記錄日期：${date || now()}
照顧者口述記錄：
${text}`;

    try {
      const result = await callAI(systemPrompt, userContent);
      console.log(`  ✅ AI 生成完成 (${result.length} 字)`);

      // 儲存日誌
      const db = loadDB();
      if (!db.journals) db.journals = [];
      db.journals.push({
        _ts: new Date().toISOString(),
        rawText: text,
        report: result,
        profileName: profile?.name || '長輩'
      });
      saveDB(db);

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, report: result }));
    } catch(e) {
      console.log(`  ❌ AI 失敗: ${e.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, message: 'AI 服務錯誤: ' + e.message }));
    }
    return;
  }

  // 📨 傳送日誌給家屬
  if (req.method === 'POST' && url === '/send-journal') {
    const body = await readBody(req);
    const { report, contacts, profileName } = body;
    if (!report || !contacts?.length) { res.writeHead(400); res.end(JSON.stringify({ ok: false })); return; }
    const msg = `📋【銀安APP 照護日誌】\n\n照護對象：${profileName||'長輩'}\n時間：${now()}\n\n${report}`;
    for (const c of contacts) {
      if (c.userId) await sendLINE(c.userId, msg);
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
