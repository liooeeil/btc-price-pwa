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

  function fractalEvents(bars, strategy, includeCurrent = false, lookback = 20) {
    const data = includeCurrent ? evaluationBars(bars) : confirmed(bars);
    const count = Math.max(1, Math.min(500, Math.round(Number(lookback) || 20)));
    const events = [];
    for (let i = Math.max(count + 1, 2); i < data.length; i++) {
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
        events.push({ strategy, direction, time: c.time, pivotTime: middle.time, closeTime: c.time + SECONDS[strategy], close: c.close, pivotPrice });
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
    if (strategy === 'fractal6h' || strategy === 'fractal1d' || strategy === 'fractal1w') return fractalEvents(bars, strategy, !!options.includeCurrent, options.lookback);
    return [];
  }

  function previewEvents(strategy, bars, options = {}) {
    return events(strategy, bars, { ...options, includeCurrent: true });
  }

  root.TideAlertRules = { SECONDS, confirmed, evaluationBars, ema, smooth, emaCrossEvents, flatMetricsAt, flatEvents, fractalEvents, events, previewEvents };
})(globalThis);


const RULES = globalThis.TideAlertRules;
const APP_ORIGIN = 'https://liooeeil.github.io';
const STRATEGIES = ['emaCross4h', 'emaCross1d', 'emaCross1w', 'flat1d', 'flat3d', 'fractal6h', 'fractal1d', 'fractal1w'];
const BARS = {
  emaCross4h: '4H',
  emaCross1d: '1Dutc',
  emaCross1w: '1Wutc',
  flat1d: '1Dutc',
  flat3d: '3Dutc',
  fractal6h: '6H',
  fractal1d: '1Dutc',
  fractal1w: '1Wutc',
};
const TITLES = {
  emaCross4h: '4小时 EMA 5/20 交叉',
  emaCross1d: '日线 EMA 5/20 交叉',
  emaCross1w: '周线 EMA 5/20 交叉',
  flat1d: '日线 SMA 走平',
  flat3d: '3日线 SMA 走平',
  fractal6h: '6 小时分型',
  fractal1d: '日线分型',
  fractal1w: '周线分型',
};
const MAX_SYMBOLS = 8;

function json(data, status = 200, origin = '') {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  });
  if (origin === APP_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
    headers.set('Access-Control-Max-Age', '86400');
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function isAllowedSymbol(value) {
  return typeof value === 'string' && /^[A-Z0-9]+(?:-[A-Z0-9]+)*-USDT-SWAP$/.test(value);
}

function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置格式无效');
  if (Number(input.schemaVersion) !== 3 || !input.configs || typeof input.configs !== 'object' || Array.isArray(input.configs)) {
    throw new Error('请刷新 BTC 页面后再同步合约独立的提醒设置');
  }
  const configs = {};
  for (const [symbol, raw] of Object.entries(input.configs)) {
    if (!isAllowedSymbol(symbol) || !raw || typeof raw !== 'object') continue;
    const enabled = {};
    for (const name of STRATEGIES) enabled[name] = raw.enabled?.[name] === true;
    if (!Object.values(enabled).some(Boolean)) continue;
    const thresholds = {};
    for (const name of ['flat1d', 'flat3d']) {
      thresholds[name] = {};
      for (const field of ['slopePct', 'spreadPct', 'bodyDistancePct']) {
        const value = Number(raw[field]?.[name]);
        thresholds[name][field] = Number.isFinite(value) ? Math.max(0, Math.min(20, value)) : null;
      }
    }
    const fractalLookbacks = {};
    for (const name of ['fractal6h', 'fractal1d', 'fractal1w']) {
      const value = Number(raw.fractalLookbacks?.[name]);
      fractalLookbacks[name] = Number.isFinite(value) ? Math.max(1, Math.min(500, Math.round(value))) : 20;
    }
    configs[symbol] = { enabled, thresholds, fractalLookbacks };
  }
  if (Object.keys(configs).length > MAX_SYMBOLS) throw new Error('服务器提醒最多支持 8 个已设置提醒的合约');
  return { schemaVersion: 3, configs };
}

function optionsFor(config, strategy) {
  const defaults = strategy === 'flat3d'
    ? { slopePct: 0.3, spreadPct: 1, bodyDistancePct: 3 }
    : { slopePct: 0.4, spreadPct: 0.5, bodyDistancePct: 1.5 };
  const values = config.thresholds?.[strategy] || {};
  return {
    timeframe: strategy === 'flat3d' ? '3D' : '1D',
    slopePct: values.slopePct ?? defaults.slopePct,
    spreadPct: values.spreadPct ?? defaults.spreadPct,
    bodyDistancePct: values.bodyDistancePct ?? defaults.bodyDistancePct,
    lookback: config.fractalLookbacks?.[strategy] ?? 20,
  };
}

async function telegram(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Worker 未设置 TELEGRAM_BOT_TOKEN');
  const response = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) throw new Error(body.description || ('Telegram HTTP ' + response.status));
  return body.result;
}

async function sendTelegram(env, chatId, text) {
  await telegram(env, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendBark(env, title, text) {
  if (!env.BARK_KEY) throw new Error('Worker 未设置 BARK_KEY');
  const response = await fetch('https://api.day.app/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_key: env.BARK_KEY,
      title,
      body: text,
      group: 'Tide BTC',
      sound: 'alarm',
      level: 'timeSensitive',
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 200) {
    throw new Error(body.message || ('Bark HTTP ' + response.status));
  }
}

async function authorized(request, env) {
  const supplied = request.headers.get('X-Admin-Key') || '';
  return !!env.ADMIN_KEY && supplied === env.ADMIN_KEY;
}

async function fetchBars(symbol, timeframe) {
  const requestStartedAt = new Date();
  const query = new URLSearchParams({ instId: symbol, bar: timeframe, limit: '300' });
  let responseStatus = null;
  let resultCode = null;
  try {
    const response = await fetch('https://www.okx.com/api/v5/market/candles?' + query);
    responseStatus = response.status;
    const result = await response.json();
    resultCode = result.code ?? null;
    const responseReceivedAt = new Date();
    const api = {
      requestStartedAt: requestStartedAt.toISOString(),
      responseReceivedAt: responseReceivedAt.toISOString(),
      elapsedMs: responseReceivedAt.getTime() - requestStartedAt.getTime(),
      httpStatus: response.status,
      okxCode: resultCode,
      rowCount: Array.isArray(result.data) ? result.data.length : 0,
    };
    if (!response.ok || result.code !== '0' || !Array.isArray(result.data) || !result.data.length) {
      const error = new Error(result.msg || ('OKX HTTP ' + response.status));
      error.apiDiagnostic = { ...api, symbol, timeframe, okxMessage: result.msg || null };
      throw error;
    }
    const bars = result.data.map((row) => ({
      time: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      confirm: String(row[8]),
    })).reverse();
    return { bars, api };
  } catch (error) {
    if (!error.apiDiagnostic) {
      const failedAt = new Date();
      error.apiDiagnostic = {
        symbol,
        timeframe,
        requestStartedAt: requestStartedAt.toISOString(),
        failedAt: failedAt.toISOString(),
        elapsedMs: failedAt.getTime() - requestStartedAt.getTime(),
        httpStatus: responseStatus,
        okxCode: resultCode,
        error: error.message || String(error),
      };
    }
    throw error;
  }
}

function candleSummary(bar, duration) {
  if (!bar) return null;
  return {
    openTime: bar.time,
    openTimeUtc: new Date(bar.time * 1000).toISOString(),
    closeTimeUtc: new Date((bar.time + duration) * 1000).toISOString(),
    close: bar.close,
    confirm: String(bar.confirm),
  };
}

function nearbyCandleBoundary(bars, duration, now, windowSeconds = 5 * 60) {
  return bars.slice(-3)
    .map((bar) => bar.time + duration)
    .filter((closeTime) => Math.abs(now - closeTime) <= windowSeconds)
    .sort((a, b) => Math.abs(now - a) - Math.abs(now - b))[0] || null;
}

function eventSummaries(events, boundary, duration) {
  return events
    .filter((event) => event.closeTime >= boundary - duration && event.closeTime <= boundary + duration)
    .map((event) => ({
      direction: event.direction,
      openTimeUtc: new Date(event.time * 1000).toISOString(),
      closeTimeUtc: new Date(event.closeTime * 1000).toISOString(),
      close: event.close,
    }));
}

function confirmElapsedCandles(bars, duration, now) {
  // OKX can briefly leave a just-ended candle unconfirmed; do not wait another full bar.
  return bars.map((bar) => String(bar.confirm) === '0' && bar.time + duration <= now
    ? { ...bar, confirm: '1' }
    : bar);
}

function alertText(symbol, strategy, event) {
  const direction = event.direction === 'up' ? '向上交叉' : event.direction === 'down' ? '向下交叉' : event.direction === 'top' ? '顶分型' : event.direction === 'bottom' ? '底分型' : '';
  const label = event.realtime ? '触发时参考价' : event.preclose ? '预收盘参考价' : '收盘价';
  const timing = event.realtime ? '（4H 实时）' : event.preclose ? '（收盘前约 1 分钟）' : '';
  return symbol.replace('-USDT-SWAP', '') + ' · ' + TITLES[strategy] + ' ' + direction + timing +
    '\n' + label + '：' + Number(event.close).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

async function connectTelegram(env) {
  const chatId = await env.ALERT_KV.get('telegram:chat-id');
  if (chatId) {
    await sendTelegram(env, chatId, '潮汐 BTC 提醒已连接。');
    return { chatId, alreadyBound: true };
  }
  const updates = await telegram(env, 'getUpdates', { limit: 100, allowed_updates: ['message'] });
  const candidates = updates.filter((item) =>
    item.message?.chat?.type === 'private' &&
    /^\/start(?:@\w+)?(?:\s|$)/i.test(item.message?.text || ''),
  );
  const latest = candidates.at(-1);
  if (!latest) throw new Error('还没有收到 /start。请先在 Telegram 打开机器人并发送 /start，再点一次绑定。');
  const id = String(latest.message.chat.id);
  await env.ALERT_KV.put('telegram:chat-id', id);
  await env.ALERT_KV.put('telegram:update-offset', String(Math.max(...updates.map((item) => item.update_id)) + 1));
  await sendTelegram(env, id, '潮汐 BTC 提醒已连接。服务器提醒已准备就绪。');
  return { chatId: id, alreadyBound: false };
}

async function handleRequest(request, env) {
  const origin = request.headers.get('Origin') || '';
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return json({ ok: true }, 200, origin);
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({ ok: true, telegramConfigured: !!env.TELEGRAM_BOT_TOKEN, barkConfigured: !!env.BARK_KEY }, 200, origin);
  }
  if (url.pathname !== '/api/config' && url.pathname !== '/api/telegram/connect' && url.pathname !== '/api/bark/test') {
    return json({ error: 'Not found' }, 404, origin);
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
  if (!(await authorized(request, env))) return json({ error: '管理密钥不正确' }, 401, origin);
  if (!env.ALERT_KV) return json({ error: 'Worker 尚未绑定 ALERT_KV' }, 500, origin);

  try {
    if (url.pathname === '/api/config') {
      const config = normalizeConfig(await request.json());
      await env.ALERT_KV.put('config', JSON.stringify(config));
      return json({ ok: true, symbols: Object.keys(config.configs).length }, 200, origin);
    }
    if (url.pathname === '/api/bark/test') {
      if (!env.BARK_KEY) return json({ error: 'Worker 尚未设置 BARK_KEY' }, 500, origin);
      await sendBark(env, '潮汐 BTC Bark 测试', 'Bark 推送已连接。');
      return json({ ok: true }, 200, origin);
    }
    if (!env.TELEGRAM_BOT_TOKEN) return json({ error: 'Worker 尚未设置 TELEGRAM_BOT_TOKEN' }, 500, origin);
    await connectTelegram(env);
    return json({ ok: true }, 200, origin);
  } catch (error) {
      const status = /配置格式|至少需要|最多支持|有效的|请刷新 BTC 页面/.test(error.message) ? 400 : 502;
    return json({ error: error.message || '请求失败' }, status, origin);
  }
}

async function evaluateAlerts(env, scheduleWindow) {
  if (!env.ALERT_KV) {
    console.warn({ type: 'scheduled_skip', run: scheduleWindow.runInfo, reason: 'missing_ALERT_KV' });
    return;
  }
  const config = await env.ALERT_KV.get('config', 'json');
  const chatId = env.TELEGRAM_BOT_TOKEN ? await env.ALERT_KV.get('telegram:chat-id') : null;
  if (!config || config.schemaVersion !== 3 || (!chatId && !env.BARK_KEY)) {
    console.warn({
      type: 'scheduled_skip',
      run: scheduleWindow.runInfo,
      reason: !config ? 'missing_config' : config.schemaVersion !== 3 ? 'unsupported_config_schema' : 'no_push_channel',
      schemaVersion: config?.schemaVersion ?? null,
      telegramConfigured: !!env.TELEGRAM_BOT_TOKEN,
      telegramChatBound: !!chatId,
      barkConfigured: !!env.BARK_KEY,
    });
    return;
  }
  const configured = Object.entries(config.configs || {}).map(([symbol, item]) => ({
    symbol,
    item,
    active: STRATEGIES.filter((name) => item.enabled?.[name] &&
      (!scheduleWindow.realtimeOnly || name === 'emaCross4h') &&
      (!scheduleWindow.sixHourOnly || name === 'fractal6h') &&
      (name !== 'fractal6h' || scheduleWindow.sixHourWindow)),
  })).filter(({ symbol, item, active }) => isAllowedSymbol(symbol) && item && active.length);
  if (!configured.length) {
    console.log({ type: 'scheduled_skip', run: scheduleWindow.runInfo, reason: 'no_active_strategies' });
    return;
  }

  const state = await env.ALERT_KV.get('state', 'json') || { checkpoints: {}, prealerts: {} };
  const originalState = JSON.stringify(state);
  const candleCache = new Map();
  const notices = [];
  const pendingCheckpoints = new Map();
  let cursor = 0;
  const jobs = [];
  for (const { symbol, item: symbolConfig, active } of configured) {
    for (const strategy of active) {
      const timeframe = BARS[strategy];
      const cacheKey = symbol + '|' + timeframe;
      if (!candleCache.has(cacheKey)) candleCache.set(cacheKey, null);
      jobs.push({ symbol, strategy, cacheKey, timeframe, config: symbolConfig });
    }
  }

  async function loadJob(job) {
    if (candleCache.get(job.cacheKey) === null) {
      candleCache.set(job.cacheKey, fetchBars(job.symbol, job.timeframe));
    }
    const pending = candleCache.get(job.cacheKey);
    const fetched = await pending;
    candleCache.set(job.cacheKey, fetched);
    const rawBars = fetched.bars;
    const now = Math.floor(Date.now() / 1000);
    const duration = RULES.SECONDS[job.strategy];
    const bars = confirmElapsedCandles(rawBars, duration, now);
    const closed = RULES.confirmed(bars);
    const latest = closed.at(-1);
    const key = job.symbol + '|' + job.strategy;
    const opts = optionsFor(job.config, job.strategy);
    const previousPrealert = Number(state.prealerts[key] || 0);
    const previous = Number(state.checkpoints[key] || 0);
    const current = RULES.evaluationBars(bars).at(-1);
    const boundary = job.strategy === 'emaCross4h'
      ? nearbyCandleBoundary(rawBars, duration, now)
      : null;
    const shouldLogBoundary = boundary !== null;
    let previewMatch = null;
    let eligible = [];
    let checkpointAction = 'unchanged';

    if (!latest) {
      if (shouldLogBoundary) {
        console.log({
          type: 'ema4h_boundary_diagnostic',
          run: scheduleWindow.runInfo,
          scheduleWindow: {
            realtimeOnly: !!scheduleWindow.realtimeOnly,
            sixHourOnly: !!scheduleWindow.sixHourOnly,
            sixHourWindow: !!scheduleWindow.sixHourWindow,
          },
          symbol: job.symbol,
          boundaryUtc: new Date(boundary * 1000).toISOString(),
          checkedAtUtc: new Date(now * 1000).toISOString(),
          api: fetched.api,
          rawCandles: rawBars.slice(-3).map((bar) => candleSummary(bar, duration)),
          effectiveCandles: bars.slice(-3).map((bar) => candleSummary(bar, duration)),
          latestConfirmed: null,
          stateBefore: {
            checkpoint: previous,
            checkpointUtc: previous ? new Date(previous * 1000).toISOString() : null,
            prealert: previousPrealert,
            prealertUtc: previousPrealert ? new Date(previousPrealert * 1000).toISOString() : null,
          },
          decision: 'no_confirmed_candle',
        });
      }
      return;
    }

    if (current && String(current.confirm) === '0') {
      const closeTime = current.time + duration;
      const remaining = closeTime - now;
      const realtimeEma = job.strategy === 'emaCross4h' && closeTime > now;
      const nearClose = remaining > 0 && remaining <= 60;
      if ((realtimeEma || nearClose) && previousPrealert < current.time) {
        previewMatch = RULES.previewEvents(job.strategy, bars, opts)
          .find((event) => event.time === current.time && event.closeTime === closeTime);
        if (previewMatch) {
          notices.push({
            text: alertText(job.symbol, job.strategy, { ...previewMatch, preclose: !realtimeEma, realtime: realtimeEma }),
            key,
            prealertTime: current.time,
          });
        }
      }
    }

    if (!previous || latest.time > previous) {
      eligible = RULES.events(job.strategy, bars, opts).filter((event) => {
        if (event.closeTime > now || Number(state.prealerts[key] || 0) === event.time) return false;
        if (previous) return event.time > previous;
        return (job.strategy.startsWith('emaCross') || job.strategy.startsWith('fractal')) &&
          event.time === latest.time &&
          event.closeTime >= now - duration;
      });
      for (const event of eligible) notices.push({ text: alertText(job.symbol, job.strategy, event), key, checkpointTime: latest.time });
      if (eligible.length) {
        pendingCheckpoints.set(key, latest.time);
        checkpointAction = 'pending_delivery';
      } else {
        state.checkpoints[key] = latest.time;
        checkpointAction = 'advanced_without_alert';
      }
    }

    if (shouldLogBoundary) {
      const rangeEvents = (events) => eventSummaries(events, boundary, duration);
      console.log({
        type: 'ema4h_boundary_diagnostic',
        run: scheduleWindow.runInfo,
        scheduleWindow: {
          realtimeOnly: !!scheduleWindow.realtimeOnly,
          sixHourOnly: !!scheduleWindow.sixHourOnly,
          sixHourWindow: !!scheduleWindow.sixHourWindow,
        },
        symbol: job.symbol,
        boundaryUtc: new Date(boundary * 1000).toISOString(),
        checkedAtUtc: new Date(now * 1000).toISOString(),
        api: fetched.api,
        rawCandles: rawBars.slice(-3).map((bar) => candleSummary(bar, duration)),
        effectiveCandles: bars.slice(-3).map((bar) => candleSummary(bar, duration)),
        latestConfirmed: candleSummary(latest, duration),
        currentEvaluated: candleSummary(current, duration),
        stateBefore: {
          checkpoint: previous,
          checkpointUtc: previous ? new Date(previous * 1000).toISOString() : null,
          prealert: previousPrealert,
          prealertUtc: previousPrealert ? new Date(previousPrealert * 1000).toISOString() : null,
        },
        stateDecision: checkpointAction,
        previewQueued: !!previewMatch,
        eligibleClosedCrosses: rangeEvents(eligible),
        signals: {
          rawConfirmed: rangeEvents(RULES.events(job.strategy, rawBars, opts)),
          rawIncludingCurrent: rangeEvents(RULES.previewEvents(job.strategy, rawBars, opts)),
          effectiveConfirmed: rangeEvents(RULES.events(job.strategy, bars, opts)),
        },
      });
    }
  }

  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        await loadJob(job);
      } catch (error) {
        console.warn({
          type: 'alert_job_failed',
          run: scheduleWindow.runInfo,
          symbol: job.symbol,
          strategy: job.strategy,
          timeframe: job.timeframe,
          error: error.message || String(error),
          api: error.apiDiagnostic || null,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, jobs.length) }, () => worker()));
  if (notices.length) {
    const message = notices.map((notice) => notice.text).join('\n\n');
    const deliveries = [];
    if (chatId) deliveries.push({ channel: 'telegram', promise: sendTelegram(env, chatId, '潮汐 BTC 行情提醒\n\n' + message) });
    if (env.BARK_KEY) deliveries.push({ channel: 'bark', promise: sendBark(env, '潮汐 BTC 行情提醒', message) });
    const results = await Promise.allSettled(deliveries.map((delivery) => delivery.promise));
    console.log({
      type: 'alert_push_result',
      run: scheduleWindow.runInfo,
      alerts: notices.map(({ key, prealertTime, checkpointTime }) => ({ key, prealertTime: prealertTime || null, checkpointTime: checkpointTime || null })),
      deliveries: results.map((result, index) => ({
        channel: deliveries[index].channel,
        status: result.status,
        error: result.status === 'rejected' ? (result.reason?.message || String(result.reason)) : null,
      })),
    });
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('Push failed:', result.reason?.message || result.reason);
      }
    }
    if (results.some((result) => result.status === 'fulfilled')) {
      for (const notice of notices) {
        if (notice.prealertTime) state.prealerts[notice.key] = notice.prealertTime;
      }
      for (const [key, time] of pendingCheckpoints) state.checkpoints[key] = time;
    }
  }
  const nextState = JSON.stringify(state);
  if (nextState !== originalState) {
    await env.ALERT_KV.put('state', nextState);
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(controller, env) {
    const runInfo = {
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
      actualStartedAt: new Date().toISOString(),
      cron: controller.cron || null,
    };
    console.log({ type: 'scheduled_start', ...runInfo });
    try {
      const scheduled = new Date(controller.scheduledTime);
      const hour = scheduled.getUTCHours();
      const minute = scheduled.getUTCMinutes();
      const regularCheck = (minute === 59 && [3, 5, 7, 11, 15, 17, 19, 23].includes(hour)) ||
        (minute === 2 && [0, 4, 6, 8, 12, 16, 18, 20].includes(hour));
      const sixHourOnly = (minute === 59 && [5, 17].includes(hour)) || (minute === 2 && [6, 18].includes(hour));
      const sixHourWindow = sixHourOnly || (minute === 59 && [11, 23].includes(hour)) || (minute === 2 && [0, 12].includes(hour));
      await evaluateAlerts(env, { sixHourOnly, sixHourWindow, realtimeOnly: !regularCheck, runInfo });
    } catch (error) {
      console.error({
        type: 'scheduled_failed',
        run: runInfo,
        error: error.message || String(error),
      });
    }
  },
};
