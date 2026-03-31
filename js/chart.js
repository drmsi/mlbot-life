/**
 * MLBot Live — Chart Module
 * TradingView Lightweight Charts integration
 */

const ChartManager = (() => {
  let chart = null;
  let candleSeries = null;
  let slLine = null;
  let tp1Line = null;
  let tp2Line = null;
  let entryLine = null;
  let markers = [];
  let historyMarkers = [];
  let historySignals = [];  // raw signal data for tooltip lookup
  let currentSymbol = 'XAUUSD';

  const PRICE_DECIMALS = {
    XAUUSD: 2, BTCUSD: 2, ETHUSD: 2, EURUSD: 5,
    GBPUSD: 5, XAGUSD: 3, USDJPY: 3, BRENTCMDUSD: 2,
  };

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

    // Crosshair tooltip for history markers
    chart.subscribeCrosshairMove(param => {
      const tooltip = document.getElementById('signalTooltip');
      if (!tooltip || historySignals.length === 0) return;
      if (!param.time || !param.point) {
        tooltip.style.display = 'none';
        return;
      }
      // Find if crosshair time matches any history marker
      const match = historySignals.find(s => s._ts === param.time);
      if (!match) {
        tooltip.style.display = 'none';
        return;
      }
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
        <div class="tt-row"><span>Model</span><span>${match.model || '--'}</span></div>
        ${match.exit_price != null ? `<div class="tt-row"><span>Exit</span><span>${match.exit_price.toFixed(dec)}</span></div>` : ''}
      `;
      // Position tooltip near crosshair
      const chartRect = container.getBoundingClientRect();
      let left = param.point.x + chartRect.left + 16;
      let top = param.point.y + chartRect.top - 40;
      // Keep within viewport
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
    candleSeries.setData(candles);
    chart.timeScale().fitContent();
  }

  function addCandle(candle) {
    if (!candleSeries || !candle) return;
    candleSeries.update(candle);
  }

  function clearSignalLines() {
    if (slLine)    { candleSeries.removePriceLine(slLine);    slLine = null; }
    if (tp1Line)   { candleSeries.removePriceLine(tp1Line);   tp1Line = null; }
    if (tp2Line)   { candleSeries.removePriceLine(tp2Line);   tp2Line = null; }
    if (entryLine) { candleSeries.removePriceLine(entryLine); entryLine = null; }
  }

  function drawSignal(signal) {
    if (!candleSeries || !signal) return;
    clearSignalLines();

    const dir = signal.signal;
    if (dir !== 'BUY' && dir !== 'SELL') return;

    const dec = PRICE_DECIMALS[currentSymbol] || 2;
    const entryPrice = signal.price;
    const slPrice = signal.sl;
    const tp1Price = signal.tp;
    const tp2Price = signal.tp2;

    if (entryPrice) {
      entryLine = candleSeries.createPriceLine({
        price: entryPrice,
        color: '#6366f1',
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: 'Entry ' + entryPrice.toFixed(dec),
      });
    }
    if (slPrice) {
      slLine = candleSeries.createPriceLine({
        price: slPrice,
        color: '#ef4444',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'SL ' + slPrice.toFixed(dec),
      });
    }
    if (tp1Price) {
      tp1Line = candleSeries.createPriceLine({
        price: tp1Price,
        color: '#22c55e',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'TP1 ' + tp1Price.toFixed(dec),
      });
    }
    if (tp2Price) {
      tp2Line = candleSeries.createPriceLine({
        price: tp2Price,
        color: '#86efac',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true,
        title: 'TP2 ' + tp2Price.toFixed(dec),
      });
    }

    // Add marker on the last candle
    if (signal.last_bar) {
      const ts = Math.floor(new Date(signal.last_bar + (signal.last_bar.includes('Z') ? '' : 'Z')).getTime() / 1000);
      const marker = {
        time: ts,
        position: dir === 'BUY' ? 'belowBar' : 'aboveBar',
        color: dir === 'BUY' ? '#22c55e' : '#ef4444',
        shape: dir === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: dir,
      };
      // Keep last 50 markers
      markers.push(marker);
      if (markers.length > 50) markers = markers.slice(-50);
      _mergeAndSetMarkers();
    }
  }

  function drawHistoryMarkers(signals) {
    if (!candleSeries || !signals || signals.length === 0) {
      historyMarkers = [];
      historySignals = [];
      _mergeAndSetMarkers();
      return;
    }
    historySignals = [];
    historyMarkers = [];
    for (const s of signals) {
      if (!s.bar_time) continue;
      const ts = Math.floor(new Date(s.bar_time.replace(' ', 'T').replace(/\+00:00$/, 'Z').replace(/$/, s.bar_time.includes('Z') || s.bar_time.includes('+') ? '' : 'Z')).getTime() / 1000);
      const dir = s.direction || '';
      const outcome = s.outcome || '';
      const label = dir.substring(0, 1) + (outcome ? ' ' + outcome : '');
      const color = dir === 'BUY' ? '#22c55e' : '#ef4444';
      historyMarkers.push({
        time: ts,
        position: dir === 'BUY' ? 'belowBar' : 'aboveBar',
        color: color,
        shape: 'circle',
        text: label,
      });
      historySignals.push({ ...s, _ts: ts });
    }
    _mergeAndSetMarkers();
  }

  function _mergeAndSetMarkers() {
    if (!candleSeries) return;
    // Merge live markers + history markers, deduplicate by time+text
    const all = [...markers, ...historyMarkers];
    const unique = {};
    all.forEach(m => { unique[m.time + '_' + m.text] = m; });
    const sorted = Object.values(unique).sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(sorted);
  }

  function setSymbol(sym) {
    currentSymbol = sym;
    markers = [];
    historyMarkers = [];
    historySignals = [];
    clearSignalLines();
    if (candleSeries) {
      candleSeries.setData([]);
      candleSeries.setMarkers([]);
    }
    const tooltip = document.getElementById('signalTooltip');
    if (tooltip) tooltip.style.display = 'none';
  }

  return { init, setCandles, addCandle, drawSignal, drawHistoryMarkers, setSymbol, clearSignalLines };
})();
