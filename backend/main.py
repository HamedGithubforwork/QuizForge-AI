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

from application import *  # noqa: E402,F403
from quiz_service import (  # noqa: E402
    MAX_AI_CHARACTERS,
    MAX_FILE_SIZE,
    MIN_EXTRACTABLE_CHARACTERS,
    SCAN_CHARACTERS_PER_PAGE,
    QuizQuestion,
    ShortAnswerGradingSpec,
    analyze_extracted_text,
    extract_pdf_pages,
    parse_avoid_questions,
    parse_focus_pages,
    parse_focus_question_types,
)
