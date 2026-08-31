import asyncio
from pathlib import Path

import application
import main
import pdf_ocr
import quiz_service
import redis_integration


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_main_is_the_single_supported_app_instance():
    assert main.app is application.app
    assert not (
        REPO_ROOT
        / "backend"
        / "main_redis.py"
    ).exists()


def test_main_composes_ocr_aware_pdf_extraction():
    assert (
        application.extract_pdf_pages_off_event_loop
        is pdf_ocr.extract_pdf_pages_off_event_loop
    )


def test_removed_legacy_surfaces_stay_removed():
    assert not hasattr(
        quiz_service,
        "build_upload_response",
    )
    assert not hasattr(
        main,
        "generate_quiz",
    )


def test_canonical_rate_limit_falls_back_without_redis(
    monkeypatch,
):
    user_id = "canonical-no-redis-user"

    monkeypatch.setattr(
        redis_integration,
        "redis_client",
        None,
    )
    redis_integration._memory_generation_requests.pop(
        user_id,
        None,
    )

    asyncio.run(
        application.enforce_quiz_rate_limit(
            user_id
        )
    )

    assert len(
        redis_integration._memory_generation_requests[
            user_id
        ]
    ) == 1

    redis_integration._memory_generation_requests.pop(
        user_id,
        None,
    )


def test_runtime_configs_use_canonical_main_entrypoint():
    dockerfile = (
        REPO_ROOT
        / "backend"
        / "Dockerfile"
    ).read_text(encoding="utf-8")
    render_config = (
        REPO_ROOT
        / "render.yaml"
    ).read_text(encoding="utf-8")
    local_stack = (
        REPO_ROOT
        / ".github"
        / "workflows"
        / "local-stack-integration.yml"
    ).read_text(encoding="utf-8")

    assert '"main:app"' in dockerfile
    assert "uvicorn main:app" in render_config
    assert "uvicorn main:app" in local_stack

    assert "main_redis:app" not in dockerfile
    assert "main_redis:app" not in render_config
    assert "main_redis:app" not in local_stack

    assert "tesseract-ocr" in dockerfile
    assert "runtime: docker" in render_config
    assert "--no-access-log" in dockerfile
    assert "--no-access-log" in render_config
