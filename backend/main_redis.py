"""Compatibility alias for the former Redis-specific entrypoint.

Use ``main:app`` for local development, CI, Docker, and production.
"""

import sys

import application as _application


# Older imports still resolve to the exact canonical application module, so
# there is no second FastAPI instance or duplicated route state.
sys.modules[__name__] = _application
