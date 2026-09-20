"""No logging, network, automatic confirmation or email-verification bypass."""
import hashlib
import hmac
import os

SYNTHETIC = {f"qf-browser-{name}@example.invalid" for name in ("mapped", "unmapped", "unverified")}


def handler(event, context):
    email = event.get("request", {}).get("userAttributes", {}).get("email", "")
    if not isinstance(email, str):
        raise ValueError("Signup is not allowed for this rehearsal")
    email = email.strip().lower()
    trigger = event.get("triggerSource")
    allowed = os.getenv("ALLOWED_EMAIL_SHA256", "")
    if trigger == "PreSignUp_AdminCreateUser" and email in SYNTHETIC:
        return event
    if (trigger == "PreSignUp_SignUp" and len(allowed) == 64
            and hmac.compare_digest(hashlib.sha256(email.encode()).hexdigest(), allowed)):
        return event
    raise ValueError("Signup is not allowed for this rehearsal")
