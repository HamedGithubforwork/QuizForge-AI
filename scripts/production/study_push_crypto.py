"""Minimal RFC 8188 Web Push encryption and RFC 8292 VAPID helpers.

Uses only the already-reviewed cryptography dependency. The implementation is
purposefully limited to modern aes128gcm Web Push payloads.
"""

from __future__ import annotations

import base64
import json
import os
import struct
from datetime import datetime, timezone
from urllib.parse import urlparse

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
)


KEY_LENGTH = 16
NONCE_LENGTH = 12
DEFAULT_RECORD_SIZE = 4096
MAX_PAYLOAD_BYTES = 3000
VAPID_TTL_SECONDS = 12 * 60 * 60

_ALLOWED_EXACT_HOSTS = {
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
}


def b64url_encode(value: bytes) -> str:
    return (
        base64.urlsafe_b64encode(value)
        .rstrip(b"=")
        .decode("ascii")
    )


def b64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(
        value + padding
    )


def push_endpoint_allowed(endpoint: str) -> bool:
    try:
        parsed = urlparse(endpoint)
        host = (
            parsed.hostname or ""
        ).lower()
    except ValueError:
        return False

    if (
        parsed.scheme != "https"
        or not host
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        return False

    return (
        host in _ALLOWED_EXACT_HOSTS
        or host.endswith(
            ".notify.windows.com"
        )
    )


def _public_bytes(
    private_key: ec.EllipticCurvePrivateKey,
) -> bytes:
    return (
        private_key.public_key()
        .public_bytes(
            Encoding.X962,
            PublicFormat.UncompressedPoint,
        )
    )


def vapid_private_key_from_string(
    value: str,
) -> ec.EllipticCurvePrivateKey:
    raw = b64url_decode(
        value.strip()
    )
    if len(raw) != 32:
        raise ValueError(
            "VAPID private key must be 32 bytes."
        )

    number = int.from_bytes(
        raw,
        "big",
    )
    if number <= 0:
        raise ValueError(
            "VAPID private key is invalid."
        )

    try:
        return ec.derive_private_key(
            number,
            ec.SECP256R1(),
        )
    except ValueError as error:
        raise ValueError(
            "VAPID private key is invalid."
        ) from error


def vapid_public_key(
    private_key: ec.EllipticCurvePrivateKey,
) -> str:
    return b64url_encode(
        _public_bytes(
            private_key
        )
    )


def vapid_authorization(
    private_key: ec.EllipticCurvePrivateKey,
    *,
    endpoint: str,
    subject: str,
    now: datetime | None = None,
) -> str:
    if not push_endpoint_allowed(
        endpoint
    ):
        raise ValueError(
            "Push endpoint is outside the supported provider boundary."
        )

    parsed = urlparse(endpoint)
    audience = (
        f"{parsed.scheme}://"
        f"{parsed.netloc}"
    )
    current = (
        datetime.now(timezone.utc)
        if now is None
        else now.astimezone(
            timezone.utc
        )
    )

    header = {
        "alg": "ES256",
        "typ": "JWT",
    }
    claims = {
        "aud": audience,
        "exp": (
            int(
                current.timestamp()
            )
            + VAPID_TTL_SECONDS
        ),
        "sub": subject,
    }

    def encode_json(
        value: dict,
    ) -> str:
        return b64url_encode(
            json.dumps(
                value,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        )

    encoded_header = encode_json(
        header
    )
    encoded_claims = encode_json(
        claims
    )
    signing_input = (
        encoded_header
        + "."
        + encoded_claims
    ).encode("ascii")

    der_signature = (
        private_key.sign(
            signing_input,
            ec.ECDSA(
                hashes.SHA256()
            ),
        )
    )
    r, s = decode_dss_signature(
        der_signature
    )
    raw_signature = (
        r.to_bytes(32, "big")
        + s.to_bytes(32, "big")
    )
    token = (
        signing_input.decode(
            "ascii"
        )
        + "."
        + b64url_encode(
            raw_signature
        )
    )

    return (
        "vapid "
        f"t={token},"
        f"k={vapid_public_key(private_key)}"
    )


def _derive_keys(
    *,
    sender_private:
        ec.EllipticCurvePrivateKey,
    receiver_public_bytes: bytes,
    auth_secret: bytes,
    salt: bytes,
) -> tuple[bytes, bytes, bytes]:
    if len(salt) != 16:
        raise ValueError(
            "Web Push salt must be 16 bytes."
        )
    if len(receiver_public_bytes) != 65:
        raise ValueError(
            "Push receiver key must be an uncompressed P-256 point."
        )
    if (
        not receiver_public_bytes
        or receiver_public_bytes[0]
        != 4
    ):
        raise ValueError(
            "Push receiver key is invalid."
        )
    if not auth_secret:
        raise ValueError(
            "Push authentication secret is missing."
        )

    receiver_public = (
        ec.EllipticCurvePublicKey
        .from_encoded_point(
            ec.SECP256R1(),
            receiver_public_bytes,
        )
    )
    sender_public_bytes = (
        _public_bytes(
            sender_private
        )
    )

    shared_secret = (
        sender_private.exchange(
            ec.ECDH(),
            receiver_public,
        )
    )
    context = (
        b"WebPush: info\x00"
        + receiver_public_bytes
        + sender_public_bytes
    )
    input_key_material = (
        HKDF(
            algorithm=
                hashes.SHA256(),
            length=32,
            salt=auth_secret,
            info=context,
        )
        .derive(shared_secret)
    )
    content_key = (
        HKDF(
            algorithm=
                hashes.SHA256(),
            length=KEY_LENGTH,
            salt=salt,
            info=(
                b"Content-Encoding: "
                b"aes128gcm\x00"
            ),
        )
        .derive(
            input_key_material
        )
    )
    nonce = (
        HKDF(
            algorithm=
                hashes.SHA256(),
            length=NONCE_LENGTH,
            salt=salt,
            info=(
                b"Content-Encoding: "
                b"nonce\x00"
            ),
        )
        .derive(
            input_key_material
        )
    )
    return (
        content_key,
        nonce,
        sender_public_bytes,
    )


def _nonce_for_record(
    base: bytes,
    counter: int,
) -> bytes:
    if (
        len(base) != NONCE_LENGTH
        or counter < 0
        or counter >= 2**64
    ):
        raise ValueError(
            "Invalid Web Push nonce counter."
        )

    prefix = base[:4]
    suffix = int.from_bytes(
        base[4:],
        "big",
    )
    return (
        prefix
        + (
            suffix ^ counter
        ).to_bytes(8, "big")
    )


def encrypt_web_push(
    payload: bytes,
    *,
    p256dh: str,
    auth: str,
    salt: bytes | None = None,
    sender_private:
        ec.EllipticCurvePrivateKey
        | None = None,
    record_size: int =
        DEFAULT_RECORD_SIZE,
) -> bytes:
    if (
        not payload
        or len(payload)
        > MAX_PAYLOAD_BYTES
    ):
        raise ValueError(
            "Web Push payload size is invalid."
        )
    if (
        record_size <= 17
        or record_size
        > 2**31 - 1
    ):
        raise ValueError(
            "Web Push record size is invalid."
        )

    receiver = b64url_decode(
        p256dh
    )
    auth_secret = b64url_decode(
        auth
    )
    salt_value = (
        os.urandom(16)
        if salt is None
        else salt
    )
    ephemeral = (
        ec.generate_private_key(
            ec.SECP256R1()
        )
        if sender_private is None
        else sender_private
    )

    key, nonce, sender_public = (
        _derive_keys(
            sender_private=
                ephemeral,
            receiver_public_bytes=
                receiver,
            auth_secret=
                auth_secret,
            salt=salt_value,
        )
    )

    chunk_size = (
        record_size - 17
    )
    encrypted = bytearray()

    for counter, start in enumerate(
        range(
            0,
            len(payload),
            chunk_size,
        )
    ):
        chunk = payload[
            start:
            start + chunk_size
        ]
        last = (
            start + chunk_size
            >= len(payload)
        )
        plaintext = (
            chunk
            + (
                b"\x02"
                if last
                else b"\x01"
            )
        )
        encrypted.extend(
            AESGCM(key).encrypt(
                _nonce_for_record(
                    nonce,
                    counter,
                ),
                plaintext,
                None,
            )
        )

    if len(sender_public) > 255:
        raise ValueError(
            "Web Push key identifier is too long."
        )

    return (
        salt_value
        + struct.pack(
            "!L",
            record_size,
        )
        + struct.pack(
            "!B",
            len(sender_public),
        )
        + sender_public
        + bytes(encrypted)
    )
