import main
import main_redis


def _route_count(app, path: str):
    return sum(
        1
        for route in app.routes
        if getattr(route, "path", None) == path
    )


def test_redis_entrypoint_uses_separate_fastapi_app():
    assert main_redis.app is not main.app


def test_importing_redis_entrypoint_does_not_mutate_base_dependencies():
    assert (
        main.extract_pdf_pages
        is main_redis.extract_pdf_pages_without_redis
    )
    assert (
        main.enforce_quiz_rate_limit.__name__
        == "enforce_quiz_rate_limit"
    )


def test_base_and_redis_apps_each_keep_one_public_route_per_contract():
    for path in (
        "/api/documents/upload",
        "/api/quizzes/generate",
    ):
        assert _route_count(main.app, path) == 1
        assert _route_count(main_redis.app, path) == 1


def test_redis_delegates_use_isolated_runtime_overrides():
    upload_globals = (
        main_redis.upload_pdf_without_redis.__globals__
    )
    generation_globals = (
        main_redis.generate_quiz_without_redis.__globals__
    )

    assert (
        upload_globals["extract_pdf_pages"]
        is main_redis.extract_pdf_pages_from_context
    )
    assert (
        generation_globals["extract_pdf_pages"]
        is main_redis.extract_pdf_pages_from_context
    )
    assert (
        generation_globals["enforce_quiz_rate_limit"]
        is main_redis._skip_local_quiz_rate_limit
    )

    assert (
        main.generate_quiz.__globals__["extract_pdf_pages"]
        is main.extract_pdf_pages
    )
    assert (
        main.generate_quiz.__globals__["enforce_quiz_rate_limit"]
        is main.enforce_quiz_rate_limit
    )


def test_redis_app_preserves_base_business_routes_and_adds_admin_metrics():
    assert _route_count(main_redis.app, "/") == 1
    assert _route_count(main_redis.app, "/api/health") == 1
    assert _route_count(main_redis.app, "/api/answers/review") == 1
    assert _route_count(main_redis.app, "/api/admin/metrics") == 1
