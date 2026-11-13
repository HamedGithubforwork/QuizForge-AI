"""Direct-only HTTP helper for synthetic probes against local runtime services."""
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class _RejectRedirects(HTTPRedirectHandler):
    """Keep loopback probes on their explicitly selected endpoint."""

    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


_LOOPBACK_OPENER = build_opener(ProxyHandler({}), _RejectRedirects())


def open_loopback(request, timeout):
    """Open only direct HTTP requests to the runtime's literal loopback host."""
    if isinstance(request, str):
        request = Request(request)
    parsed = urlsplit(request.full_url)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1':
        raise ValueError('Runtime rehearsal requests must target HTTP loopback')
    return _LOOPBACK_OPENER.open(request, timeout=timeout)
