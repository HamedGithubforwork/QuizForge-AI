"""Generate the frontend wire contract from FastAPI's OpenAPI schema.

The generated TypeScript file is committed so frontend code can import the
backend-owned wire shapes without needing a running API server. CI runs this
script with --check and fails when the committed contract is stale.
"""

from __future__ import annotations

import argparse
import difflib
import json
from pathlib import Path
from typing import Any

from main import app


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_PATH = (
    REPOSITORY_ROOT
    / "frontend"
    / "src"
    / "types"
    / "api.generated.ts"
)

PUBLIC_SCHEMA_NAMES = (
    "AnswerReviewCase",
    "AnswerReviewDecision",
    "AnswerReviewRequest",
    "AnswerReviewResponse",
    "Quiz",
    "QuizQuestion",
    "ShortAnswerGradingSpec",
    "SourcePageResponse",
    "UploadPageSummary",
    "UploadResponse",
)

HTTP_METHODS = {
    "delete",
    "get",
    "head",
    "options",
    "patch",
    "post",
    "put",
    "trace",
}


def quote_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def reference_name(reference: str) -> str:
    return reference.rsplit("/", 1)[-1]


def render_union(items: list[str]) -> str:
    unique_items: list[str] = []

    for item in items:
        if item not in unique_items:
            unique_items.append(item)

    if not unique_items:
        return "unknown"

    if len(unique_items) == 1:
        return unique_items[0]

    return " | ".join(unique_items)


def render_schema(schema: dict[str, Any]) -> str:
    reference = schema.get("$ref")
    if isinstance(reference, str):
        return reference_name(reference)

    if "const" in schema:
        value = schema["const"]
        if isinstance(value, str):
            return quote_string(value)
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "true" if value else "false"
        return str(value)

    enum = schema.get("enum")
    if isinstance(enum, list):
        values: list[str] = []
        for value in enum:
            if isinstance(value, str):
                values.append(quote_string(value))
            elif value is None:
                values.append("null")
            elif isinstance(value, bool):
                values.append("true" if value else "false")
            else:
                values.append(str(value))
        return render_union(values)

    for union_key in ("anyOf", "oneOf"):
        union_schemas = schema.get(union_key)
        if isinstance(union_schemas, list):
            return render_union(
                [render_schema(item) for item in union_schemas]
            )

    all_of = schema.get("allOf")
    if isinstance(all_of, list):
        return " & ".join(
            render_schema(item) for item in all_of
        )

    schema_type = schema.get("type")

    if schema_type == "array":
        item_type = render_schema(schema.get("items", {}))
        if " | " in item_type or " & " in item_type:
            item_type = f"({item_type})"
        return f"{item_type}[]"

    if schema_type in {"integer", "number"}:
        return "number"

    if schema_type == "string":
        return "string"

    if schema_type == "boolean":
        return "boolean"

    if schema_type == "null":
        return "null"

    if schema_type == "object" or "properties" in schema:
        properties = schema.get("properties", {})
        required = set(schema.get("required", []))
        lines = ["{"]

        for name, property_schema in properties.items():
            optional = "" if name in required else "?"
            property_type = render_schema(property_schema)
            lines.append(
                f"  {quote_string(name)}{optional}: {property_type}"
            )

        additional = schema.get("additionalProperties")
        if isinstance(additional, dict):
            lines.append(
                f"  [key: string]: {render_schema(additional)}"
            )
        elif additional is True:
            lines.append("  [key: string]: unknown")

        lines.append("}")
        return "\n".join(lines)

    return "unknown"


def render_routes(openapi_schema: dict[str, Any]) -> list[str]:
    routes: list[str] = []

    for path, path_item in openapi_schema.get("paths", {}).items():
        for method in path_item:
            normalized_method = method.lower()
            if normalized_method not in HTTP_METHODS:
                continue
            routes.append(
                f"{normalized_method.upper()} {path}"
            )

    return sorted(routes)


def generate_contract() -> str:
    openapi_schema = app.openapi()
    components = (
        openapi_schema
        .get("components", {})
        .get("schemas", {})
    )

    missing = [
        name
        for name in PUBLIC_SCHEMA_NAMES
        if name not in components
    ]
    if missing:
        raise RuntimeError(
            "Expected public OpenAPI schemas are missing: "
            + ", ".join(missing)
        )

    lines = [
        "// This file is generated by backend/scripts/generate_api_contract.py.",
        "// Do not edit it by hand. Regenerate it after changing FastAPI wire schemas.",
        "",
    ]

    for name in PUBLIC_SCHEMA_NAMES:
        rendered = render_schema(components[name])
        lines.append(f"export type {name} = {rendered}")
        lines.append("")

    lines.append("export const API_ROUTES = [")
    for route in render_routes(openapi_schema):
        lines.append(f"  {quote_string(route)},")
    lines.extend(
        [
            "] as const",
            "",
            "export type ApiRoute = (typeof API_ROUTES)[number]",
            "",
        ]
    )

    return "\n".join(lines)


def check_contract(expected: str) -> int:
    if not OUTPUT_PATH.exists():
        print(
            f"Generated API contract is missing: {OUTPUT_PATH}"
        )
        return 1

    current = OUTPUT_PATH.read_text(encoding="utf-8")
    if current == expected:
        print("Generated API contract is up to date.")
        return 0

    print("Generated API contract is stale.")
    print(
        "".join(
            difflib.unified_diff(
                current.splitlines(keepends=True),
                expected.splitlines(keepends=True),
                fromfile=str(OUTPUT_PATH),
                tofile="generated",
            )
        )
    )
    print(
        "Run `cd backend && python scripts/generate_api_contract.py` "
        "and commit the updated frontend/src/types/api.generated.ts."
    )
    return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail instead of writing when the generated contract is stale.",
    )
    args = parser.parse_args()

    generated = generate_contract()

    if args.check:
        return check_contract(generated)

    OUTPUT_PATH.write_text(generated, encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
