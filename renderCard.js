// ============================================================
// يرسم بطاقة صفقة (PNG) بنفس تصميم التطبيق — يستخدم @napi-rs/canvas
// (حزمة بها ملفات ثنائية جاهزة، تعمل بدون أي أدوات بناء على CI)
// ============================================================
"use strict";
const { createCanvas } = require('@napi-rs/canvas');
const { priceDecimals } = require('./analysis');

function roundRect(ctx, x, y, w, h, r) {
  if (w <= 0) w = 0.01;
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function renderSignalCard(h) {
  const W = 900, H = 500;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const bg1 = '#0B0E14', bg2 = '#171C27', gold = '#C9A24B';
  const up = '#3FBF7F', down = '#E2555C', muted = '#7C8494', text = '#EAECEF';
  const isBuy = h.direction === 'BUY';
  const dirColor = isBuy ? up : down;

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, bg2); grad.addColorStop(1, bg1);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = gold;
  ctx.font = '700 15px Arial';
  ctx.textAlign = 'left';
  ctx.fillText('BIQUOTE SIGNAL ENGINE — AUTO BACKGROUND SCAN', 40, 50);
  ctx.strokeStyle = 'rgba(201,162,75,0.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(40, 65); ctx.lineTo(W - 40, 65); ctx.stroke();

  ctx.fillStyle = text;
  ctx.font = '700 34px Arial';
  ctx.fillText(h.pair, 40, 120);
  ctx.fillStyle = muted;
  ctx.font = '600 16px Arial';
  ctx.fillText(h.timeframe, 40, 148);

  ctx.fillStyle = isBuy ? 'rgba(63,191,127,0.15)' : 'rgba(226,85,92,0.15)';
  roundRect(ctx, W - 260, 85, 220, 56, 10); ctx.fill();
  ctx.fillStyle = dirColor;
  ctx.font = '900 26px Arial';
  ctx.textAlign = 'center';
  ctx.fillText((isBuy ? 'BUY' : 'SELL'), W - 150, 122);
  ctx.textAlign = 'left';

  ctx.fillStyle = muted; ctx.font = '600 14px Arial';
  ctx.fillText('CONFIDENCE', 40, 185);
  ctx.fillStyle = gold; ctx.font = '700 14px Arial'; ctx.textAlign = 'right';
  ctx.fillText(h.confidence + '%', W - 40, 185); ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; roundRect(ctx, 40, 195, W - 80, 10, 5); ctx.fill();
  ctx.fillStyle = gold; roundRect(ctx, 40, 195, (W - 80) * Math.min(h.confidence, 100) / 100, 10, 5); ctx.fill();

  const dec = priceDecimals(h.entry);
  const cells = [
    ['ENTRY', h.entry.toFixed(dec), text],
    ['STOP LOSS', h.sl.toFixed(dec), down],
    ['TP1', h.tp.toFixed(dec), up],
    ['TP2', h.tp2 != null ? h.tp2.toFixed(dec) : '—', up],
  ];
  const cellW = (W - 80) / 4, cellY = 240, cellH = 110;
  cells.forEach((c, i) => {
    const x = 40 + i * cellW;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    roundRect(ctx, x + 6, cellY, cellW - 12, cellH, 10); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    roundRect(ctx, x + 6, cellY, cellW - 12, cellH, 10); ctx.stroke();
    ctx.fillStyle = muted; ctx.font = '700 12px Arial'; ctx.textAlign = 'center';
    ctx.fillText(c[0], x + cellW / 2, cellY + 34);
    ctx.fillStyle = c[2]; ctx.font = '700 22px monospace';
    ctx.fillText(c[1], x + cellW / 2, cellY + 72);
    ctx.textAlign = 'left';
  });

  const risk = Math.abs(h.entry - h.sl), reward = Math.abs(h.tp - h.entry);
  const rr = risk ? (reward / risk) : 0;
  ctx.fillStyle = gold; ctx.font = '700 16px Arial'; ctx.textAlign = 'center';
  ctx.fillText(`R:R = 1 : ${rr.toFixed(2)}`, W / 2, 400);
  ctx.textAlign = 'left';

  const d = new Date(h.date);
  const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} UTC`;
  ctx.strokeStyle = 'rgba(201,162,75,0.25)'; ctx.beginPath(); ctx.moveTo(40, 430); ctx.lineTo(W - 40, 430); ctx.stroke();
  ctx.fillStyle = muted; ctx.font = '600 13px Arial';
  ctx.fillText('New trade auto-detected (background scan)', 40, 465);
  ctx.textAlign = 'right';
  ctx.fillText(dateStr, W - 40, 465);
  ctx.textAlign = 'left';

  return canvas.toBuffer('image/png');
}

module.exports = { renderSignalCard };
