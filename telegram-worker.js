(function (root) {
  'use strict';

  const SECONDS = {
    emaCross: 4 * 60 * 60,
    emaCross4h: 4 * 60 * 60,
    emaCross1d: 24 * 60 * 60,
    emaCross1w: 7 * 24 * 60 * 60,
    flat1d: 24 * 60 * 60,
    flat3d: 3 * 24 * 60 * 60,
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

  function events(strategy, bars, options = {}) {
    if (strategy === 'emaCross' || strategy === 'emaCross4h' || strategy === 'emaCross1d' || strategy === 'emaCross1w') {
      return emaCrossEvents(bars, strategy, !!options.includeCurrent);
    }
    if (strategy === 'flat1d') return flatEvents(bars, { ...options, timeframe: '1D' });
    if (strategy === 'flat3d') return flatEvents(bars, { ...options, timeframe: '3D' });
    return [];
  }

  function previewEvents(strategy, bars, options = {}) {
    return events(strategy, bars, { ...options, includeCurrent: true });
  }

  root.TideAlertRules = { SECONDS, confirmed, evaluationBars, ema, smooth, emaCrossEvents, flatMetricsAt, flatEvents, events, previewEvents };
})(globalThis);


const RULES = globalThis.TideAlertRules;
const APP_ORIGIN = 'https://liooeeil.github.io';
const STRATEGIES = ['emaCross4h', 'emaCross1d', 'emaCross1w', 'flat1d', 'flat3d'];
const BARS = {
  emaCross4h: '4H',
  emaCross1d: '1Dutc',
  emaCross1w: '1Wutc',
  flat1d: '1Dutc',
  flat3d: '3Dutc',
};
const TITLES = {
  emaCross4h: '4小时 EMA 5/20 交叉',
  emaCross1d: '日线 EMA 5/20 交叉',
  emaCross1w: '周线 EMA 5/20 交叉',
  flat1d: '日线 SMA 走平',
  flat3d: '3日线 SMA 走平',
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
  const symbols = [...new Set(Array.isArray(input.symbols) ? input.symbols.filter(isAllowedSymbol) : [])];
  if (!symbols.length) throw new Error('至少需要一个有效的 USDT 永续合约');
  if (symbols.length > MAX_SYMBOLS) throw new Error('服务器提醒最多支持 8 个品种，请从观察列表中减少后再同步');
  const enabled = {};
  for (const name of STRATEGIES) enabled[name] = input.enabled?.[name] === true;
  const thresholds = {};
  for (const name of ['flat1d', 'flat3d']) {
    thresholds[name] = {};
    for (const field of ['slopePct', 'spreadPct', 'bodyDistancePct']) {
      const value = Number(input[field]?.[name]);
      thresholds[name][field] = Number.isFinite(value) ? Math.max(0, Math.min(20, value)) : null;
    }
  }
  return { schemaVersion: 1, enabled, symbols, thresholds };
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

async function authorized(request, env) {
  const supplied = request.headers.get('X-Admin-Key') || '';
  return !!env.ADMIN_KEY && supplied === env.ADMIN_KEY;
}

async function fetchBars(symbol, timeframe) {
  const query = new URLSearchParams({ instId: symbol, bar: timeframe, limit: '300' });
  const response = await fetch('https://www.okx.com/api/v5/market/candles?' + query);
  const result = await response.json();
  if (!response.ok || result.code !== '0' || !Array.isArray(result.data) || !result.data.length) {
    throw new Error(result.msg || ('OKX HTTP ' + response.status));
  }
  return result.data.map((row) => ({
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    confirm: String(row[8]),
  })).reverse();
}

function alertText(symbol, strategy, event) {
  const direction = event.direction === 'up' ? '向上交叉' : event.direction === 'down' ? '向下交叉' : '';
  const label = event.preclose ? '预收盘参考价' : '收盘价';
  const timing = event.preclose ? '（收盘前约 3 分钟）' : '';
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
    return json({ ok: true, telegramConfigured: !!env.TELEGRAM_BOT_TOKEN }, 200, origin);
  }
  if (url.pathname !== '/api/config' && url.pathname !== '/api/telegram/connect') {
    return json({ error: 'Not found' }, 404, origin);
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
  if (!(await authorized(request, env))) return json({ error: '管理密钥不正确' }, 401, origin);
  if (!env.ALERT_KV) return json({ error: 'Worker 尚未绑定 ALERT_KV' }, 500, origin);

  try {
    if (url.pathname === '/api/config') {
      const config = normalizeConfig(await request.json());
      await env.ALERT_KV.put('config', JSON.stringify(config));
      return json({ ok: true, symbols: config.symbols.length }, 200, origin);
    }
    if (!env.TELEGRAM_BOT_TOKEN) return json({ error: 'Worker 尚未设置 TELEGRAM_BOT_TOKEN' }, 500, origin);
    await connectTelegram(env);
    return json({ ok: true }, 200, origin);
  } catch (error) {
    const status = /配置格式|至少需要|最多支持|有效的/.test(error.message) ? 400 : 502;
    return json({ error: error.message || '请求失败' }, status, origin);
  }
}

async function evaluateAlerts(env) {
  if (!env.ALERT_KV || !env.TELEGRAM_BOT_TOKEN) return;
  const config = await env.ALERT_KV.get('config', 'json');
  const chatId = await env.ALERT_KV.get('telegram:chat-id');
  if (!config || !chatId) return;
  const active = STRATEGIES.filter((name) => config.enabled?.[name]);
  if (!active.length) return;

  const state = await env.ALERT_KV.get('state', 'json') || { checkpoints: {}, prealerts: {} };
  const candleCache = new Map();
  const notices = [];
  let cursor = 0;
  const jobs = [];
  for (const symbol of config.symbols || []) {
    if (!isAllowedSymbol(symbol)) continue;
    for (const strategy of active) {
      const timeframe = BARS[strategy];
      const cacheKey = symbol + '|' + timeframe;
      if (!candleCache.has(cacheKey)) candleCache.set(cacheKey, null);
      jobs.push({ symbol, strategy, cacheKey, timeframe });
    }
  }

  async function loadJob(job) {
    if (candleCache.get(job.cacheKey) === null) {
      candleCache.set(job.cacheKey, fetchBars(job.symbol, job.timeframe));
    }
    const pending = candleCache.get(job.cacheKey);
    const bars = await pending;
    candleCache.set(job.cacheKey, bars);
    const closed = RULES.confirmed(bars);
    const latest = closed.at(-1);
    if (!latest) return;

    const key = job.symbol + '|' + job.strategy;
    const now = Math.floor(Date.now() / 1000);
    const opts = optionsFor(config, job.strategy);
    const previousPrealert = Number(state.prealerts[key] || 0);
    const current = RULES.evaluationBars(bars).at(-1);
    if (current && String(current.confirm) === '0') {
      const closeTime = current.time + RULES.SECONDS[job.strategy];
      const remaining = closeTime - now;
      if (remaining > 0 && remaining <= 3 * 60 && previousPrealert < current.time) {
        const preview = RULES.previewEvents(job.strategy, bars, opts)
          .find((event) => event.time === current.time && event.closeTime === closeTime);
        if (preview) {
          notices.push(alertText(job.symbol, job.strategy, { ...preview, preclose: true }));
          state.prealerts[key] = current.time;
        }
      }
    }

    const previous = Number(state.checkpoints[key] || 0);
    if (!previous || latest.time > previous) {
      const eligible = RULES.events(job.strategy, bars, opts).filter((event) => {
        if (event.closeTime > now || Number(state.prealerts[key] || 0) === event.time) return false;
        if (previous) return event.time > previous;
        return job.strategy.startsWith('emaCross') &&
          event.time === latest.time &&
          event.closeTime >= now - 6 * 60 * 60;
      });
      for (const event of eligible) notices.push(alertText(job.symbol, job.strategy, event));
      state.checkpoints[key] = latest.time;
    }
  }

  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        await loadJob(job);
      } catch (error) {
        console.warn('Alert check failed for ' + job.symbol + '/' + job.strategy + ': ' + error.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, jobs.length) }, () => worker()));
  if (notices.length) {
    await sendTelegram(env, chatId, '潮汐 BTC 行情提醒\n\n' + notices.join('\n\n'));
  }
  await env.ALERT_KV.put('state', JSON.stringify(state));
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(controller, env) {
    try {
      await evaluateAlerts(env);
    } catch (error) {
      console.error('Scheduled alert check failed:', error.message);
    }
  },
};
