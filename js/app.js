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
  let connected     = false;
  let backfilledSymbols = new Set(); // Track which symbols have been backfilled

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
          localStorage.setItem('ddd_tracked_signals', JSON.stringify(trackedSignals.slice(0, 50)));
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
          localStorage.setItem('ddd_tracked_signals', JSON.stringify(trackedSignals.slice(0, 50)));
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

          // For BUY signal
          if (signal.direction === 'BUY') {
            // Check SL first (stop loss takes priority)
            if (signal.sl != null && signal.sl !== 0) {
              if (candle.low <= signal.sl) {
                debugLog('HIT_SL', `BUY signal hit SL at ${signal.sl}`, {
                  candle_low: candle.low,
                  bar_time: candle.time
                });
                return { outcome: 'SL', bar_time: candle.time };
              }
            }
            // Check TP1
            if (signal.tp1 != null && signal.tp1 !== 0) {
              if (candle.high >= signal.tp1) {
                debugLog('HIT_TP1', `BUY signal hit TP1 at ${signal.tp1}`, {
                  candle_high: candle.high,
                  bar_time: candle.time
                });
                // Continue checking for TP2
                // Check TP2 in same or later candles
                for (let j = i; j < candles.length; j++) {
                  if (candles[j].high >= signal.tp2 && signal.tp2 != null && signal.tp2 !== 0) {
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
          }
          // For SELL signal
          else if (signal.direction === 'SELL') {
            // Check SL first
            if (signal.sl != null && signal.sl !== 0) {
              if (candle.high >= signal.sl) {
                debugLog('HIT_SL', `SELL signal hit SL at ${signal.sl}`, {
                  candle_high: candle.high,
                  bar_time: candle.time
                });
                return { outcome: 'SL', bar_time: candle.time };
              }
            }
            // Check TP1
            if (signal.tp1 != null && signal.tp1 !== 0) {
              if (candle.low <= signal.tp1) {
                debugLog('HIT_TP1', `SELL signal hit TP1 at ${signal.tp1}`, {
                  candle_low: candle.low,
                  bar_time: candle.time
                });
                // Continue checking for TP2
                for (let j = i; j < candles.length; j++) {
                  if (candles[j].low <= signal.tp2 && signal.tp2 != null && signal.tp2 !== 0) {
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
  const kpiAvgSlots    = $('kpiAvgSlots');

  // ── Init ────────────────────────────────────────────────────────────
  async function init() {
    ChartManager.init('chartContainer');
    bindSymbolButtons();
    await switchSymbol('XAUUSD');
  }

  function bindSymbolButtons() {
    document.querySelectorAll('.sym-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sym-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        switchSymbol(btn.dataset.symbol);
      });
    });
  }

  async function switchSymbol(sym) {
    currentSymbol = sym;
    const mySwitch = ++switchId;  // capture switch generation
    chartSymbol.textContent = sym;
    chartLastBar.textContent = '--';
    ChartManager.setSymbol(sym);
    resetSignalPanel();

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
    fetchStats(mySwitch);
    fetchTradeStats(mySwitch);
    fetchCandles(mySwitch).then(() => {
      if (switchId !== mySwitch) return;  // symbol changed while fetching
      fetchSignal(mySwitch);
      fetchHistory(mySwitch);
      fetchTradeHistory(mySwitch);
    });
    pollTimer    = setInterval(() => fetchSignal(switchId),  POLL_INTERVAL_MS);
    candleTimer  = setInterval(() => fetchCandles(switchId), CANDLE_POLL_MS);
    historyTimer = setInterval(() => fetchHistory(switchId), CANDLE_POLL_MS);
    tradeTimer   = setInterval(() => { fetchTradeHistory(switchId); fetchTradeStats(switchId); }, CANDLE_POLL_MS);
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
      setConnected(false);
    }
  }

  // ── Fetch History ──────────────────────────────────────────────────
  // ── Backfill SignalTracker with Historical Signals ─────────────
  async function backfillSignalTracker(sym, days = 30) {
    try {
      // Calculate timestamp for 30 days ago
      const thirtyDaysAgo = Math.floor((Date.now() / 1000) - (days * 24 * 60 * 60));

      // Fetch historical signals with reasonable limit
      // Try different limits if 422 error occurs
      let data = null;
      let limit = 200;
      const maxRetries = 3;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const url = `${BRIDGE_URL}/v4/public/signals/${sym}/history?limit=${limit}`;
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

      // Filter signals to last 30 days
      const recentSignals = data.signals.filter(s => {
        const signalTs = SignalTracker.parseTime(s.bar_time);
        return signalTs >= thirtyDaysAgo;
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
          price: s.entry,
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
    try {
      const sym = currentSymbol;

      // Use tracked stats from SignalTracker for original signal outcomes
      const trackedStats = SignalTracker.getStats(sym);

      kpiSignals.textContent = trackedStats.total;
      kpiWR.textContent = trackedStats.win_rate + '%';
      kpiTP.textContent = trackedStats.tp;
      kpiSL.textContent = trackedStats.sl;
      kpiPending.textContent = trackedStats.pending;

      // Calculate PnL based on tracked outcomes
      let pnlPips = 0;
      const history = SignalTracker.getHistory(sym, 100);
      for (const sig of history) {
        if (sig.outcome === 'TP1') {
          const pipDiff = Math.abs(sig.tp1 - sig.entry);
          pnlPips += sig.direction === 'BUY' ? pipDiff : -pipDiff;
        } else if (sig.outcome === 'TP2') {
          const pipDiff = Math.abs(sig.tp2 - sig.entry);
          pnlPips += sig.direction === 'BUY' ? pipDiff : -pipDiff;
        } else if (sig.outcome === 'SL') {
          const pipDiff = Math.abs(sig.sl - sig.entry);
          pnlPips += sig.direction === 'BUY' ? -pipDiff : pipDiff;
        }
      }
      kpiPnL.textContent = (pnlPips >= 0 ? '+' : '') + pnlPips.toFixed(1);

      // Color coding
      const wrEl = kpiWR.parentElement;
      wrEl.className = 'stats-kpi ' + (trackedStats.win_rate >= 50 ? 'kpi-wr-good' : 'kpi-wr-bad');
      const pnlEl = kpiPnL.parentElement;
      pnlEl.className = 'stats-kpi ' + (pnlPips >= 0 ? 'kpi-pnl-pos' : 'kpi-pnl-neg');

      SignalTracker.debugLog('STATS_UPDATE', `Updated stats for ${sym}`, {
        total: trackedStats.total,
        win_rate: trackedStats.win_rate,
        tp: trackedStats.tp,
        sl: trackedStats.sl,
        pending: trackedStats.pending,
        pnl_pips: pnlPips
      });
    } catch (err) {
      console.error('[fetchStats] Error:', err.message);
      SignalTracker.errorLog('FETCH_STATS', `Failed to fetch stats for ${currentSymbol}`, err);
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
      if (!ts) return;
      kpiPositions.textContent = ts.positions;
      kpiTradeWR.textContent = ts.win_rate + '%';
      kpiTradeWins.textContent = ts.wins;
      kpiTradeLosses.textContent = ts.losses;
      kpiTradePnL.textContent = (ts.net_pnl >= 0 ? '+$' : '-$') + Math.abs(ts.net_pnl).toFixed(2);
      kpiAvgSlots.textContent = ts.avg_slots;
      // Color coding
      const wrEl = kpiTradeWR.parentElement;
      wrEl.className = 'stats-kpi ' + (ts.win_rate >= 50 ? 'kpi-trade-wr-good' : 'kpi-trade-wr-bad');
      const pnlEl = kpiTradePnL.parentElement;
      pnlEl.className = 'stats-kpi ' + (ts.net_pnl >= 0 ? 'kpi-trade-pnl-pos' : 'kpi-trade-pnl-neg');
      // Hide row if no positions
      const row = $('tradeStatsRow');
      if (row) row.style.display = ts.positions > 0 ? '' : 'none';
    } catch (err) {
      console.warn('Trade stats fetch error:', err.message);
    }
  }

  // ── Update Signal Panel ─────────────────────────────────────────────
  function updateSignalPanel(sig) {
    const dir = sig.signal || 'HOLD';
    sigDir.textContent = dir;
    sigDir.className = 'signal-direction ' + dir.toLowerCase();

    sigStr.textContent = sig.strength_bars || '';
    sigModel.textContent = sig.model_used || '--';
    sigAge.textContent = sig.signal_age_sec != null
      ? formatAge(sig.signal_age_sec) + ' ago'
      : '--';

    const dec = getDecimals(currentSymbol);
    priceEntry.textContent = sig.price != null ? sig.price.toFixed(dec) : '--';
    priceSL.textContent    = (sig.sl != null && sig.sl !== 0)  ? sig.sl.toFixed(dec)  : (dir !== 'HOLD' ? 'Trail' : '--');
    priceTP1.textContent   = (sig.tp != null && sig.tp !== 0)  ? sig.tp.toFixed(dec)  : (dir !== 'HOLD' ? 'Trail' : '--');
    priceTP2.textContent   = (sig.tp2 != null && sig.tp2 !== 0) ? sig.tp2.toFixed(dec) : (dir !== 'HOLD' ? 'Trail' : '--');

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
      tp2:      (sig.tp2 != null && sig.tp2 !== 0) ? sig.tp2.toFixed(dec) : 'Trail',
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
