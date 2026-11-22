"""Direct-only HTTP helper for synthetic probes against local runtime services."""
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from http.client import HTTPConnection, HTTPException


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


def post_loopback(path, body, host_header, timeout, port=80):
    """POST bytes directly to loopback with one explicit virtual-host header."""
    connection = HTTPConnection('127.0.0.1', port, timeout=timeout)
    send_error = None
    try:
        # HTTPConnection normally inserts Host itself; skip it before setting
        # the virtual host required by the local Caddy route.
        connection.putrequest('POST', path, skip_host=True)
        connection.putheader('Host', host_header)
        connection.putheader('Content-Type', 'application/json')
        connection.putheader('Content-Length', str(len(body)))
        try:
            connection.endheaders()
            connection.send(body)
        except OSError as error:
            send_error = error

        try:
            response = connection.getresponse()
        except (HTTPException, OSError, TimeoutError) as error:
            if send_error is not None:
                raise AssertionError(
                    'Boundary POST failed before an HTTP status was readable'
                ) from send_error
            raise AssertionError(
                'Boundary POST completed without a readable HTTP status'
            ) from error

        status = response.status
        try:
            response_body = response.read()
        except (HTTPException, OSError, TimeoutError) as error:
            raise AssertionError(
                f'Boundary POST received HTTP {status} but not the complete response body'
            ) from error
        return status, response_body
    finally:
        connection.close()
