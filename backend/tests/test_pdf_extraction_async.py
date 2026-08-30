import asyncio
import threading

import main_redis


def test_pdf_extraction_runs_in_worker_thread(
    monkeypatch,
):
    event_loop_thread = threading.get_ident()
    extraction_threads = []
    expected_pages = [
        {
            "page_number": 1,
            "text": "Extracted study material",
        }
    ]

    def fake_extraction(contents):
        assert contents == b"pdf bytes"
        extraction_threads.append(
            threading.get_ident()
        )
        return expected_pages

    monkeypatch.setattr(
        main_redis,
        "extract_pdf_pages_without_redis",
        fake_extraction,
    )

    pages = asyncio.run(
        main_redis.extract_pdf_pages_off_event_loop(
            b"pdf bytes"
        )
    )

    assert pages == expected_pages
    assert len(extraction_threads) == 1
    assert (
        extraction_threads[0]
        != event_loop_thread
    )
