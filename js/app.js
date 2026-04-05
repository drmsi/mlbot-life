/**
 * DDD Signals — Main Application
 * Polls bridge for signals + candles, updates UI
 */

(() => {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────
  const BRIDGE_URL  = 'https://gold.ddd.bz';
  const POLL_INTERVAL_MS = 30000;   // poll signals every 30s
  const CANDLE_POLL_MS   = 60000;   // poll candles every 60s
  const MAX_HISTORY      = 50;

  // No auth needed — public endpoints, CORS-restricted by bridge

  let currentSymbol = 'XAUUSD';
  let switchId      = 0;            // incremented on every symbol switch to discard stale responses
  let signalHistory = [];
  let pollTimer     = null;
  let candleTimer   = null;
  let historyTimer  = null;
  let tradeTimer    = null;
  let sparkTimer    = null;
  let connected     = false;
  let backfilledSymbols = new Set(); // Track which symbols have been backfilled
  let allSignalsCache = {};          // Latest signals for all symbols (from /v4/public/signals)
  let sparklineCache  = {};          // 7-day PnL data keyed by symbol
  let errorHistory    = [];          // Last 5 errors
  let errorPanelOpen  = false;

  // ── Signal Tracker Module ────────────────────────────────────────────
  // Tracks original signal outcomes (TP1/TP2/SL hits) based on price action
  const SignalTracker = (() => {
    const MAX_TRACKED_SIGNALS = 200;
    let trackedSignals = [];
    let candleCache = new Map(); // symbol -> array of candles

    function debugLog(category, message, data = null) {
      const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
      const prefix = `[SignalTracker ${timestamp}]`;
      console.log(`${prefix} [${category}] ${message}`, data ? data : '');
    }

    function errorLog(category, message, error = null) {
      const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
      const prefix = `[SignalTracker ERROR ${timestamp}]`;
      console.error(`${prefix} [${category}] ${message}`, error ? error : '');
    }

    function addSignal(sig) {
      try {
        if (!sig || (sig.signal !== 'BUY' && sig.signal !== 'SELL')) {
          return null;
        }

        const signal = {
          key: `${sig.last_bar}_${sig.symbol}_${sig.signal}`,
          symbol: sig.symbol || currentSymbol,
          direction: sig.signal,
          entry: sig.price,
          sl: sig.sl,
          tp1: sig.tp,
          tp2: sig.tp2,
          bar_time: sig.last_bar,
          model: sig.model_used,
          atr: sig.atr,
          tracked: false,
          outcome: null, // 'TP1', 'TP2', 'SL', 'Pending'
          outcome_bar: null,
          checked_bars: 0,
          max_check_bars: 100 // Maximum bars to check (500 minutes for M5)
        };

        // Deduplicate
        if (trackedSignals.some(s => s.key === signal.key)) {
          debugLog('DUPLICATE', `Signal already tracked: ${signal.key}`);
          return null;
        }

        trackedSignals.unshift(signal);
        if (trackedSignals.length > MAX_TRACKED_SIGNALS) {
          trackedSignals = trackedSignals.slice(0, MAX_TRACKED_SIGNALS);
        }

        debugLog('ADD', `New signal tracked: ${signal.key}`, {
          symbol: signal.symbol,
          direction: signal.direction,
          entry: signal.entry,
          tp1: signal.tp1,
          tp2: signal.tp2,
          sl: signal.sl
        });

        // Save to localStorage for persistence
        try {
          localStorage.setItem('ddd_tracked_signals', JSON.stringify(trackedSignals.slice(0, MAX_TRACKED_SIGNALS)));
        } catch (e) {
          errorLog('STORAGE', 'Failed to save signals to localStorage', e);
        }

        return signal;
      } catch (error) {
        errorLog('ADD_SIGNAL', 'Error adding signal to tracker', error);
        return null;
      }
    }

    function updateCandles(symbol, candles) {
      try {
        if (!candles || candles.length === 0) {
          return;
        }

        candleCache.set(symbol, candles);
        debugLog('CANDLES', `Updated candle cache for ${symbol}: ${candles.length} candles`);

        // Check pending signals after candles update
        checkPendingSignals();
      } catch (error) {
        errorLog('CANDLES', `Error updating candles for ${symbol}`, error);
      }
    }

    function checkPendingSignals() {
      try {
        const currentCandles = candleCache.get(currentSymbol);
        if (!currentCandles || currentCandles.length === 0) {
          return;
        }

        debugLog('CHECK', `Checking pending signals for ${currentSymbol}`);

        for (const signal of trackedSignals) {
          if (signal.symbol !== currentSymbol || signal.tracked) {
            continue;
          }

          const result = checkSignalOutcome(signal, currentCandles);
          if (result) {
            signal.outcome = result.outcome;
            signal.outcome_bar = result.bar_time;
            signal.tracked = true;
            debugLog('OUTCOME', `Signal ${signal.key} hit ${signal.outcome}`, {
              entry: signal.entry,
              outcome_bar: signal.outcome_bar
            });
          }

          signal.checked_bars++;
          if (signal.checked_bars >= signal.max_check_bars) {
            signal.tracked = true;
            signal.outcome = 'Pending (Expired)';
            debugLog('EXPIRED', `Signal ${signal.key} expired without outcome`);
          }
        }

        // Save updated signals
        try {
          localStorage.setItem('ddd_tracked_signals', JSON.stringify(trackedSignals.slice(0, MAX_TRACKED_SIGNALS)));
        } catch (e) {
          errorLog('STORAGE', 'Failed to save updated signals', e);
        }
      } catch (error) {
        errorLog('CHECK', 'Error checking pending signals', error);
      }
    }

    function checkSignalOutcome(signal, candles) {
      try {
        // Find the signal's candle
        let signalCandleIndex = -1;
        const signalTs = parseTime(signal.bar_time);

        for (let i = 0; i < candles.length; i++) {
          if (Math.abs(candles[i].time - signalTs) <= 300) { // Within 5 minutes
            signalCandleIndex = i;
            break;
          }
        }

        if (signalCandleIndex === -1) {
          debugLog('CHECK', `Signal candle not found for ${signal.key}`);
          return null;
        }

        // Check candles after signal candle
        for (let i = signalCandleIndex + 1; i < candles.length; i++) {
          const candle = candles[i];

          // For BUY signal — check TP before SL (TP wins on same-bar touch)
          if (signal.direction === 'BUY') {
            // Check TP1 first
            if (signal.tp1 != null && signal.tp1 !== 0) {
              if (candle.high >= signal.tp1) {
                debugLog('HIT_TP1', `BUY signal hit TP1 at ${signal.tp1}`, {
                  candle_high: candle.high,
                  bar_time: candle.time
                });
                // Continue checking for TP2 in same or later candles
                for (let j = i; j < candles.length; j++) {
                  if (signal.tp2 != null && signal.tp2 !== 0 && candles[j].high >= signal.tp2) {
                    debugLog('HIT_TP2', `BUY signal hit TP2 at ${signal.tp2}`, {
                      candle_high: candles[j].high,
                      bar_time: candles[j].time
                    });
                    return { outcome: 'TP2', bar_time: candles[j].time };
                  }
                }
                return { outcome: 'TP1', bar_time: candle.time };
              }
            }
            // Check SL
            if (signal.sl != null && signal.sl !== 0) {
              if (candle.low <= signal.sl) {
                debugLog('HIT_SL', `BUY signal hit SL at ${signal.sl}`, {
                  candle_low: candle.low,
                  bar_time: candle.time
                });
                return { outcome: 'SL', bar_time: candle.time };
              }
            }
          }
          // For SELL signal — check TP before SL
          else if (signal.direction === 'SELL') {
            // Check TP1 first
            if (signal.tp1 != null && signal.tp1 !== 0) {
              if (candle.low <= signal.tp1) {
                debugLog('HIT_TP1', `SELL signal hit TP1 at ${signal.tp1}`, {
                  candle_low: candle.low,
                  bar_time: candle.time
                });
                // Continue checking for TP2
                for (let j = i; j < candles.length; j++) {
                  if (signal.tp2 != null && signal.tp2 !== 0 && candles[j].low <= signal.tp2) {
                    debugLog('HIT_TP2', `SELL signal hit TP2 at ${signal.tp2}`, {
                      candle_low: candles[j].low,
                      bar_time: candles[j].time
                    });
                    return { outcome: 'TP2', bar_time: candles[j].time };
                  }
                }
                return { outcome: 'TP1', bar_time: candle.time };
              }
            }
            // Check SL
            if (signal.sl != null && signal.sl !== 0) {
              if (candle.high >= signal.sl) {
                debugLog('HIT_SL', `SELL signal hit SL at ${signal.sl}`, {
                  candle_high: candle.high,
                  bar_time: candle.time
                });
                return { outcome: 'SL', bar_time: candle.time };
              }
            }
          }
        }

        return null;
      } catch (error) {
        errorLog('CHECK_OUTCOME', `Error checking outcome for signal ${signal.key}`, error);
        return null;
      }
    }

    function parseTime(timeStr) {
      try {
        let iso = timeStr.replace(' ', 'T');
        if (!iso.includes('Z') && !iso.includes('+')) iso += 'Z';
        return Math.floor(new Date(iso).getTime() / 1000);
      } catch (error) {
        errorLog('PARSE_TIME', `Error parsing time: ${timeStr}`, error);
        return 0;
      }
    }

    function getStats(symbol) {
      try {
        const symbolSignals = trackedSignals.filter(s =>
          s.symbol === symbol && s.tracked && s.outcome && !s.outcome.includes('Pending')
        );

        const total = symbolSignals.length;
        const tp1 = symbolSignals.filter(s => s.outcome === 'TP1').length;
        const tp2 = symbolSignals.filter(s => s.outcome === 'TP2').length;
        const sl = symbolSignals.filter(s => s.outcome === 'SL').length;
        const wins = tp1 + tp2;
        const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : 0;
        const pending = trackedSignals.filter(s =>
          s.symbol === symbol && !s.tracked
        ).length;

        debugLog('STATS', `Calculated stats for ${symbol}`, {
          total,
          wins,
          tp1,
          tp2,
          sl,
          winRate,
          pending
        });

        return { total, tp: wins, sl, win_rate: parseFloat(winRate), pending };
      } catch (error) {
        errorLog('STATS', `Error calculating stats for ${symbol}`, error);
        return { total: 0, tp: 0, sl: 0, win_rate: 0, pending: 0 };
      }
    }

    function getHistory(symbol, limit = 20) {
      try {
        return trackedSignals
          .filter(s => s.symbol === symbol)
          .slice(0, limit);
      } catch (error) {
        errorLog('HISTORY', `Error getting history for ${symbol}`, error);
        return [];
      }
    }

    function loadFromStorage() {
      try {
        const stored = localStorage.getItem('ddd_tracked_signals');
        if (stored) {
          const allSignals = JSON.parse(stored);

          // Filter to last 30 days
          const thirtyDaysAgo = Math.floor((Date.now() / 1000) - (30 * 24 * 60 * 60));
          trackedSignals = allSignals.filter(s => {
            const signalTs = parseTime(s.bar_time);
            const isRecent = signalTs >= thirtyDaysAgo;
            if (!isRecent) {
              debugLog('LOAD_FILTER', `Filtered out old signal: ${s.key} (${s.bar_time})`);
            }
            return isRecent;
          });

          const filteredOut = allSignals.length - trackedSignals.length;
          debugLog('LOAD', `Loaded ${trackedSignals.length} signals from storage (filtered out ${filteredOut} older than 30 days)`);
        }
      } catch (error) {
        errorLog('LOAD', 'Error loading signals from storage', error);
      }
    }

    function clear() {
      trackedSignals = [];
      candleCache.clear();
      try {
        localStorage.removeItem('ddd_tracked_signals');
        debugLog('CLEAR', 'Cleared all tracked signals');
      } catch (error) {
        errorLog('CLEAR', 'Error clearing tracked signals', error);
      }
    }

    // Initialize on load
    loadFromStorage();

    return {
      addSignal,
      updateCandles,
      getStats,
      getHistory,
      clear,
      debugLog,
      errorLog,
      parseTime
    };
  })();

  // ── Error Logging ────────────────────────────────────────────────────
  function logError(source, message) {
    const ts = new Date().toLocaleTimeString();
    errorHistory.unshift({ ts, source, message });
    if (errorHistory.length > 5) errorHistory.length = 5;
    renderErrorPanel();
  }

  function renderErrorPanel() {
    const panel = document.getElementById('errorPanel');
    const body  = document.getElementById('errorLogBody');
    const count = document.getElementById('errorCount');
    if (!panel || !body || !count) return;
    if (errorHistory.length === 0) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    count.textContent = errorHistory.length;
    body.style.display = errorPanelOpen ? '' : 'none';
    body.innerHTML = errorHistory.map(e =>
      `<div class="error-log-item"><span class="err-time">${e.ts}</span><span class="err-src">[${e.source}]</span><span class="err-msg">${e.msg || e.message}</span></div>`
    ).join('');
  }

  // exposed globally for onclick in HTML
  window.toggleErrorPanel = function() {
    errorPanelOpen = !errorPanelOpen;
    renderErrorPanel();
  };

  // ── DOM refs ────────────────────────────────────────────────────────
  const $  = id => document.getElementById(id);
  const statusDot    = $('statusDot');
  const statusText   = $('statusText');
  const chartSymbol  = $('chartSymbol');
  const chartLastBar = $('chartLastBar');
  const sigDir       = $('signalDirection');
  const sigStr       = $('signalStrength');
  const sigModel     = $('signalModel');
  const sigAge       = $('signalAge');
  const priceEntry   = $('priceEntry');
  const priceSL      = $('priceSL');
  const priceTP1     = $('priceTP1');
  const probBuy      = $('probBuy');
  const probHold     = $('probHold');
  const probSell     = $('probSell');
  const probBuyPct   = $('probBuyPct');
  const probHoldPct  = $('probHoldPct');
  const probSellPct  = $('probSellPct');
  const detailATR    = $('detailATR');
  const detailRegime = $('detailRegime');
  const detailH1     = $('detailH1');
  const detailRisk   = $('detailRisk');
  const historyBody  = $('historyBody');
  const kpiSignals   = $('kpiSignals');
  const kpiWR        = $('kpiWR');
  const kpiTP        = $('kpiTP');
  const kpiSL        = $('kpiSL');
  const kpiPnL       = $('kpiPnL');
  const kpiPending   = $('kpiPending');
  // Trade execution KPIs
  const kpiPositions   = $('kpiPositions');
  const kpiTradeWR     = $('kpiTradeWR');
  const kpiTradeWins   = $('kpiTradeWins');
  const kpiTradeLosses = $('kpiTradeLosses');
  const kpiTradePnL    = $('kpiTradePnL');
  const kpiTradePF     = $('kpiTradePF');
  const kpiAvgSlots    = $('kpiAvgSlotsInline');
  // EA Journal KPIs (v5.36+)
  const kpiJournalOpens    = $('kpiJournalOpens');
  const kpiJournalSkips    = $('kpiJournalSkips');
  const kpiJournalTimeouts = $('kpiJournalTimeouts');
  const kpiJournalBE       = $('kpiJournalBE');
  const kpiJournalCB       = $('kpiJournalCB');
  const kpiJournalGate     = $('kpiJournalGate');
  const journalActivityRow = $('journalActivityRow');
  // New fields
  const signalReasonWrap = $('signalReasonWrap');
  const signalReason     = $('signalReason');
  const detailAlloc      = $('detailAlloc');
  const statsErrorBadge  = $('statsErrorBadge');

  // ── Init ────────────────────────────────────────────────────────────
  async function init() {
    ChartManager.init('chartContainer');
    renderOverviewGrid(); // show empty grid immediately
    await switchSymbol('XAUUSD');
  }

  function resetTradeKPIs() {
    if (kpiPositions)   kpiPositions.textContent   = '--';
    if (kpiTradeWR)     kpiTradeWR.textContent      = '--';
    if (kpiTradeWins)   kpiTradeWins.textContent    = '--';
    if (kpiTradeLosses) kpiTradeLosses.textContent  = '--';
    if (kpiTradePnL)    kpiTradePnL.textContent     = '--';
    if (kpiTradePF)     kpiTradePF.textContent      = '--';
    if (kpiAvgSlots)    kpiAvgSlots.textContent     = '';
    if (kpiTradeWR)     kpiTradeWR.parentElement.className     = 'stats-kpi';
    if (kpiTradePnL)    kpiTradePnL.parentElement.className    = 'stats-kpi';
    if (kpiJournalOpens)    kpiJournalOpens.textContent    = '--';
    if (kpiJournalSkips)    kpiJournalSkips.textContent    = '--';
    if (kpiJournalTimeouts) kpiJournalTimeouts.textContent = '--';
    if (kpiJournalBE)       kpiJournalBE.textContent       = '--';
    if (kpiJournalCB)       kpiJournalCB.textContent       = '--';
    if (kpiJournalGate)     kpiJournalGate.textContent     = '--';
  }

  async function switchSymbol(sym) {
    currentSymbol = sym;
    const mySwitch = ++switchId;  // capture switch generation
    chartSymbol.textContent = sym;
    chartLastBar.textContent = '--';
    ChartManager.setSymbol(sym);
    resetSignalPanel();
    resetTradeKPIs();

    // Clear history for the old symbol so stale rows don't bleed into new symbol view
    signalHistory = [];
    renderHistory();

    // Backfill historical signals on first visit to a symbol
    if (!backfilledSymbols.has(sym)) {
      backfilledSymbols.add(sym);
      SignalTracker.debugLog('BACKFILL_INIT', `Starting backfill for ${sym}`);
      await backfillSignalTracker(sym, 30);
    }

    // Reset timers immediately
    clearInterval(pollTimer);
    clearInterval(candleTimer);
    clearInterval(historyTimer);
    clearInterval(tradeTimer);
    clearInterval(sparkTimer);
    // Fetch candles first, then signal + history + trades — all guarded by switchId
    fetchStats(mySwitch);
    fetchTradeStats(mySwitch);
    fetchTradeSummary(mySwitch);
    fetchJournalStats(mySwitch);
    fetchSparklineData(sym).then(data => {
      if (switchId === mySwitch) renderSparkline(data);
    });
    fetchCandles(mySwitch).then(async () => {
      if (switchId !== mySwitch) return;  // symbol changed while fetching
      // fetchSignal must complete first so liveSignalTs is set before
      // drawHistoryMarkers runs its dedup check — prevents same-bar duplicate markers
      await fetchSignal(mySwitch);
      if (switchId !== mySwitch) return;
      fetchHistory(mySwitch);
      fetchTradeHistory(mySwitch);
    });
    pollTimer    = setInterval(() => fetchSignal(switchId),  POLL_INTERVAL_MS);
    candleTimer  = setInterval(() => { fetchCandles(switchId); fetchStats(switchId); }, CANDLE_POLL_MS);
    historyTimer = setInterval(() => fetchHistory(switchId), CANDLE_POLL_MS);
    tradeTimer   = setInterval(() => { fetchTradeHistory(switchId); fetchTradeStats(switchId); fetchTradeSummary(switchId); fetchJournalStats(switchId); }, CANDLE_POLL_MS);
    sparkTimer   = setInterval(() => {
      fetchSparklineData(currentSymbol).then(data => { if (switchId !== undefined) renderSparkline(data); });
    }, 5 * 60 * 1000); // refresh sparkline every 5 min
  }

  // ── Fetch Candles ───────────────────────────────────────────────────
  async function fetchCandles(gen) {
    try {
      const sym = currentSymbol;
      const resp = await fetch(`${BRIDGE_URL}/v4/public/candles/${sym}?limit=300`);
      if (gen !== undefined && gen !== switchId) return;  // stale
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (gen !== undefined && gen !== switchId) return;  // stale
      if (data.candles && data.candles.length > 0) {
        ChartManager.setCandles(data.candles);
        // Update signal tracker with new candles
        SignalTracker.updateCandles(sym, data.candles);
        setConnected(true);
      }
    } catch (err) {
      console.error('[fetchCandles] Error:', err.message);
      SignalTracker.errorLog('FETCH_CANDLES', `Failed to fetch candles for ${currentSymbol}`, err);
      setConnected(false);
    }
  }

  // ── Fetch Signal ────────────────────────────────────────────────────
  async function fetchSignal(gen) {
    try {
      const resp = await fetch(`${BRIDGE_URL}/v4/public/signals`);
      if (gen !== undefined && gen !== switchId) return;  // stale
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (gen !== undefined && gen !== switchId) return;  // stale
      setConnected(true);

      // Cache all symbols data + update overview grid
      allSignalsCache = data;
      renderOverviewGrid();

      const sig = data[currentSymbol];
      if (!sig) {
        resetSignalPanel();
        return;
      }

      // Add signal to tracker for outcome tracking
      if (sig.signal === 'BUY' || sig.signal === 'SELL') {
        SignalTracker.addSignal(sig);
      }

      updateSignalPanel(sig);
      ChartManager.drawSignal(sig);

      // Add to history if it's a BUY/SELL
      if (sig.signal === 'BUY' || sig.signal === 'SELL') {
        addToHistory(sig);
      }
    } catch (err) {
      console.error('[fetchSignal] Error:', err.message);
      SignalTracker.errorLog('FETCH_SIGNAL', `Failed to fetch signal for ${currentSymbol}`, err);
      logError('Signal', 'Bridge unreachable — ' + err.message);
      setConnected(false);
    }
  }

  // ── Overview Grid ────────────────────────────────────────────────────
  function renderOverviewGrid() {
    const grid = $('overviewGrid');
    if (!grid) return;
    const symbols = ['XAUUSD','BTCUSD','EURUSD','ETHUSD','GBPUSD','XAGUSD','USDJPY','BRENTCMDUSD'];
    const names   = {XAUUSD:'Gold',BTCUSD:'BTC',EURUSD:'EUR',ETHUSD:'ETH',GBPUSD:'GBP',XAGUSD:'Silver',USDJPY:'JPY',BRENTCMDUSD:'Brent'};
    grid.innerHTML = symbols.map(sym => {
      const sig = allSignalsCache[sym];
      const dir = sig ? (sig.signal || 'HOLD') : '?';
      const dec = getDecimals(sym);
      const price = sig && sig.price != null ? sig.price.toFixed(dec) : '--';
      const alloc = sig && sig.capital_allocation_pct != null ? sig.capital_allocation_pct.toFixed(0) + '%' : '--';
      const isActive = sym === currentSymbol;
      return `<div class="ov-card${isActive ? ' active' : ''}" data-sym="${sym}" onclick="window._switchSym('${sym}')">
        <div class="ov-sym">${sym === 'BRENTCMDUSD' ? 'BRENT' : sym}</div>
        <div class="ov-row">
          <span class="ov-badge ${dir.toLowerCase()}">${dir}</span>
          <span class="ov-alloc">${alloc}</span>
        </div>
        <div class="ov-price">${price}</div>
      </div>`;
    }).join('');
  }

  // Expose switchSymbol globally for overview grid onclick
  window._switchSym = function(sym) {
    switchSymbol(sym);
  };

  // ── Fetch History ──────────────────────────────────────────────────
  // ── Backfill SignalTracker with Historical Signals ─────────────
  async function backfillSignalTracker(sym, days = 30) {
    try {
      // Calculate timestamp for N days ago
      const cutoffTs = Math.floor((Date.now() / 1000) - (days * 24 * 60 * 60));

      // Fetch historical signals with reasonable limit
      // Try different limits if 422 error occurs
      let data = null;
      let limit = 500;
      const maxRetries = 3;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const url = `${BRIDGE_URL}/v4/public/signals/${sym}/history?limit=${limit}&days=${days}`;
        const resp = await fetch(url);

        if (!resp.ok) {
          SignalTracker.errorLog('BACKFILL_FETCH', `Attempt ${attempt + 1}: HTTP ${resp.status} for ${url}`, null);
          if (resp.status === 422) {
            // Try smaller limit on 422 error
            limit = Math.floor(limit / 2);
            SignalTracker.debugLog('BACKFILL_RETRY', `422 error, retrying with limit=${limit}`);
            continue;
          }
          throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        }

        data = await resp.json();
        SignalTracker.debugLog('BACKFILL_SUCCESS', `Successfully fetched ${url}`);
        break;
      }

      if (!data || !data.signals || data.signals.length === 0) {
        SignalTracker.debugLog('BACKFILL', `No historical signals found for ${sym}`);
        return;
      }

      // Filter signals to requested days window
      const recentSignals = data.signals.filter(s => {
        const signalTs = SignalTracker.parseTime(s.bar_time);
        return signalTs >= cutoffTs;
      });

      if (recentSignals.length === 0) {
        SignalTracker.debugLog('BACKFILL', `No signals in last ${days} days for ${sym}`);
        return;
      }

      // Add historical signals to tracker
      let addedCount = 0;
      let skippedCount = 0;

      for (const s of recentSignals) {
        // Convert to signal format expected by SignalTracker
        const signal = {
          signal: s.direction, // BUY or SELL
          price: s.price,
          sl: s.sl,
          tp: s.tp1, // Bridge uses tp1, tracker uses tp
          tp2: s.tp2,
          last_bar: s.bar_time,
          symbol: sym,
          model_used: s.model || '--',
          atr: s.atr || null
        };

        const added = SignalTracker.addSignal(signal);
        if (added) {
          addedCount++;
        } else {
          skippedCount++;
        }
      }

      SignalTracker.debugLog('BACKFILL', `Backfilled ${addedCount}/${recentSignals.length} signals for ${sym} (last ${days} days)`, {
        total_in_history: data.signals.length,
        filtered_last_days: recentSignals.length,
        added: addedCount,
        skipped: skippedCount,
        excluded_older_than: data.signals.length - recentSignals.length
      });

      // Update candles after backfill to check outcomes
      fetchCandles();
    } catch (err) {
      SignalTracker.errorLog('BACKFILL', `Failed to backfill signals for ${sym}`, err);
    }
  }

  async function fetchHistory(gen) {
    try {
      const sym = currentSymbol;
      const resp = await fetch(`${BRIDGE_URL}/v4/public/signals/${sym}/history?limit=5`);
      if (gen !== undefined && gen !== switchId) return;  // stale
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (gen !== undefined && gen !== switchId) return;  // stale
      if (data.signals && data.signals.length > 0) {
        ChartManager.drawHistoryMarkers(data.signals);
      }
    } catch (err) {
      console.warn('History fetch error:', err.message);
      if (historyBody && historyBody.innerHTML.includes('Waiting')) {
        historyBody.innerHTML = '<tr class="error-row"><td colspan="9">⚠ History unavailable — ' + err.message + '</td></tr>';
      }
    }
  }

  // ── Fetch Trade History ────────────────────────────────────────────
  async function fetchTradeHistory(gen) {
    try {
      const sym = currentSymbol;
      const resp = await fetch(`${BRIDGE_URL}/v4/public/trades/${sym}/history?limit=50&days=30`);
      if (gen !== undefined && gen !== switchId) return;  // stale
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (gen !== undefined && gen !== switchId) return;  // stale
      if (data.trades && data.trades.length > 0) {
        ChartManager.drawTradeMarkers(data.trades);
      }
    } catch (err) {
      console.warn('Trade history fetch error:', err.message);
    }
  }

  // ── Fetch Daily Stats ──────────────────────────────────────────────
  async function fetchStats(gen) {
    const sym = currentSymbol;

    // Try server-side stats (Mon → today), aggregate week in parallel
    let serverStats = null;
    try {
      const today = new Date();
      const dow = today.getDay();                        // 0=Sun … 6=Sat
      const daysSinceMon = dow === 0 ? 6 : dow - 1;     // Mon=0 … Sun=6
      const dates = [];
      for (let i = daysSinceMon; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        dates.push(d.toISOString().split('T')[0]);
      }
      const dailyResults = await Promise.all(dates.map(dt =>
        fetch(`${BRIDGE_URL}/v4/public/stats/daily?symbol=${sym}&dt=${dt}`)
          .then(r => r.ok ? r.json() : null)
          .then(json => json && json[sym] ? json[sym] : null)
          .catch(() => null)
      ));
      if (gen !== undefined && gen !== switchId) return;
      let total = 0, completed = 0, pending = 0, tp = 0, sl = 0, pnl = 0;
      for (const r of dailyResults) {
        if (!r) continue;
        total     += r.total     || 0;
        completed += r.completed || 0;
        pending   += r.pending   || 0;
        tp        += r.tp        || 0;
        sl        += r.sl        || 0;
        pnl       += r.pnl_pips  || 0;
      }
      if (total > 0) {
        const win_rate = completed > 0 ? Math.round((tp / completed) * 1000) / 10 : 0;
        serverStats = { total, completed, pending, tp, sl, win_rate, pnl_pips: Math.round(pnl * 100) / 100 };
      }
    } catch (err) {
      // fall through to SignalTracker
    }
    if (gen !== undefined && gen !== switchId) return;

    if (serverStats && serverStats.total > 0) {
      // Server-side data available — use it
      kpiSignals.textContent = serverStats.total;
      kpiWR.textContent = serverStats.win_rate + '%';
      kpiTP.textContent = serverStats.tp;
      kpiSL.textContent = serverStats.sl;
      kpiPending.textContent = serverStats.pending;
      kpiPnL.textContent = (serverStats.pnl_pips >= 0 ? '+' : '') + serverStats.pnl_pips.toFixed(0);

      const wrEl = kpiWR.parentElement;
      wrEl.className = 'stats-kpi ' + (serverStats.win_rate >= 50 ? 'kpi-wr-good' : 'kpi-wr-bad');
      const pnlEl = kpiPnL.parentElement;
      pnlEl.className = 'stats-kpi ' + (serverStats.pnl_pips >= 0 ? 'kpi-pnl-pos' : 'kpi-pnl-neg');

      if (statsErrorBadge) statsErrorBadge.style.display = 'none';
      return;
    }

    // Fallback: client-side SignalTracker
    try {
      const trackedStats = SignalTracker.getStats(sym);

      kpiSignals.textContent = trackedStats.total;
      kpiWR.textContent = trackedStats.win_rate + '%';
      kpiTP.textContent = trackedStats.tp;
      kpiSL.textContent = trackedStats.sl;
      kpiPending.textContent = trackedStats.pending;

      // Calculate PnL in pips based on tracked outcomes
      let pnlPips = 0;
      const pipSize = getPipSize(sym);
      const history = SignalTracker.getHistory(sym, 500);
      for (const sig of history) {
        if (!sig.tracked || !sig.outcome || sig.outcome.includes('Pending')) continue;
        const entry = sig.entry;
        if (!entry || !pipSize) continue;
        if (sig.outcome === 'TP1' && sig.tp1) {
          pnlPips += (sig.direction === 'BUY' ? sig.tp1 - entry : entry - sig.tp1) / pipSize;
        } else if (sig.outcome === 'TP2' && sig.tp2) {
          pnlPips += (sig.direction === 'BUY' ? sig.tp2 - entry : entry - sig.tp2) / pipSize;
        } else if (sig.outcome === 'SL' && sig.sl) {
          pnlPips += (sig.direction === 'BUY' ? sig.sl - entry : entry - sig.sl) / pipSize;
        }
      }
      kpiPnL.textContent = (pnlPips >= 0 ? '+' : '') + Math.round(pnlPips).toFixed(0);

      const wrEl = kpiWR.parentElement;
      wrEl.className = 'stats-kpi ' + (trackedStats.win_rate >= 50 ? 'kpi-wr-good' : 'kpi-wr-bad');
      const pnlEl = kpiPnL.parentElement;
      pnlEl.className = 'stats-kpi ' + (pnlPips >= 0 ? 'kpi-pnl-pos' : 'kpi-pnl-neg');

      if (statsErrorBadge) {
        if (trackedStats.total === 0) {
          statsErrorBadge.style.display = '';
          statsErrorBadge.textContent = '⚠ Stats unavailable (no server data for today)';
        } else {
          statsErrorBadge.style.display = 'none';
        }
      }
    } catch (err) {
      console.error('[fetchStats] Error:', err.message);
      SignalTracker.errorLog('FETCH_STATS', `Failed to fetch stats for ${currentSymbol}`, err);
      if (statsErrorBadge) {
        statsErrorBadge.style.display = '';
        statsErrorBadge.textContent = '⚠ Stats unavailable';
      }
      logError('Stats', err.message);
    }
  }

  // ── Fetch Trade Stats ──────────────────────────────────────────────
  async function fetchTradeStats(gen) {
    try {
      const sym = currentSymbol;
      const resp = await fetch(`${BRIDGE_URL}/v4/public/trades/daily-stats?symbol=${sym}&days=30`);
      if (gen !== undefined && gen !== switchId) return;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (gen !== undefined && gen !== switchId) return;
      const ts = data[sym];
      if (ts && ts.positions > 0) {
        kpiPositions.textContent = ts.positions;
        kpiTradeWR.textContent = ts.win_rate + '%';
        kpiTradeWins.textContent = ts.wins;
        kpiTradeLosses.textContent = ts.losses;
        kpiTradePnL.textContent = (ts.net_pnl >= 0 ? '+$' : '-$') + Math.abs(ts.net_pnl).toFixed(2);
        if (kpiAvgSlots && ts.avg_slots != null) kpiAvgSlots.textContent = 'avg ' + ts.avg_slots + ' slots';
        const wrEl = kpiTradeWR.parentElement;
        wrEl.className = 'stats-kpi ' + (ts.win_rate >= 50 ? 'kpi-trade-wr-good' : 'kpi-trade-wr-bad');
        const pnlEl = kpiTradePnL.parentElement;
        pnlEl.className = 'stats-kpi ' + (ts.net_pnl >= 0 ? 'kpi-trade-pnl-pos' : 'kpi-trade-pnl-neg');
      } else {
        resetTradeKPIs();
      }
    } catch (err) {
      console.warn('Trade stats fetch error:', err.message);
    }
  }

  // ── Fetch Trade Summary (PF + close reasons) ───────────────────────
  async function fetchTradeSummary(gen) {
    try {
      const sym = currentSymbol;
      const resp = await fetch(`${BRIDGE_URL}/v4/public/trades/${sym}/summary?days=30`);
      if (gen !== undefined && gen !== switchId) return;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (gen !== undefined && gen !== switchId) return;
      const stats = data.stats || {};
      const pf = stats.profit_factor ?? stats.pf;
      if (kpiTradePF) kpiTradePF.textContent = pf != null ? pf.toFixed(2) : '--';
    } catch (err) {
      if (kpiTradePF) kpiTradePF.textContent = '--';
    }
  }

  // ── Fetch EA Journal Stats (v5.36+) ────────────────────────────────
  async function fetchJournalStats(gen) {
    try {
      const sym = currentSymbol;
      const resp = await fetch(`${BRIDGE_URL}/v4/public/journal/stats?symbol=${sym}&days=30`);
      if (gen !== undefined && gen !== switchId) return;
      if (!resp.ok) return; // endpoint may not exist on older bridge — skip silently
      const data = await resp.json();
      if (gen !== undefined && gen !== switchId) return;
      const ev = data.events;
      if (!ev) {
        if (kpiJournalOpens) kpiJournalOpens.textContent = '--';
        if (kpiJournalSkips) kpiJournalSkips.textContent = '--';
        if (kpiJournalTimeouts) kpiJournalTimeouts.textContent = '--';
        if (kpiJournalBE) kpiJournalBE.textContent = '--';
        if (kpiJournalCB) kpiJournalCB.textContent = '--';
        if (kpiJournalGate) kpiJournalGate.textContent = '--';
        return;
      }
      const total = Object.values(ev).reduce((a, b) => a + b, 0);
      if (total === 0 && !ev.group_open) {
        if (kpiJournalOpens) kpiJournalOpens.textContent = '--';
        if (kpiJournalSkips) kpiJournalSkips.textContent = '--';
        if (kpiJournalTimeouts) kpiJournalTimeouts.textContent = '--';
        if (kpiJournalBE) kpiJournalBE.textContent = '--';
        if (kpiJournalCB) kpiJournalCB.textContent = '--';
        if (kpiJournalGate) kpiJournalGate.textContent = '--';
        return;
      }
      if (journalActivityRow) journalActivityRow.style.display = '';
      if (kpiJournalOpens)    kpiJournalOpens.textContent    = ev.group_open      ?? '--';
      if (kpiJournalSkips)    kpiJournalSkips.textContent    = ev.entry_skip      ?? '--';
      if (kpiJournalTimeouts) kpiJournalTimeouts.textContent = ev.order_timeout   ?? '--';
      if (kpiJournalBE)       kpiJournalBE.textContent       = ev.be_triggered    ?? '--';
      if (kpiJournalCB)       kpiJournalCB.textContent       = ev.circuit_breaker ?? '--';
      if (kpiJournalGate)     kpiJournalGate.textContent     = ev.loss_gate       ?? '--';
    } catch (err) {
      // Journal stats not critical — skip silently (EA < v5.36 won't have data)
    }
  }

  // ── 7-Day Sparkline ─────────────────────────────────────────────────
  async function fetchSparklineData(sym) {
    if (sparklineCache[sym]) return sparklineCache[sym];
    const data = [];
    const now = new Date();
    const fetches = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dt = d.toISOString().split('T')[0];
      fetches.push(
        fetch(`${BRIDGE_URL}/v4/public/stats/daily?symbol=${sym}&dt=${dt}`)
          .then(r => r.ok ? r.json() : null)
          .then(json => json && json[sym] ? json[sym].pnl_pips || 0 : 0)
          .catch(() => 0)
      );
    }
    const results = await Promise.all(fetches);
    sparklineCache[sym] = results;
    return results;
  }

  function renderSparkline(data) {
    const svg = $('pnlSparkline');
    const wrap = $('sparklineWrap');
    if (!svg || !wrap) return;

    // Hide if all zeros
    if (!data || data.every(v => v === 0)) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';

    const W = 100, H = 36, pad = 4;
    const cumulativePnL = [];
    let running = 0;
    for (const v of data) { running += v; cumulativePnL.push(running); }

    const minV = Math.min(...cumulativePnL);
    const maxV = Math.max(...cumulativePnL);
    const range = maxV - minV || 1;
    const n = cumulativePnL.length;

    const pts = cumulativePnL.map((v, i) => {
      const x = pad + (i / (n - 1)) * (W - 2 * pad);
      const y = (H - pad) - ((v - minV) / range) * (H - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const lastVal = cumulativePnL[cumulativePnL.length - 1];
    const color = lastVal >= 0 ? '#22c55e' : '#ef4444';
    const [lx, ly] = pts[pts.length - 1].split(',');
    // Zero line
    const zeroY = (H - pad) - ((0 - minV) / range) * (H - 2 * pad);
    const zeroLine = minV < 0 && maxV > 0
      ? `<line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${W - pad}" y2="${zeroY.toFixed(1)}" stroke="rgba(255,255,255,0.1)" stroke-width="1" stroke-dasharray="2,2"/>`
      : '';
    svg.innerHTML = `
      ${zeroLine}
      <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${lx}" cy="${ly}" r="2.5" fill="${color}"/>
    `;
  }

  // ── Update Signal Panel ─────────────────────────────────────────────
  function updateSignalPanel(sig) {
    const dir = sig.signal || 'HOLD';
    sigDir.textContent = dir;
    sigDir.className = 'signal-direction ' + dir.toLowerCase();

    sigStr.textContent = sig.strength_bars || '';
    sigModel.textContent = sig.model_used || '--';

    // Age with color coding
    const ageSec = sig.signal_age_sec;
    if (ageSec != null) {
      sigAge.textContent = formatAge(ageSec) + ' ago';
      let ageClass = 'age-fresh';
      if (ageSec > 900) ageClass = 'age-stale';
      else if (ageSec > 300) ageClass = 'age-aging';
      sigAge.className = 'signal-age ' + ageClass;
    } else {
      sigAge.textContent = '--';
      sigAge.className = 'signal-age';
    }

    // Signal reason (especially useful for HOLD)
    if (signalReasonWrap && signalReason) {
      const reason = sig.reason || '';
      if (reason) {
        signalReason.textContent = reason;
        signalReasonWrap.style.display = '';
      } else {
        signalReasonWrap.style.display = 'none';
      }
    }

    const dec = getDecimals(currentSymbol);
    priceEntry.textContent = sig.price != null ? sig.price.toFixed(dec) : '--';
    priceSL.textContent    = (sig.sl != null && sig.sl !== 0)  ? sig.sl.toFixed(dec)  : (dir !== 'HOLD' ? 'Trail' : '--');
    priceTP1.textContent   = (sig.tp != null && sig.tp !== 0)  ? sig.tp.toFixed(dec)  : (dir !== 'HOLD' ? 'Trail' : '--');

    // Probabilities
    const bp = (sig.buy_prob  || 0) * 100;
    const hp = (sig.hold_prob || 0) * 100;
    const sp = (sig.sell_prob || 0) * 100;
    probBuy.style.width  = bp + '%';
    probHold.style.width = hp + '%';
    probSell.style.width = sp + '%';
    probBuyPct.textContent  = bp.toFixed(1) + '%';
    probHoldPct.textContent = hp.toFixed(1) + '%';
    probSellPct.textContent = sp.toFixed(1) + '%';

    // Details
    detailATR.textContent    = sig.atr != null ? sig.atr : '--';
    detailRegime.textContent = sig.regime_label || '--';
    detailH1.textContent     = sig.h1_confluence || '--';
    detailRisk.textContent   = sig.risk_multiplier != null ? sig.risk_multiplier + 'x' : '--';
    if (detailAlloc) {
      detailAlloc.textContent = sig.capital_allocation_pct != null
        ? sig.capital_allocation_pct.toFixed(0) + '%'
        : '--';
    }

    // Last bar
    if (sig.last_bar) {
      chartLastBar.textContent = sig.last_bar.replace('T', ' ').substring(0, 19);
    }
  }

  function resetSignalPanel() {
    sigDir.textContent = 'HOLD';
    sigDir.className = 'signal-direction hold';
    sigStr.textContent = '';
    sigModel.textContent = '--';
    sigAge.textContent = '--';
    sigAge.className = 'signal-age';
    priceEntry.textContent = '--';
    priceSL.textContent = '--';
    priceTP1.textContent = '--';
    probBuy.style.width = '0%';
    probHold.style.width = '0%';
    probSell.style.width = '0%';
    probBuyPct.textContent = '--';
    probHoldPct.textContent = '--';
    probSellPct.textContent = '--';
    detailATR.textContent = '--';
    detailRegime.textContent = '--';
    detailH1.textContent = '--';
    detailRisk.textContent = '--';
    if (detailAlloc) detailAlloc.textContent = '--';
    if (signalReasonWrap) signalReasonWrap.style.display = 'none';
    ChartManager.clearSignalLines();
  }

  // ── Signal History ──────────────────────────────────────────────────
  function addToHistory(sig) {
    // Deduplicate by last_bar + symbol + signal
    const key = `${sig.last_bar}_${sig.symbol || currentSymbol}_${sig.signal}`;
    if (signalHistory.some(h => h.key === key)) return;

    const dec = getDecimals(sig.symbol || currentSymbol);

    // Get outcome from SignalTracker if available
    let outcome = 'Pending';
    let outcomeClass = 'hold';

    const tracked = SignalTracker.getHistory(sig.symbol || currentSymbol, MAX_HISTORY);
    const trackedSig = tracked.find(s => s.key === key);
    if (trackedSig && trackedSig.outcome) {
      outcome = trackedSig.outcome;
      if (outcome === 'SL') {
        outcomeClass = 'sell';
      } else if (outcome.startsWith('TP')) {
        outcomeClass = 'buy';
      }
    }

    signalHistory.unshift({
      key,
      time:     sig.last_bar ? sig.last_bar.replace('T', ' ').substring(0, 16) : '--',
      symbol:   sig.symbol || currentSymbol,
      signal:   sig.signal,
      entry:    sig.price != null ? sig.price.toFixed(dec) : '--',
      sl:       (sig.sl != null && sig.sl !== 0)  ? sig.sl.toFixed(dec)  : 'Trail',
      tp1:      (sig.tp != null && sig.tp !== 0)  ? sig.tp.toFixed(dec)  : 'Trail',
      strength: sig.strength_label || '--',
      outcome:  outcome,
      outcomeClass: outcomeClass,
    });

    if (signalHistory.length > MAX_HISTORY) signalHistory = signalHistory.slice(0, MAX_HISTORY);
    renderHistory();
  }

  function renderHistory() {
    if (signalHistory.length === 0) {
      historyBody.innerHTML = '<tr class="empty-row"><td colspan="9">Waiting for signals...</td></tr>';
      return;
    }
    historyBody.innerHTML = signalHistory.map(h => `
      <tr>
        <td>${h.time}</td>
        <td>${h.symbol}</td>
        <td><span class="sig-badge ${h.signal.toLowerCase()}">${h.signal}</span></td>
        <td>${h.entry}</td>
        <td>${h.sl}</td>
        <td>${h.tp1}</td>
        <td><span class="sig-badge ${h.outcomeClass}">${h.outcome}</span></td>
        <td>${h.strength}</td>
      </tr>
    `).join('');
  }

  // ── Connection Status ───────────────────────────────────────────────
  function setConnected(ok) {
    connected = ok;
    if (ok) {
      statusDot.className = 'status-dot live';
      statusText.textContent = 'Live';
    } else {
      statusDot.className = 'status-dot error';
      statusText.textContent = 'Disconnected';
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────
  function getDecimals(sym) {
    const map = {
      XAUUSD: 2, BTCUSD: 2, ETHUSD: 2, EURUSD: 5,
      GBPUSD: 5, XAGUSD: 3, USDJPY: 3, BRENTCMDUSD: 2,
    };
    return map[sym] || 2;
  }

  // Pip size per symbol (1 pip in price units)
  function getPipSize(sym) {
    const map = {
      XAUUSD: 0.1, BTCUSD: 1.0, ETHUSD: 0.1, EURUSD: 0.0001,
      GBPUSD: 0.0001, XAGUSD: 0.001, USDJPY: 0.01, BRENTCMDUSD: 0.01,
    };
    return map[sym] || 0.0001;
  }

  function formatAge(seconds) {
    if (seconds < 60) return Math.round(seconds) + 's';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm';
    if (seconds < 86400) return Math.round(seconds / 3600) + 'h';
    return Math.round(seconds / 86400) + 'd';
  }

  // ── Boot ────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
