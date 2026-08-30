import main
import main_redis
import quiz_service


def _route_count(app, path: str):
    return sum(
        1
        for route in app.routes
        if getattr(route, "path", None) == path
    )


def test_redis_entrypoint_uses_separate_fastapi_app():
    assert main_redis.app is not main.app


def test_base_and_redis_apps_share_service_models_not_app_state():
    assert main.Quiz is quiz_service.Quiz
    assert main_redis.Quiz is quiz_service.Quiz
    assert main.get_current_user is main_redis.get_current_user


def test_base_and_redis_apps_each_keep_one_public_route_per_contract():
    for path in (
        "/api/documents/upload",
        "/api/quizzes/generate",
    ):
        assert _route_count(main.app, path) == 1
        assert _route_count(main_redis.app, path) == 1


def test_redis_entrypoint_no_longer_clones_base_endpoints():
    assert not hasattr(
        main_redis,
        "_clone_endpoint_with_global_overrides",
    )
    assert not hasattr(
        main_redis,
        "upload_pdf_without_redis",
    )
    assert not hasattr(
        main_redis,
        "generate_quiz_without_redis",
    )
    assert not hasattr(
        main_redis,
        "_document_pages_context",
    )


def test_redis_app_preserves_common_routes_and_adds_admin_metrics():
    assert _route_count(main_redis.app, "/") == 1
    assert _route_count(main_redis.app, "/api/health") == 1
    assert _route_count(main_redis.app, "/api/answers/review") == 1
    assert _route_count(main_redis.app, "/api/admin/metrics") == 1
