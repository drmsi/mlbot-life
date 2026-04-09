/**
 * DDD Signals — Main Application
 * Polls bridge for signals + candles, updates UI
 */

(() => {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────
  const BRIDGE_URL  = 'https://mlbot.ddd.bz';
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
  let connected     = false;
  let backfilledSymbols = new Set(); // Track which symbols have been backfilled
  let allSignalsCache = {};          // Latest signals for all symbols (from /v6/public/signals)
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
          tp1: sig.tp1,
          tp2: sig.tp2,
          bar_time: sig.last_bar,
          model: sig.model_used,
          atr: sig.atr,
          tracked: false,
          outcome: null, // 'hitTp1', 'hitTp2', 'SL', 'Pending'
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
            // Check tp1 first
            if (signal.tp1 != null && signal.tp1 !== 0) {
              if (candle.high >= signal.tp1) {
                debugLog('HIT_TP1', `BUY signal hit tp1 at ${signal.tp1}`, {
                  candle_high: candle.high,
                  bar_time: candle.time
                });
                // Continue checking for tp2 in same or later candles
                for (let j = i; j < candles.length; j++) {
                  if (signal.tp2 != null && signal.tp2 !== 0 && candles[j].high >= signal.tp2) {
                    debugLog('HIT_TP2', `BUY signal hit tp2 at ${signal.tp2}`, {
                      candle_high: candles[j].high,
                      bar_time: candles[j].time
                    });
                    return { outcome: 'hitTp2', bar_time: candles[j].time };
                  }
                }
                return { outcome: 'hitTp1', bar_time: candle.time };
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
            // Check tp1 first
            if (signal.tp1 != null && signal.tp1 !== 0) {
              if (candle.low <= signal.tp1) {
                debugLog('HIT_TP1', `SELL signal hit tp1 at ${signal.tp1}`, {
                  candle_low: candle.low,
                  bar_time: candle.time
                });
                // Continue checking for tp2
                for (let j = i; j < candles.length; j++) {
                  if (signal.tp2 != null && signal.tp2 !== 0 && candles[j].low <= signal.tp2) {
                    debugLog('HIT_TP2', `SELL signal hit tp2 at ${signal.tp2}`, {
                      candle_low: candles[j].low,
                      bar_time: candles[j].time
                    });
                    return { outcome: 'hitTp2', bar_time: candles[j].time };
                  }
                }
                return { outcome: 'hitTp1', bar_time: candle.time };
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
        const tp1 = symbolSignals.filter(s => s.outcome === 'hitTp1').length;
        const tp2 = symbolSignals.filter(s => s.outcome === 'hitTp2').length;
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

          // Migrate legacy outcome strings
          for (const s of allSignals) {
            if (s.outcome === 'TP1') s.outcome = 'hitTp1';
            if (s.outcome === 'TP2') s.outcome = 'hitTp2';
          }

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
  const priceTP2     = $('priceTP2');
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
  // Stats grids are rendered dynamically — no individual KPI refs needed
  // New fields
  const signalReasonWrap = $('signalReasonWrap');
  const signalReason     = $('signalReason');
  const detailAlloc      = $('detailAlloc');
  const statsErrorBadge  = $('statsErrorBadge');

  // ── Init ────────────────────────────────────────────────────────────
  async function init() {
    // ?reset=1 in URL clears all localStorage stats (use after server history clear)
    if (new URLSearchParams(window.location.search).get('reset') === '1') {
      localStorage.removeItem('ddd_tracked_signals');
      debugLog('RESET', 'Cleared tracked signals via ?reset=1');
      // Remove the param from URL so refresh doesn't re-clear
      const url = new URL(window.location.href);
      url.searchParams.delete('reset');
      window.history.replaceState({}, '', url.toString());
    }
    ChartManager.init('chartContainer');
    renderOverviewGrid(); // show empty grid immediately
    // Fetch all-symbols stats (independent of selected symbol)
    fetchAllStats();
    fetchAllTradeStats();
    setInterval(() => { fetchAllStats(); fetchAllTradeStats(); }, CANDLE_POLL_MS);
    await switchSymbol('XAUUSD');
  }

  async function switchSymbol(sym) {
    currentSymbol = sym;
    const mySwitch = ++switchId;  // capture switch generation
    chartSymbol.textContent = sym;
    chartLastBar.textContent = '--';
    ChartManager.setSymbol(sym);
    resetSignalPanel();

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
    // Fetch candles first, then signal + history + trades — all guarded by switchId
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
    candleTimer  = setInterval(() => fetchCandles(switchId), CANDLE_POLL_MS);
    historyTimer = setInterval(() => fetchHistory(switchId), CANDLE_POLL_MS);
    tradeTimer   = setInterval(() => fetchTradeHistory(switchId), CANDLE_POLL_MS);
  }

  // ── Fetch Candles ───────────────────────────────────────────────────
  async function fetchCandles(gen) {
    try {
      const sym = currentSymbol;
      const resp = await fetch(`${BRIDGE_URL}/v6/public/candles/${sym}?limit=300`);
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
      const resp = await fetch(`${BRIDGE_URL}/v6/public/signals`);
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
    const symbols = ['XAUUSD', 'BTCUSD'];
    const names   = {XAUUSD:'Gold', BTCUSD:'BTC'};
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
        const url = `${BRIDGE_URL}/v6/public/signals/${sym}/history?limit=${limit}&days=${days}`;
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
          tp1: s.tp1,
          tp2: s.tp2,
          last_bar: s.bar_time,
          symbol: sym,
          model_used: s.model || '--',
          atr: s.atr || null
        };

        const added = SignalTracker.addSignal(signal);
        if (added) {
          addedCount++;
          // Apply server-side outcome if available (migrate old TP1/TP2 → hitTp1/hitTp2)
          if (s.outcome) {
            let outcome = s.outcome;
            if (outcome === 'TP1') outcome = 'hitTp1';
            if (outcome === 'TP2') outcome = 'hitTp2';
            added.outcome = outcome;
            added.tracked = true;
          }
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
      const resp = await fetch(`${BRIDGE_URL}/v6/public/signals/${sym}/history?limit=5`);
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
      const resp = await fetch(`${BRIDGE_URL}/v6/public/trades/${sym}/history?limit=50&days=30`);
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

  // ── All-symbols stats (signal performance + trade execution) ─────
  const ALL_STATS_SYMBOLS = ['XAUUSD', 'BTCUSD'];

  // Render signal KPI row HTML for one symbol
  function _signalKpiRow(r) {
    const wrClass = r.wr >= 50 ? 'kpi-wr-good' : (r.total > 0 ? 'kpi-wr-bad' : '');
    const pnlClass = r.pnl >= 0 ? 'kpi-pnl-pos' : 'kpi-pnl-neg';
    const pnlText = r.total > 0 ? ((r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(0)) : '--';
    return `<div class="sym-kpi-row">
      <div class="sym-kpi"><span class="sym-kpi-value">${r.total || '--'}</span><span class="sym-kpi-label">Signals</span></div>
      <div class="sym-kpi ${wrClass}"><span class="sym-kpi-value">${r.total > 0 ? r.wr + '%' : '--'}</span><span class="sym-kpi-label">Win Rate</span></div>
      <div class="sym-kpi kpi-green"><span class="sym-kpi-value">${r.total > 0 ? r.tp1 : '--'}</span><span class="sym-kpi-label">TP1</span></div>
      <div class="sym-kpi kpi-green"><span class="sym-kpi-value">${r.total > 0 ? r.tp2 : '--'}</span><span class="sym-kpi-label">TP2</span></div>
      <div class="sym-kpi kpi-red"><span class="sym-kpi-value">${r.total > 0 ? r.sl : '--'}</span><span class="sym-kpi-label">SL</span></div>
      <div class="sym-kpi ${r.total > 0 ? pnlClass : ''}"><span class="sym-kpi-value">${pnlText}</span><span class="sym-kpi-label">P&L</span></div>
      <div class="sym-kpi"><span class="sym-kpi-value">${r.total > 0 ? r.pending : '--'}</span><span class="sym-kpi-label">Pending</span></div>
    </div>`;
  }

  // Render trade KPI row HTML for one symbol
  function _tradeKpiRow(r) {
    const wrClass = r.positions > 0 ? (r.wr >= 50 ? 'kpi-wr-good' : 'kpi-wr-bad') : '';
    const pnlClass = r.positions > 0 ? (r.pnl >= 0 ? 'kpi-pnl-pos' : 'kpi-pnl-neg') : '';
    const pnlText = r.positions > 0 ? ((r.pnl >= 0 ? '+$' : '-$') + Math.abs(r.pnl).toFixed(2)) : '--';
    return `<div class="sym-kpi-row">
      <div class="sym-kpi"><span class="sym-kpi-value">${r.positions || '--'}</span><span class="sym-kpi-label">Positions</span></div>
      <div class="sym-kpi ${wrClass}"><span class="sym-kpi-value">${r.positions > 0 ? r.wr + '%' : '--'}</span><span class="sym-kpi-label">Win Rate</span></div>
      <div class="sym-kpi kpi-green"><span class="sym-kpi-value">${r.positions > 0 ? r.wins : '--'}</span><span class="sym-kpi-label">Wins</span></div>
      <div class="sym-kpi kpi-red"><span class="sym-kpi-value">${r.positions > 0 ? r.losses : '--'}</span><span class="sym-kpi-label">Losses</span></div>
      <div class="sym-kpi ${pnlClass}"><span class="sym-kpi-value">${pnlText}</span><span class="sym-kpi-label">P&L $</span></div>
      <div class="sym-kpi"><span class="sym-kpi-value">${r.pf != null ? r.pf.toFixed(2) : '--'}</span><span class="sym-kpi-label">PF</span></div>
    </div>`;
  }

  // Cached per-symbol data for grid render
  let _sigData = {};
  let _tradeData = {};

  function _renderDashGrid() {
    const grid = $('symDashGrid');
    if (!grid) return;
    grid.innerHTML = ALL_STATS_SYMBOLS.map(sym => {
      const sig = _sigData[sym] || { sym, total: 0, tp: 0, sl: 0, pending: 0, wr: 0, pnl: 0 };
      const tr = _tradeData[sym] || { sym, positions: 0, wr: 0, wins: 0, losses: 0, pnl: 0, pf: null };
      return `<div class="sym-dash-col">
        <div class="sym-dash-title">${sym}</div>
        <div class="sym-dash-section sym-dash-section-signals">
          <div class="sym-dash-section-title">Signal Performance <span class="sym-dash-period">30d</span></div>
          ${_signalKpiRow(sig)}
        </div>
        <div class="sym-dash-section sym-dash-section-trades">
          <div class="sym-dash-section-title">Trade Execution <span class="sym-dash-period">30d</span></div>
          ${_tradeKpiRow(tr)}
        </div>
      </div>`;
    }).join('');
  }

  async function fetchAllStats() {
    for (const sym of ALL_STATS_SYMBOLS) {
      try {
        const today = new Date();
        const dates = [];
        for (let i = 29; i >= 0; i--) {
          const d = new Date(today);
          d.setDate(today.getDate() - i);
          dates.push(d.toISOString().split('T')[0]);
        }
        const dailyResults = await Promise.all(dates.map(dt =>
          fetch(`${BRIDGE_URL}/v6/public/stats/daily?symbol=${sym}&dt=${dt}`)
            .then(r => r.ok ? r.json() : null)
            .then(json => json && json[sym] ? json[sym] : null)
            .catch(() => null)
        ));
        let total = 0, completed = 0, pending = 0, tp = 0, tp1 = 0, tp2 = 0, sl = 0, pnl = 0;
        for (const r of dailyResults) {
          if (!r) continue;
          total += r.total || 0; completed += r.completed || 0;
          pending += r.pending || 0; tp += r.tp || 0; sl += r.sl || 0;
          tp1 += r.tp1 || 0; tp2 += r.tp2 || 0;
          pnl += r.pnl_pips || 0;
        }
        const wr = completed > 0 ? Math.round((tp / completed) * 1000) / 10 : 0;
        pnl = Math.round(pnl * 100) / 100;
        _sigData[sym] = { sym, total, tp, tp1, tp2, sl, pending, wr, pnl };
      } catch (err) {
        _sigData[sym] = { sym, total: 0, tp: 0, tp1: 0, tp2: 0, sl: 0, pending: 0, wr: 0, pnl: 0 };
      }
    }
    _renderDashGrid();
  }

  async function fetchAllTradeStats() {
    for (const sym of ALL_STATS_SYMBOLS) {
      try {
        const [tsResp, sumResp] = await Promise.all([
          fetch(`${BRIDGE_URL}/v6/public/trades/daily-stats?symbol=${sym}&days=30`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${BRIDGE_URL}/v6/public/trades/${sym}/summary?days=30`).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        const ts = tsResp && tsResp[sym] ? tsResp[sym] : null;
        const stats = sumResp && sumResp.stats ? sumResp.stats : {};
        const pf = stats.profit_factor ?? stats.pf;
        _tradeData[sym] = {
          sym,
          positions: ts ? ts.positions : 0,
          wr: ts ? ts.win_rate : 0,
          wins: ts ? ts.wins : 0,
          losses: ts ? ts.losses : 0,
          pnl: ts ? ts.net_pnl : 0,
          pf: pf,
        };
      } catch (err) {
        _tradeData[sym] = { sym, positions: 0, wr: 0, wins: 0, losses: 0, pnl: 0, pf: null };
      }
    }
    _renderDashGrid();
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
    priceTP1.textContent   = (sig.tp1 != null && sig.tp1 !== 0) ? sig.tp1.toFixed(dec) : '--';
    priceTP2.textContent   = (sig.tp2 != null && sig.tp2 !== 0) ? sig.tp2.toFixed(dec) : '--';

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
    priceTP2.textContent = '--';
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
      } else if (outcome.startsWith('hit') || outcome.startsWith('TP')) {
        outcomeClass = 'buy';
      }
    }

    signalHistory.unshift({
      key,
      time:     sig.last_bar ? sig.last_bar.replace('T', ' ').substring(0, 16) : '--',
      symbol:   sig.symbol || currentSymbol,
      signal:   sig.signal,
      entry:    sig.price != null ? sig.price.toFixed(dec) : '--',
      sl:       (sig.sl != null && sig.sl !== 0)   ? sig.sl.toFixed(dec)  : 'Trail',
      tp1:      (sig.tp1 != null && sig.tp1 !== 0) ? sig.tp1.toFixed(dec) : '--',
      tp2:      (sig.tp2 != null && sig.tp2 !== 0) ? sig.tp2.toFixed(dec) : '--',
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
        <td>${h.tp2}</td>
        <td><span class="sig-badge ${h.outcomeClass}">${h.outcome === 'hitTp1' ? 'tp1' : h.outcome === 'hitTp2' ? 'tp2' : h.outcome}</span></td>
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
