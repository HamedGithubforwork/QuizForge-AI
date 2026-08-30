import asyncio
import os

import httpx
from openai import AsyncOpenAI


HTTP_TIMEOUT_SECONDS = 8.0

_http_client: httpx.AsyncClient | None = None
_openai_client: AsyncOpenAI | None = None
_openai_client_api_key: str | None = None
_client_lock = asyncio.Lock()


async def get_http_client():
    global _http_client

    if (
        _http_client is not None
        and not _http_client.is_closed
    ):
        return _http_client

    async with _client_lock:
        if (
            _http_client is None
            or _http_client.is_closed
        ):
            _http_client = httpx.AsyncClient(
                timeout=HTTP_TIMEOUT_SECONDS,
            )

        return _http_client


async def get_openai_client(
    api_key: str,
):
    global _openai_client
    global _openai_client_api_key

    normalized_api_key = api_key.strip()

    if not normalized_api_key:
        raise ValueError(
            "An OpenAI API key is required."
        )

    if (
        _openai_client is not None
        and _openai_client_api_key
        == normalized_api_key
    ):
        return _openai_client

    async with _client_lock:
        if (
            _openai_client is not None
            and _openai_client_api_key
            == normalized_api_key
        ):
            return _openai_client

        previous_client = _openai_client

        _openai_client = AsyncOpenAI(
            api_key=normalized_api_key,
        )
        _openai_client_api_key = (
            normalized_api_key
        )

        if previous_client is not None:
            await previous_client.close()

        return _openai_client


async def start_outbound_clients():
    await get_http_client()

    api_key = os.getenv(
        "OPENAI_API_KEY",
        "",
    ).strip()

    if api_key:
        await get_openai_client(
            api_key,
        )


async def close_outbound_clients():
    global _http_client
    global _openai_client
    global _openai_client_api_key

    async with _client_lock:
        http_client = _http_client
        openai_client = _openai_client

        _http_client = None
        _openai_client = None
        _openai_client_api_key = None

    if http_client is not None:
        await http_client.aclose()

    if openai_client is not None:
        await openai_client.close()
