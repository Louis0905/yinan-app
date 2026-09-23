// ════════════════════════════════════════
// 銀安 APP - Railway 雲端伺服器
// ════════════════════════════════════════

const http  = require('http');
const https = require('https');
const PORT  = process.env.PORT || 3000;

const LINE_TOKEN = 'ltvwoo7FoPeILJfjVxxu6xt60G2vaULO0BmYqmGYOVK+iSx1NuzMHfTlEZIQ267yXHXeEghmxmBKua4LsxnkLhsJvYws4KPD776VfKT8Ir1YoVnapDYgl/ONE77ld9TM0ihr0xis+/Uai5Lb0WKvVQdB04t89/1O/w1cDnyilFU=';

// ── 自架 AI 設定 ──────────────────────────────────
const AI_API_KEY  = 'Louis@0905';
const AI_BASE_URL = 'http://60.251.180.157:8001/v1';
const AI_MODEL    = 'gpt-oss-20b-MXFP4-Q8';

// APP 介面語言代碼 → 給 AI 翻譯指示用的語言名稱
// （照護日誌報表要依外籍照顧者當下選擇的 APP 語言顯示，方便他們自己看懂；
//   但傳給家屬/接班人的 LINE 通知，仍固定用繁體中文，見 /ai-journal 與 /send-journal）
const LANG_NAMES = {
  'zh-TW': '繁體中文',
  'zh-CN': '簡體中文',
  'id': 'Bahasa Indonesia（印尼文）',
  'vi': 'Tiếng Việt（越南文）',
  'fil': 'Filipino（菲律賓文/他加祿語）',
};

async function callAI(systemPrompt, userContent, maxTokens = 1500) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  }
      ],
      temperature: 0.7,
      max_tokens: maxTokens
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
      const contacts = body.contacts?.length ? body.contacts : savedContacts;
      let report = `壓力偏高 ${body.emoji}${body.note ? `，備註：${body.note}` : ''}。建議適時休息並關心照顧者狀況。`;
      try {
        const aiResult = await callAI(
          `你是長照照護異常分析助理。根據照顧者的壓力狀態生成簡短的家屬通知摘要（繁體中文，不超過80字）。語氣溫和關懷。`,
          `照護對象：${body.user}，時間：${now()}，照顧者壓力狀態：${body.emoji}（紅燈）${body.note ? `，備註：${body.note}` : ''}。請生成通知摘要。`
        );
        report = aiResult;
      } catch(e) {
        console.log(`  ⚠️ AI 分析失敗，使用固定文字`);
      }
      const msg = `📋【銀安APP 照護日誌】\n\n照護對象：${body.user}\n時間：${now()}\n\n🧠 壓力偏高\n\n${report}`;
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
    console.log(`❤️  [${now()}] ${body.user} 血壓:${body.sys}/${body.dia} 心跳:${body.hr||'--'}`);

    // 血壓異常 → AI 分析 → LINE
    let alertMsg = null;
    let alertLevel = null;
    if (body.sys >= 180 || body.dia >= 120) {
      alertLevel = 'crisis';
      alertMsg = `🚨 血壓危象｜${body.sys}/${body.dia} mmHg`;
    } else if (body.sys >= 160 || body.dia >= 100) {
      alertLevel = 'high2';
      alertMsg = `⚠️ 血壓偏高（第二期）｜${body.sys}/${body.dia} mmHg`;
    } else if (body.sys >= 140 || body.dia >= 90) {
      alertLevel = 'high1';
      alertMsg = `⚠️ 血壓偏高（第一期）｜${body.sys}/${body.dia} mmHg`;
    }

    if (alertLevel) {
      const contacts = body.contacts?.length ? body.contacts : savedContacts;
      // 嘗試用 AI 生成分析，失敗則用固定文字
      let report = alertMsg + `\n\n建議持續監測並告知醫師。`;
      try {
        const aiResult = await callAI(
          `你是長照照護異常分析助理。根據血壓數值生成簡短的家屬通知摘要（繁體中文，不超過80字）。說明異常狀況並給出建議行動。語氣溫和但明確。`,
          `照護對象：${body.user}，時間：${now()}，血壓：${body.sys}/${body.dia} mmHg${body.hr ? `，心跳：${body.hr} bpm` : ''}。請生成通知摘要。`
        );
        report = aiResult;
      } catch(e) {
        console.log(`  ⚠️ AI 分析失敗，使用固定文字`);
      }
      const msg = `📋【銀安APP 照護日誌】\n\n照護對象：${body.user}\n時間：${now()}\n\n${alertMsg.split('｜')[0]}\n\n${report}`;
      broadcast(contacts, 'bp', msg);
    }

    // 心跳異常
    if (body.hr && body.hr > 120) {
      const contacts = body.contacts?.length ? body.contacts : savedContacts;
      const msg = `💗【銀安APP 心跳警示】\n\n📋 照護對象：${body.user}\n⏰ 時間：${now()}\n💗 心跳：${body.hr} bpm（偏快）\n\n建議休息並告知醫師。`;
      broadcast(contacts, 'bp', msg);
    } else if (body.hr && body.hr < 50) {
      const contacts = body.contacts?.length ? body.contacts : savedContacts;
      const msg = `🔵【銀安APP 心跳警示】\n\n📋 照護對象：${body.user}\n⏰ 時間：${now()}\n🔵 心跳：${body.hr} bpm（偏慢）\n\n建議告知醫師。`;
      broadcast(contacts, 'bp', msg);
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
      if (!userId) continue;

      // 只回應：加好友、查看User ID指令、LINE ID格式回覆
      const isFollow = event.type === 'follow';
      const isViewId = event.type === 'message' && event.message?.text === '查看 User ID';
      const isLineIdReply = event.type === 'message' && event.message?.type === 'text' &&
        /^[a-zA-Z0-9._-]{3,20}$/.test(event.message.text.trim().replace('@',''));

      if (!isFollow && !isViewId && !isLineIdReply) continue; // 其他訊息不回覆

      console.log(`\n👤 LINE User ID: ${userId} (${event.type})`);

      // LINE ID 格式回覆 → 發確認卡片
      if (isLineIdReply) {
        const lineId = event.message.text.trim().replace('@','');
        console.log(`  💬 收到 LINE ID: ${lineId}`);
        const msg = {
          to: userId,
          messages: [{ type: 'flex', altText: '✅ ID 整理完成，請截圖給照顧者',
            contents: { type: 'bubble',
              hero: { type: 'box', layout: 'vertical', backgroundColor: '#3182CE', paddingAll: '20px',
                contents: [{ type: 'text', text: '🏥 銀安APP', size: 'xxl', weight: 'bold', color: '#ffffff', align: 'center' }]
              },
              body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
                { type: 'text', text: '✅ ID 整理完成！', weight: 'bold', size: 'lg', color: '#1a202c' },
                { type: 'text', text: '請截圖提供給照顧者填入設定', size: 'sm', color: '#718096', margin: 'sm' },
                { type: 'separator', margin: 'lg' },
                { type: 'text', text: '📋 User ID（接收 SOS 通知用）', weight: 'bold', size: 'sm', color: '#4a5568', margin: 'lg' },
                { type: 'box', layout: 'horizontal', backgroundColor: '#EBF8FF', cornerRadius: '8px', paddingAll: '10px', margin: 'sm',
                  action: { type: 'clipboard', clipboardText: userId },
                  contents: [
                    { type: 'text', text: userId, size: 'xxs', color: '#2b6cb0', wrap: true, weight: 'bold', flex: 5 },
                    { type: 'text', text: '複製', size: 'xs', color: '#3182CE', weight: 'bold', flex: 1, align: 'end', gravity: 'center' }
                  ]
                },
                { type: 'separator', margin: 'lg' },
                { type: 'text', text: '💬 LINE ID（直接對話用）', weight: 'bold', size: 'sm', color: '#4a5568', margin: 'lg' },
                { type: 'box', layout: 'horizontal', backgroundColor: '#F0FFF4', cornerRadius: '8px', paddingAll: '10px', margin: 'sm',
                  action: { type: 'clipboard', clipboardText: lineId },
                  contents: [
                    { type: 'text', text: lineId, size: 'sm', color: '#276749', wrap: true, weight: 'bold', flex: 5 },
                    { type: 'text', text: '複製', size: 'xs', color: '#38A169', weight: 'bold', flex: 1, align: 'end', gravity: 'center' }
                  ]
                },
                { type: 'text', text: '👆 點擊各區塊可分別複製', size: 'xs', color: '#718096', wrap: true, margin: 'sm', align: 'center' }
              ]},
              footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
                { type: 'button', style: 'primary', color: '#3182CE',
                  action: { type: 'uri', label: '🏠 開啟銀安APP', uri: 'https://louis0905.github.io/yinan-app/' } }
              ]}
            }
          }]
        };
        const mb = JSON.stringify(msg);
        await new Promise(r => {
          const o = { hostname:'api.line.me', path:'/v2/bot/message/push', method:'POST',
            headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${LINE_TOKEN}`, 'Content-Length':Buffer.byteLength(mb) } };
          const rq = https.request(o, rs => { let d=''; rs.on('data',c=>d+=c); rs.on('end',()=>{ console.log(`  確認訊息 ${rs.statusCode===200?'✅':'❌ '+d}`); r(); }); });
          rq.on('error', ()=>r()); rq.write(mb); rq.end();
        });
        continue;
      }

      // 加好友 或 查看User ID → 發歡迎訊息
      const welcomeMsg = {
        to: userId,
        messages: [{ type: 'flex', altText: '歡迎加入銀安APP！您的 User ID：' + userId,
          contents: { type: 'bubble',
            hero: { type: 'box', layout: 'vertical', backgroundColor: '#3182CE', paddingAll: '20px',
              contents: [{ type: 'text', text: '🏥 銀安APP', size: 'xxl', weight: 'bold', color: '#ffffff', align: 'center' }]
            },
            body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
              { type: 'text', text: '👋 歡迎加入銀安APP！', weight: 'bold', size: 'lg', color: '#1a202c' },
              { type: 'text', text: '您已成功加入緊急通知名單', size: 'sm', color: '#718096', margin: 'sm' },
              { type: 'separator', margin: 'lg' },
              { type: 'text', text: '📋 您的 User ID', weight: 'bold', size: 'sm', color: '#4a5568', margin: 'lg' },
              { type: 'box', layout: 'horizontal', backgroundColor: '#EBF8FF', cornerRadius: '8px', paddingAll: '10px', margin: 'sm',
                action: { type: 'clipboard', clipboardText: userId },
                contents: [
                  { type: 'text', text: userId, size: 'xxs', color: '#2b6cb0', wrap: true, weight: 'bold', flex: 5 },
                  { type: 'text', text: '複製', size: 'xs', color: '#3182CE', weight: 'bold', flex: 1, align: 'end', gravity: 'center' }
                ]
              },
              { type: 'text', text: '👆 點擊藍色區塊可複製', size: 'xs', color: '#718096', wrap: true, margin: 'xs', align: 'center' },
              { type: 'separator', margin: 'lg' },
              { type: 'text', text: '💬 LINE ID（直接對話用）', weight: 'bold', size: 'sm', color: '#4a5568', margin: 'lg' },
              { type: 'text', text: '請回覆您的 LINE ID 給我，收到後我會整理成一則訊息方便截圖給照顧者。\n\n查詢：LINE → 設定 → 個人檔案 → LINE ID', size: 'xs', color: '#718096', wrap: true, margin: 'sm' }
            ]},
            footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
              { type: 'button', style: 'primary', color: '#3182CE',
                action: { type: 'uri', label: '🏠 開啟銀安APP', uri: 'https://louis0905.github.io/yinan-app/' } },
              { type: 'button', style: 'secondary',
                action: { type: 'message', label: '📋 再次查看 User ID', text: '查看 User ID' } }
            ]}
          }
        }]
      };
      const wb = JSON.stringify(welcomeMsg);
      await new Promise(r => {
        const o = { hostname:'api.line.me', path:'/v2/bot/message/push', method:'POST',
          headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${LINE_TOKEN}`, 'Content-Length':Buffer.byteLength(wb) } };
        const rq = https.request(o, rs => { let d=''; rs.on('data',c=>d+=c); rs.on('end',()=>{ console.log(`  歡迎訊息 ${rs.statusCode===200?'✅':'❌ '+d}`); r(); }); });
        rq.on('error', ()=>r()); rq.write(wb); rq.end();
      });
    }
    res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
  }

  // 🤖 AI 照護日誌生成
  if (req.method === 'POST' && url === '/ai-journal') {
    const body = await readBody(req);
    const { text, profile, date, lang } = body;
    if (!text) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: '請提供日誌內容' })); return; }

    console.log(`\n🤖 [${now()}] AI 日誌生成 (${text.length} 字)${lang && lang !== 'zh-TW' ? `，目標語言:${lang}` : ''}`);

    const isAutoAlert = body.autoAlert === true;
    // 自架的落地 AI 模型（20B，跑在自己機器上）本來生成一次報表就要一點時間，
    // 如果拆成「先生成中文、再呼叫一次翻譯」兩次獨立的 API 呼叫，等於要排隊處理兩次、
    // 而且第二次還要重新讀一次上下文，很容易兩次加起來超過前端 30 秒的等待時間而 timeout。
    // 改成一次請求就同時要求 AI 輸出「中文報表」+ 分隔符號 + 「翻譯版報表」，只跑一次推論，
    // 省掉第二次的排隊與上下文重讀時間。
    const targetLangName = lang && lang !== 'zh-TW' ? LANG_NAMES[lang] : null;
    const TRANSLATION_DELIMITER = '===TRANSLATION===';

    const baseFormatRules = `格式要求：1.簡潔清楚方便家屬閱讀 2.自動分類：身體狀況、情緒狀態、飲食記錄、活動記錄、異常事項、待追蹤事項 3.沒提到的項目直接略過 4.若為交接班記錄加上【交接重點】段落 5.結尾加上照顧者建議（如有需要）6.輸出純文字用emoji輔助分類`;

    const systemPrompt = isAutoAlert
      ? `你是長照照護異常分析助理。根據偵測到的異常事件，生成簡短的家屬通知摘要（繁體中文，不超過150字）。先說明異常狀況，再給出建議行動。語氣溫和但明確。`
      : targetLangName
        ? `你是一位專業的長照照護記錄助理，同時精通${targetLangName}翻譯。照顧者提供的口述記錄可能是用${targetLangName}講的，請依序完成兩個步驟並照順序輸出：
【步驟一】將照顧者提供的口語記錄整理成結構化的照護日誌報表，全部內容都必須是繁體中文。如果原始口述記錄中出現${targetLangName}或其他非中文的詞語、片語、句子，也要把它們翻譯成繁體中文寫進報表裡，不可以原封不動保留非中文的字詞（emoji 除外）。${baseFormatRules}
【步驟二】另起一行，只輸出這個分隔符號：${TRANSLATION_DELIMITER}
【步驟三】接著把步驟一產生的完整繁體中文報表，完整翻譯成${targetLangName}，保留段落結構、條列與 emoji，不要增加、省略或評論內容。
請務必依「中文報表 → 分隔符號 → 翻譯報表」的順序輸出，不要附加任何其他說明文字，步驟一產生的報表裡絕對不能混雜非中文字詞。`
        : `你是一位專業的長照照護記錄助理。請將照顧者提供的口語記錄整理成結構化的照護日誌報表，使用繁體中文。${baseFormatRules}`;

    const userContent = `照護對象：${profile?.name || '長輩'}
記錄日期：${date || now()}
照顧者口述記錄：
${text}`;

    try {
      // 有翻譯需求時，輸出內容變成兩份報表疊在一起，長度接近兩倍，max_tokens 也要跟著放寬，
      // 避免翻譯的部分被截斷。
      const result = await callAI(systemPrompt, userContent, targetLangName ? 2600 : 1500);
      console.log(`  ✅ AI 生成完成 (${result.length} 字)`);

      // 拆分中文版／翻譯版
      let reportZh = result;
      let report = result;
      if (targetLangName) {
        const idx = result.indexOf(TRANSLATION_DELIMITER);
        if (idx !== -1) {
          reportZh = result.slice(0, idx).trim();
          report = result.slice(idx + TRANSLATION_DELIMITER.length).trim() || reportZh;
        } else {
          console.log(`  ⚠️ AI 沒有輸出分隔符號`);
        }

        // 保險機制：不管有沒有抓到分隔符號，都再確認一次 reportZh 是不是「真的」是中文。
        // 落地小模型偶爾會不聽兩步驟指令，整段直接輸出翻譯後的外語內容、完全略過中文段落，
        // 這種情況下如果照舊把整份輸出當成「中文版」，會導致傳給家屬的 LINE 訊息其實是
        // 外語，家屬看不懂——這裡用中文字元比例判斷，太低就代表這份其實是外語，改成：
        // 原始輸出當作看護畫面顯示用的翻譯版，另外單獨呼叫一次「純中文、不翻譯」確保
        // 傳給家屬的一定是真的中文。
        const hanCount = (reportZh.match(/[一-鿿]/g) || []).length;
        const nonSpaceLen = reportZh.replace(/\s/g, '').length || 1;
        const hanRatio = hanCount / nonSpaceLen;
        if (hanRatio < 0.15) {
          console.log(`  ⚠️ 中文版偵測到不像中文（中文字比例僅 ${(hanRatio*100).toFixed(0)}%），視為AI整段直接輸出了外語，改用原始輸出當翻譯版，另外重新產生中文版給家屬`);
          report = result;
          try {
            const zhOnlyPrompt = `你是一位專業的長照照護記錄助理。請將照顧者提供的口語記錄整理成結構化的照護日誌報表，使用繁體中文。${baseFormatRules}`;
            reportZh = await callAI(zhOnlyPrompt, userContent, 1500);
          } catch (e2) {
            console.log(`  ❌ 中文版備援呼叫也失敗: ${e2.message}，退回使用原始輸出（可能仍是外語，請留意）`);
            reportZh = result;
          }
        }

        // 保險機制二：這個落地模型有個習慣，即使被要求「全部中文」，還是會不時寫成
        // 「中文短語（外語原文 / 另一語言原文）」這種雙語括號附註格式（例如
        // 「情緒良好（Semangat baik / Tinh thần tốt）」），只把「標籤」翻成中文，
        // 卻把每一項的內容原封不動用括號夾帶外語留著。這裡把中文版裡任何「括號內幾乎
        // 沒有中文字、但有拉丁字母且像片語（有空格或斜線）」的括號附註整組剝掉，
        // 只保留純中文本文，傳給家屬前再把關一次。
        const beforeStrip = reportZh;
        reportZh = reportZh.replace(/[（(]([^（）()]*)[）)]/g, (m, inner) => {
          const hasHan = /[一-鿿]/.test(inner);
          if (hasHan) return m;
          const hasDigit = /\d/.test(inner);
          if (hasDigit) return m; // 含數字，視為數值/讀數（如血壓 120/80 mmHg、劑量等），保留
          const hasLetters = /[A-Za-zÀ-ɏ]/.test(inner);
          if (!hasLetters) return m;
          const looksLikePhrase = /[ \/]/.test(inner.trim());
          return looksLikePhrase ? '' : m;
        }).replace(/[ \t]+([，。、\n])/g, '$1').replace(/ {2,}/g, ' ').trim();
        if (reportZh !== beforeStrip) {
          console.log(`  ⚠️ 中文版偵測到括號夾帶外語附註（例如「中文（外語）」），已自動剝除`);
        }
      }

      // 儲存日誌（中文版與顯示版都留存，方便之後查閱/除錯）
      const db = loadDB();
      if (!db.journals) db.journals = [];
      db.journals.push({
        _ts: new Date().toISOString(),
        rawText: text,
        report: reportZh,
        reportTranslated: report !== reportZh ? report : undefined,
        lang: lang || 'zh-TW',
        profileName: profile?.name || '長輩'
      });
      saveDB(db);

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, report, reportZh }));
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
    const { report, contacts, profileName, isAutoAlert } = body;
    if (!report || !contacts?.length) { res.writeHead(400); res.end(JSON.stringify({ ok: false })); return; }
    const msg = isAutoAlert
      ? `🚨【銀安APP 自動警示】\n\n照護對象：${profileName||'長輩'}\n時間：${now()}\n\n${report}`
      : `📋【銀安APP 照護日誌】\n\n照護對象：${profileName||'長輩'}\n時間：${now()}\n\n${report}`;
    let sent = 0;
    for (const c of contacts) {
      if (c.userId) { await sendLINE(c.userId, msg); sent++; }
    }
    console.log(`  📲 傳送${isAutoAlert?'警示':'日誌'}給 ${sent} 位聯絡人`);
    res.writeHead(200); res.end(JSON.stringify({ ok: true, sent })); return;
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
