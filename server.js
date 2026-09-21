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
    const systemPrompt = isAutoAlert
      ? `你是長照照護異常分析助理。根據偵測到的異常事件，生成簡短的家屬通知摘要（繁體中文，不超過150字）。先說明異常狀況，再給出建議行動。語氣溫和但明確。`
      : `你是一位專業的長照照護記錄助理。請將照顧者提供的口語記錄整理成結構化的照護日誌報表，使用繁體中文。格式要求：1.簡潔清楚方便家屬閱讀 2.自動分類：身體狀況、情緒狀態、飲食記錄、活動記錄、異常事項、待追蹤事項 3.沒提到的項目直接略過 4.若為交接班記錄加上【交接重點】段落 5.結尾加上照顧者建議（如有需要）6.輸出純文字用emoji輔助分類`;

    const userContent = `照護對象：${profile?.name || '長輩'}
記錄日期：${date || now()}
照顧者口述記錄：
${text}`;

    try {
      // 報表一律先用繁體中文生成——這份「中文版」會拿去傳給家屬/接班人的 LINE 通知
      // （家屬多半只看得懂中文，所以送出去的訊息不能跟著 APP 介面語言變動）。
      const reportZh = await callAI(systemPrompt, userContent);
      console.log(`  ✅ AI 生成完成（中文，${reportZh.length} 字）`);

      // 若照顧者目前的 APP 介面不是繁體中文，另外把中文版翻譯成該語言，
      // 這份「翻譯版」只用來在 APP 裡顯示給照顧者自己看，不會拿去發送。
      let report = reportZh;
      const targetLangName = lang && lang !== 'zh-TW' ? LANG_NAMES[lang] : null;
      if (targetLangName) {
        try {
          report = await callAI(
            `你是專業的翻譯員。請將使用者提供的繁體中文長照照護日誌報表，完整翻譯成${targetLangName}。保留原本的段落結構、條列與 emoji 標示，不要增加、省略或評論內容，只輸出翻譯後的文字，不要附上任何說明。`,
            reportZh
          );
          console.log(`  ✅ 翻譯完成（${lang}，${report.length} 字）`);
        } catch(e) {
          console.log(`  ⚠️ 翻譯失敗，改用中文版顯示: ${e.message}`);
          report = reportZh;
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
