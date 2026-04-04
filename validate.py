#!/usr/bin/env python3
"""
DDD Signals - Validation Script
Validates the implementation and checks for common issues.
"""

import os
import sys
import re
from pathlib import Path

def check_file_exists(filepath, description):
    """Check if a file exists."""
    if filepath.exists():
        print(f"  ✓ {description}: {filepath.name}")
        return True
    else:
        print(f"  ✗ {description}: {filepath.name} (MISSING)")
        return False

def check_file_contains(filepath, patterns, description):
    """Check if a file contains specific patterns."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()

        all_found = True
        for pattern in patterns:
            if re.search(pattern, content):
                print(f"  ✓ Found: {pattern[:50]}...")
            else:
                print(f"  ✗ Missing: {pattern[:50]}...")
                all_found = False

        return all_found
    except Exception as e:
        print(f"  ✗ Error reading file: {e}")
        return False

def validate_implementation():
    """Validate the DDD Signals implementation."""

    print("🔍 DDD Signals Validation")
    print("=" * 60)

    project_root = Path(__file__).parent
    all_valid = True

    # 1. Check file structure
    print("\n1. File Structure Check")
    print("-" * 60)

    required_files = {
        'index.html': 'Main dashboard HTML',
        'js/app.js': 'Main application logic',
        'js/chart.js': 'Chart management',
        'css/style.css': 'Styling',
        'init.py': 'Initialization script',
        'debug.py': 'Debug helper script',
        'README.md': 'Documentation',
        'IMPLEMENTATION.md': 'Implementation details'
    }

    for filename, description in required_files.items():
        filepath = project_root / filename
        if not check_file_exists(filepath, description):
            all_valid = False

    # 2. Check SignalTracker module in app.js
    print("\n2. SignalTracker Module Check")
    print("-" * 60)

    app_js = project_root / 'js' / 'app.js'
    if app_js.exists():
        tracker_patterns = [
            r'SignalTracker\s*=\s*\(\(\)\s*=>\s*\{',
            r'function\s+addSignal\s*\(',
            r'function\s+updateCandles\s*\(',
            r'function\s+getStats\s*\(',
            r'function\s+getHistory\s*\(',
            r'function\s+checkPendingSignals\s*\(',
            r'function\s+checkSignalOutcome\s*\(',
            r'debugLog\s*\(',
            r'errorLog\s*\(',
            r'localStorage\.setItem\(.*ddd_tracked_signals',
        ]

        if not check_file_contains(app_js, tracker_patterns, "SignalTracker"):
            all_valid = False
    else:
        print("  ✗ app.js not found")
        all_valid = False

    # 3. Check HTML structure
    print("\n3. HTML Structure Check")
    print("-" * 60)

    index_html = project_root / 'index.html'
    if index_html.exists():
        html_patterns = [
            r'kpi-label.*Original Signals',
            r'Trade Groups.*30d',
            r'<th>Outcome</th>',
            r'colspan="9"',
        ]

        if not check_file_contains(index_html, html_patterns, "HTML"):
            all_valid = False
    else:
        print("  ✗ index.html not found")
        all_valid = False

    # 4. Check statistics calculation
    print("\n4. Statistics Calculation Check")
    print("-" * 60)

    stats_patterns = [
        r'SignalTracker\.getStats\(sym\)',
        r'trackedStats\.total',
        r'trackedStats\.win_rate',
        r'trackedStats\.tp',
        r'trackedStats\.sl',
        r'trackedStats\.pending',
    ]

    if not check_file_contains(app_js, stats_patterns, "Statistics"):
        all_valid = False

    # 5. Check signal outcome tracking
    print("\n5. Signal Outcome Tracking Check")
    print("-" * 60)

    outcome_patterns = [
        r"outcome\s*===\s*['\"]SL['\"]",
        r"outcome\.startsWith\(['\"]TP['\"]\)",
        r'trackedSig\.outcome',
        r'outcomeClass',
    ]

    if not check_file_contains(app_js, outcome_patterns, "Outcome Tracking"):
        all_valid = False

    # 6. Check error handling
    print("\n6. Error Handling Check")
    print("-" * 60)

    error_patterns = [
        r'try\s*\{',
        r'\}\s*catch\s*\(',
        r'console\.error',
        r'SignalTracker\.errorLog',
    ]

    if not check_file_contains(app_js, error_patterns, "Error Handling"):
        all_valid = False

    # 7. Check candle update integration
    print("\n7. Candle Update Integration Check")
    print("-" * 60)

    candle_patterns = [
        r'SignalTracker\.updateCandles\(sym,\s*data\.candles\)',
        r'fetchCandles',
    ]

    if not check_file_contains(app_js, candle_patterns, "Candle Updates"):
        all_valid = False

    # 8. Check history updates
    print("\n8. History Updates Check")
    print("-" * 60)

    history_patterns = [
        r'SignalTracker\.getHistory\(.*\)',
        r'outcome',
        r'outcomeClass',
    ]

    if not check_file_contains(app_js, history_patterns, "History"):
        all_valid = False

    # 9. Check documentation
    print("\n9. Documentation Check")
    print("-" * 60)

    readme_patterns = [
        r'Original Signal Tracking',
        r'Dual Statistics Dashboards',
        r'Installation & Setup',
        r'Debugging & Logs',
    ]

    readme_md = project_root / 'README.md'
    if readme_md.exists():
        if not check_file_contains(readme_md, readme_patterns, "README"):
            all_valid = False
    else:
        print("  ✗ README.md not found")
        all_valid = False

    # 10. JavaScript syntax validation
    print("\n10. JavaScript Syntax Validation")
    print("-" * 60)

    js_files = ['js/app.js', 'js/chart.js']
    for js_file in js_files:
        filepath = project_root / js_file
        if filepath.exists():
            result = os.system(f"node --check {filepath} 2>&1 > /dev/null")
            if result == 0:
                print(f"  ✓ {js_file}: Valid syntax")
            else:
                print(f"  ✗ {js_file}: Syntax errors detected")
                all_valid = False
        else:
            print(f"  ✗ {js_file}: File not found")
            all_valid = False

    # 11. Check for common issues
    print("\n11. Common Issues Check")
    print("-" * 60)

    issues_found = []

    # Check for hardcoded API URLs (should use constant)
    with open(app_js, 'r', encoding='utf-8') as f:
        app_content = f.read()
        if 'gold.ddd.bz' in app_content and 'BRIDGE_URL' in app_content:
            print("  ✓ API URL uses constant")
        else:
            print("  ⚠ Warning: API URL might not use constant")

    # Check for localStorage error handling
    if 'try' in app_content and 'localStorage' in app_content:
        print("  ✓ localStorage has error handling")
    else:
        print("  ⚠ Warning: localStorage might not have error handling")
        issues_found.append("localStorage error handling")

    # Check for duplicate detection
    if 'deduplicate' in app_content.lower() or 'key' in app_content:
        print("  ✓ Duplicate signal detection present")
    else:
        print("  ⚠ Warning: Duplicate signal detection might be missing")
        issues_found.append("duplicate detection")

    # Summary
    print("\n" + "=" * 60)
    if all_valid and not issues_found:
        print("✅ All checks passed! Implementation is valid.")
        print("=" * 60)
        return 0
    else:
        if issues_found:
            print("⚠ Found potential issues:")
            for issue in issues_found:
                print(f"  • {issue}")
        print("=" * 60)
        print("Some checks failed. Please review the output above.")
        return 1


if __name__ == "__main__":
    try:
        exit_code = validate_implementation()
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\n\n❌ Validation interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ Validation failed with error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
