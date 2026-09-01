#!/usr/bin/env node
'use strict';

/* ============================================================
   signal-bot.js — GitHub Actions ICT signal scanner
   ------------------------------------------------------------
   Node.js port of the ICT engine (Order Blocks / FVG / Liquidity /
   BOS-CHoCH / Premium-Discount+OTE) and the "ICT Auto-Sweep" system
   from analyzer.html, adapted to run headless on a 5-minute cron.

   Ported 1:1 from analyzer.html:
     - Indicators.atr / Indicators.pivots / Indicators.clusterLevels
     - the `ICT` object (structure/orderBlocks/fvgList/liquidityZones/
       premiumDiscount/analyze) — same math, same thresholds
     - QUICK_PAIRS / MTF_LIST / MTF_LABELS / createSignalFingerprint
     - the ictAutoScanPair() / runICTAutoSweep() dedup + scan flow
     - the "🧊 ICT SETUP" Telegram caption from sendTelegramICTSignal()

   Deliberate deviation from analyzer.html (documented, not hidden):
     sendTelegramICTSignal() in the browser also renders a chart-card
     PNG via <canvas> (renderSignalCardCanvas) and sends it as a photo.
     A plain Node/Actions runner has no DOM/canvas, so this script
     sends the exact same caption text via Telegram's sendMessage
     instead of sendPhoto. All text fields, wording and order are
     unchanged.

   Data source: unchanged — same biquote.io OHLC endpoint the app
   already uses (BiquoteAPI.ohlc), single-page request per pair/tf
   (only ~60 bars are needed, well under biquote's 1000-bar cap, so
   no paging is required here — ictAutoScanPair() in the browser
   doesn't page either).

   State / dedup: analyzer.html keeps ictHistory in localStorage.
   There's no localStorage in Actions, so this uses a JSON file
   (ict-state.json) committed back to the repo by the existing
   workflow step — same dedup rule: (pair, timeframe, direction,
   candleTime) must differ from the last recorded signal for that
   pair+timeframe, or it's skipped as a repeat.
============================================================ */

const fs = require('fs');
const path = require('path');

/* ============================================================
   0. CONFIG — mirrors analyzer.html defaults
============================================================ */
const QUICK_PAIRS = [
  ['XAU', 'USD'], ['EUR', 'USD'], ['GBP', 'USD'], ['USD', 'JPY'],
  ['USD', 'TRY'], ['EUR', 'GBP'], ['XAG', 'USD'], ['BTC', 'USD']
];
const ICT_AUTO_PAIRS = QUICK_PAIRS.map(([f, t]) => `${f}/${t}`);
const MTF_LIST = ['1m', '5m', '15m', '1h'];
const MTF_LABELS = { '1m': '1M', '5m': '5M', '15m': '15M', '1h': '1H' };

// Matches getCfg()'s defaults in analyzer.html when no UI overrides are set.
const CFG = { atrPeriod: 14, maSlow: 21 };

// "Professional ICT trader" behavior gates — see the message accompanying
// this change for what each one does and why. All are tunable here if the
// signal rate turns out too strict or too loose in practice.
const STRATEGY = {
  requireLiquiditySweep: true,   // stop-hunt beyond a prior swing before the break
  requireDisplacement: true,     // the breakout candle must be a real impulse, not a grind
  requireRejectionCandle: true,  // the current candle must show a wick-rejection inside the zone
  useKillZones: true,            // only fire during London/NY session windows (UTC)
  displacementAtrMult: 0.8,      // breakout candle body >= ATR * this
  rejectionWickMult: 1.2,        // rejection wick >= body * this
  sweepLookback: 20              // bars scanned backward for a swept swing point
};

// London Killzone 07:00-10:00 UTC, New York Killzone 12:00-15:00 UTC.
// XAU/BTC trade outside these hours too, but this applies the same
// session-based filter uniformly across all 8 pairs per the current
// strategy choice — loosen/remove if it turns out too restrictive for
// the metals/crypto pairs specifically.
function inKillZone(date) {
  date = date || new Date();
  const h = date.getUTCHours();
  return (h >= 7 && h < 10) || (h >= 12 && h < 15);
}

const STATE_FILE = path.join(__dirname, 'ict-state.json');
const MAX_ICT_HISTORY = 500;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ============================================================
   1. API LAYER — same provider/endpoint as analyzer.html's BiquoteAPI
============================================================ */
const BiquoteAPI = {
  base: 'https://biquote.io/api',

  async request(pathname, params, retries) {
    retries = (retries === undefined) ? 2 : retries;
    const qs = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const url = this.base + pathname + (qs ? ('?' + qs) : '');
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url);
        let data = {};
        try { data = await res.json(); } catch (e) { data = {}; }
        if (!res.ok) {
          if (res.status === 429) {
            const retryAfter = Number(res.headers.get('Retry-After')) || 3;
            if (attempt < retries) { await sleep(retryAfter * 1000); continue; }
            throw new Error('rate limited (429)');
          }
          if (res.status === 404) throw new Error(data.message || 'symbol/timeframe not supported');
          if (attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
          throw new Error(data.message || `server error (${res.status})`);
        }
        return data;
      } catch (err) {
        lastErr = err;
        if (attempt >= retries) throw lastErr;
        await sleep(400 * (attempt + 1));
      }
    }
    throw lastErr || new Error('fetch failed');
  },

  ohlc(symbol, interval, limit, to) {
    return this.request(`/${symbol}/ohlc`, { interval, limit, to });
  }
};

/* ============================================================
   2. INDICATOR LIBRARY — ported verbatim from analyzer.html
   (only the pieces ICT.analyze needs: atr, pivots, clusterLevels)
============================================================ */
const Indicators = {
  atr(bars, period) {
    const tr = bars.map((b, i) => {
      if (i === 0) return b.high - b.low;
      const pc = bars[i - 1].close;
      return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    });
    const out = new Array(bars.length).fill(null);
    let prev = null;
    for (let i = 0; i < tr.length; i++) {
      if (i < period - 1) continue;
      if (i === period - 1) {
        let s = 0; for (let j = 0; j <= i; j++) s += tr[j];
        prev = s / period; out[i] = prev; continue;
      }
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
    return out;
  },

  pivots(bars, wing) {
    wing = wing || 3;
    const highs = [], lows = [];
    for (let i = wing; i < bars.length - wing; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - wing; j <= i + wing; j++) {
        if (j === i) continue;
        if (bars[j].high >= bars[i].high) isHigh = false;
        if (bars[j].low <= bars[i].low) isLow = false;
      }
      if (isHigh) highs.push({ idx: i, price: bars[i].high });
      if (isLow) lows.push({ idx: i, price: bars[i].low });
    }
    return { highs, lows };
  },

  clusterLevels(points, tolerancePct) {
    tolerancePct = tolerancePct === undefined ? 0.08 : tolerancePct;
    const sorted = points.slice().sort((a, b) => a.price - b.price);
    const clusters = [];
    sorted.forEach(p => {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(p.price - last.avg) / last.avg * 100 <= tolerancePct) {
        last.prices.push(p.price);
        last.avg = last.prices.reduce((a, b) => a + b, 0) / last.prices.length;
        last.count++;
      } else {
        clusters.push({ avg: p.price, prices: [p.price], count: 1 });
      }
    });
    return clusters;
  }
};

/* ============================================================
   3. ICT ENGINE — ported verbatim from analyzer.html's `ICT` object
============================================================ */
const ICT = {
  structure(bars, piv) {
    const closeNow = bars[bars.length - 1].close;
    const highs = piv.highs, lows = piv.lows;
    if (highs.length < 2 || lows.length < 2) return { trend: 0, event: null, lastHigh: null, lastLow: null };
    const lastHigh = highs[highs.length - 1], prevHigh = highs[highs.length - 2];
    const lastLow = lows[lows.length - 1], prevLow = lows[lows.length - 2];
    let bias = 0;
    const higherHigh = lastHigh.price > prevHigh.price, higherLow = lastLow.price > prevLow.price;
    if (higherHigh && higherLow) bias = 1;
    else if (!higherHigh && !higherLow) bias = -1;
    let event = null;
    if (closeNow > lastHigh.price) event = { type: bias >= 0 ? 'BOS' : 'CHOCH', dir: 1 };
    else if (closeNow < lastLow.price) event = { type: bias <= 0 ? 'BOS' : 'CHOCH', dir: -1 };
    const trend = event ? event.dir : bias;
    return { trend, event, lastHigh, lastLow, prevHigh, prevLow };
  },

  orderBlocks(bars, struct) {
    let bullishOB = null, bearishOB = null;
    if (struct.lastLow) {
      let bestIdx = -1, bestMove = 0;
      for (let i = struct.lastLow.idx + 1; i < bars.length; i++) {
        const move = bars[i].close - bars[i].open;
        if (move > bestMove) { bestMove = move; bestIdx = i; }
      }
      for (let i = bestIdx - 1; i >= struct.lastLow.idx; i--) {
        if (bars[i].close < bars[i].open) { bullishOB = { idx: i, high: bars[i].high, low: bars[i].low }; break; }
      }
      if (bullishOB) bullishOB.mitigated = bars.slice(bullishOB.idx + 1).some(b => b.low <= bullishOB.high);
    }
    if (struct.lastHigh) {
      let bestIdx = -1, bestMove = 0;
      for (let i = struct.lastHigh.idx + 1; i < bars.length; i++) {
        const move = bars[i].open - bars[i].close;
        if (move > bestMove) { bestMove = move; bestIdx = i; }
      }
      for (let i = bestIdx - 1; i >= struct.lastHigh.idx; i--) {
        if (bars[i].close > bars[i].open) { bearishOB = { idx: i, high: bars[i].high, low: bars[i].low }; break; }
      }
      if (bearishOB) bearishOB.mitigated = bars.slice(bearishOB.idx + 1).some(b => b.high >= bearishOB.low);
    }
    return { bullishOB, bearishOB };
  },

  fvgList(bars, lookback) {
    lookback = lookback || 80;
    const start = Math.max(2, bars.length - lookback);
    const out = [];
    for (let i = start; i < bars.length; i++) {
      const c1 = bars[i - 2], c3 = bars[i];
      if (c1.high < c3.low) out.push({ type: 'BULLISH', top: c3.low, bottom: c1.high, idx: i - 1 });
      else if (c1.low > c3.high) out.push({ type: 'BEARISH', top: c1.low, bottom: c3.high, idx: i - 1 });
    }
    out.forEach(g => { g.mitigated = bars.slice(g.idx + 2).some(b => b.low <= g.top && b.high >= g.bottom); });
    return out.filter(g => !g.mitigated).slice(-5);
  },

  liquidityZones(piv) {
    const buySide = Indicators.clusterLevels(piv.highs, 0.1).filter(c => c.count >= 2);
    const sellSide = Indicators.clusterLevels(piv.lows, 0.1).filter(c => c.count >= 2);
    return { buySide, sellSide };
  },

  // Was there a genuine stop-hunt before this structural break? Bullish
  // setups (direction=1) need sell-side liquidity swept — a bar wicking
  // below a prior swing low and a later close reclaiming above it.
  // Bearish setups mirror this off swing highs.
  liquiditySwept(bars, piv, direction, lookback) {
    lookback = lookback || 20;
    const start = Math.max(0, bars.length - lookback);
    if (direction === 1) {
      for (let i = start; i < bars.length; i++) {
        const priorLows = piv.lows.filter(l => l.idx < i);
        if (!priorLows.length) continue;
        const refLow = priorLows[priorLows.length - 1].price;
        if (bars[i].low < refLow) {
          for (let j = i; j < bars.length; j++) {
            if (bars[j].close > refLow) return true;
          }
        }
      }
      return false;
    }
    for (let i = start; i < bars.length; i++) {
      const priorHighs = piv.highs.filter(h => h.idx < i);
      if (!priorHighs.length) continue;
      const refHigh = priorHighs[priorHighs.length - 1].price;
      if (bars[i].high > refHigh) {
        for (let j = i; j < bars.length; j++) {
          if (bars[j].close < refHigh) return true;
        }
      }
    }
    return false;
  },

  // Was the breakout candle a real impulsive move (institutional intent),
  // not a weak grind-through? Body must clear a meaningful fraction of ATR.
  hasDisplacement(bars, atrNow, mult) {
    if (!atrNow) return false;
    const b = bars[bars.length - 1];
    const body = Math.abs(b.close - b.open);
    return body >= atrNow * (mult == null ? 0.8 : mult);
  },

  // Did the current candle actually reject the zone (long wick against the
  // setup direction, close back toward continuation) rather than just
  // closing inside the zone numerically with no real rejection?
  hasRejectionCandle(bars, direction, mult) {
    mult = mult == null ? 1.2 : mult;
    const b = bars[bars.length - 1];
    const body = Math.abs(b.close - b.open);
    const lowerWick = Math.min(b.open, b.close) - b.low;
    const upperWick = b.high - Math.max(b.open, b.close);
    if (direction === 1) return lowerWick >= body * mult && b.close > (b.high + b.low) / 2;
    return upperWick >= body * mult && b.close < (b.high + b.low) / 2;
  },

  premiumDiscount(bars, struct) {
    if (!struct.lastHigh || !struct.lastLow) return null;
    const legDir = struct.lastHigh.idx > struct.lastLow.idx ? 1 : -1;
    const low = Math.min(struct.lastLow.price, struct.lastHigh.price);
    const high = Math.max(struct.lastLow.price, struct.lastHigh.price);
    const range = high - low;
    if (range <= 0) return null;
    const equilibrium = low + range * 0.5;
    const price = bars[bars.length - 1].close;
    const zone = price < equilibrium ? 'DISCOUNT' : (price > equilibrium ? 'PREMIUM' : 'EQUILIBRIUM');
    // Strong OTE (62%-79% retracement) — the classic ICT sweet spot.
    const oteZone = legDir === 1 ? [low + range * 0.21, low + range * 0.382] : [low + range * 0.618, low + range * 0.79];
    const inOTE = price >= oteZone[0] && price <= oteZone[1];
    // Weaker early-entry zone (50%-62% retracement) — equilibrium out to the
    // start of OTE. Valid confluence, just a shallower/less-confirmed pullback.
    const earlyZone = legDir === 1 ? [low + range * 0.382, low + range * 0.5] : [low + range * 0.5, low + range * 0.618];
    const inEarlyZone = price >= earlyZone[0] && price <= earlyZone[1];
    return { low, high, equilibrium, zone, oteZone, inOTE, earlyZone, inEarlyZone, legDir };
  },

  analyze(bars, cfg) {
    if (!bars || bars.length < 30) return null;
    const piv = Indicators.pivots(bars, 3);
    const struct = this.structure(bars, piv);
    const ob = this.orderBlocks(bars, struct);
    const fvgs = this.fvgList(bars, 80);
    const liq = this.liquidityZones(piv);
    const pd = this.premiumDiscount(bars, struct);
    const price = bars[bars.length - 1].close;
    const atrArr = Indicators.atr(bars, cfg.atrPeriod || 14);
    const atrNow = atrArr[atrArr.length - 1];

    let direction = 0, score = 0; const reasons = [];
    if (struct.trend === 1 && pd && pd.zone === 'DISCOUNT') {
      const sweepOk = !STRATEGY.requireLiquiditySweep || this.liquiditySwept(bars, piv, 1, STRATEGY.sweepLookback);
      const dispOk = !STRATEGY.requireDisplacement || this.hasDisplacement(bars, atrNow, STRATEGY.displacementAtrMult);
      const rejOk = !STRATEGY.requireRejectionCandle || this.hasRejectionCandle(bars, 1, STRATEGY.rejectionWickMult);
      if (sweepOk && dispOk && rejOk) {
        direction = 1; score += 30; reasons.push('هيكل صاعد (Bias/BOS صاعد)');
        if (STRATEGY.requireLiquiditySweep) reasons.push('سحب سيولة (Liquidity Sweep) قبل الكسر');
        if (STRATEGY.requireDisplacement) reasons.push('شمعة اندفاع (Displacement) تؤكد الكسر');
        if (STRATEGY.requireRejectionCandle) reasons.push('شمعة رفض/تأكيد صاعدة عند المنطقة');
        if (pd.inOTE) { score += 25; reasons.push('السعر داخل منطقة OTE القوية (61.8%-79%)'); }
        else if (pd.inEarlyZone) { score += 12; reasons.push('السعر داخل منطقة دخول أولى أضعف (50%-61.8%)'); }
        if (fvgs.find(g => g.type === 'BULLISH' && price >= g.bottom && price <= g.top)) { score += 25; reasons.push('السعر داخل Fair Value Gap صاعد غير ممتلئ'); }
        if (ob.bullishOB && !ob.bullishOB.mitigated && price <= ob.bullishOB.high) { score += 20; reasons.push('قرب Order Block صاعد غير مُختبر'); }
      }
    } else if (struct.trend === -1 && pd && pd.zone === 'PREMIUM') {
      const sweepOk = !STRATEGY.requireLiquiditySweep || this.liquiditySwept(bars, piv, -1, STRATEGY.sweepLookback);
      const dispOk = !STRATEGY.requireDisplacement || this.hasDisplacement(bars, atrNow, STRATEGY.displacementAtrMult);
      const rejOk = !STRATEGY.requireRejectionCandle || this.hasRejectionCandle(bars, -1, STRATEGY.rejectionWickMult);
      if (sweepOk && dispOk && rejOk) {
        direction = -1; score += 30; reasons.push('هيكل هابط (Bias/BOS هابط)');
        if (STRATEGY.requireLiquiditySweep) reasons.push('سحب سيولة (Liquidity Sweep) قبل الكسر');
        if (STRATEGY.requireDisplacement) reasons.push('شمعة اندفاع (Displacement) تؤكد الكسر');
        if (STRATEGY.requireRejectionCandle) reasons.push('شمعة رفض/تأكيد هابطة عند المنطقة');
        if (pd.inOTE) { score += 25; reasons.push('السعر داخل منطقة OTE القوية (61.8%-79%)'); }
        else if (pd.inEarlyZone) { score += 12; reasons.push('السعر داخل منطقة دخول أولى أضعف (50%-61.8%)'); }
        if (fvgs.find(g => g.type === 'BEARISH' && price <= g.top && price >= g.bottom)) { score += 25; reasons.push('السعر داخل Fair Value Gap هابط غير ممتلئ'); }
        if (ob.bearishOB && !ob.bearishOB.mitigated && price >= ob.bearishOB.low) { score += 20; reasons.push('قرب Order Block هابط غير مُختبر'); }
      }
    }

    let plan = null;
    if (direction !== 0 && atrNow) {
      const entry = price;
      const sl = direction === 1
        ? (ob.bullishOB ? ob.bullishOB.low - atrNow * 0.2 : entry - atrNow * 1.5)
        : (ob.bearishOB ? ob.bearishOB.high + atrNow * 0.2 : entry + atrNow * 1.5);
      const risk = Math.abs(entry - sl);
      if (risk > 0) {
        // Draw on Liquidity: prefer a pool OUTSIDE the current dealing range
        // (beyond the last swing high/low) — that's the real external target
        // a professional reads price as being "drawn to". Fall back to the
        // nearest internal cluster, then to a measured-move 2R.
        let tp, rr;
        if (direction === 1) {
          const external = liq.buySide.filter(z => z.avg > entry && (!struct.lastHigh || z.avg >= struct.lastHigh.price)).sort((a, b) => a.avg - b.avg)[0];
          const internal = liq.buySide.filter(z => z.avg > entry).sort((a, b) => a.avg - b.avg)[0];
          const targetLiq = external || internal;
          tp = targetLiq ? targetLiq.avg : entry + risk * 2;
          rr = Math.abs(tp - entry) / risk;
          if (rr < 1.2) { tp = entry + risk * 2; rr = 2; }
          else if (targetLiq) reasons.push(external ? 'الهدف عند مجمع سيولة خارجي (Draw on Liquidity)' : 'الهدف عند أقرب مجمع سيولة داخلي');
        } else {
          const external = liq.sellSide.filter(z => z.avg < entry && (!struct.lastLow || z.avg <= struct.lastLow.price)).sort((a, b) => b.avg - a.avg)[0];
          const internal = liq.sellSide.filter(z => z.avg < entry).sort((a, b) => b.avg - a.avg)[0];
          const targetLiq = external || internal;
          tp = targetLiq ? targetLiq.avg : entry - risk * 2;
          rr = Math.abs(tp - entry) / risk;
          if (rr < 1.2) { tp = entry - risk * 2; rr = 2; }
          else if (targetLiq) reasons.push(external ? 'الهدف عند مجمع سيولة خارجي (Draw on Liquidity)' : 'الهدف عند أقرب مجمع سيولة داخلي');
        }
        plan = { entry, sl, tp, rr, direction };
      }
    }
    return { direction, score: Math.round(score), reasons, struct, ob, fvgs, liq, pd, plan };
  }
};

/* ============================================================
   4. STATE / DEDUP — file-based equivalent of ictHistory/localStorage
============================================================ */
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}
function saveState(history) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(history.slice(0, MAX_ICT_HISTORY), null, 2));
}
function createSignalFingerprint(pair, timeframeKey, direction, candleTime, entryTypeCode) {
  return `${pair}|${timeframeKey}|${direction}|${candleTime || 'NA'}|${entryTypeCode || 'NONE'}`;
}

/* ============================================================
   5. TELEGRAM — same "🧊 ICT SETUP" caption as sendTelegramICTSignal()
   in analyzer.html. Sent via sendMessage instead of sendPhoto — see
   note at the top of this file for why.
============================================================ */
function priceDecimals(v) { return v < 10 ? 5 : (v < 1000 ? 4 : 2); }

async function sendTelegramICTSignal(h) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn(`Missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID — skipping send for ${h.pair} ${h.timeframe}`);
    return false;
  }
  const dec = priceDecimals(h.entry);
  const emoji = h.direction === 'BUY' ? '🟢' : '🔴';
  const reasonsStr = (h.reasons && h.reasons.length) ? h.reasons.map(r => `• ${r}`).join('\n') : '—';
  const caption = `🧊 ICT SETUP\n\n`
    + `${h.pair} (${h.timeframe})\n${emoji} ${h.direction}\n\n`
    + `Score: ${h.score}/100\nR:R: 1:${h.rr != null ? h.rr.toFixed(2) : '—'}\n\n`
    + `Entry:\n${h.entry.toFixed(dec)}\n\nSL:\n${h.sl.toFixed(dec)}\n\nTP:\n${h.tp.toFixed(dec)}\n\n${reasonsStr}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: caption })
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) {
      console.error('Telegram send failed:', data.description || data);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Telegram send error:', e.message);
    return false;
  }
}

/* ============================================================
   6. SCAN — mirrors ictAutoScanPair()/runICTAutoSweep() in analyzer.html
============================================================ */
async function scanPair(pairStr, history) {
  const [base, quote] = pairStr.split('/');
  const symbol = base + quote;
  const newSignals = [];

  if (STRATEGY.useKillZones && !inKillZone()) return newSignals; // outside London/NY killzone — skip this pair entirely this run

  await Promise.all(MTF_LIST.map(async (tf) => {
    let bars;
    try {
      const data = await BiquoteAPI.ohlc(symbol, tf, Math.max(CFG.maSlow + 10, 60));
      // biquote returns newest-first; ICT.analyze expects oldest->newest.
      bars = data && data.bars ? data.bars.slice().reverse() : null;
    } catch (e) {
      console.warn(`fetch failed ${pairStr} ${tf}: ${e.message}`);
      return;
    }
    if (!bars || bars.length < 30) return;

    let res;
    try { res = ICT.analyze(bars, CFG); } catch (e) { res = null; }
    if (!res || res.direction === 0 || !res.plan || res.score < 50 || res.plan.rr < 1.2) return;

    const candleTime = bars[bars.length - 1].openTime;
    const timeframeLabel = MTF_LABELS[tf] || tf;
    const fingerprint = createSignalFingerprint(pairStr, tf, res.direction, candleTime, 'ICT');
    const last = history.find(h => h.pair === pairStr && h.timeframe === timeframeLabel);
    if (last && last.fingerprint === fingerprint) return; // same candle/setup already sent

    const entry = {
      fingerprint,
      date: new Date().toISOString(),
      pair: pairStr,
      timeframe: timeframeLabel,
      timeframeKey: tf,
      candleTime,
      direction: res.direction === 1 ? 'BUY' : 'SELL',
      score: res.score,
      reasons: res.reasons.slice(),
      entry: res.plan.entry,
      sl: res.plan.sl,
      tp: res.plan.tp,
      rr: res.plan.rr,
      source: 'ICT',
      createdAt: Date.now()
    };
    history.unshift(entry);
    newSignals.push(entry);
  }));

  return newSignals;
}

async function main() {
  const history = loadState();

  const results = await Promise.all(ICT_AUTO_PAIRS.map(async (pair) => {
    try {
      return await scanPair(pair, history);
    } catch (e) {
      console.warn(`scan failed for ${pair}: ${e.message}`);
      return [];
    }
  }));
  const allNew = results.flat();

  if (allNew.length) {
    console.log(`${allNew.length} new ICT signal(s) found.`);
    for (const sig of allNew) {
      const ok = await sendTelegramICTSignal(sig);
      console.log(`${ok ? 'sent' : 'FAILED'}: ${sig.pair} ${sig.timeframe} ${sig.direction} score=${sig.score} rr=${sig.rr.toFixed(2)}`);
    }
  } else {
    console.log('No new ICT signals this run.');
  }

  saveState(history);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
