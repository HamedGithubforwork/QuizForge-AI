import re
from dataclasses import dataclass


DEFAULT_CHUNK_CHARACTERS = 12_000
DEFAULT_CONTEXT_CHARACTERS = 100_000
MIN_CONTEXT_CHARACTERS = 512

TOKEN_PATTERN = re.compile(r"[a-z0-9]+", re.IGNORECASE)
QUERY_STOP_WORDS = {
    "about",
    "after",
    "before",
    "could",
    "does",
    "from",
    "have",
    "into",
    "should",
    "that",
    "their",
    "there",
    "these",
    "this",
    "what",
    "when",
    "where",
    "which",
    "with",
    "would",
}


@dataclass(frozen=True)
class DocumentChunk:
    global_index: int
    page_number: int
    chunk_index: int
    chunk_count: int
    text: str


@dataclass(frozen=True)
class ContextSelection:
    chunks: tuple[DocumentChunk, ...]
    study_material: str
    source_pages: frozenset[int]
    total_chunk_count: int
    total_character_count: int
    truncated: bool

    @property
    def selected_character_count(self) -> int:
        return len(self.study_material)


class GenerationPageSequence:
    """Iterate selected pages while preserving the original PDF page count."""

    def __init__(
        self,
        *,
        selected_pages: list[dict[str, int | str]],
        original_page_count: int,
        selection: ContextSelection,
    ):
        self._selected_pages = tuple(
            selected_pages
        )
        self.original_page_count = (
            original_page_count
        )
        self.selection = selection
        self.source_pages = (
            selection.source_pages
        )

    def __len__(self) -> int:
        return self.original_page_count

    def __iter__(self):
        return iter(self._selected_pages)


def _hard_split_text(
    text: str,
    max_characters: int,
) -> list[str]:
    return [
        text[start:start + max_characters].strip()
        for start in range(
            0,
            len(text),
            max_characters,
        )
        if text[start:start + max_characters].strip()
    ]


def split_page_text(
    text: str,
    *,
    max_characters: int = DEFAULT_CHUNK_CHARACTERS,
) -> list[str]:
    if max_characters < 1:
        raise ValueError(
            "max_characters must be positive."
        )

    lines = [
        line.strip()
        for line in text.splitlines()
        if line.strip()
    ]

    if not lines:
        stripped = text.strip()
        return (
            _hard_split_text(
                stripped,
                max_characters,
            )
            if stripped
            else []
        )

    chunks: list[str] = []
    current_lines: list[str] = []
    current_length = 0

    def flush_current() -> None:
        nonlocal current_lines, current_length

        if current_lines:
            chunks.append(
                "\n".join(current_lines)
            )
            current_lines = []
            current_length = 0

    for line in lines:
        if len(line) > max_characters:
            flush_current()
            chunks.extend(
                _hard_split_text(
                    line,
                    max_characters,
                )
            )
            continue

        separator_length = (
            1 if current_lines else 0
        )
        next_length = (
            current_length
            + separator_length
            + len(line)
        )

        if (
            current_lines
            and next_length > max_characters
        ):
            flush_current()

        current_lines.append(line)
        current_length = (
            len(line)
            if len(current_lines) == 1
            else current_length + 1 + len(line)
        )

    flush_current()
    return chunks


def build_document_chunks(
    pages,
    *,
    max_chunk_characters: int = DEFAULT_CHUNK_CHARACTERS,
) -> list[DocumentChunk]:
    chunks: list[DocumentChunk] = []

    for page in pages:
        page_number = int(page["page_number"])
        page_chunks = split_page_text(
            str(page.get("text", "")),
            max_characters=max_chunk_characters,
        )
        chunk_count = len(page_chunks)

        for chunk_index, text in enumerate(
            page_chunks,
            start=1,
        ):
            chunks.append(
                DocumentChunk(
                    global_index=len(chunks),
                    page_number=page_number,
                    chunk_index=chunk_index,
                    chunk_count=chunk_count,
                    text=text,
                )
            )

    return chunks


def render_document_chunk(
    chunk: DocumentChunk,
) -> str:
    if chunk.chunk_count > 1:
        header = (
            f"--- PAGE {chunk.page_number} "
            f"CHUNK {chunk.chunk_index}/"
            f"{chunk.chunk_count} ---"
        )
    else:
        header = (
            f"--- PAGE {chunk.page_number} ---"
        )

    return f"{header}\n{chunk.text}"


def _coverage_order(
    indices: list[int],
) -> list[int]:
    if not indices:
        return []

    remaining = set(indices)
    selected: list[int] = []

    first = min(remaining)
    selected.append(first)
    remaining.remove(first)

    if remaining:
        last = max(remaining)
        selected.append(last)
        remaining.remove(last)

    while remaining:
        next_index = max(
            remaining,
            key=lambda index: (
                min(
                    abs(index - chosen)
                    for chosen in selected
                ),
                -index,
            ),
        )
        selected.append(next_index)
        remaining.remove(next_index)

    return selected


def _query_tokens(
    query_texts: list[str],
) -> set[str]:
    tokens: set[str] = set()

    for value in query_texts:
        for match in TOKEN_PATTERN.findall(
            value.lower()
        ):
            if (
                len(match) >= 4
                and match not in QUERY_STOP_WORDS
            ):
                tokens.add(match)

    return tokens


def _chunk_query_score(
    chunk: DocumentChunk,
    query_tokens: set[str],
) -> int:
    if not query_tokens:
        return 0

    chunk_tokens = {
        token
        for token in TOKEN_PATTERN.findall(
            chunk.text.lower()
        )
        if len(token) >= 4
    }

    return len(
        query_tokens.intersection(chunk_tokens)
    )


def select_document_context(
    pages,
    *,
    focus_page_numbers: list[int] | None = None,
    query_texts: list[str] | None = None,
    max_context_characters: int = DEFAULT_CONTEXT_CHARACTERS,
    max_chunk_characters: int = DEFAULT_CHUNK_CHARACTERS,
) -> ContextSelection:
    if max_context_characters < MIN_CONTEXT_CHARACTERS:
        raise ValueError(
            "max_context_characters is too small."
        )

    effective_chunk_characters = min(
        max_chunk_characters,
        max_context_characters // 2,
    )
    chunks = build_document_chunks(
        pages,
        max_chunk_characters=(
            effective_chunk_characters
        ),
    )

    if not chunks:
        return ContextSelection(
            chunks=(),
            study_material="",
            source_pages=frozenset(),
            total_chunk_count=0,
            total_character_count=0,
            truncated=False,
        )

    focus_pages = set(
        focus_page_numbers or []
    )
    query_tokens = _query_tokens(
        query_texts or []
    )

    focus_indices = [
        chunk.global_index
        for chunk in chunks
        if chunk.page_number in focus_pages
    ]
    focus_index_set = set(focus_indices)

    query_ranked = [
        (
            _chunk_query_score(
                chunk,
                query_tokens,
            ),
            chunk.global_index,
        )
        for chunk in chunks
        if chunk.global_index not in focus_index_set
    ]
    query_indices = [
        index
        for score, index in sorted(
            query_ranked,
            key=lambda item: (
                -item[0],
                item[1],
            ),
        )
        if score > 0
    ]
    query_index_set = set(query_indices)

    coverage_indices = [
        chunk.global_index
        for chunk in chunks
        if (
            chunk.global_index
            not in focus_index_set
            and chunk.global_index
            not in query_index_set
        )
    ]

    priority_order = (
        _coverage_order(focus_indices)
        + query_indices
        + _coverage_order(coverage_indices)
    )

    selected_indices: list[int] = []
    used_characters = 0

    for index in priority_order:
        rendered = render_document_chunk(
            chunks[index]
        )
        separator_length = (
            2 if selected_indices else 0
        )
        added_characters = (
            separator_length + len(rendered)
        )

        if (
            used_characters + added_characters
            > max_context_characters
        ):
            continue

        selected_indices.append(index)
        used_characters += added_characters

    selected_chunks = tuple(
        chunks[index]
        for index in sorted(
            selected_indices
        )
    )
    study_material = "\n\n".join(
        render_document_chunk(chunk)
        for chunk in selected_chunks
    )

    return ContextSelection(
        chunks=selected_chunks,
        study_material=study_material,
        source_pages=frozenset(
            chunk.page_number
            for chunk in selected_chunks
        ),
        total_chunk_count=len(chunks),
        total_character_count=sum(
            len(chunk.text)
            for chunk in chunks
        ),
        truncated=(
            len(selected_chunks) < len(chunks)
        ),
    )


def build_generation_pages(
    pages,
    *,
    focus_page_numbers: list[int] | None = None,
    query_texts: list[str] | None = None,
    max_context_characters: int = DEFAULT_CONTEXT_CHARACTERS,
    max_chunk_characters: int = DEFAULT_CHUNK_CHARACTERS,
) -> GenerationPageSequence:
    original_page_count = len(pages)
    selection = select_document_context(
        pages,
        focus_page_numbers=focus_page_numbers,
        query_texts=query_texts,
        max_context_characters=(
            max_context_characters
        ),
        max_chunk_characters=(
            max_chunk_characters
        ),
    )

    page_parts: dict[int, list[str]] = {}

    for chunk in selection.chunks:
        page_parts.setdefault(
            chunk.page_number,
            [],
        ).append(chunk.text)

    selected_pages = [
        {
            "page_number": page_number,
            "text": "\n\n".join(
                page_parts[page_number]
            ),
        }
        for page_number in sorted(page_parts)
    ]

    return GenerationPageSequence(
        selected_pages=selected_pages,
        original_page_count=(
            original_page_count
        ),
        selection=selection,
    )
