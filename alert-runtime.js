(function () {
  'use strict';

  const RULES = globalThis.TideAlertRules;
  const SETTINGS_KEY = 'tide:alerts:settings:v1';
  const SYMBOL_SETTINGS_KEY = 'tide:alerts:settings-by-symbol:v1';
  const CHECKPOINT_KEY = 'tide:alerts:checked:v1';
  const SETTINGS_VERSION = 3;
  const INITIAL_EMA_WINDOW_SECONDS = 6 * 60 * 60;
  const PREALERT_SECONDS = 60;
  const defaultSettings = {
    enabled: { emaCross4h: false, emaCross1d: false, emaCross1w: false, flat1d: false, flat3d: false, fractal6h: false, fractal1d: false, fractal1w: false },
    spreadPct: { flat1d: 0.5, flat3d: 1 },
    slopePct: { flat1d: 0.4, flat3d: 0.3 },
    bodyDistancePct: { flat1d: 1.5, flat3d: 3 },
    serverUrl: '',
    serverKey: '',
  };
  const rawSavedSettings = readStored(SETTINGS_KEY);
  const settingsBySymbol = readStored(SYMBOL_SETTINGS_KEY);
  const initialSymbol = document.querySelector('#symbol')?.value || 'BTC-USDT-SWAP';
  const migratedSettings = !Object.keys(settingsBySymbol).length && Object.keys(rawSavedSettings).length > 0;
  const sharedSettings = { serverUrl: rawSavedSettings.serverUrl || '', serverKey: rawSavedSettings.serverKey || '' };
  const initialSavedSettings = settingsBySymbol[initialSymbol] || (migratedSettings ? rawSavedSettings : {});
  const savedSettings = { ...defaultSettings, ...initialSavedSettings };
  let settings = makeSymbolSettings(initialSavedSettings);
  if (rawSavedSettings.enabled?.emaCross4h == null && rawSavedSettings.enabled?.emaCross != null && migratedSettings) {
    settings.enabled.emaCross4h = !!rawSavedSettings.enabled.emaCross;
  }
  if (migratedSettings) {
    const previousDefaults = {
      spreadPct: { flat1d: 1, flat3d: 1 },
      slopePct: { flat1d: 0.3, flat3d: 0.3 },
      bodyDistancePct: { flat1d: 1, flat3d: 1 },
    };
    for (const field of Object.keys(previousDefaults)) {
      for (const strategy of ['flat1d', 'flat3d']) {
        const stored = rawSavedSettings[field]?.[strategy];
        if (stored != null && Number(stored) === previousDefaults[field][strategy]) {
          settings[field][strategy] = defaultSettings[field][strategy];
        }
      }
    }
  }
  settings.serverUrl = sharedSettings.serverUrl;
  settings.serverKey = sharedSettings.serverKey;
  let currentSymbol = initialSymbol;
  let checkpoints = read(CHECKPOINT_KEY, {});
  let prechecked = read('tide:alerts:prechecked:v1', {});
  let checking = false;
  let markerPlugin = null;
  let hoverTime = null;
  let localTimer = null;

  function read(key, fallback) {
    try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; }
    catch { return JSON.parse(JSON.stringify(fallback)); }
  }
  function readStored(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  function readLog() {
    try {
      const items = JSON.parse(localStorage.getItem('tide:alerts:log:v1') || '[]');
      return Array.isArray(items) ? items : [];
    } catch { return []; }
  }
  function save() {
    settings.schemaVersion = SETTINGS_VERSION;
    settingsBySymbol[currentSymbol] = {
      enabled: { ...settings.enabled },
      spreadPct: { ...settings.spreadPct },
      slopePct: { ...settings.slopePct },
      bodyDistancePct: { ...settings.bodyDistancePct },
    };
    try {
      localStorage.setItem(SYMBOL_SETTINGS_KEY, JSON.stringify(settingsBySymbol));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ schemaVersion: SETTINGS_VERSION, ...sharedSettings }));
    } catch {}
  }
  function makeSymbolSettings(raw = {}) {
    return {
      ...defaultSettings,
      ...raw,
      enabled: { ...defaultSettings.enabled, ...(raw.enabled || {}) },
      spreadPct: { ...defaultSettings.spreadPct, ...(raw.spreadPct || {}) },
      slopePct: { ...defaultSettings.slopePct, ...(raw.slopePct || {}) },
      bodyDistancePct: { ...defaultSettings.bodyDistancePct, ...(raw.bodyDistancePct || {}) },
      serverUrl: sharedSettings?.serverUrl || '',
      serverKey: sharedSettings?.serverKey || '',
    };
  }
  function number(value, fallback) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }
  function symbols() {
    const symbol = document.querySelector('#symbol')?.value || currentSymbol;
    return symbol ? [symbol] : [];
  }
  function fractalLookback(strategy, symbol = currentSymbol) {
    const chartBar = ({ fractal6h: '6H', fractal1d: '1D', fractal1w: '1W' })[strategy];
    if (!chartBar) return 20;
    try {
      const saved = JSON.parse(localStorage.getItem(`tide:${symbol}:${chartBar}:settings`) || '{}');
      return Math.max(1, Math.min(500, Math.round(Number(saved.fractalLookback) || 20)));
    } catch { return 20; }
  }
  function strategyOptions(strategy, symbol = currentSymbol) {
    return {
      slopePct: number(settings.slopePct?.[strategy], strategy === 'flat1d' ? 0.4 : 0.3),
      spreadPct: number(settings.spreadPct?.[strategy], strategy === 'flat1d' ? 0.5 : 1),
      bodyDistancePct: number(settings.bodyDistancePct?.[strategy], strategy === 'flat1d' ? 1.5 : 3),
      lookback: fractalLookback(strategy, symbol),
    };
  }
  function makePanel() {
    const side = document.querySelector('.side');
    if (!side) return;
    const card = document.createElement('section');
    card.className = 'card side-card tide-alert-card';
    card.innerHTML = `
      <button class="alert-title alert-card-toggle" type="button" aria-expanded="true" aria-controls="alertCardContent"><span>价格提醒 <small>ALERTS</small></span><span class="alert-page-status" id="alertInstrumentStatus"></span><span class="alert-page-status" id="alertLocalStatus">页面提醒已就绪</span></button>
      <div class="alert-card-content" id="alertCardContent">
      <p class="alert-scope">当前合约单独保存提醒。加入自选不会自动开启；切换合约后可分别设置。</p>
      <div class="alert-strategy" data-strategy="emaCross4h">
        <div class="alert-strategy-head"><button class="alert-collapse" type="button" aria-expanded="false">4H EMA 5 / 20 交叉 <small>预收盘 · 1 分钟</small></button><label class="alert-enable"><input class="switch alert-switch" type="checkbox" data-alert-enable="emaCross4h">开启</label></div>
        <div class="alert-strategy-body"><p>收盘前约 1 分钟，根据当前 K 线价格预判 EMA 5 / 20 上穿或下穿；若未触发，收盘后约 2 分钟补查。</p></div>
      </div>
      <div class="alert-strategy" data-strategy="emaCross1d">
        <div class="alert-strategy-head"><button class="alert-collapse" type="button" aria-expanded="false">日线 EMA 5 / 20 交叉 <small>预收盘 · 1 分钟</small></button><label class="alert-enable"><input class="switch alert-switch" type="checkbox" data-alert-enable="emaCross1d">开启</label></div>
        <div class="alert-strategy-body"><p>收盘前约 1 分钟，根据当前 K 线价格预判 EMA 5 / 20 上穿或下穿；若未触发，收盘后约 2 分钟补查。</p></div>
      </div>
      <div class="alert-strategy" data-strategy="emaCross1w">
        <div class="alert-strategy-head"><button class="alert-collapse" type="button" aria-expanded="false">周线 EMA 5 / 20 交叉 <small>预收盘 · 1 分钟</small></button><label class="alert-enable"><input class="switch alert-switch" type="checkbox" data-alert-enable="emaCross1w">开启</label></div>
        <div class="alert-strategy-body"><p>收盘前约 1 分钟，根据当前 K 线价格预判 EMA 5 / 20 上穿或下穿；若未触发，收盘后约 2 分钟补查。</p></div>
      </div>
      <div class="alert-strategy" data-strategy="flat1d">
        <div class="alert-strategy-head"><button class="alert-collapse" type="button" aria-expanded="false">日线 SMA 走平 <small>预收盘 · 1 分钟</small></button><label class="alert-enable"><input class="switch alert-switch" type="checkbox" data-alert-enable="flat1d">开启</label></div>
        <div class="alert-strategy-body"><p>收盘前约 1 分钟，用当前 K 线价格计算 SMA 5/8/13 走平、SMA 5/13 间距和价格偏离；收盘后约 2 分钟补查。</p><label class="alert-threshold">三线变动率上限 <input type="number" min="0" max="20" step="0.1" data-slope="flat1d"> %</label><label class="alert-threshold">SMA 5 / 13 间距 <input type="number" min="0.1" max="20" step="0.1" data-spread="flat1d"> %</label><label class="alert-threshold">收盘价距 SMA 5 <input type="number" min="0" max="20" step="0.1" data-body-distance="flat1d"> %</label></div>
      </div>
      <div class="alert-strategy" data-strategy="flat3d">
        <div class="alert-strategy-head"><button class="alert-collapse" type="button" aria-expanded="false">3 日线 SMA 走平 <small>预收盘 · 1 分钟</small></button><label class="alert-enable"><input class="switch alert-switch" type="checkbox" data-alert-enable="flat3d">开启</label></div>
        <div class="alert-strategy-body"><p>收盘前约 1 分钟，用当前 K 线价格按 3 日线规则计算；若未触发，收盘后约 2 分钟补查。</p><label class="alert-threshold">三线变动率上限 <input type="number" min="0" max="20" step="0.1" data-slope="flat3d"> %</label><label class="alert-threshold">SMA 5 / 13 间距 <input type="number" min="0" max="20" step="0.1" data-spread="flat3d"> %</label><label class="alert-threshold">收盘价距 SMA 5 <input type="number" min="0" max="20" step="0.1" data-body-distance="flat3d"> %</label></div>
      </div>
      <div class="alert-strategy" data-strategy="fractal6h">
        <div class="alert-strategy-head"><button class="alert-collapse" type="button" aria-expanded="false">6 小时顶 / 底分型 <small>收盘确认</small></button><label class="alert-enable"><input class="switch alert-switch" type="checkbox" data-alert-enable="fractal6h">开启</label></div>
        <div class="alert-strategy-body"><p>顶、底分型分别提醒，按形态页规则以第三根 K 线收盘确认。</p></div>
      </div>
      <div class="alert-strategy" data-strategy="fractal1d">
        <div class="alert-strategy-head"><button class="alert-collapse" type="button" aria-expanded="false">日线顶 / 底分型 <small>收盘确认</small></button><label class="alert-enable"><input class="switch alert-switch" type="checkbox" data-alert-enable="fractal1d">开启</label></div>
        <div class="alert-strategy-body"><p>顶、底分型分别提醒，使用形态页的前序比较规则。</p></div>
      </div>
      <div class="alert-strategy" data-strategy="fractal1w">
        <div class="alert-strategy-head"><button class="alert-collapse" type="button" aria-expanded="false">周线顶 / 底分型 <small>收盘确认</small></button><label class="alert-enable"><input class="switch alert-switch" type="checkbox" data-alert-enable="fractal1w">开启</label></div>
        <div class="alert-strategy-body"><p>顶、底分型分别提醒，使用形态页的前序比较规则。</p></div>
      </div>
      <div class="alert-server">
        <strong>服务器推送 · Telegram + Bark</strong>
        <label>Worker 地址<input type="url" id="alertServerUrl" placeholder="https://你的服务.workers.dev"></label>
        <label>管理密钥<input type="password" id="alertServerKey" autocomplete="off" placeholder="部署时设置的 ADMIN_KEY"></label>
        <button type="button" class="action" id="alertSyncServer">保存并同步服务器策略</button>
        <button type="button" class="action" id="alertTelegramConnect">绑定 Telegram 并发送测试</button>
        <span id="alertBarkStatus">Bark 状态：尚未检查</span>
         <button type="button" class="action" id="alertBarkTest">发送 Bark 测试</button>
         <span id="alertServerStatus">填入 Worker 地址和密钥后即可同步</span>
        <p>提醒开关按当前合约分别保存；加入自选不会自动开启提醒。先在 Telegram 向机器人发送 /start，再点“绑定 Telegram 并发送测试”。Bark 与 Telegram 分开发送，可分别测试。</p>
      </div>
      <div class="alert-log-head"><strong>最近提醒</strong><button type="button" id="alertClearLog">清除</button></div>
      <ol class="alert-log" id="alertLog" aria-live="polite"><li class="alert-empty">还没有触发提醒</li></ol>
      </div><div class="alert-toast" id="alertToast" role="status" aria-live="assertive"></div>`;
    const css = document.createElement('style');
    css.textContent = `
      .tide-alert-card{padding:16px}.alert-title,.alert-strategy-head,.alert-log-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.alert-title{font-size:12px;font-weight:700;margin-bottom:10px}.alert-title small,.alert-collapse small{color:var(--muted);font:9px 'DM Mono';font-weight:400}.alert-page-status,#alertServerStatus{font-size:9px;color:var(--muted)}.alert-strategy{border-top:1px solid var(--line);padding:8px 0}.alert-collapse{padding:2px 0;text-align:left;border:0;background:transparent;color:#dce5e2;font-size:11px;font-weight:600}.alert-enable{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:10px;white-space:nowrap}.alert-enable .alert-switch{width:31px;height:17px;min-width:31px;margin:0;flex:0 0 31px;accent-color:#62bd8e}.alert-strategy-body{padding:4px 0 2px}.alert-strategy-body p,.alert-server p{margin:3px 0 6px;color:var(--muted);font-size:10px;line-height:1.6}.alert-strategy-body{max-height:900px;opacity:1;overflow:hidden;transition:max-height .42s cubic-bezier(.2,.72,.2,1),opacity .25s ease,transform .32s ease}.alert-strategy.collapsed .alert-strategy-body{max-height:0;opacity:0;transform:translateY(-5px);padding-top:0;padding-bottom:0}.alert-collapse:before{content:'−';display:inline-block;width:15px;color:var(--muted);font:13px 'DM Mono'}.alert-strategy.collapsed .alert-collapse:before{content:'+'}.alert-threshold{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:10px}.alert-threshold input{width:58px;padding:5px 6px;border:1px solid #342a27;border-radius:6px;background:#100e0d;color:var(--text);font:11px 'DM Mono'}.alert-server{display:grid;gap:7px;border-top:1px solid var(--line);padding-top:11px;margin-top:4px}.alert-server strong,.alert-log-head strong{font-size:10px}.alert-server label{display:grid;gap:4px;color:var(--muted);font-size:9px}.alert-server input{width:100%;padding:7px 8px;border:1px solid #342a27;border-radius:6px;background:#100e0d;color:var(--text);font:10px 'DM Mono'}.alert-server .action{font-size:10px;padding:7px;border-color:#304148}.alert-log-head{padding-top:11px;margin-top:8px;border-top:1px solid var(--line)}.alert-log-head button{color:var(--muted);font-size:9px}.alert-log{margin:5px 0 0;padding-left:17px;color:#dce5e2;font-size:10px;line-height:1.65}.alert-log li{padding:2px 0}.alert-empty{list-style:none;margin-left:-17px;color:var(--muted)}.alert-toast{position:fixed;right:18px;bottom:18px;z-index:1000;max-width:min(380px,calc(100vw - 36px));padding:11px 15px;border:1px solid #5a876e;border-radius:8px;background:#13251c;color:#c9f1d8;box-shadow:0 8px 28px #0008;font-size:12px;opacity:0;transform:translateY(8px);pointer-events:none;transition:.2s}.alert-toast.show{opacity:1;transform:translateY(0)}#ohlcLegend{position:absolute;z-index:9;top:8px;left:12px;display:flex;flex-wrap:wrap;gap:7px 12px;max-width:calc(100% - 72px);padding:3px 0;color:#a5b2b4;font:10px 'DM Mono';pointer-events:none;text-shadow:0 1px 3px #0a0e12}.ohlc-item{white-space:nowrap}.ohlc-item b{font-weight:500;color:#e6eceb;font-variant-numeric:tabular-nums}.ohlc-item.close-up b{color:var(--green)}.ohlc-item.close-down b{color:var(--red)}.alert-candidate-legend{color:#e4bb76;font-size:9px;margin-left:4px}@media(max-width:620px){.tide-alert-card{padding:13px}.alert-toast{right:10px;bottom:10px}#ohlcLegend{left:8px;top:6px;gap:5px 8px;font-size:9px}}`;
    css.textContent += `.alert-scope{margin:0 0 7px;color:var(--muted);font-size:9px;line-height:1.5}.alert-title{flex-wrap:wrap}`;
    css.textContent += `.alert-card-toggle{width:100%;padding:0;border:0;background:transparent;color:var(--text);cursor:pointer;text-align:left}.alert-card-toggle:after{content:'−';margin-left:10px;color:var(--muted);font:16px 'DM Mono'}.tide-alert-card.collapsed{padding-bottom:14px}.alert-card-content{max-height:2600px;opacity:1;transform:translateY(0);overflow:hidden;transition:max-height .52s cubic-bezier(.2,.72,.2,1),opacity .3s ease,transform .36s ease}.tide-alert-card.collapsed .alert-card-content{display:block;max-height:0;opacity:0;transform:translateY(-8px);pointer-events:none}.tide-alert-card.collapsed .alert-card-toggle:after{content:'+'}`;
    document.head.append(css);
    const averageCard = side.querySelector('.toggle-list')?.closest('.side-card');
    const calculatorCard = side.querySelector('.side-card.calculator');
    side.prepend(card);
    if (averageCard && calculatorCard) side.insertBefore(averageCard, calculatorCard);
    const collapseButton = card.querySelector('.alert-card-toggle');
    let alertCollapsed = false;
    try { alertCollapsed = localStorage.getItem('tide:alerts:panel-collapsed:v1') === 'true'; } catch {}
    card.classList.toggle('collapsed', alertCollapsed);
    collapseButton.setAttribute('aria-expanded', String(!alertCollapsed));
    collapseButton.addEventListener('click', () => {
      alertCollapsed = card.classList.toggle('collapsed');
      collapseButton.setAttribute('aria-expanded', String(!alertCollapsed));
      try { localStorage.setItem('tide:alerts:panel-collapsed:v1', String(alertCollapsed)); } catch {}
    });
    for (const [name, enabled] of Object.entries(settings.enabled || {})) {
      const checkbox = card.querySelector(`[data-alert-enable="${name}"]`);
      if (checkbox) checkbox.checked = !!enabled;
    }
    for (const [name, spread] of Object.entries(settings.spreadPct || {})) {
      const input = card.querySelector(`[data-spread="${name}"]`);
      if (input) input.value = spread;
    }
    for (const [name, slope] of Object.entries(settings.slopePct || {})) {
      const input = card.querySelector(`[data-slope="${name}"]`);
      if (input) input.value = slope;
    }
    for (const [name, distance] of Object.entries(settings.bodyDistancePct || {})) {
      const input = card.querySelector(`[data-body-distance="${name}"]`);
      if (input) input.value = distance;
    }
    card.querySelector('#alertServerUrl').value = settings.serverUrl || '';
    card.querySelector('#alertServerKey').value = settings.serverKey || '';
    let collapsedStrategies = {};
    try { collapsedStrategies = JSON.parse(localStorage.getItem('tide:alerts:strategy-collapsed:v1') || '{}') || {}; } catch {}
    card.querySelectorAll('.alert-collapse').forEach((button) => {
      const row = button.closest('.alert-strategy');
      const name = row.dataset.strategy;
      const initial = collapsedStrategies[name] !== false;
      row.classList.toggle('collapsed', initial);
      button.setAttribute('aria-expanded', String(!initial));
      button.onclick = () => {
        const collapsed = row.classList.toggle('collapsed');
        collapsedStrategies[name] = collapsed;
        button.setAttribute('aria-expanded', String(!collapsed));
        try { localStorage.setItem('tide:alerts:strategy-collapsed:v1', JSON.stringify(collapsedStrategies)); } catch {}
      };
    });
    card.querySelectorAll('[data-alert-enable]').forEach((input) => input.addEventListener('change', () => {
      settings.enabled[input.dataset.alertEnable] = input.checked;
      save();
      updateCandidateMarkers();
      scheduleServerSync();
      scheduleLocalCheck();
    }));
    const symbolSelect = document.querySelector('#symbol');
    const instrumentStatus = card.querySelector('#alertInstrumentStatus');
    const showCurrentInstrument = () => {
      if (instrumentStatus) instrumentStatus.textContent = `当前 ${currentSymbol.replace(/-USDT-SWAP$/, '')}`;
    };
    showCurrentInstrument();
    symbolSelect?.addEventListener('change', () => {
      save();
      currentSymbol = symbolSelect.value;
      settings = makeSymbolSettings(settingsBySymbol[currentSymbol] || {});
      for (const [name, enabled] of Object.entries(settings.enabled)) {
        const input = card.querySelector(`[data-alert-enable="${name}"]`);
        if (input) input.checked = !!enabled;
      }
      for (const [field, attribute] of [['spreadPct', 'spread'], ['slopePct', 'slope'], ['bodyDistancePct', 'body-distance']]) {
        for (const [name, value] of Object.entries(settings[field])) {
          const input = card.querySelector(`[data-${attribute}="${name}"]`);
          if (input) input.value = value;
        }
      }
      showCurrentInstrument();
      updateCandidateMarkers();
      scheduleLocalCheck();
      scheduleServerSync();
    });
    document.querySelectorAll('.tab[data-bar]').forEach((button) => button.addEventListener('click', () => {
      if (settings.serverUrl && settings.serverKey) scheduleServerSync();
    }));
    document.querySelector('#fractalLookback')?.addEventListener('change', () => {
      if (settings.serverUrl && settings.serverKey) scheduleServerSync();
    });
    card.querySelectorAll('[data-spread]').forEach((input) => input.addEventListener('change', () => {
      const value = Math.min(20, Math.max(.1, number(input.value, 1)));
      input.value = String(value);
      settings.spreadPct[input.dataset.spread] = value;
      save();
      updateCandidateMarkers();
      scheduleServerSync();
    }));
    card.querySelectorAll('[data-slope]').forEach((input) => input.addEventListener('change', () => {
      const value = Math.min(20, Math.max(0, number(input.value, 0.3)));
      input.value = String(value);
      settings.slopePct[input.dataset.slope] = value;
      save();
      updateCandidateMarkers();
      scheduleServerSync();
    }));
    card.querySelectorAll('[data-body-distance]').forEach((input) => input.addEventListener('change', () => {
      const value = Math.min(20, Math.max(0, number(input.value, 1)));
      input.value = String(value);
      settings.bodyDistancePct[input.dataset.bodyDistance] = value;
      save();
      updateCandidateMarkers();
      scheduleServerSync();
    }));
    for (const selector of ['#alertServerUrl', '#alertServerKey']) card.querySelector(selector).addEventListener('change', () => {
      settings.serverUrl = card.querySelector('#alertServerUrl').value.trim();
      settings.serverKey = card.querySelector('#alertServerKey').value;
      sharedSettings.serverUrl = settings.serverUrl;
      sharedSettings.serverKey = settings.serverKey;
      save();
    });
    card.querySelector('#alertSyncServer').onclick = syncServer;
    card.querySelector('#alertTelegramConnect').onclick = connectTelegram;
    card.querySelector('#alertClearLog').onclick = () => {
      card.querySelector('#alertLog').innerHTML = '<li class="alert-empty">还没有触发提醒</li>';
      try { localStorage.removeItem('tide:alerts:log:v1'); } catch {}
    };
    const log = readLog();
    if (log.length) renderLog(log);
  }

  function format(value) {
    const n = Number(value);
    const max = Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 4 : Math.abs(n) >= 0.01 ? 6 : 8;
    return n.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, max), maximumFractionDigits: max });
  }
  function renderOhlc(time = null) {
    const host = document.querySelector('#ohlcLegend');
    if (!host || !Array.isArray(bars) || !bars.length) return;
    const candle = (time != null ? bars.find((item) => item.time === Number(time)) : null) || bars.at(-1);
    if (!candle) return;
    const changePct = candle.open ? (candle.close / candle.open - 1) * 100 : 0;
    const changeClass = changePct >= 0 ? 'close-up' : 'close-down';
    const changeText = `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`;
    const currentPrice = Number(bars.at(-1)?.close);
    const toCurrentPct = Number.isFinite(currentPrice) && candle.close ? (currentPrice / candle.close - 1) * 100 : 0;
    const currentClass = toCurrentPct >= 0 ? 'close-up' : 'close-down';
    const toCurrentText = `${toCurrentPct >= 0 ? '+' : ''}${toCurrentPct.toFixed(2)}%`;
    host.innerHTML = `<span class="ohlc-item">开 <b>${format(candle.open)}</b></span><span class="ohlc-item">高 <b>${format(candle.high)}</b></span><span class="ohlc-item">低 <b>${format(candle.low)}</b></span><span class="ohlc-item ${changeClass}">收 <b>${format(candle.close)}</b></span><span class="ohlc-item ${changeClass}">涨跌 <b>${changeText}</b></span><span class="ohlc-item ${currentClass}">至现价 <b>${toCurrentText}</b></span>`;
  }  function onCrosshair(param) {
    hoverTime = param?.time == null ? null : Number(param.time);
    renderOhlc(hoverTime);
  }

  function markerEvents() {
    if (!Array.isArray(bars) || !bars.length || !RULES) return [];
    let events = [];
    if (bar === '1D' && settings.enabled.flat1d) events = RULES.events('flat1d', bars, strategyOptions('flat1d'));
    if (bar === '3D' && settings.enabled.flat3d) events = RULES.events('flat3d', bars, strategyOptions('flat3d'));
    return events.map((event) => ({
      time: event.time,
      position: 'belowBar',
      shape: 'arrowUp',
      color: '#f3cf68',
      text: '趋势启动',
    }));
  }
  function updateCandidateMarkers() {
    if (!globalThis.LightweightCharts || !candleSeries || !Array.isArray(bars) || !bars.length) return;
    try {
      if (!markerPlugin) markerPlugin = LightweightCharts.createSeriesMarkers(candleSeries, []);
      markerPlugin.setMarkers(markerEvents());
    } catch (error) {
      console.info('提醒候选标记暂不可用', error.message);
    }
  }

  let toastTimer = null;
  function notifyLocal(symbol, event) {
    const names = {
      emaCross4h: '4H EMA 5/20 交叉',
      emaCross1d: '日线 EMA 5/20 交叉',
      emaCross1w: '周线 EMA 5/20 交叉',
      flat1d: '日线 SMA 走平',
      flat3d: '3日线 SMA 走平',
      fractal6h: '6 小时分型',
      fractal1d: '日线分型',
      fractal1w: '周线分型',
    };
    const direction = event.direction === 'up' ? '向上交叉' : event.direction === 'down' ? '向下交叉' : event.direction === 'top' ? '顶分型' : event.direction === 'bottom' ? '底分型' : '';
    const timing = event.preclose ? '收盘前 1 分钟 · ' : '';
    const priceLabel = event.preclose ? '预收盘参考价' : '收盘';
    const message = `${symbol.replace('-USDT-SWAP', '')} · ${names[event.strategy]} ${direction} · ${timing}${priceLabel} ${format(event.close)}`;
    const log = readLog();
    log.unshift({ message, time: new Date().toLocaleString('zh-CN', { hour12: false }) });
    renderLog(log.slice(0, 8));
    try { localStorage.setItem('tide:alerts:log:v1', JSON.stringify(log.slice(0, 8))); } catch {}
    const toast = document.querySelector('#alertToast');
    if (toast) {
      toast.textContent = message;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 9000);
    }
  }
  function renderLog(items) {
    const list = document.querySelector('#alertLog');
    if (!list) return;
    list.innerHTML = items.length ? items.slice(0, 8).map((item) => `<li><time>${item.time}</time> ${item.message}</li>`).join('') : '<li class="alert-empty">还没有触发提醒</li>';
  }
  function candleBar(strategy) {
    return ({
      emaCross4h: '4H',
      emaCross1d: '1Dutc',
      emaCross1w: '1Wutc',
      flat1d: '1Dutc',
      flat3d: '3Dutc',
      fractal6h: '6H',
      fractal1d: '1Dutc',
      fractal1w: '1Wutc',
    })[strategy];
  }
  async function fetchAlertBars(symbol, timeframe) {
    const query = new URLSearchParams({ instId: symbol, bar: timeframe, limit: '300' });
    const response = await fetch(`https://www.okx.com/api/v5/market/candles?${query}`);
    const body = await response.json();
    if (!response.ok || body.code !== '0' || !body.data?.length) throw new Error(body.msg || `OKX ${response.status}`);
    return body.data.map((row) => ({ time: Math.floor(Number(row[0]) / 1000), open: +row[1], high: +row[2], low: +row[3], close: +row[4], volume: +row[5], confirm: String(row[8]) })).reverse();
  }
  async function checkOne(symbol, strategy) {
    const data = await fetchAlertBars(symbol, candleBar(strategy));
    const closed = RULES.confirmed(data);
    const latest = closed.at(-1);
    if (!latest) return;
    const key = `${symbol}|${strategy}`;
    const now = Math.floor(Date.now() / 1000);
    const current = RULES.evaluationBars(data).at(-1);
    if (current && String(current.confirm) === '0') {
      const closeTime = current.time + RULES.SECONDS[strategy];
      const remaining = closeTime - now;
      if (remaining > 0 && remaining <= PREALERT_SECONDS && Number(prechecked[key] || 0) < current.time) {
        const previews = RULES.previewEvents(strategy, data, strategyOptions(strategy))
          .filter((event) => event.time === current.time && event.closeTime === closeTime);
        if (previews.length) {
          for (const event of previews) notifyLocal(symbol, { ...event, preclose: true });
          prechecked[key] = current.time;
          try { localStorage.setItem('tide:alerts:prechecked:v1', JSON.stringify(prechecked)); } catch {}
        }
      }
    }
    const previous = Number(checkpoints[key] || 0);
    if (!previous || latest.time > previous) {
      const eligible = RULES.events(strategy, data, strategyOptions(strategy)).filter((event) => {
        if (event.closeTime > now) return false;
        if (previous) return event.time > previous;
        const recentWindow = strategy.startsWith('emaCross') ? INITIAL_EMA_WINDOW_SECONDS : RULES.SECONDS[strategy];
        return (strategy.startsWith('emaCross') || strategy.startsWith('fractal')) && event.time === latest.time && event.closeTime >= now - recentWindow;
      });
      for (const event of eligible) if (Number(prechecked[key] || 0) !== event.time) notifyLocal(symbol, event);
      checkpoints[key] = latest.time;
    }
    try { localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoints)); } catch {}
  }
  async function runLocalCheck({ sixHourOnly = false, sixHourWindow = false } = {}) {
    if (checking || !RULES) return;
    const active = Object.keys(settings.enabled || {}).filter((strategy) =>
      settings.enabled[strategy] &&
      (!sixHourOnly || strategy === 'fractal6h') &&
      (strategy !== 'fractal6h' || sixHourWindow),
    );
    if (!active.length) {
      const status = document.querySelector('#alertLocalStatus');
      if (status) status.textContent = '页面提醒已关闭';
      return;
    }
    checking = true;
    const status = document.querySelector('#alertLocalStatus');
    if (status) status.textContent = '正在检查';
    try {
      for (const symbol of symbols()) {
        for (const strategy of active) {
          try { await checkOne(symbol, strategy); }
          catch (error) { console.info(`本地提醒检查失败 ${symbol}/${strategy}:`, error.message); }
        }
      }
      if (status) status.textContent = `页面提醒运行中 · ${new Date().toLocaleTimeString('zh-CN')}`;
    } finally { checking = false; }
  }

  function scheduleLocalCheck() {
    clearTimeout(localTimer);
    const active = Object.values(settings.enabled || {}).some(Boolean);
    const status = document.querySelector('#alertLocalStatus');
    if (!active) {
      if (status) status.textContent = '页面提醒已关闭';
      return;
    }
    const regular = [
      ...[3, 7, 11, 15, 19, 23].map((hour) => ({ hour, minute: 59, sixHourOnly: false, sixHourWindow: [23, 11].includes(hour) })),
      ...[0, 4, 8, 12, 16, 20].map((hour) => ({ hour, minute: 2, sixHourOnly: false, sixHourWindow: [0, 12].includes(hour) })),
    ];
    const sixHourOnly = settings.enabled.fractal6h ? [
      { hour: 5, minute: 59, sixHourOnly: true, sixHourWindow: true },
      { hour: 17, minute: 59, sixHourOnly: true, sixHourWindow: true },
      { hour: 6, minute: 2, sixHourOnly: true, sixHourWindow: true },
      { hour: 18, minute: 2, sixHourOnly: true, sixHourWindow: true },
    ] : [];
    const now = Date.now();
    const today = new Date();
    let next = null;
    for (let offset = 0; offset <= 1; offset++) {
      for (const item of [...regular, ...sixHourOnly]) {
        const when = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset, item.hour, item.minute);
        if (when > now && (next == null || when < next.when)) next = { ...item, when };
      }
    }
    if (!next) return;
    if (status) status.textContent = `页面提醒待检查 · ${new Date(next.when).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })}`;
    localTimer = setTimeout(() => {
      runLocalCheck(next).finally(scheduleLocalCheck);
    }, Math.max(0, next.when - now));
  }

  function serverPayload() {
    const configs = {};
    for (const [symbol, config] of Object.entries(settingsBySymbol)) {
      if (Object.values(config.enabled || {}).some(Boolean)) configs[symbol] = {
        ...config,
        fractalLookbacks: {
          fractal6h: fractalLookback('fractal6h', symbol),
          fractal1d: fractalLookback('fractal1d', symbol),
          fractal1w: fractalLookback('fractal1w', symbol),
        },
      };
    }
    if (Object.values(settings.enabled || {}).some(Boolean)) {
      configs[currentSymbol] = {
        enabled: { ...settings.enabled },
        spreadPct: { ...settings.spreadPct },
        slopePct: { ...settings.slopePct },
        bodyDistancePct: { ...settings.bodyDistancePct },
        fractalLookbacks: {
          fractal6h: fractalLookback('fractal6h', currentSymbol),
          fractal1d: fractalLookback('fractal1d', currentSymbol),
          fractal1w: fractalLookback('fractal1w', currentSymbol),
        },
      };
    }
    return {
      schemaVersion: SETTINGS_VERSION,
      configs,
    };
  }
  async function syncServer() {
    const base = (document.querySelector('#alertServerUrl')?.value || settings.serverUrl || '').trim().replace(/\/$/, '');
    const key = document.querySelector('#alertServerKey')?.value || settings.serverKey || '';
    settings.serverUrl = base;
    settings.serverKey = key;
    save();
    const status = document.querySelector('#alertServerStatus');
    if (!base || !key) {
      if (status) status.textContent = '请填写 Worker 地址和管理密钥';
      return;
    }
    if (status) status.textContent = '正在同步…';
    try {
      const response = await fetch(`${base}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
        body: JSON.stringify(serverPayload()),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (status) status.textContent = `已同步 · ${body.symbols ?? Object.keys(serverPayload().configs).length} 个已设置提醒的合约`;
    } catch (error) {
      if (status) status.textContent = `同步失败：${error.message}`;
    }
  }
  async function checkPushStatus() {
    const base = (document.querySelector('#alertServerUrl')?.value || settings.serverUrl || '').trim().replace(/\/$/, '');
    const status = document.querySelector('#alertBarkStatus');
    if (!base) { if (status) status.textContent = 'Bark 状态：请填写 Worker 地址'; return; }
    if (status) status.textContent = 'Bark 状态：检查中…';
    try {
      const response = await fetch(base + '/api/health');
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));
      if (status) status.textContent = body.barkConfigured ? 'Bark 状态：已配置' : 'Bark 状态：Worker 未配置 BARK_KEY';
    } catch (error) {
      if (status) status.textContent = 'Bark 状态：检查失败 · ' + error.message;
    }
  }
  async function testBark() {
    const base = (document.querySelector('#alertServerUrl')?.value || settings.serverUrl || '').trim().replace(/\/$/, '');
    const key = document.querySelector('#alertServerKey')?.value || settings.serverKey || '';
    const status = document.querySelector('#alertBarkStatus');
    if (!base || !key) { if (status) status.textContent = 'Bark 测试：请填写 Worker 地址和管理密钥'; return; }
    settings.serverUrl = base; settings.serverKey = key; save();
    if (status) status.textContent = 'Bark 测试发送中…';
    try {
      const response = await fetch(base + '/api/bark/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
        body: '{}',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));
      if (status) status.textContent = 'Bark 测试已发送，请检查手机';
    } catch (error) {
      if (status) status.textContent = 'Bark 测试失败：' + error.message;
    }
  }
  async function connectTelegram() {
    const base = (document.querySelector('#alertServerUrl')?.value || settings.serverUrl || '').trim().replace(/\/$/, '');
    const key = document.querySelector('#alertServerKey')?.value || settings.serverKey || '';
    const status = document.querySelector('#alertServerStatus');
    if (!base || !key) {
      if (status) status.textContent = '请先填写 Worker 地址和管理密钥';
      return;
    }
    if (status) status.textContent = '正在绑定 Telegram…';
    try {
      const response = await fetch(base + '/api/telegram/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
        body: '{}',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));
      if (status) status.textContent = 'Telegram 已绑定 · 测试通知已发送';
    } catch (error) {
      if (status) status.textContent = '绑定失败：' + error.message;
    }
  }
  document.querySelector('#alertBarkTest')?.addEventListener('click', testBark);
  document.querySelector('#alertServerUrl')?.addEventListener('change', checkPushStatus);
  checkPushStatus();
  let syncTimer = null;
  function scheduleServerSync() {
    if (!settings.serverUrl || !settings.serverKey) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncServer, 900);
  }

  function addOhlcOverlay() {
    const chartHost = document.querySelector('#priceChart');
    if (chartHost && !document.querySelector('#ohlcLegend')) {
      const overlay = document.createElement('div');
      overlay.id = 'ohlcLegend';
      overlay.setAttribute('aria-label', '当前 K 线开盘价、最高价、最低价、收盘价');
      chartHost.append(overlay);
    }
    if (typeof priceChart !== 'undefined') priceChart.subscribeCrosshairMove(onCrosshair);
    if (typeof macdChart !== 'undefined') macdChart.subscribeCrosshairMove(onCrosshair);
    renderOhlc();
  }

  function hookChartRefresh() {
    const original = applyAll;
    applyAll = function (...args) {
      const result = original.apply(this, args);
      renderOhlc(hoverTime);
      updateCandidateMarkers();
      return result;
    };
  }

  makePanel();
  if (migratedSettings) {
    save();
    if (settings.serverUrl && settings.serverKey) setTimeout(syncServer, 1200);
  }
  addOhlcOverlay();
  hookChartRefresh();
  updateCandidateMarkers();
  scheduleLocalCheck();
  window.addEventListener('beforeunload', () => clearTimeout(localTimer), { once: true });
})();

