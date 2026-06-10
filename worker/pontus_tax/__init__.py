"""Pontus Property Tax Checker — worker engine.

Excel in → portal lookup per row (Skyvern) → Excel out.
Core logic is jurisdiction-agnostic; vendor/state specifics live in
playbooks (data), never in code paths. See CLAUDE.md at the repo root.
"""

__version__ = "1.0.0"
