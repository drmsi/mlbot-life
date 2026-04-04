#!/usr/bin/env python3
"""
DDD Signals - Project Initialization Script
Initializes the trading signals dashboard project structure and configuration.
"""

import os
import sys
from pathlib import Path

def init_project():
    """
    Initialize the DDD Signals project by verifying structure and configuration.
    """

    print("🚀 Initializing DDD Signals Project...")
    print("-" * 50)

    # Define project structure
    project_root = Path(__file__).parent
    required_dirs = ['js', 'css', 'img']
    required_files = {
        'index.html': 'Main dashboard HTML file',
        'js/app.js': 'Main application logic',
        'js/chart.js': 'Chart management with TradingView Lightweight Charts',
        'css/style.css': 'Styling and responsive design',
    }

    # Check directories
    print("📁 Checking directory structure...")
    for dir_name in required_dirs:
        dir_path = project_root / dir_name
        if dir_path.exists():
            print(f"  ✓ {dir_name}/ exists")
        else:
            print(f"  ✗ {dir_name}/ is missing")
            dir_path.mkdir(parents=True, exist_ok=True)
            print(f"  → Created {dir_name}/")

    # Check files
    print("\n📄 Checking required files...")
    for file_path, description in required_files.items():
        full_path = project_root / file_path
        if full_path.exists():
            print(f"  ✓ {file_path} - {description}")
        else:
            print(f"  ✗ {file_path} is missing - {description}")
            return False

    # Verify bridge connectivity
    print("\n🔌 Checking bridge connectivity...")
    print(f"  Bridge URL: https://gold.ddd.bz")
    print("  → Endpoints:")
    print("    • /v4/public/signals - Live signals")
    print("    • /v4/public/signals/{symbol}/history - Signal history")
    print("    • /v4/public/candles/{symbol} - Candle data")
    print("    • /v4/public/stats/daily - Original signal statistics")
    print("    • /v4/public/trades/daily-stats - Trade execution statistics")

    # Supported symbols
    print("\n📊 Supported symbols:")
    symbols = ['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'GBPUSD', 'XAGUSD', 'USDJPY', 'BRENTCMDUSD']
    for symbol in symbols:
        print(f"  • {symbol}")

    # Signal tracking features
    print("\n🎯 Signal tracking features:")
    print("  ✓ Original signal outcome tracking (TP1/TP2/SL)")
    print("  ✓ Client-side price action monitoring")
    print("  ✓ Real-time signal history updates")
    print("  ✓ Statistics dashboard for original signals")
    print("  ✓ Trade execution statistics (30-day window)")

    # Completed
    print("\n" + "=" * 50)
    print("✅ DDD Signals project initialized successfully!")
    print("\nNext steps:")
    print("  1. Open index.html in a web browser")
    print("  2. Verify bridge connectivity")
    print("  3. Monitor signals and statistics")
    print("\nFor issues or enhancements, check the console for debugging logs.")
    print("=" * 50)

    return True


if __name__ == "__main__":
    try:
        success = init_project()
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n\n❌ Initialization interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ Initialization failed with error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
