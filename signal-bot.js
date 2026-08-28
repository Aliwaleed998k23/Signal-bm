// ============================================================
// البوت الرئيسي — يُشغّل دورياً عبر GitHub Actions (بدون فتح أي متصفح).
// يفحص كل الأزواج × الفريمات في config.js، ويرسل صورة صفقة جديدة
// لتيليجرام فور رصدها، مع منع تكرار نفس الصفقة عبر state.json.
// ============================================================
"use strict";

const fs = require('fs');
const cfg = require('./config');
const { Analysis } = require('./analysis');
const { fetchBarsAscending } = require('./biquote');
const { renderSignalCard } = require('./renderCard');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(cfg.STATE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveState(state) {
  fs.writeFileSync(cfg.STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendTelegramPhoto(buffer, caption) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('⚠ TELEGRAM_BOT_TOKEN أو TELEGRAM_CHAT_ID غير مضبوطين — تم تخطي الإرسال.');
    return;
  }
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption', caption);
  form.append('photo', new Blob([buffer], { type: 'image/png' }), 'signal.png');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) {
    console.error('✗ فشل إرسال تيليجرام:', data.description || data);
  } else {
    console.log('✓ أُرسلت الصورة لتيليجرام');
  }
}

function buildCaption(h) {
  const dec = h.entry < 10 ? 5 : (h.entry < 1000 ? 4 : 2);
  const emoji = h.direction === 'BUY' ? '🟢' : '🔴';
  return `${emoji} صفقة جديدة: ${h.direction}\n`
    + `الزوج: ${h.pair} | الفريم: ${h.timeframe}\n`
    + `Entry: ${h.entry.toFixed(dec)}\nSL: ${h.sl.toFixed(dec)}\nTP1: ${h.tp.toFixed(dec)}\n`
    + `الثقة: ${h.confidence}%`;
}

async function scanPair(pair, state) {
  const symbol = `${pair.from}${pair.to}`;
  const pairLabel = `${pair.from}/${pair.to}`;

  // اجلب شموع كل الفريمات أولاً (لحساب توافق الفريمات المتعدد MTF)
  const mtfBars = {};
  for (const tf of cfg.TIMEFRAMES) {
    try {
      mtfBars[tf] = await fetchBarsAscending(symbol, tf, cfg.BARS_LIMIT);
    } catch (e) {
      console.error(`✗ تعذر جلب ${symbol}/${tf}:`, e.message);
      mtfBars[tf] = null;
    }
  }

  const mtfTrends = {};
  cfg.TIMEFRAMES.forEach(tf => {
    if (mtfBars[tf] && mtfBars[tf].length >= cfg.CFG.maSlow + 2) {
      mtfTrends[tf] = Analysis.timeframeTrend(mtfBars[tf], cfg.CFG);
    }
  });

  for (const tf of cfg.TIMEFRAMES) {
    const bars = mtfBars[tf];
    if (!bars || bars.length < cfg.CFG.maSlow + 5) continue;

    const a = Analysis.computeAll(bars, cfg.CFG);
    const sig = Analysis.signalScore(a, mtfTrends, {});
    if (sig.direction === 0) continue;
    const plan = Analysis.tradePlan(a, sig, { minRR: cfg.CFG.minRR });
    if (!plan.valid) continue;

    const direction = sig.direction === 1 ? 'BUY' : 'SELL';
    const key = `${pairLabel}|${cfg.TF_LABELS[tf]}|${direction}|${plan.entry.toFixed(6)}`;
    const stateKey = `${pairLabel}|${cfg.TF_LABELS[tf]}`;

    if (state[stateKey] === key) continue; // نفس الصفقة سبق إرسالها — تخطي

    const entry = {
      pair: pairLabel, timeframe: cfg.TF_LABELS[tf], direction,
      entry: plan.entry, sl: plan.sl, tp: plan.tp1, tp2: plan.tp2,
      confidence: sig.confidence, date: new Date().toISOString()
    };

    console.log(`➜ صفقة جديدة: ${pairLabel} ${cfg.TF_LABELS[tf]} ${direction} conf=${sig.confidence}%`);
    const buffer = renderSignalCard(entry);
    await sendTelegramPhoto(buffer, buildCaption(entry));

    state[stateKey] = key;
  }
}

async function main() {
  const state = loadState();
  for (const pair of cfg.PAIRS) {
    try {
      await scanPair(pair, state);
    } catch (e) {
      console.error(`✗ خطأ أثناء فحص ${pair.from}/${pair.to}:`, e.message);
    }
  }
  saveState(state);
  console.log('اكتمل الفحص.');
}

main().catch(err => { console.error('فشل تشغيل البوت:', err); process.exit(1); });
