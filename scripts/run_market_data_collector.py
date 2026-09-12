#!/usr/bin/env python3
"""Convenience entry point for the Mac collector."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from collector.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
