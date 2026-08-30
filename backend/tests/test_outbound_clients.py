import asyncio

import outbound_clients


class FakeHttpClient:
    def __init__(self, *, timeout):
        self.timeout = timeout
        self.is_closed = False
        self.close_count = 0

    async def aclose(self):
        self.close_count += 1
        self.is_closed = True


class FakeOpenAIClient:
    def __init__(self, *, api_key):
        self.api_key = api_key
        self.close_count = 0

    async def close(self):
        self.close_count += 1


def test_outbound_clients_are_reused_and_closed(
    monkeypatch,
):
    http_clients = []
    openai_clients = []

    def make_http_client(*, timeout):
        client = FakeHttpClient(
            timeout=timeout,
        )
        http_clients.append(client)
        return client

    def make_openai_client(*, api_key):
        client = FakeOpenAIClient(
            api_key=api_key,
        )
        openai_clients.append(client)
        return client

    monkeypatch.setattr(
        outbound_clients.httpx,
        "AsyncClient",
        make_http_client,
    )
    monkeypatch.setattr(
        outbound_clients,
        "AsyncOpenAI",
        make_openai_client,
    )

    async def exercise_clients():
        await outbound_clients.close_outbound_clients()

        first_http = (
            await outbound_clients.get_http_client()
        )
        second_http = (
            await outbound_clients.get_http_client()
        )

        first_openai = (
            await outbound_clients.get_openai_client(
                "test-key",
            )
        )
        second_openai = (
            await outbound_clients.get_openai_client(
                "test-key",
            )
        )

        assert first_http is second_http
        assert first_openai is second_openai
        assert len(http_clients) == 1
        assert len(openai_clients) == 1

        replacement_openai = (
            await outbound_clients.get_openai_client(
                "replacement-key",
            )
        )

        assert replacement_openai is not first_openai
        assert len(openai_clients) == 2
        assert first_openai.close_count == 1

        await outbound_clients.close_outbound_clients()

        assert first_http.close_count == 1
        assert replacement_openai.close_count == 1

    asyncio.run(
        exercise_clients()
    )
