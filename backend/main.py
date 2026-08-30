"""Canonical ASGI entrypoint for QuizForge AI.

All backend routes and Redis-optional behavior live in ``application``.
Keep deployment and local commands pointed at ``main:app``.
"""

import sys

import application as _application


# Expose the canonical application module under the historical ``main`` name.
# This keeps direct imports/monkeypatching aligned with the single app state.
sys.modules[__name__] = _application
