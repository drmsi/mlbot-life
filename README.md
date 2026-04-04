# DDD Signals - Trading Dashboard

Real-time AI-powered trading signals dashboard with comprehensive signal tracking and execution statistics.

## Features

### 🎯 Original Signal Tracking
- **Client-side price action monitoring**: Tracks original signal outcomes (TP1/TP2/SL hits) based on candle price data
- **Independent of trade execution**: Shows what the original signal would have achieved, regardless of trading mode (trail-only vs. TP-based)
- **Real-time updates**: Automatically checks pending signals against new candle data
- **Persistent storage**: Uses localStorage to maintain signal history across page refreshes

### 📊 Dual Statistics Dashboards

#### 1. Original Signal Statistics
- **Total Signals**: Number of tracked signals
- **Win Rate**: Percentage of signals that hit TP1 or TP2
- **TP Hits**: Combined count of TP1 and TP2 hits
- **SL Hits**: Count of stop-loss hits
- **P&L (pips)**: Calculated profit/loss based on original signal levels
- **Pending**: Number of signals still being tracked

#### 2. Trade Execution Statistics (30-day window)
- **Trade Groups**: Number of position groups opened
- **Trade WR**: Win rate of executed trades
- **Wins/Losses**: Count of winning and losing trades
- **P&L $**: Actual dollar profit/loss from executed trades
- **Slots/Group**: Average slots per group

### 📈 Signal Features
- **Multi-symbol support**: XAUUSD, BTCUSD, EURUSD, ETHUSD, GBPUSD, XAGUSD, USDJPY, BRENTCMDUSD
- **Real-time signals**: Updates every 30 seconds
- **Detailed analysis**: Entry, SL, TP1, TP2, strength, probabilities, ATR, regime
- **Interactive charts**: TradingView Lightweight Charts with signal markers
- **Signal history**: Complete history with outcomes tracked

## Installation & Setup

### Prerequisites
- A web browser (Chrome, Firefox, Safari, or Edge)
- Access to the bridge API at `https://gold.ddd.bz`

### Quick Start

1. **Initialize the project**:
   ```bash
   python3 init.py
   ```

2. **Open the dashboard**:
   Simply open `index.html` in your web browser, or serve it with a local server:
   ```bash
   # Using Python
   python3 -m http.server 8000

   # Using Node.js
   npx http-server

   # Then open http://localhost:8000
   ```

## How It Works

### Signal Tracking Process

1. **Signal Reception**: Dashboard receives BUY/SELL signals from the bridge
2. **Signal Recording**: Signal is stored in the tracker with entry, SL, TP1, TP2 levels
3. **Price Action Monitoring**: New candle data is received and analyzed
4. **Outcome Detection**: System checks if price has hit TP1, TP2, or SL
5. **Result Tracking**: Outcome is recorded and statistics are updated

### Example Scenario

For a BTCUSD BUY signal in trail-only mode:

```
Original Signal:
- Entry: 65000.00
- TP1:   65150.00
- TP2:   65300.00
- SL:    64850.00

Trade Execution (trail-only):
- Uses trailing stop, no fixed TP
- May exit at 65080.00 with small profit

Original Signal Tracking:
- Monitors price action independently
- If price hits 65150.00 → Records TP1 hit
- If price hits 65300.00 → Records TP2 hit
- If price hits 64850.00 → Records SL hit
```

**Result**: Statistics show the TRUE performance of the original signal, independent of execution mode.

## Debugging & Logs

The dashboard includes comprehensive debugging via the browser console:

### SignalTracker Logs

All tracker operations are logged with timestamps:

```
[SignalTracker 10:38:15] [ADD] New signal tracked: 2026-04-04T10:30:00_BTCUSD_BUY
[SignalTracker 10:38:15] [CANDLES] Updated candle cache for BTCUSD: 300 candles
[SignalTracker 10:38:16] [CHECK] Checking pending signals for BTCUSD
[SignalTracker 10:38:16] [HIT_TP1] BUY signal hit TP1 at 65150.00
[SignalTracker 10:38:16] [OUTCOME] Signal 2026-04-04T10:30:00_BTCUSD_BUY hit TP1
```

### Error Handling

Errors are clearly marked and logged:

```
[SignalTracker ERROR 10:38:15] [FETCH_SIGNAL] Failed to fetch signal for BTCUSD
Error: Network request failed
```

### Troubleshooting

**Issue**: Statistics showing "Pending" for old signals
- **Cause**: Signal tracking has a maximum check limit (100 bars / 500 minutes)
- **Solution**: Old signals will be marked as "Pending (Expired)"

**Issue**: Signals not being tracked
- **Cause**: localStorage is disabled or full
- **Solution**: Check browser console for storage errors

**Issue**: Outdated signal outcomes
- **Cause**: Page not refreshed for extended period
- **Solution**: Refresh page to clear cache and reload signals

## Project Structure

```
mlbot-life/
├── index.html          # Main dashboard HTML
├── init.py            # Project initialization script
├── js/
│   ├── app.js         # Main application logic + SignalTracker module
│   └── chart.js       # Chart management with TradingView
├── css/
│   └── style.css      # Styling and responsive design
└── img/               # Images and icons
```

## API Endpoints

The dashboard connects to the following bridge endpoints:

- `GET /v4/public/signals` - Live signals for all symbols
- `GET /v4/public/signals/{symbol}/history` - Signal history
- `GET /v4/public/candles/{symbol}?limit=300` - Candle data
- `GET /v4/public/stats/daily?symbol={symbol}` - Original signal stats (now computed client-side)
- `GET /v4/public/trades/daily-stats?symbol={symbol}&days=30` - Trade execution stats

## Enhancements & Improvements

### Recent Updates

1. **Original Signal Tracking** (v2.0)
   - Added SignalTracker module for client-side outcome tracking
   - Independent monitoring of TP1/TP2/SL hits
   - Persistent storage using localStorage
   - Comprehensive debugging and error handling

2. **Enhanced Statistics**
   - Original signal stats now show tracked outcomes
   - Trade execution stats remain separate (30-day window)
   - Clear distinction between signal performance and execution performance

3. **Improved UI**
   - Added "Outcome" column to signal history
   - Updated labels for clarity (Original Signals vs. Trade Groups)
   - Enhanced hero section description

4. **Debugging Tools**
   - Timestamped logging for all tracker operations
   - Error categorization and detailed messages
   - Console-based diagnostics

## Configuration

### Symbol Configurations

Different symbols may use different trading modes:

- **XAUUSD, EURUSD, GBPUSD, XAGUSD**: Usually TP-based with fixed levels
- **BTCUSD, ETHUSD, USDJPY, BRENTCMDUSD**: May use trail-only mode (TP values shown as 0.00)

The dashboard handles both modes correctly by:
- Showing "Trail" for zero values on active signals
- Tracking original signal outcomes independently of execution mode

### Polling Intervals

- **Signals**: 30 seconds
- **Candles**: 60 seconds
- **History**: 60 seconds
- **Trade Stats**: 60 seconds

## Disclaimer

This dashboard displays AI-generated trading signals for educational and informational purposes only.
These signals do not constitute financial advice. Trading forex, commodities, and cryptocurrencies involves substantial risk of loss.
Past performance does not guarantee future results.

---

**Built with passion by DDD**
**Powered by LightGBM & TradingView Lightweight Charts**
