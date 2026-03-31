/**
 * MLBot Live — Main Application
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
  let connected     = false;

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

  // ── Init ────────────────────────────────────────────────────────────
  function init() {
    ChartManager.init('chartContainer');
    bindSymbolButtons();
    switchSymbol('XAUUSD');
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

  function switchSymbol(sym) {
    currentSymbol = sym;
    const mySwitch = ++switchId;  // capture switch generation
    chartSymbol.textContent = sym;
    chartLastBar.textContent = '--';
    ChartManager.setSymbol(sym);
    resetSignalPanel();
    // Reset timers immediately
    clearInterval(pollTimer);
    clearInterval(candleTimer);
    clearInterval(historyTimer);
    // Fetch candles first, then signal + history — all guarded by switchId
    fetchCandles(mySwitch).then(() => {
      if (switchId !== mySwitch) return;  // symbol changed while fetching
      fetchSignal(mySwitch);
      fetchHistory(mySwitch);
    });
    pollTimer    = setInterval(() => fetchSignal(switchId),  POLL_INTERVAL_MS);
    candleTimer  = setInterval(() => fetchCandles(switchId), CANDLE_POLL_MS);
    historyTimer = setInterval(() => fetchHistory(switchId), CANDLE_POLL_MS);
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
        setConnected(true);
      }
    } catch (err) {
      console.warn('Candle fetch error:', err.message);
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
      updateSignalPanel(sig);
      ChartManager.drawSignal(sig);

      // Add to history if it's a BUY/SELL
      if (sig.signal === 'BUY' || sig.signal === 'SELL') {
        addToHistory(sig);
      }
    } catch (err) {
      console.warn('Signal fetch error:', err.message);
      setConnected(false);
    }
  }

  // ── Fetch History ──────────────────────────────────────────────────
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
    priceSL.textContent    = sig.sl != null    ? sig.sl.toFixed(dec) : '--';
    priceTP1.textContent   = sig.tp != null    ? sig.tp.toFixed(dec) : '--';
    priceTP2.textContent   = sig.tp2 != null   ? sig.tp2.toFixed(dec) : '--';

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
    signalHistory.unshift({
      key,
      time:     sig.last_bar ? sig.last_bar.replace('T', ' ').substring(0, 16) : '--',
      symbol:   sig.symbol || currentSymbol,
      signal:   sig.signal,
      entry:    sig.price != null ? sig.price.toFixed(dec) : '--',
      sl:       sig.sl != null ? sig.sl.toFixed(dec) : '--',
      tp1:      sig.tp != null ? sig.tp.toFixed(dec) : '--',
      tp2:      sig.tp2 != null ? sig.tp2.toFixed(dec) : '--',
      strength: sig.strength_label || '--',
    });

    if (signalHistory.length > MAX_HISTORY) signalHistory = signalHistory.slice(0, MAX_HISTORY);
    renderHistory();
  }

  function renderHistory() {
    if (signalHistory.length === 0) {
      historyBody.innerHTML = '<tr class="empty-row"><td colspan="8">Waiting for signals...</td></tr>';
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
