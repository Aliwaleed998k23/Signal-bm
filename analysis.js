// ============================================================
// محرك التحليل — منسوخ حرفياً من نفس منطق analyzer.html
// (Indicators + Analysis) بدون أي اعتماد على المتصفح/DOM.
// ============================================================
"use strict";

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function priceDecimals(v) { return v < 10 ? 5 : (v < 1000 ? 4 : 2); }

const Indicators = {
  sma(closes, period) {
    const out = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      let s = 0; for (let j = i - period + 1; j <= i; j++) s += closes[j];
      out[i] = s / period;
    }
    return out;
  },
  ema(closes, period) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < period) return out;
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < closes.length; i++) {
      if (i < period - 1) continue;
      if (i === period - 1) {
        let s = 0; for (let j = 0; j < period; j++) s += closes[j];
        prev = s / period; out[i] = prev; continue;
      }
      prev = closes[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  },
  ma(closes, period, type) { return type === 'sma' ? this.sma(closes, period) : this.ema(closes, period); },

  rsi(closes, period) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return out;
    for (let i = period; i < closes.length; i++) {
      let gains = 0, losses = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const diff = closes[j] - closes[j - 1];
        if (diff >= 0) gains += diff; else losses += -diff;
      }
      const avgGain = gains / period, avgLoss = losses / period;
      out[i] = avgLoss === 0 ? 100 : (100 - 100 / (1 + (avgGain / avgLoss)));
    }
    return out;
  },

  macd(closes, fast, slow, signal) {
    const emaFast = this.ema(closes, fast);
    const emaSlow = this.ema(closes, slow);
    const macdLine = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
    const validIdx = [], validVals = [];
    macdLine.forEach((v, i) => { if (v != null) { validIdx.push(i); validVals.push(v); } });
    const sigCompact = this.ema(validVals, signal);
    const signalLine = new Array(closes.length).fill(null);
    sigCompact.forEach((v, idx) => { if (v != null) signalLine[validIdx[idx]] = v; });
    const histogram = closes.map((_, i) => (macdLine[i] != null && signalLine[i] != null) ? macdLine[i] - signalLine[i] : null);
    return { macdLine, signalLine, histogram };
  },

  momentum(closes, period) {
    return closes.map((c, i) => i >= period ? c - closes[i - period] : null);
  },

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
  },

  supplyDemandZones(bars, atrArr) {
    const zones = { supply: [], demand: [] };
    for (let i = 2; i < bars.length; i++) {
      const impulse = bars[i];
      const body = Math.abs(impulse.close - impulse.open);
      const a = atrArr[i] || atrArr[i - 1];
      if (!a) continue;
      if (body > a * 1.4) {
        const base = bars[i - 1];
        const zoneHigh = Math.max(base.open, base.close, base.high);
        const zoneLow = Math.min(base.open, base.close, base.low);
        if (impulse.close < impulse.open) {
          zones.supply.push({ high: zoneHigh, low: zoneLow, idx: i });
        } else {
          zones.demand.push({ high: zoneHigh, low: zoneLow, idx: i });
        }
      }
    }
    return zones;
  }
};

const Analysis = {
  computeAll(bars, cfg) {
    const closes = bars.map(b => b.close);
    const n = closes.length;
    const maFast = Indicators.ma(closes, cfg.maFast, cfg.maType);
    const maSlow = Indicators.ma(closes, cfg.maSlow, cfg.maType);
    const rsi = Indicators.rsi(closes, cfg.rsiPeriod);
    const macd = Indicators.macd(closes, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
    const momentum = Indicators.momentum(closes, cfg.momPeriod);
    const atr = Indicators.atr(bars, cfg.atrPeriod);
    const pivots = Indicators.pivots(bars, 3);
    const price = closes[n - 1];
    const resClusters = Indicators.clusterLevels(pivots.highs.filter(h => h.price > price).map(h => ({ price: h.price })))
      .sort((a, b) => a.avg - b.avg);
    const supClusters = Indicators.clusterLevels(pivots.lows.filter(l => l.price < price).map(l => ({ price: l.price })))
      .sort((a, b) => b.avg - a.avg);
    const sd = Indicators.supplyDemandZones(bars, atr);
    const supplyNear = sd.supply.filter(z => z.low > price).sort((a, b) => a.low - b.low).slice(0, 2);
    const demandNear = sd.demand.filter(z => z.high < price).sort((a, b) => b.high - a.high).slice(0, 2);

    return {
      bars, closes, n, maFast, maSlow, rsi, macd, momentum, atr, price,
      resistances: resClusters.slice(0, 2), supports: supClusters.slice(0, 2),
      supplyZones: supplyNear, demandZones: demandNear
    };
  },

  timeframeTrend(bars, cfg) {
    if (!bars || bars.length < cfg.maSlow + 2) return null;
    const closes = bars.map(b => b.close);
    const f = Indicators.ma(closes, cfg.maFast, cfg.maType);
    const s = Indicators.ma(closes, cfg.maSlow, cfg.maType);
    const n = closes.length - 1;
    if (f[n] == null || s[n] == null) return null;
    if (f[n] > s[n]) return 'bull';
    if (f[n] < s[n]) return 'bear';
    return 'flat';
  },

  signalScore(a, mtfTrends, opts) {
    opts = opts || {};
    const n = a.n - 1;
    const reasons = [];
    const W = { ema: 20, macd: 20, rsi: 15, momentum: 15, sr: 15, mtf: 15 };

    let emaDir = 0;
    const fastNow = a.maFast[n], slowNow = a.maSlow[n];
    if (fastNow != null && slowNow != null) {
      if (fastNow > slowNow && a.price > fastNow) { emaDir = 1; reasons.push({ d: 1, t: 'المتوسط السريع فوق البطيء والسعر فوقهما — اتجاه صاعد' }); }
      else if (fastNow < slowNow && a.price < fastNow) { emaDir = -1; reasons.push({ d: -1, t: 'المتوسط السريع تحت البطيء والسعر تحتهما — اتجاه هابط' }); }
      else reasons.push({ d: 0, t: 'المتوسطات المتحركة متعارضة — لا اتجاه واضح' });
    } else reasons.push({ d: 0, t: 'بيانات غير كافية لحساب المتوسطات' });

    let macdDir = 0;
    const hLast = a.macd.histogram[n], hPrev = a.macd.histogram[n - 1];
    if (hLast != null) {
      if (hLast > 0) { macdDir = 1; reasons.push({ d: 1, t: hPrev != null && hLast > hPrev ? 'MACD إيجابي ومتزايد — زخم صاعد' : 'MACD إيجابي — زخم صاعد' }); }
      else if (hLast < 0) { macdDir = -1; reasons.push({ d: -1, t: hPrev != null && hLast < hPrev ? 'MACD سلبي ومتناقص — زخم هابط' : 'MACD سلبي — زخم هابط' }); }
      else reasons.push({ d: 0, t: 'MACD عند خط الصفر — لا زخم واضح' });
    } else reasons.push({ d: 0, t: 'بيانات غير كافية لحساب MACD' });

    let rsiDir = 0;
    const rsiNow = a.rsi[n];
    if (rsiNow != null) {
      if (rsiNow > 55) { rsiDir = 1; reasons.push({ d: 1, t: `RSI ${rsiNow.toFixed(1)} يدعم الاتجاه الصاعد` }); }
      else if (rsiNow < 45) { rsiDir = -1; reasons.push({ d: -1, t: `RSI ${rsiNow.toFixed(1)} يدعم الاتجاه الهابط` }); }
      else reasons.push({ d: 0, t: `RSI ${rsiNow.toFixed(1)} محايد` });
    } else reasons.push({ d: 0, t: 'بيانات غير كافية لحساب RSI' });

    let momDir = 0;
    const momNow = a.momentum[n];
    if (momNow != null) {
      if (momNow > 0) { momDir = 1; reasons.push({ d: 1, t: 'الزخم (Momentum) إيجابي' }); }
      else if (momNow < 0) { momDir = -1; reasons.push({ d: -1, t: 'الزخم (Momentum) سلبي' }); }
      else reasons.push({ d: 0, t: 'الزخم متعادل' });
    } else reasons.push({ d: 0, t: 'بيانات غير كافية لحساب الزخم' });

    const phase1 = emaDir * W.ema + macdDir * W.macd + rsiDir * W.rsi + momDir * W.momentum;
    const provisionalDir = phase1 === 0 ? 0 : (phase1 > 0 ? 1 : -1);

    let srSigned = 0;
    const atrNow = a.atr[n];
    if (provisionalDir === 1) {
      const nearestRes = a.resistances[0];
      if (nearestRes && atrNow && (nearestRes.avg - a.price) < atrNow * 0.5) {
        reasons.push({ d: 0, t: `السعر قريب جداً من مقاومة عند ${nearestRes.avg.toFixed(priceDecimals(a.price))} — الإشارة مقيّدة` });
      } else {
        srSigned = W.sr; reasons.push({ d: 1, t: 'مساحة كافية قبل أقرب مقاومة' });
      }
    } else if (provisionalDir === -1) {
      const nearestSup = a.supports[0];
      if (nearestSup && atrNow && (a.price - nearestSup.avg) < atrNow * 0.5) {
        reasons.push({ d: 0, t: `السعر قريب جداً من دعم عند ${nearestSup.avg.toFixed(priceDecimals(a.price))} — الإشارة مقيّدة` });
      } else {
        srSigned = -W.sr; reasons.push({ d: -1, t: 'مساحة كافية قبل أقرب دعم' });
      }
    }

    let mtfSigned = 0;
    const tfVals = Object.values(mtfTrends || {}).filter(v => v);
    const total = tfVals.length;
    const bullCount = tfVals.filter(v => v === 'bull').length;
    const bearCount = tfVals.filter(v => v === 'bear').length;
    if (total > 0 && provisionalDir !== 0) {
      const agree = provisionalDir === 1 ? bullCount : bearCount;
      const ratio = agree / total;
      mtfSigned = provisionalDir * Math.round(W.mtf * ratio);
      reasons.push({ d: provisionalDir, t: `توافق ${agree} من ${total} فريمات مع الاتجاه ${provisionalDir === 1 ? 'الصاعد' : 'الهابط'}` });
    }

    const total100 = clamp(phase1 + srSigned + mtfSigned, -100, 100);
    const direction = total100 === 0 ? 0 : (total100 > 0 ? 1 : -1);
    const confidence = Math.round(Math.abs(total100));

    let band;
    if (confidence < 40) band = 'NO_TRADE';
    else if (confidence < 60) band = 'WEAK';
    else if (confidence < 75) band = 'MODERATE';
    else if (confidence < 90) band = 'STRONG';
    else band = 'VERY_STRONG';

    return {
      direction, confidence, band, reasons: reasons.map(r => r.t),
      components: { emaDir, macdDir, rsiDir, momDir, srSigned, mtfSigned },
      mtf: { bullCount, bearCount, total }
    };
  },

  tradePlan(a, signal, opts) {
    opts = opts || {};
    const n = a.n - 1;
    const atrNow = a.atr[n];
    const minRR = opts.minRR !== undefined ? opts.minRR : 1.5;
    const slMult = opts.slMult || 1.5;
    const tpMults = opts.tpMults || [1.5, 2.5, 4];

    if (signal.direction === 0 || signal.confidence < 40 || !atrNow) {
      return { valid: false, reason: signal.direction === 0 ? 'لا يوجد اتجاه واضح' : 'الثقة منخفضة جداً' };
    }

    const entry = a.price;
    let sl, rr;
    if (signal.direction === 1) {
      const supportBelow = a.supports[0];
      const atrSl = entry - atrNow * slMult;
      sl = (supportBelow && supportBelow.avg < entry && (entry - supportBelow.avg) < atrNow * 2.5)
        ? Math.min(atrSl, supportBelow.avg - atrNow * 0.15) : atrSl;
      const risk = entry - sl;
      if (risk <= 0) return { valid: false, reason: 'تعذر حساب وقف خسارة منطقي' };
      let tp1 = entry + risk * tpMults[0];
      const resAbove = a.resistances[0];
      if (resAbove && resAbove.avg < tp1 && resAbove.avg > entry) tp1 = resAbove.avg - atrNow * 0.1;
      const tp2 = entry + risk * tpMults[1];
      const tp3 = entry + risk * tpMults[2];
      rr = (tp1 - entry) / risk;
      if (rr < minRR) return { valid: false, reason: `R:R ضعيف (${rr.toFixed(2)})` };
      return { valid: true, direction: 1, entry, sl, tp1, tp2, tp3, rr, risk };
    } else {
      const resAbove = a.resistances[0];
      const atrSl = entry + atrNow * slMult;
      sl = (resAbove && resAbove.avg > entry && (resAbove.avg - entry) < atrNow * 2.5)
        ? Math.max(atrSl, resAbove.avg + atrNow * 0.15) : atrSl;
      const risk = sl - entry;
      if (risk <= 0) return { valid: false, reason: 'تعذر حساب وقف خسارة منطقي' };
      let tp1 = entry - risk * tpMults[0];
      const supBelow = a.supports[0];
      if (supBelow && supBelow.avg > tp1 && supBelow.avg < entry) tp1 = supBelow.avg + atrNow * 0.1;
      const tp2 = entry - risk * tpMults[1];
      const tp3 = entry - risk * tpMults[2];
      rr = (entry - tp1) / risk;
      if (rr < minRR) return { valid: false, reason: `R:R ضعيف (${rr.toFixed(2)})` };
      return { valid: true, direction: -1, entry, sl, tp1, tp2, tp3, rr, risk };
    }
  }
};

module.exports = { Indicators, Analysis, priceDecimals, clamp };
