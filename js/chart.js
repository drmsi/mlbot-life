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
      // De-duplicate by time
      const unique = {};
      markers.forEach(m => { unique[m.time + '_' + m.text] = m; });
      const sorted = Object.values(unique).sort((a, b) => a.time - b.time);
      candleSeries.setMarkers(sorted);
    }
  }

  function setSymbol(sym) {
    currentSymbol = sym;
    markers = [];
    clearSignalLines();
    if (candleSeries) {
      candleSeries.setData([]);
      candleSeries.setMarkers([]);
    }
  }

  return { init, setCandles, addCandle, drawSignal, setSymbol, clearSignalLines };
})();
