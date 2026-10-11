"""Adapt the canonical database bootstrap for the isolated staging database."""


def staging_application_schema(schema=None):
    if schema is None:
        from pathlib import Path
        schema = Path("application_schema.sql").read_text()
    # The canonical bootstrap names its production database in CONNECT grants.
    # Rewrite only those database identifiers for this disposable database.
    reference = "DATABASE quizforge "
    assert schema.count(reference) == 3, "Unexpected canonical schema database references"
    return schema.replace(reference, "DATABASE quizforge_rehearsal ")
