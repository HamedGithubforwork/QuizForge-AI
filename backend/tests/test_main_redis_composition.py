import application
import main
import main_redis
import quiz_service


def _route_count(app, path: str):
    return sum(
        1
        for route in app.routes
        if getattr(route, "path", None) == path
    )


def test_main_and_legacy_entrypoint_share_one_fastapi_app():
    assert main.app is application.app
    assert main_redis.app is application.app
    assert main.app is main_redis.app


def test_entrypoints_share_service_models_and_auth_state():
    assert main.Quiz is quiz_service.Quiz
    assert main_redis.Quiz is quiz_service.Quiz
    assert main.get_current_user is main_redis.get_current_user


def test_canonical_app_keeps_one_public_route_per_contract():
    for path in (
        "/api/documents/upload",
        "/api/quizzes/generate",
        "/api/documents/{document_sha256}/pages/{page_number}",
        "/api/answers/review",
        "/api/admin/metrics",
    ):
        assert _route_count(main.app, path) == 1


def test_legacy_entrypoint_is_the_canonical_application_module():
    assert main_redis is application


def test_canonical_app_preserves_common_routes_and_admin_metrics():
    assert _route_count(main.app, "/") == 1
    assert _route_count(main.app, "/api/health") == 1
    assert _route_count(main.app, "/api/answers/review") == 1
    assert _route_count(main.app, "/api/admin/metrics") == 1
