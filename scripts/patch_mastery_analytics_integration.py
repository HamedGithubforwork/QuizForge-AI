from pathlib import Path


QUIZ_HISTORY = Path("frontend/src/QuizHistory.tsx")


def insert_before(text: str, marker: str, addition: str, label: str) -> str:
    if addition in text:
        return text

    index = text.find(marker)
    if index < 0:
        raise SystemExit(f"{label} marker not found")

    return text[:index] + addition + text[index:]


# Add the advanced current-PDF mastery panel without changing the
# existing weak-area practice calculations.
text = QUIZ_HISTORY.read_text()

mastery_import = "import MasteryAnalyticsPanel from './MasteryAnalyticsPanel.tsx'\n"
text = insert_before(
    text,
    "import {\n  deleteQuizHistory,",
    mastery_import + "\n",
    "mastery panel import",
)

mastery_panel = """                  <MasteryAnalyticsPanel
                    history={history}
                    currentFilename={
                      currentFilename
                    }
                    currentDocumentSha256={
                      currentDocumentSha256
                    }
                  />

"""
text = insert_before(
    text,
    '                  <div className="history-weakness-panel">',
    mastery_panel,
    "mastery panel render",
)

QUIZ_HISTORY.write_text(text)
