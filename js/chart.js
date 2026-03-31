/**
 * DDD Signals — Chart Module
 * TradingView Lightweight Charts integration
 */

const ChartManager = (() => {
  let chart = null;
  let candleSeries = null;
  // Live signal price lines
  let slLine = null;
  let tp1Line = null;
  let tp2Line = null;
  let entryLine = null;
  // History signal price lines (for most recent pending)
  let histSlLine = null;
  let histTp1Line = null;
  let histTp2Line = null;
  let histEntryLine = null;

  let markers = [];
  let liveSignalTs = null;      // timestamp of current live signal (to deduplicate vs history)
  let liveSignalDir = null;     // direction of current live signal ('BUY'/'SELL')
  let historyMarkers = [];
  let historySignals = [];
  let currentSymbol = 'XAUUSD';
  let hasActiveSignal = false;
  let expandedTs = null;

  const PRICE_DECIMALS = {
    XAUUSD: 2, BTCUSD: 2, ETHUSD: 2, EURUSD: 5,
    GBPUSD: 5, XAGUSD: 3, USDJPY: 3, BRENTCMDUSD: 2,
  };

  const PRICE_MIN_MOVE = {
    XAUUSD: 0.01, BTCUSD: 0.01, ETHUSD: 0.01, EURUSD: 0.00001,
    GBPUSD: 0.00001, XAGUSD: 0.001, USDJPY: 0.001, BRENTCMDUSD: 0.01,
  };

  // Bright glow colors for pending/active history signals
  const GLOW_BUY  = '#86efac';  // bright green glow
  const GLOW_SELL = '#fca5a5';  // bright red glow

  function init(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    chart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: 'solid', color: '#161636' },
        textColor: '#8888aa',
        fontFamily: "'Inter', sans-serif",
        fontSize: 12,
      },
      grid: {
        vertLines: { color: 'rgba(42,42,90,0.4)' },
        horzLines: { color: 'rgba(42,42,90,0.4)' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: 'rgba(99,102,241,0.3)', labelBackgroundColor: '#6366f1' },
        horzLine: { color: 'rgba(99,102,241,0.3)', labelBackgroundColor: '#6366f1' },
      },
      rightPriceScale: {
        borderColor: '#2a2a5a',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: '#2a2a5a',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
      },
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
      handleScroll: { vertTouchDrag: true },
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e88',
      wickDownColor: '#ef444488',
    });

    // Click handler for history marker expansion
    chart.subscribeClick(param => {
      const tooltip = document.getElementById('signalTooltip');
      if (!tooltip) return;

      if (!param.time || !param.point || historySignals.length === 0) {
        tooltip.style.display = 'none';
        expandedTs = null;
        return;
      }

      // Find nearest history marker within 3 bars (900s for M5)
      const SNAP_SEC = 900;
      let match = null;
      let bestDist = Infinity;
      for (const s of historySignals) {
        const dist = Math.abs(s._ts - param.time);
        if (dist < bestDist && dist <= SNAP_SEC) {
          bestDist = dist;
          match = s;
        }
      }
      if (!match) {
        tooltip.style.display = 'none';
        expandedTs = null;
        return;
      }

      // Toggle: click same marker again to close
      if (expandedTs === match._ts) {
        tooltip.style.display = 'none';
        expandedTs = null;
        return;
      }

      expandedTs = match._ts;
      const dec = PRICE_DECIMALS[currentSymbol] || 2;
      const outcomeText = match.outcome || 'Pending';
      const outcomeClass = match.outcome === 'SL' ? 'sell'
        : (match.outcome && match.outcome.startsWith('TP')) ? 'buy' : 'hold';
      tooltip.innerHTML = `
        <div class="tt-header">
          <span class="sig-badge ${match.direction.toLowerCase()}">${match.direction}</span>
          <span class="sig-badge ${outcomeClass}">${outcomeText}</span>
        </div>
        <div class="tt-row"><span>Entry</span><span>${match.price != null ? match.price.toFixed(dec) : '--'}</span></div>
        <div class="tt-row"><span>SL</span><span>${match.sl != null ? match.sl.toFixed(dec) : '--'}</span></div>
        <div class="tt-row"><span>TP1</span><span>${match.tp1 != null ? match.tp1.toFixed(dec) : '--'}</span></div>
        <div class="tt-row"><span>TP2</span><span>${match.tp2 != null ? match.tp2.toFixed(dec) : '--'}</span></div>
        <div class="tt-row"><span>ATR</span><span>${match.atr != null ? match.atr : '--'}</span></div>
        <div class="tt-row"><span>Model</span><span>${match.model || '--'}</span></div>
        ${match.exit_price != null ? `<div class="tt-row"><span>Exit</span><span>${match.exit_price.toFixed(dec)}</span></div>` : ''}
      `;
      const chartRect = container.getBoundingClientRect();
      let left = param.point.x + chartRect.left + 16;
      let top = param.point.y + chartRect.top - 60;
      if (left + 220 > window.innerWidth) left = param.point.x + chartRect.left - 230;
      if (top < 0) top = 10;
      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
      tooltip.style.display = 'block';
    });

    // Responsive resize
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        chart.applyOptions({ width, height });
      }
    });
    ro.observe(container);
  }

  function setCandles(candles) {
    if (!candleSeries || !candles || candles.length === 0) return;
    const dec = PRICE_DECIMALS[currentSymbol] || 2;
    const minMove = PRICE_MIN_MOVE[currentSymbol] || 0.01;
    candleSeries.applyOptions({
      priceFormat: { type: 'price', precision: dec, minMove: minMove },
    });
    candleSeries.setData(candles);
    _mergeAndSetMarkers();
    candleSeries.priceScale().applyOptions({ autoScale: true });
    chart.timeScale().fitContent();
  }

  function addCandle(candle) {
    if (!candleSeries || !candle) return;
    candleSeries.update(candle);
  }

  function clearSignalLines() {
    try { if (slLine)    { candleSeries.removePriceLine(slLine); } } catch(e) {}
    try { if (tp1Line)   { candleSeries.removePriceLine(tp1Line); } } catch(e) {}
    try { if (tp2Line)   { candleSeries.removePriceLine(tp2Line); } } catch(e) {}
    try { if (entryLine) { candleSeries.removePriceLine(entryLine); } } catch(e) {}
    slLine = null; tp1Line = null; tp2Line = null; entryLine = null;
    hasActiveSignal = false;
  }

  function _clearHistoryPriceLines() {
    try { if (histSlLine)    { candleSeries.removePriceLine(histSlLine); } } catch(e) {}
    try { if (histTp1Line)   { candleSeries.removePriceLine(histTp1Line); } } catch(e) {}
    try { if (histTp2Line)   { candleSeries.removePriceLine(histTp2Line); } } catch(e) {}
    try { if (histEntryLine) { candleSeries.removePriceLine(histEntryLine); } } catch(e) {}
    histSlLine = null; histTp1Line = null; histTp2Line = null; histEntryLine = null;
  }

  function _drawPriceLines(sig, prefix) {
    if (!candleSeries) return;
    const dec = PRICE_DECIMALS[currentSymbol] || 2;
    const isHist = (prefix === 'hist');
    // Slightly dimmer style for history price lines
    const entryColor = isHist ? '#818cf8' : '#6366f1';
    const entryWidth = isHist ? 1 : 2;

    if (sig.price != null) {
      const line = candleSeries.createPriceLine({
        price: sig.price, color: entryColor, lineWidth: entryWidth,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true, title: 'Entry ' + sig.price.toFixed(dec),
      });
      if (isHist) histEntryLine = line; else entryLine = line;
    }
    if (sig.sl != null) {
      const line = candleSeries.createPriceLine({
        price: sig.sl, color: '#ef4444', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true, title: 'SL ' + sig.sl.toFixed(dec),
      });
      if (isHist) histSlLine = line; else slLine = line;
    }
    if (sig.tp1 != null) {
      const line = candleSeries.createPriceLine({
        price: sig.tp1, color: '#22c55e', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true, title: 'TP1 ' + sig.tp1.toFixed(dec),
      });
      if (isHist) histTp1Line = line; else tp1Line = line;
    }
    if (sig.tp2 != null) {
      const line = candleSeries.createPriceLine({
        price: sig.tp2, color: '#86efac', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true, title: 'TP2 ' + sig.tp2.toFixed(dec),
      });
      if (isHist) histTp2Line = line; else tp2Line = line;
    }
  }

  function drawSignal(signal) {
    if (!candleSeries || !signal) return;
    clearSignalLines();

    const dir = signal.signal;
    if (dir !== 'BUY' && dir !== 'SELL') {
      // No active live signal — let history draw its own price lines
      return;
    }

    hasActiveSignal = true;
    _clearHistoryPriceLines();

    _drawPriceLines({ price: signal.price, sl: signal.sl, tp1: signal.tp, tp2: signal.tp2 }, 'live');

    // Single arrow marker for the current live signal (replaces any previous)
    markers = [];
    liveSignalTs = null;
    liveSignalDir = dir;
    if (signal.last_bar) {
      const ts = Math.floor(new Date(signal.last_bar + (signal.last_bar.includes('Z') ? '' : 'Z')).getTime() / 1000);
      liveSignalTs = ts;
      markers = [{
        time: ts,
        position: dir === 'BUY' ? 'belowBar' : 'aboveBar',
        color: dir === 'BUY' ? '#22c55e' : '#ef4444',
        shape: dir === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: dir,
      }];
    }
    _mergeAndSetMarkers();
  }

  function drawHistoryMarkers(signals) {
    _clearHistoryPriceLines();

    if (!candleSeries || !signals || signals.length === 0) {
      historyMarkers = [];
      historySignals = [];
      _mergeAndSetMarkers();
      return;
    }

    historySignals = [];
    historyMarkers = [];

    // Build markers — all history signals are circle dots, skip if same as live signal
    for (const s of signals) {
      if (!s.bar_time) continue;
      let isoTime = s.bar_time.replace(' ', 'T');
      if (!isoTime.includes('Z') && !isoTime.includes('+')) isoTime += 'Z';
      const ts = Math.floor(new Date(isoTime).getTime() / 1000);
      // Skip if this is the same bar AND same direction as the live signal
      if (liveSignalTs && ts === liveSignalTs && dir === liveSignalDir) continue;
      const dir = s.direction || '';
      const isPending = (s.outcome === null || s.outcome === undefined);

      historyMarkers.push({
        time: ts,
        position: dir === 'BUY' ? 'belowBar' : 'aboveBar',
        color: isPending ? (dir === 'BUY' ? GLOW_BUY : GLOW_SELL)
                         : (dir === 'BUY' ? '#22c55e' : '#ef4444'),
        shape: 'circle',
        text: '',
      });
      historySignals.push({ ...s, _ts: ts });
    }

    _mergeAndSetMarkers();
  }

  function _mergeAndSetMarkers() {
    if (!candleSeries) return;
    const all = [...markers, ...historyMarkers];
    // Live arrows take precedence over history circles on same bar+position
    const arrowKeys = new Set();
    for (const m of all) {
      if (m.shape !== 'circle') arrowKeys.add(m.time + '_' + m.position);
    }
    const filtered = all.filter(m => {
      if (m.shape === 'circle' && arrowKeys.has(m.time + '_' + m.position)) return false;
      return true;
    });
    filtered.sort((a, b) => a.time - b.time);
    try {
      candleSeries.setMarkers(filtered);
    } catch(e) {}
  }

  function setSymbol(sym) {
    currentSymbol = sym;
    markers = [];
    historyMarkers = [];
    historySignals = [];
    hasActiveSignal = false;
    expandedTs = null;
    liveSignalTs = null;
    liveSignalDir = null;
    slLine = null; tp1Line = null; tp2Line = null; entryLine = null;
    histSlLine = null; histTp1Line = null; histTp2Line = null; histEntryLine = null;
    if (candleSeries) {
      candleSeries.setData([]);
      candleSeries.setMarkers([]);
    }
    const tooltip = document.getElementById('signalTooltip');
    if (tooltip) tooltip.style.display = 'none';
  }

  return { init, setCandles, addCandle, drawSignal, drawHistoryMarkers, setSymbol, clearSignalLines };
})();
