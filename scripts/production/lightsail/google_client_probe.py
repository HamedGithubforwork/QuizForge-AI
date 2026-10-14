"""Bounded OAuth client diagnostic; never exchange a real user authorization code."""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from scripts.production.lightsail.google_provider_readiness import validate_google_credentials

ENDPOINT = "https://oauth2.googleapis.com/token"
REDIRECT = "https://quizforge-399311815467.auth.ca-central-1.amazoncognito.com/oauth2/idpresponse"
INVALID_CODE = "quizforge-diagnostic-intentionally-invalid-code"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never send the existing client secret to another origin.
        return None


def probe(client_id, secret, *, opener=None):
    if not validate_google_credentials(client_id, secret):
        raise ValueError("Protected Google credentials unavailable")
    opener = opener or urllib.request.build_opener(NoRedirect())
    payload = urllib.parse.urlencode({"client_id": client_id, "client_secret": secret,
        "code": INVALID_CODE, "grant_type": "authorization_code", "redirect_uri": REDIRECT}).encode()
    request = urllib.request.Request(ENDPOINT, data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    try:
        with opener.open(request, timeout=15) as response:
            # An impossible successful code exchange must never be displayed or accepted.
            return "unexpected_success"
    except urllib.error.HTTPError as response:
        try:
            with response:
                raw = response.read(4097)
                if len(raw) > 4096:
                    return "unclassified_response"
                body = json.loads(raw)
            error = body.get("error") if isinstance(body, dict) else None
            if response.code not in (400, 401):
                return "unclassified_response"
            return error if error in {"invalid_client", "invalid_grant", "deleted_client", "redirect_uri_mismatch"} else "unclassified_response"
        except Exception:
            return "unclassified_response"
    except Exception:
        return "network_unavailable"


def inspect(client_id, secret, *, opener=None):
    actual = probe(client_id, secret, opener=opener)
    # Negative control avoids claiming acceptance if Google checks code first.
    control = probe(client_id, "intentionally-invalid-client-secret", opener=opener)
    return {"configured_client_result": actual, "invalid_secret_control_result": control,
            "credential_check_distinguishes_secrets": actual == "invalid_grant" and control == "invalid_client"}


def main():
    try:
        result = inspect(os.getenv("PROD_GOOGLE_OAUTH_CLIENT_ID"), os.getenv("PROD_GOOGLE_OAUTH_CLIENT_SECRET"))
    except Exception:
        raise SystemExit("FAIL: Google client probe unavailable; no settings changed") from None
    print("Google synthetic-code client probe: " + json.dumps(result, sort_keys=True))
    print("No real user code, password, token, account or quiz used. No production settings changed.")


if __name__ == "__main__":
    main()
