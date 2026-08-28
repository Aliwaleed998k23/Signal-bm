// ============================================================
// عميل بيانات biquote.io — نفس منطق الطلبات بالتطبيق الأصلي
// ============================================================
"use strict";

const BASE = 'https://biquote.io/api';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ohlc(symbol, interval, limit) {
  const url = `${BASE}/${symbol}/ohlc?interval=${interval}&limit=${limit}`;
  let lastErr = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url);
      let data = {};
      try { data = await res.json(); } catch (e) { data = {}; }
      if (!res.ok) {
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('Retry-After')) || 3;
          if (attempt < 2) { await sleep(retryAfter * 1000); continue; }
        }
        throw new Error(data.message || `HTTP ${res.status} for ${symbol}/${interval}`);
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) { await sleep(500 * (attempt + 1)); continue; }
    }
  }
  throw lastErr || new Error(`فشل جلب بيانات ${symbol}/${interval}`);
}

// bars from biquote arrive newest-first; analysis needs oldest->newest
async function fetchBarsAscending(symbol, interval, limit) {
  const data = await ohlc(symbol, interval, limit);
  const bars = (data.bars || []).slice().reverse();
  return bars;
}

module.exports = { ohlc, fetchBarsAscending };
