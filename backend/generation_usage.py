from typing import Literal

from pydantic import BaseModel

from observability import record_generation_provider_metric


class LocalGenerationEvent(BaseModel):
    kind: Literal[
        "quiz",
        "targeted_practice",
    ]


async def record_local_generation_event(
    client,
    event: LocalGenerationEvent,
):
    metric_event = (
        "quiz_completed"
        if event.kind == "quiz"
        else "targeted_practice_completed"
    )
    await record_generation_provider_metric(
        client,
        provider="local",
        event=metric_event,
    )
