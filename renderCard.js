// test-send.js
// سكربت اختبار فوري: يرسل صفقة وهمية لتيليجرام للتأكد من الاتصال بدون انتظار السوق

const { renderSignalCard } = require('./renderCard.js');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTestSignal() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars.');
    process.exit(1);
  }

  const fakeTrade = {
    pair: 'XAU/USD',
    timeframe: '15M',
    direction: 'BUY',
    entry: 2412.50,
    sl: 2408.00,
    tp: 2420.00,
    tp2: null,
    confidence: 87,
    date: new Date()
  };

  console.log('🎨 Generating test trade card...');
  const imageBuffer = renderSignalCard(fakeTrade);

  console.log('📤 Sending to Telegram...');
  const FormData = require('form-data');
  const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

  const form = new FormData();
  form.append('chat_id', TELEGRAM_CHAT_ID);
  form.append('caption',
    `🧪 اختبار اتصال\n\nالزوج: ${fakeTrade.pair}\nالفريم: ${fakeTrade.timeframe}\nالاتجاه: ${fakeTrade.direction}\nالدخول: ${fakeTrade.entry}\nوقف الخسارة: ${fakeTrade.sl}\nجني الأرباح: ${fakeTrade.tp}\nنسبة الثقة: ${fakeTrade.confidence}%\n\n✅ إذا وصلتك هذه الصورة، الاتصال يعمل بشكل صحيح.`
  );
  form.append('photo', imageBuffer, { filename: 'test-signal.png', contentType: 'image/png' });

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
  
