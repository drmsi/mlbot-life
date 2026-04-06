#!/usr/bin/env python3
"""
DDD Signals - Debug Helper Script
Helps diagnose and troubleshoot signal tracking issues.
"""

import json
import sys
from pathlib import Path

def analyze_tracked_signals():
    """
    Analyze tracked signals from localStorage dump.
    """
    print("🔍 DDD Signals Debug Helper")
    print("=" * 50)

    # Check for potential issues in the code
    print("\n📋 Common Issues & Solutions:")
    print("-" * 50)

    issues = [
        {
            "issue": "Statistics showing incorrect values",
            "causes": [
                "localStorage cleared or disabled",
                "Signal tracker not initialized properly",
                "Candle data not updating"
            ],
            "solutions": [
                "Check browser console for SignalTracker errors",
                "Open DevTools → Application → Local Storage → check 'ddd_tracked_signals'",
                "Verify network requests in DevTools → Network tab"
            ]
        },
        {
            "issue": "Signals not tracking outcomes",
            "causes": [
                "TP1/TP2/SL values are 0 (trail-only mode)",
                "Not enough candle data to determine outcome",
                "Signal expired (100 bars max check limit)"
            ],
            "solutions": [
                "Check that signal has non-zero TP/SL values",
                "Wait for more candle data to accumulate",
                "Recent signals (within 500 minutes) will track properly"
            ]
        },
        {
            "issue": "Console errors appearing",
            "causes": [
                "Network connectivity issues",
                "Bridge API unavailable",
                "CORS restrictions",
                "localStorage quota exceeded"
            ],
            "solutions": [
                "Check internet connection",
                "Verify bridge is accessible: https://mlbot.ddd.bz",
                "Clear localStorage if quota exceeded",
                "Check browser console for specific error messages"
            ]
        },
        {
            "issue": "History table not updating",
            "causes": [
                "Signal history not fetching",
                "Duplicate signal detection working correctly",
                "Symbol switch cleared history"
            ],
            "solutions": [
                "Wait for new BUY/SELL signals",
                "Check console for history fetch errors",
                "Verify you're looking at the correct symbol"
            ]
        },
        {
            "issue": "Charts not displaying",
            "causes": [
                "TradingView Lightweight Charts not loading",
                "Candle data not fetching",
                "Chart container size issues"
            ],
            "solutions": [
                "Check Network tab for lightweight-charts.js loading",
                "Verify candle API response in Network tab",
                "Resize browser window to trigger chart resize"
            ]
        }
    ]

    for i, issue in enumerate(issues, 1):
        print(f"\n{i}. {issue['issue']}")
        print(f"   Possible causes:")
        for cause in issue['causes']:
            print(f"     • {cause}")
        print(f"   Solutions:")
        for solution in issue['solutions']:
            print(f"     • {solution}")

    print("\n" + "=" * 50)
    print("📊 Console Log Patterns to Look For:")
    print("-" * 50)

    patterns = [
        {
            "pattern": "[SignalTracker] [ADD]",
            "meaning": "New signal added to tracker",
            "status": "✓ Normal"
        },
        {
            "pattern": "[SignalTracker] [HIT_TP1] or [HIT_TP2] or [HIT_SL]",
            "meaning": "Signal outcome detected",
            "status": "✓ Success"
        },
        {
            "pattern": "[SignalTracker] [EXPIRED]",
            "meaning": "Signal expired without outcome (500+ minutes old)",
            "status": "⚠ Warning"
        },
        {
            "pattern": "[SignalTracker ERROR]",
            "meaning": "Error in tracker - investigate",
            "status": "✗ Issue"
        },
        {
            "pattern": "[fetchSignal] Error:",
            "meaning": "Failed to fetch signals from bridge",
            "status": "✗ Issue"
        },
        {
            "pattern": "[fetchCandles] Error:",
            "meaning": "Failed to fetch candle data",
            "status": "✗ Issue"
        }
    ]

    for pattern in patterns:
        status_color = "✓" if pattern["status"] == "✓ Normal" or pattern["status"] == "✓ Success" else ("⚠" if "Warning" in pattern["status"] else "✗")
        print(f"\n{status_color} {pattern['pattern']}")
        print(f"  {pattern['meaning']}")
        print(f"  Status: {pattern['status']}")

    print("\n" + "=" * 50)
    print("🔧 Diagnostic Commands:")
    print("-" * 50)

    commands = [
        "Clear all tracked signals:",
        "  Run in browser console: localStorage.removeItem('ddd_tracked_signals'); location.reload();",
        "",
        "View all tracked signals:",
        "  Run in browser console: JSON.parse(localStorage.getItem('ddd_tracked_signals'));",
        "",
        "Check network requests:",
        "  1. Open DevTools (F12)",
        "  2. Go to Network tab",
        "  3. Filter by 'v4/public'",
        "  4. Look for failed requests (red)",
        "",
        "Check localStorage usage:",
        "  1. Open DevTools (F12)",
        "  2. Go to Application tab",
        "  3. Expand Local Storage",
        "  4. Click your domain",
        "  5. Look for 'ddd_tracked_signals'"
    ]

    for cmd in commands:
        print(cmd)

    print("\n" + "=" * 50)
    print("📈 Understanding Signal Outcomes:")
    print("-" * 50)

    outcomes = [
        {
            "outcome": "TP1",
            "description": "First take-profit level reached",
            "example": "BUY signal: price >= TP1",
            "tracking": "Independent of trade execution"
        },
        {
            "outcome": "TP2",
            "description": "Second take-profit level reached",
            "example": "BUY signal: price >= TP2 (after TP1)",
            "tracking": "Independent of trade execution"
        },
        {
            "outcome": "SL",
            "description": "Stop-loss level reached",
            "example": "BUY signal: price <= SL",
            "tracking": "Independent of trade execution"
        },
        {
            "outcome": "Pending",
            "description": "Signal still being tracked (no outcome yet)",
            "example": "Price hasn't hit TP1, TP2, or SL",
            "tracking": "Checks every 60 seconds with new candles"
        },
        {
            "outcome": "Pending (Expired)",
            "description": "Signal expired without outcome",
            "example": "100 bars (500 minutes) passed without hitting any level",
            "tracking": "Stopped tracking to save resources"
        }
    ]

    for outcome in outcomes:
        print(f"\n• {outcome['outcome']}")
        print(f"  {outcome['description']}")
        print(f"  Example: {outcome['example']}")
        print(f"  Tracking: {outcome['tracking']}")

    print("\n" + "=" * 50)
    print("✅ Quick Health Check:")
    print("-" * 50)

    checks = [
        ("Open browser console (F12)", "Should see SignalTracker logs"),
        ("Check Network tab for API calls", "All requests should return 200 OK"),
        ("Verify localStorage has 'ddd_tracked_signals'", "Should contain recent signals"),
        ("Check dashboard displays data", "All KPIs should show values, not '--'"),
        ("Wait for 2-3 poll cycles", "Signals and candles should update automatically")
    ]

    for i, (check, expected) in enumerate(checks, 1):
        print(f"\n{i}. {check}")
        print(f"   Expected: {expected}")

    print("\n" + "=" * 50)
    print("💡 Performance Tips:")
    print("-" * 50)

    tips = [
        "Dashboard polls every 30-60 seconds - this is normal",
        "Up to 200 signals are tracked in memory",
        "Oldest 50 signals are persisted to localStorage",
        "Expired signals are automatically cleaned up",
        "Candle cache is refreshed every 60 seconds",
        "Chart markers update in real-time"
    ]

    for tip in tips:
        print(f"• {tip}")

    print("\n" + "=" * 50)
    print("📞 Getting Help:")
    print("-" * 50)

    print("\nIf issues persist:")
    print("1. Check browser console for specific error messages")
    print("2. Verify all API endpoints are accessible")
    print("3. Check localStorage is enabled and not full")
    print("4. Try clearing localStorage: localStorage.clear()")
    print("5. Refresh the page after clearing cache")
    print("\nReport issues with:")
    print("• Console error messages")
    print("• Network request status")
    print("• Browser and version")
    print("• Steps to reproduce")

    print("\n" + "=" * 50)
    print("✨ Debug helper complete!")
    print("=" * 50)


if __name__ == "__main__":
    try:
        analyze_tracked_signals()
    except KeyboardInterrupt:
        print("\n\n❌ Debug helper interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ Debug helper failed with error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
