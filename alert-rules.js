(function (root) {
  'use strict';

  const SECONDS = {
    emaCross: 4 * 60 * 60,
    emaCross4h: 4 * 60 * 60,
    emaCross1d: 24 * 60 * 60,
    emaCross1w: 7 * 24 * 60 * 60,
    flat1d: 24 * 60 * 60,
    flat3d: 3 * 24 * 60 * 60,
    fractal6h: 6 * 60 * 60,
    fractal1d: 24 * 60 * 60,
    fractal1w: 7 * 24 * 60 * 60,
  };

  function confirmed(bars) {
    return (bars || []).filter((bar) => String(bar.confirm) === '1').sort((a, b) => a.time - b.time);
  }

  function evaluationBars(bars) {
    const data = confirmed(bars);
    const current = (bars || []).filter((bar) => String(bar.confirm) === '0').sort((a, b) => a.time - b.time).at(-1);
    return current && (!data.length || current.time > data.at(-1).time) ? data.concat(current) : data;
  }

  function ema(values, period) {
    const out = Array(values.length).fill(null);
    if (values.length < period) return out;
    let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
    out[period - 1] = value;
    const alpha = 2 / (period + 1);
    for (let i = period; i < values.length; i++) out[i] = value = values[i] * alpha + value * (1 - alpha);
    return out;
  }

  // Matches the chart's SMA-labelled series, which currently uses Wilder smoothing.
  function smooth(values, period) {
    const out = Array(values.length).fill(null);
    if (values.length < period) return out;
    let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
    out[period - 1] = value;
    for (let i = period; i < values.length; i++) out[i] = value = (value * (period - 1) + values[i]) / period;
    return out;
  }

  function emaCrossEvents(bars, strategy = 'emaCross4h', includeCurrent = false) {
    if (strategy === 'emaCross') strategy = 'emaCross4h';
    const data = includeCurrent ? evaluationBars(bars) : confirmed(bars);
    const close = data.map((bar) => bar.close);
    const fast = ema(close, 5), slow = ema(close, 20), events = [];
    for (let i = 1; i < data.length; i++) {
      if (![fast[i - 1], slow[i - 1], fast[i], slow[i]].every(Number.isFinite)) continue;
      let direction = null;
      if (fast[i - 1] <= slow[i - 1] && fast[i] > slow[i]) direction = 'up';
      else if (fast[i - 1] >= slow[i - 1] && fast[i] < slow[i]) direction = 'down';
      if (direction) events.push({ strategy, direction, time: data[i].time, closeTime: data[i].time + SECONDS[strategy], close: data[i].close });
    }
    return events;
  }

  function flatMetricsAt(bars, index, options = {}) {
    const data = options.includeCurrent ? evaluationBars(bars) : confirmed(bars);
    const periods = [5, 8, 13];
    const slopeBars = 1;
    const defaults = options.timeframe === '3D'
      ? { slopePct: 0.3, spreadPct: 1, bodyDistancePct: 3 }
      : { slopePct: 0.4, spreadPct: 0.5, bodyDistancePct: 1.5 };
    const slopeLimit = Math.max(0, Number.isFinite(+options.slopePct) ? +options.slopePct : defaults.slopePct);
    const spreadLimit = Math.max(0, Number.isFinite(+options.spreadPct) ? +options.spreadPct : defaults.spreadPct);
    const bodyDistanceLimit = Math.max(0, Number.isFinite(+options.bodyDistancePct) ? +options.bodyDistancePct : defaults.bodyDistancePct);
    if (index < Math.max(...periods) - 1 + slopeBars || index >= data.length) return null;

    const close = data.map((bar) => bar.close);
    const lines = periods.map((period) => smooth(close, period));
    const values = lines.map((line) => line[index]);
    const before = lines.map((line) => line[index - slopeBars]);
    if (![...values, ...before].every((value) => Number.isFinite(value) && value > 0)) return null;

    // Compare the latest two evaluated MA values as a percentage of the prior value.
    const slopes = values.map((value, i) => Math.abs(value / before[i] - 1) * 100);
    // The closeness threshold is specifically the distance between SMA 5 and SMA 13,
    // expressed as a percentage of SMA 13. SMA 8 only participates in the angle test.
    const distancePct = Math.abs(values[0] - values[2]) / values[2] * 100;
    const candle = data[index];
    const bodyDistancePct = Math.abs(candle.close - values[0]) / values[0] * 100;
    return {
      slopes,
      spreadPct: distancePct,
      distancePct,
      bodyDistancePct,
      isFlat: slopes.every((slope) => slope <= slopeLimit) && distancePct <= spreadLimit && bodyDistancePct <= bodyDistanceLimit,
    };
  }

  function flatEvents(bars, options = {}) {
    const data = options.includeCurrent ? evaluationBars(bars) : confirmed(bars), events = [];
    let previousFlat = false;
    for (let i = 0; i < data.length; i++) {
      const metrics = flatMetricsAt(data, i, options);
      const isFlat = !!metrics?.isFlat;
      if (isFlat && !previousFlat) {
        const timeframe = options.timeframe === '3D' ? '3D' : '1D';
        events.push({
          strategy: timeframe === '3D' ? 'flat3d' : 'flat1d',
          direction: 'flat',
          time: data[i].time,
          closeTime: data[i].time + (timeframe === '3D' ? SECONDS.flat3d : SECONDS.flat1d),
          close: data[i].close,
          slopes: metrics.slopes,
          spreadPct: metrics.spreadPct,
          bodyDistancePct: metrics.bodyDistancePct,
        });
      }
      previousFlat = isFlat;
    }
    return events;
  }

  // Keep the alert definition aligned with the chart's 3-candle top/bottom fractals.
  function fractalEvents(bars, strategy, includeCurrent = false, lookback = 20) {
    const data = includeCurrent ? evaluationBars(bars) : confirmed(bars);
    const count = Math.max(1, Math.min(500, Math.round(Number(lookback) || 20)));
    const events = [];
    for (let i = Math.max(count, 1); i < data.length; i++) {
      const a = data[i - 2], middle = data[i - 1], c = data[i];
      if (!a || !middle || !c || (!includeCurrent && String(c.confirm) !== '1')) continue;
      const past = data.slice(i - 1 - count, i - 1);
      if (past.length < count) continue;
      const high = Math.max(...past.map((bar) => bar.high));
      const low = Math.min(...past.map((bar) => bar.low));
      const top = middle.high > high && middle.high > a.high && middle.high > c.high &&
        c.close < middle.open && c.close < middle.close && c.close < c.open;
      const bottom = middle.low < low && middle.low < a.low && middle.low < c.low &&
        c.close > middle.open && c.close > middle.close && c.close > c.open;
      for (const [isMatch, direction, pivotPrice] of [[top, 'top', middle.high], [bottom, 'bottom', middle.low]]) {
        if (!isMatch) continue;
        events.push({
          strategy,
          direction,
          time: c.time,
          pivotTime: middle.time,
          closeTime: c.time + SECONDS[strategy],
          close: c.close,
          pivotPrice,
        });
      }
    }
    return events;
  }

  function events(strategy, bars, options = {}) {
    if (strategy === 'emaCross' || strategy === 'emaCross4h' || strategy === 'emaCross1d' || strategy === 'emaCross1w') {
      return emaCrossEvents(bars, strategy, !!options.includeCurrent);
    }
    if (strategy === 'flat1d') return flatEvents(bars, { ...options, timeframe: '1D' });
    if (strategy === 'flat3d') return flatEvents(bars, { ...options, timeframe: '3D' });
    if (strategy === 'fractal6h' || strategy === 'fractal1d' || strategy === 'fractal1w') {
      return fractalEvents(bars, strategy, !!options.includeCurrent, options.lookback);
    }
    return [];
  }

  function previewEvents(strategy, bars, options = {}) {
    return events(strategy, bars, { ...options, includeCurrent: true });
  }

  root.TideAlertRules = { SECONDS, confirmed, evaluationBars, ema, smooth, emaCrossEvents, flatMetricsAt, flatEvents, fractalEvents, events, previewEvents };
})(globalThis);
