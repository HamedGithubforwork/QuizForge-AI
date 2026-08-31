"""Canonical ASGI entrypoint for QuizForge AI.

All backend routes and Redis-optional behavior live in ``application``.
Keep deployment and local commands pointed at ``main:app``.
"""

import application as _application
from application import AuthenticatedUser, get_current_user
from pdf_ocr import (
    extract_pdf_pages_off_event_loop as extract_pdf_pages_with_ocr_off_event_loop,
)
from performance_metrics import install_performance_instrumentation
from quiz_service import (
    QuizQuestion,
    ShortAnswerGradingSpec,
    analyze_extracted_text,
    parse_avoid_questions,
    parse_focus_pages,
    parse_focus_question_types,
)

_application.extract_pdf_pages_off_event_loop = (
    extract_pdf_pages_with_ocr_off_event_loop
)
install_performance_instrumentation(_application)

app = _application.app
