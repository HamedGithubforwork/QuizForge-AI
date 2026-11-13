"""Fixed GitHub Actions identity for QuizForge-AI's approved destination.

These identifiers intentionally accept only the destination organization.
The former owner is not an alternate identity after repository transfer.
"""

from collections.abc import Mapping

REPOSITORY = "QuizFromNotes/QuizForge-AI"
REPOSITORY_ID = "1307099196"
OWNER_ID = "356387243"


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
