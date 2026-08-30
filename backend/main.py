"""Canonical ASGI entrypoint for QuizForge AI.

All backend routes and Redis-optional behavior live in ``application``.
Keep deployment and local commands pointed at ``main:app``.
"""

import application as _application
from performance_metrics import (
    install_performance_instrumentation,
)


install_performance_instrumentation(
    _application
)

# Keep the ASGI surface intentionally small. Runtime code lives in
# ``application`` and service helpers live in their authoritative modules.
app = _application.app
