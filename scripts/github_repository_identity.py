"""Fixed GitHub Actions identity for QuizForge-AI's approved destination.

These identifiers intentionally accept only the destination organization.
The former owner is not an alternate identity after repository transfer.
"""

from collections.abc import Mapping

REPOSITORY = "QuizFromNotes/QuizForge-AI"
REPOSITORY_ID = "1307099196"
OWNER_ID = "356387243"
SOURCE_REPOSITORY = "HamedGithubforwork/QuizForge-AI"
SOURCE_OWNER_ID = "148009407"


def is_read_only_ci_repository(repository: object, repository_id: object, owner_id: object) -> bool:
    """Accept the exact source or destination identity for read-only PR metadata.

    This migration bridge must never be reused for cloud, deployment, or merge
    authorization. Those guards remain destination-only through
    ``is_target_repository``.
    """
    if is_target_repository(repository, repository_id, owner_id):
        return True
    return (
        repository == SOURCE_REPOSITORY
        and str(repository_id or "") == REPOSITORY_ID
        and str(owner_id or "") == SOURCE_OWNER_ID
    )


def is_read_only_ci_repository_object(repository: object, expected_name: str) -> bool:
    """Require a GitHub PR repo object to match this run's exact repo identity."""
    if not isinstance(repository, dict):
        return False
    owner = repository.get("owner")
    owner_id = owner.get("id") if isinstance(owner, dict) else None
    return (
        repository.get("full_name") == expected_name
        and is_read_only_ci_repository(
            repository.get("full_name"), repository.get("id"), owner_id
        )
    )


def read_only_ci_repository_from_environment(env: Mapping[str, str]) -> str:
    """Return only this run's exact source/destination repo for read-only API calls."""
    repository = env.get("GITHUB_REPOSITORY")
    if not is_read_only_ci_repository(
        repository,
        env.get("GITHUB_REPOSITORY_ID"),
        env.get("GITHUB_REPOSITORY_OWNER_ID"),
    ):
        raise ValueError("Read-only GitHub API access requires the exact source or destination repository identity.")
    return str(repository)


def is_target_repository(repository: object, repository_id: object, owner_id: object) -> bool:
    """Match both immutable GitHub IDs and the intended human-readable name."""
    return (
        repository == REPOSITORY
        and str(repository_id or "") == REPOSITORY_ID
        and str(owner_id or "") == OWNER_ID
    )


def is_target_actions_environment(env: Mapping[str, str]) -> bool:
    """Require GitHub-provided Actions repository identity variables."""
    return is_target_repository(
        env.get("GITHUB_REPOSITORY"),
        env.get("GITHUB_REPOSITORY_ID"),
        env.get("GITHUB_REPOSITORY_OWNER_ID"),
    )


def is_target_repository_object(repository: object) -> bool:
    """Validate a repository object returned in a GitHub event/API response."""
    if not isinstance(repository, dict):
        return False
    owner = repository.get("owner")
    owner_id = owner.get("id") if isinstance(owner, dict) else None
    return is_target_repository(repository.get("full_name"), repository.get("id"), owner_id)
