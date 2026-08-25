import math
import re
import unicodedata
from typing import Any


QUESTION_TYPES = (
    "multiple_choice",
    "true_false",
    "short_answer",
)

SPELLING_EQUIVALENTS = {
    "behavioural": "behavioral",
    "behaviour": "behavior",
    "behaviours": "behaviors",
    "colour": "color",
    "colours": "colors",
    "organisation": "organization",
    "organisations": "organizations",
    "organised": "organized",
    "organising": "organizing",
    "analyse": "analyze",
    "analysed": "analyzed",
    "analysing": "analyzing",
}

NUMBER_PATTERN = re.compile(
    r"[-+]?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?",
    re.IGNORECASE,
)


def _linear_unit(
    dimension: str,
    factor: float,
):
    return {
        "dimension": dimension,
        "to_base": lambda value: value * factor,
        "from_base": lambda value: value / factor,
    }


UNIT_DEFINITIONS = {
    "kg": _linear_unit("mass", 1000),
    "g": _linear_unit("mass", 1),
    "mg": _linear_unit("mass", 0.001),
    "ug": _linear_unit("mass", 0.000001),
    "km": _linear_unit("length", 1000),
    "m": _linear_unit("length", 1),
    "cm": _linear_unit("length", 0.01),
    "mm": _linear_unit("length", 0.001),
    "um": _linear_unit("length", 0.000001),
    "l": _linear_unit("volume", 1),
    "ml": _linear_unit("volume", 0.001),
    "ul": _linear_unit("volume", 0.000001),
    "h": _linear_unit("time", 3600),
    "min": _linear_unit("time", 60),
    "s": _linear_unit("time", 1),
    "ms": _linear_unit("time", 0.001),
    "day": _linear_unit("time", 86400),
    "week": _linear_unit("time", 604800),
    "percent": _linear_unit("percentage", 1),
    "celsius": {
        "dimension": "temperature",
        "to_base": lambda value: value,
        "from_base": lambda value: value,
    },
    "fahrenheit": {
        "dimension": "temperature",
        "to_base": lambda value: ((value - 32) * 5) / 9,
        "from_base": lambda value: (value * 9) / 5 + 32,
    },
}

UNIT_ALIASES = {
    "kg": "kg",
    "kilogram": "kg",
    "kilograms": "kg",
    "g": "g",
    "gram": "g",
    "grams": "g",
    "mg": "mg",
    "milligram": "mg",
    "milligrams": "mg",
    "ug": "ug",
    "mcg": "ug",
    "microgram": "ug",
    "micrograms": "ug",
    "km": "km",
    "kilometer": "km",
    "kilometers": "km",
    "kilometre": "km",
    "kilometres": "km",
    "m": "m",
    "meter": "m",
    "meters": "m",
    "metre": "m",
    "metres": "m",
    "cm": "cm",
    "centimeter": "cm",
    "centimeters": "cm",
    "centimetre": "cm",
    "centimetres": "cm",
    "mm": "mm",
    "millimeter": "mm",
    "millimeters": "mm",
    "millimetre": "mm",
    "millimetres": "mm",
    "um": "um",
    "micrometer": "um",
    "micrometers": "um",
    "micrometre": "um",
    "micrometres": "um",
    "l": "l",
    "liter": "l",
    "liters": "l",
    "litre": "l",
    "litres": "l",
    "ml": "ml",
    "milliliter": "ml",
    "milliliters": "ml",
    "millilitre": "ml",
    "millilitres": "ml",
    "ul": "ul",
    "microliter": "ul",
    "microliters": "ul",
    "microlitre": "ul",
    "microlitres": "ul",
    "h": "h",
    "hr": "h",
    "hrs": "h",
    "hour": "h",
    "hours": "h",
    "min": "min",
    "mins": "min",
    "minute": "min",
    "minutes": "min",
    "s": "s",
    "sec": "s",
    "secs": "s",
    "second": "s",
    "seconds": "s",
    "ms": "ms",
    "millisecond": "ms",
    "milliseconds": "ms",
    "day": "day",
    "days": "day",
    "week": "week",
    "weeks": "week",
    "%": "percent",
    "percent": "percent",
    "percentage": "percent",
    "c": "celsius",
    "°c": "celsius",
    "celsius": "celsius",
    "degreecelsius": "celsius",
    "degreescelsius": "celsius",
    "f": "fahrenheit",
    "°f": "fahrenheit",
    "fahrenheit": "fahrenheit",
    "degreefahrenheit": "fahrenheit",
    "degreesfahrenheit": "fahrenheit",
}


def normalize_answer_text(value: str) -> str:
    normalized = unicodedata.normalize(
        "NFKD",
        value,
    )
    normalized = "".join(
        character
        for character in normalized
        if not unicodedata.combining(character)
    )
    normalized = normalized.lower()
    normalized = re.sub(
        r"[-–—/]",
        " ",
        normalized,
    )
    normalized = re.sub(
        r"[^a-z0-9.%+\-\s]",
        " ",
        normalized,
    )
    words = [
        SPELLING_EQUIVALENTS.get(word, word)
        for word in normalized.split()
    ]
    return " ".join(words)


def _normalize_unit_text(value: str) -> str:
    normalized = unicodedata.normalize(
        "NFKC",
        value,
    ).lower()
    normalized = normalized.replace("μ", "u")
    normalized = normalized.replace("µ", "u")
    normalized = normalized.replace("º", "°")
    normalized = re.sub(
        r"[.,;:!?()\[\]{}]",
        " ",
        normalized,
    )
    return " ".join(normalized.split())


def _compact_unit_text(value: str) -> str:
    return _normalize_unit_text(value).replace(
        " ",
        "",
    )


def _resolve_known_unit(value: str):
    return UNIT_ALIASES.get(
        _compact_unit_text(value)
    )


def _parse_numeric_measurement(
    answer: str,
    expected_unit_raw: str,
):
    match = NUMBER_PATTERN.search(answer)

    if not match:
        return None

    try:
        value = float(
            match.group(0).replace(",", "")
        )
    except ValueError:
        return None

    if not math.isfinite(value):
        return None

    provided_unit_text = answer[
        match.end():
    ].strip()
    expected_unit = expected_unit_raw.strip()

    if not expected_unit:
        if provided_unit_text:
            return None
        return value

    if not provided_unit_text:
        return None

    expected_known = _resolve_known_unit(
        expected_unit
    )
    provided_known = _resolve_known_unit(
        provided_unit_text
    )

    if expected_known:
        if not provided_known:
            return None

        expected_definition = (
            UNIT_DEFINITIONS[expected_known]
        )
        provided_definition = (
            UNIT_DEFINITIONS[provided_known]
        )

        if (
            expected_definition["dimension"]
            != provided_definition["dimension"]
        ):
            return None

        base_value = provided_definition[
            "to_base"
        ](value)
        return expected_definition[
            "from_base"
        ](base_value)

    if (
        _compact_unit_text(provided_unit_text)
        != _compact_unit_text(expected_unit)
    ):
        return None

    return value


def _numeric_answer_matches(
    answer: str,
    expected_value: float,
    tolerance: float,
    expected_unit: str,
) -> bool:
    converted_value = _parse_numeric_measurement(
        answer,
        expected_unit,
    )

    if converted_value is None:
        return False

    absolute_tolerance = max(
        tolerance,
        1e-9 * max(1, abs(expected_value)),
    )

    return (
        abs(converted_value - expected_value)
        <= absolute_tolerance
    )


def _phrase_matches(
    answer: str,
    alias: str,
) -> bool:
    answer_tokens = normalize_answer_text(
        answer
    ).split()
    alias_tokens = normalize_answer_text(
        alias
    ).split()

    if (
        not alias_tokens
        or len(answer_tokens) < len(alias_tokens)
    ):
        return False

    window_size = len(alias_tokens)

    return any(
        answer_tokens[start:start + window_size]
        == alias_tokens
        for start in range(
            len(answer_tokens) - window_size + 1
        )
    )


def _matched_concept_groups(
    answer: str,
    groups: list[list[str]],
) -> int:
    return sum(
        1
        for group in groups
        if any(
            _phrase_matches(answer, alias)
            for alias in group
        )
    )


def _clean_answer_groups(
    groups: list[list[str]],
):
    return [
        [
            alias.strip()
            for alias in group
            if isinstance(alias, str)
            and alias.strip()
        ]
        for group in groups
    ]


def _validate_grading(
    question: Any,
    question_number: int,
) -> list[str]:
    errors: list[str] = []
    grading = question.grading
    prefix = f"Question {question_number}"

    if question.question_type != "short_answer":
        if grading.grading_mode != "none":
            errors.append(
                f"{prefix} uses grading on a non-short-answer question."
            )
        if grading.answer_groups:
            errors.append(
                f"{prefix} has answer groups on a non-short-answer question."
            )
        if grading.required_group_count != 0:
            errors.append(
                f"{prefix} has a non-zero required concept count outside concept grading."
            )
        if (
            grading.numeric_value != 0
            or grading.numeric_tolerance != 0
            or grading.numeric_unit.strip()
        ):
            errors.append(
                f"{prefix} has numeric rubric data on a non-short-answer question."
            )
        return errors

    if grading.grading_mode == "none":
        errors.append(
            f"{prefix} has no short-answer grading mode."
        )
        return errors

    if grading.grading_mode == "concepts":
        clean_groups = _clean_answer_groups(
            grading.answer_groups
        )

        if (
            not clean_groups
            or any(not group for group in clean_groups)
        ):
            errors.append(
                f"{prefix} has an empty concept group."
            )
            return errors

        if not (
            1
            <= grading.required_group_count
            <= len(clean_groups)
        ):
            errors.append(
                f"{prefix} has an invalid required concept count."
            )

        seen_aliases: dict[str, int] = {}

        for group_index, group in enumerate(
            clean_groups,
        ):
            for alias in group:
                normalized_alias = (
                    normalize_answer_text(alias)
                )

                if not normalized_alias:
                    errors.append(
                        f"{prefix} has an empty concept alias."
                    )
                    continue

                previous_group = seen_aliases.get(
                    normalized_alias
                )

                if (
                    previous_group is not None
                    and previous_group != group_index
                ):
                    errors.append(
                        f"{prefix} reuses the same alias across different concept groups."
                    )
                elif previous_group is None:
                    seen_aliases[
                        normalized_alias
                    ] = group_index

        if (
            grading.numeric_value != 0
            or grading.numeric_tolerance != 0
            or grading.numeric_unit.strip()
        ):
            errors.append(
                f"{prefix} mixes concept and numeric grading data."
            )

        required = grading.required_group_count

        if required >= 1:
            if (
                _matched_concept_groups(
                    question.correct_answer,
                    clean_groups,
                )
                < required
            ):
                errors.append(
                    f"{prefix} correct_answer does not satisfy its concept rubric."
                )

            for accepted_answer in (
                question.accepted_answers
            ):
                if (
                    _matched_concept_groups(
                        accepted_answer,
                        clean_groups,
                    )
                    < required
                ):
                    errors.append(
                        f"{prefix} contains a partially correct accepted answer."
                    )
                    break

        return errors

    if grading.answer_groups:
        errors.append(
            f"{prefix} has answer groups outside concept grading."
        )

    if grading.required_group_count != 0:
        errors.append(
            f"{prefix} has a required concept count outside concept grading."
        )

    if grading.grading_mode == "exact":
        if (
            grading.numeric_value != 0
            or grading.numeric_tolerance != 0
            or grading.numeric_unit.strip()
        ):
            errors.append(
                f"{prefix} mixes exact and numeric grading data."
            )

        return errors

    if grading.grading_mode == "numeric":
        if not math.isfinite(
            grading.numeric_value
        ):
            errors.append(
                f"{prefix} has a non-finite numeric target."
            )
            return errors

        if not math.isfinite(
            grading.numeric_tolerance
        ):
            errors.append(
                f"{prefix} has a non-finite numeric tolerance."
            )
            return errors

        if not _numeric_answer_matches(
            question.correct_answer,
            grading.numeric_value,
            grading.numeric_tolerance,
            grading.numeric_unit,
        ):
            errors.append(
                f"{prefix} correct_answer does not satisfy its numeric rubric."
            )

        for accepted_answer in (
            question.accepted_answers
        ):
            if not _numeric_answer_matches(
                accepted_answer,
                grading.numeric_value,
                grading.numeric_tolerance,
                grading.numeric_unit,
            ):
                errors.append(
                    f"{prefix} contains an accepted answer that does not satisfy its numeric rubric."
                )
                break

        return errors

    errors.append(
        f"{prefix} has an unsupported grading mode."
    )
    return errors


def get_quiz_validation_errors(
    quiz: Any,
    *,
    question_count: int,
    requested_question_type: str,
    page_count: int,
) -> list[str]:
    errors: list[str] = []

    if not quiz.title.strip():
        errors.append(
            "The quiz title is empty."
        )

    if len(quiz.questions) != question_count:
        errors.append(
            "The quiz has the wrong number of questions."
        )

    valid_pages = set(
        range(1, page_count + 1)
    )
    types_found = set()
    seen_questions = set()

    for question_number, question in enumerate(
        quiz.questions,
        start=1,
    ):
        prefix = f"Question {question_number}"
        types_found.add(
            question.question_type
        )

        normalized_question = (
            normalize_answer_text(
                question.question
            )
        )

        if not normalized_question:
            errors.append(
                f"{prefix} has empty question text."
            )
        elif normalized_question in seen_questions:
            errors.append(
                f"{prefix} duplicates another question."
            )
        else:
            seen_questions.add(
                normalized_question
            )

        if not question.correct_answer.strip():
            errors.append(
                f"{prefix} has an empty correct answer."
            )

        if not question.explanation.strip():
            errors.append(
                f"{prefix} has an empty explanation."
            )

        clean_accepted = [
            answer.strip()
            for answer in question.accepted_answers
            if isinstance(answer, str)
            and answer.strip()
        ]

        if not clean_accepted:
            errors.append(
                f"{prefix} has no accepted answers."
            )
        else:
            normalized_accepted = [
                normalize_answer_text(answer)
                for answer in clean_accepted
            ]

            if len(set(normalized_accepted)) != len(
                normalized_accepted
            ):
                errors.append(
                    f"{prefix} contains duplicate accepted answers."
                )

            if (
                normalize_answer_text(
                    question.correct_answer
                )
                not in set(normalized_accepted)
            ):
                errors.append(
                    f"{prefix} accepted_answers does not include correct_answer."
                )

        if (
            not question.source_pages
            or len(set(question.source_pages))
            != len(question.source_pages)
            or not set(
                question.source_pages
            ).issubset(valid_pages)
        ):
            errors.append(
                f"{prefix} has invalid source pages."
            )

        if (
            requested_question_type != "mixed"
            and question.question_type
            != requested_question_type
        ):
            errors.append(
                f"{prefix} has the wrong requested question type."
            )

        if question.question_type == "multiple_choice":
            normalized_choices = [
                normalize_answer_text(choice)
                for choice in question.choices
            ]

            if (
                len(question.choices) != 4
                or any(
                    not normalized
                    for normalized in normalized_choices
                )
            ):
                errors.append(
                    f"{prefix} does not contain four non-empty choices."
                )
            elif len(set(normalized_choices)) != 4:
                errors.append(
                    f"{prefix} contains duplicate multiple-choice options."
                )

            if question.correct_index not in range(4):
                errors.append(
                    f"{prefix} has an invalid multiple-choice correct index."
                )
            elif (
                len(question.choices) == 4
                and question.correct_answer
                != question.choices[
                    question.correct_index
                ]
            ):
                errors.append(
                    f"{prefix} correct_answer does not match the indexed choice."
                )

        elif question.question_type == "true_false":
            if question.choices != [
                "True",
                "False",
            ]:
                errors.append(
                    f"{prefix} has invalid True / False choices."
                )

            if question.correct_index not in [0, 1]:
                errors.append(
                    f"{prefix} has an invalid True / False correct index."
                )
            elif (
                len(question.choices) == 2
                and question.correct_answer
                != question.choices[
                    question.correct_index
                ]
            ):
                errors.append(
                    f"{prefix} correct_answer does not match the True / False index."
                )

        elif question.question_type == "short_answer":
            if question.choices:
                errors.append(
                    f"{prefix} has choices on a short-answer question."
                )

            if question.correct_index != -1:
                errors.append(
                    f"{prefix} has an invalid short-answer correct index."
                )

        else:
            errors.append(
                f"{prefix} has an unsupported question type."
            )

        errors.extend(
            _validate_grading(
                question,
                question_number,
            )
        )

    if requested_question_type == "mixed":
        if not set(QUESTION_TYPES).issubset(
            types_found
        ):
            errors.append(
                "A mixed quiz does not contain all three question types."
            )

    return errors
