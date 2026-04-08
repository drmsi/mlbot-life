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
  let tradeMarkers = [];
  let tradeRecords = [];
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
        rightOffset: 60,
      },
      handleScale: { axisPressedMouseMove: true, mouseWheel: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
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

      if (!param.time || !param.point || (historySignals.length === 0 && tradeRecords.length === 0)) {
        tooltip.style.display = 'none';
        expandedTs = null;
        _clearHistoryPriceLines();
        return;
      }

      // Find nearest trade marker within 3 bars (900s for M5)
      const SNAP_SEC = 900;
      let tradeMatch = null;
      let tradeDist = Infinity;
      for (const tr of tradeRecords) {
        const dist = Math.abs(tr._ts - param.time);
        if (dist < tradeDist && dist <= SNAP_SEC) {
          tradeDist = dist;
          tradeMatch = tr;
        }
      }

      // Find nearest history marker within 3 bars
      let match = null;
      let bestDist = Infinity;
      for (const s of historySignals) {
        const dist = Math.abs(s._ts - param.time);
        if (dist < bestDist && dist <= SNAP_SEC) {
          bestDist = dist;
          match = s;
        }
      }

      // Trade marker takes priority if closer
      if (tradeMatch && tradeDist <= bestDist) {
        _showTradeTooltip(tradeMatch, param, container, tooltip);
        return;
      }

      if (!match) {
        tooltip.style.display = 'none';
        expandedTs = null;
        _clearHistoryPriceLines();
        return;
      }

      // Toggle: click same marker again to close
      if (expandedTs === match._ts) {
        tooltip.style.display = 'none';
        expandedTs = null;
        _clearHistoryPriceLines();
        return;
      }

      expandedTs = match._ts;
      // Redraw price lines for the clicked signal (clear previous history lines first)
      _clearHistoryPriceLines();
      if (!hasActiveSignal) {
        _drawPriceLines({ price: match.price, sl: match.sl, tp1: match.tp1, tp2: match.tp2 }, 'hist');
      }
      const dec = PRICE_DECIMALS[currentSymbol] || 2;
      const outcomeText = match.outcome || 'Pending';
      const outcomeClass = match.outcome === 'SL' ? 'sell'
        : (match.outcome && (match.outcome.startsWith('hit') || match.outcome.startsWith('TP'))) ? 'buy' : 'hold';
      tooltip.innerHTML = `
        <div class="tt-header">
          <span class="sig-badge ${match.direction.toLowerCase()}">${match.direction}</span>
          <span class="sig-badge ${outcomeClass}">${outcomeText}</span>
        </div>
        <div class="tt-row"><span>Entry</span><span>${match.price != null ? match.price.toFixed(dec) : '--'}</span></div>
        <div class="tt-row"><span>SL</span><span>${match.sl != null ? match.sl.toFixed(dec) : '--'}</span></div>
        <div class="tt-row"><span>tp1</span><span>${match.tp1 != null ? match.tp1.toFixed(dec) : '--'}</span></div>
        <div class="tt-row"><span>tp2</span><span>${match.tp2 != null ? match.tp2.toFixed(dec) : '--'}</span></div>
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

    // Allow horizontal wheel scroll on chart, pass vertical scroll to page
    container.addEventListener('wheel', e => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault(); // horizontal — let chart handle it
      }
      // vertical — do nothing, page scrolls normally
    }, { passive: false });

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
    // Show last 30 bars zoomed in, shifted left
    if (candles.length > 0) {
      const fromIdx = Math.max(0, candles.length - 30);
      chart.timeScale().setVisibleRange({
        from: candles[fromIdx].time,
        to: candles[candles.length - 1].time,
      });
    } else {
      chart.timeScale().fitContent();
    }
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
    if (sig.tp1 != null && sig.tp1 !== 0) {
      const line = candleSeries.createPriceLine({
        price: sig.tp1, color: '#22c55e', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true, title: 'tp1 ' + sig.tp1.toFixed(dec),
      });
      if (isHist) histTp1Line = line; else tp1Line = line;
    }
    if (sig.tp2 != null && sig.tp2 !== 0) {
      const line = candleSeries.createPriceLine({
        price: sig.tp2, color: '#4ade80', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true, title: 'tp2 ' + sig.tp2.toFixed(dec),
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

    _drawPriceLines({ price: signal.price, sl: signal.sl, tp1: signal.tp1, tp2: signal.tp2 }, 'live');

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

    // Close tooltip on refresh
    const tooltip = document.getElementById('signalTooltip');
    if (tooltip) tooltip.style.display = 'none';

    if (!candleSeries || !signals || signals.length === 0) {
      historyMarkers = [];
      historySignals = [];
      expandedTs = null;
      _mergeAndSetMarkers();
      return;
    }

    historySignals = [];
    historyMarkers = [];

    // Parse all history signals first
    const parsed = [];
    for (const s of signals) {
      if (!s.bar_time) continue;
      let isoTime = s.bar_time.replace(' ', 'T');
      if (!isoTime.includes('Z') && !isoTime.includes('+')) isoTime += 'Z';
      const ts = Math.floor(new Date(isoTime).getTime() / 1000);
      const dir = s.direction || '';
      // Skip if this is the same bar AND same direction as the live signal
      if (liveSignalTs && ts === liveSignalTs && dir === liveSignalDir) continue;
      parsed.push({ sig: s, ts, dir });
    }

    // Find the latest (most recent) signal by timestamp
    let latestTs = -Infinity;
    for (const p of parsed) {
      if (p.ts > latestTs) latestTs = p.ts;
    }

    // Find the single latest entry (first max-ts hit only — avoids two arrows on same bar)
    let latestIdx = -1;
    for (let i = 0; i < parsed.length; i++) {
      if (parsed[i].ts === latestTs && latestIdx === -1) latestIdx = i;
    }

    // Build markers — latest signal gets arrow + auto-expand, rest get small circles
    for (let i = 0; i < parsed.length; i++) {
      const { sig: s, ts, dir } = parsed[i];
      const isPending = (s.outcome === null || s.outcome === undefined);
      const isLatest = (i === latestIdx);

      historyMarkers.push({
        time: ts,
        position: dir === 'BUY' ? 'belowBar' : 'aboveBar',
        color: isPending ? (dir === 'BUY' ? GLOW_BUY : GLOW_SELL)
                         : (dir === 'BUY' ? '#22c55e' : '#ef4444'),
        shape: isLatest ? (dir === 'SELL' ? 'arrowDown' : 'arrowUp') : 'circle',
        text: isLatest ? dir : '',
      });
      historySignals.push({ ...s, _ts: ts });
    }

    // Auto-expand latest signal: draw its price lines (unless live signal is active)
    if (!hasActiveSignal && latestTs > -Infinity) {
      const latestSig = parsed.find(p => p.ts === latestTs);
      if (latestSig) {
        expandedTs = latestTs;
        const s = latestSig.sig;
        _drawPriceLines({ price: s.price, sl: s.sl, tp1: s.tp1, tp2: s.tp2 }, 'hist');
      }
    } else {
      expandedTs = null;
    }

    _mergeAndSetMarkers();
  }

  function _showTradeTooltip(trade, param, container, tooltip) {
    expandedTs = null;
    _clearHistoryPriceLines();
    const dec = PRICE_DECIMALS[currentSymbol] || 2;
    const dir = trade.direction === 1 ? 'BUY' : 'SELL';
    const dirClass = dir.toLowerCase();
    const pnl = typeof trade.net_profit === 'number' ? trade.net_profit : 0;
    const profitable = pnl >= 0;
    const pnlClass = profitable ? 'tt-pnl-buy' : 'tt-pnl-sell';
    const pnlText = (profitable ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
    const reason = trade.close_reason || '--';
    const isExit = trade._isExit;
    const entryP = typeof trade.entry_price === 'number' ? trade.entry_price.toFixed(dec) : '--';
    const exitP = typeof trade.exit_price === 'number' ? trade.exit_price.toFixed(dec) : '--';

    // Duration
    let duration = '--';
    if (trade.entry_time && trade.exit_time) {
      try {
        let eIso = trade.entry_time.replace(' ', 'T');
        if (!eIso.includes('Z') && !eIso.includes('+')) eIso += 'Z';
        let xIso = trade.exit_time.replace(' ', 'T');
        if (!xIso.includes('Z') && !xIso.includes('+')) xIso += 'Z';
        const diffMs = new Date(xIso).getTime() - new Date(eIso).getTime();
        if (diffMs > 0 && diffMs < 86400000) {
          const mins = Math.round(diffMs / 60000);
          duration = mins >= 60 ? Math.round(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm';
        }
      } catch(e) {}
    }

    const reasonClass = reason === 'manual' ? 'hold' : (profitable ? 'buy' : 'sell');
    tooltip.innerHTML = `
      <div class="tt-header">
        <span class="sig-badge ${dirClass}">${dir}</span>
        <span class="sig-badge trade-badge">TRADE</span>
        <span class="sig-badge ${reasonClass}">${reason.toUpperCase()}</span>
      </div>
      <div class="tt-row"><span>Entry</span><span>${entryP}</span></div>
      <div class="tt-row"><span>Exit</span><span>${exitP}</span></div>
      <div class="tt-row"><span>P&L</span><span class="${pnlClass}">${pnlText}</span></div>
      <div class="tt-row"><span>Lots</span><span>${trade.total_lots || '--'}</span></div>
      <div class="tt-row"><span>Slots</span><span>${trade.slots_filled || 1}</span></div>
      <div class="tt-row"><span>Duration</span><span>${duration}</span></div>
    `;
    const chartRect = container.getBoundingClientRect();
    let left = param.point.x + chartRect.left + 16;
    let top = param.point.y + chartRect.top - 60;
    if (left + 220 > window.innerWidth) left = param.point.x + chartRect.left - 230;
    if (top < 0) top = 10;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
    tooltip.style.display = 'block';
  }

  function drawTradeMarkers(trades) {
    if (!candleSeries || !trades || trades.length === 0) {
      tradeMarkers = [];
      tradeRecords = [];
      _mergeAndSetMarkers();
      return;
    }

    tradeMarkers = [];
    tradeRecords = [];

    for (const t of trades) {
      const dir = t.direction === 1 ? 'BUY' : 'SELL';
      const pos = dir === 'BUY' ? 'belowBar' : 'aboveBar';
      const pnl = typeof t.net_profit === 'number' ? t.net_profit : 0;
      // Skip corrupt records (absurd values from data corruption)
      if (Math.abs(pnl) > 1e6) continue;
      const profitable = pnl >= 0;

      // Single marker per group at exit bar — green=profit, red=loss, amber=manual
      if (t.exit_time) {
        let iso = t.exit_time.replace(' ', 'T');
        if (!iso.includes('Z') && !iso.includes('+')) iso += 'Z';
        const exitTs = Math.floor(new Date(iso).getTime() / 1000);
        const absPnl = Math.abs(pnl);
        const pnlLabel = absPnl >= 1 ? Math.round(absPnl) : absPnl.toFixed(2);
        const pnlText = (profitable ? '+$' : '-$') + pnlLabel;
        const isManual = (t.close_reason === 'manual');
        const markerColor = isManual ? '#f59e0b' : (profitable ? '#22c55e' : '#ef4444');
        tradeMarkers.push({
          time: exitTs,
          position: pos,
          color: markerColor,
          shape: 'square',
          text: pnlText,
        });
        tradeRecords.push({ ...t, _ts: exitTs, _isExit: true });
      }
    }

    _mergeAndSetMarkers();
  }

  function _mergeAndSetMarkers() {
    if (!candleSeries) return;

    // Priority: live markers > history markers > trade squares (always shown)
    // At each time+position slot only ONE non-square marker is kept.
    const liveKeys = new Set(markers.map(m => m.time + '_' + m.position));
    const arrowKeys = new Set();
    for (const m of [...markers, ...historyMarkers]) {
      if (m.shape !== 'circle') arrowKeys.add(m.time + '_' + m.position);
    }

    const seen = new Set();  // tracks filled time+position slots
    const filtered = [];

    for (const m of [...markers, ...historyMarkers, ...tradeMarkers]) {
      if (m.shape === 'square') { filtered.push(m); continue; }         // trades always in
      if (m.shape === 'circle' && arrowKeys.has(m.time + '_' + m.position)) continue; // circle behind arrow
      const slot = m.time + '_' + m.position;
      if (seen.has(slot)) continue;  // already have an arrow here (live wins, being first)
      seen.add(slot);
      filtered.push(m);
    }

    filtered.sort((a, b) => a.time - b.time);
    try { candleSeries.setMarkers(filtered); } catch(e) {}
  }

  function setSymbol(sym) {
    currentSymbol = sym;
    markers = [];
    historyMarkers = [];
    historySignals = [];
    tradeMarkers = [];
    tradeRecords = [];
    expandedTs = null;
    liveSignalTs = null;
    liveSignalDir = null;
    // Remove price lines from chart BEFORE nulling refs (prevents ghost lines on symbol switch)
    clearSignalLines();
    _clearHistoryPriceLines();
    if (candleSeries) {
      candleSeries.setData([]);
      candleSeries.setMarkers([]);
    }
    const tooltip = document.getElementById('signalTooltip');
    if (tooltip) tooltip.style.display = 'none';
  }

  return { init, setCandles, addCandle, drawSignal, drawHistoryMarkers, drawTradeMarkers, setSymbol, clearSignalLines };
})();
