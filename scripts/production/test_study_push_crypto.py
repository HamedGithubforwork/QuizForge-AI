import json
import struct
import unittest
from datetime import datetime, timezone

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    encode_dss_signature,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
)

from study_push_crypto import (
    b64url_decode,
    b64url_encode,
    encrypt_web_push,
    push_endpoint_allowed,
    vapid_authorization,
    vapid_public_key,
)


class StudyPushCryptoTests(unittest.TestCase):
    def test_provider_allowlist_rejects_arbitrary_or_private_hosts(self):
        for value in (
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            "https://web.push.apple.com/QPush/abc",
            "https://wns2-abc.notify.windows.com/w/?token=abc",
        ):
            with self.subTest(value=value):
                self.assertTrue(
                    push_endpoint_allowed(value)
                )

        for value in (
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://127.0.0.1/push",
            "https://localhost/push",
            "https://example.com/push",
            "https://fcm.googleapis.com.evil.invalid/push",
            "https://user:pass@fcm.googleapis.com/push",
        ):
            with self.subTest(value=value):
                self.assertFalse(
                    push_endpoint_allowed(value)
                )

    def test_vapid_signature_is_valid_es256_and_bound_to_endpoint_origin(self):
        private = ec.derive_private_key(
            7,
            ec.SECP256R1(),
        )
        now = datetime(
            2026,
            9,
            28,
            6,
            0,
            tzinfo=timezone.utc,
        )
        value = vapid_authorization(
            private,
            endpoint=(
                "https://fcm.googleapis.com/"
                "fcm/send/synthetic"
            ),
            subject=(
                "https://quizfromnotes.com"
            ),
            now=now,
        )

        self.assertTrue(
            value.startswith(
                "vapid t="
            )
        )
        token, key = (
            value.removeprefix(
                "vapid t="
            )
            .split(",k=", 1)
        )
        header_b64, claims_b64, signature_b64 = (
            token.split(".")
        )

        header = json.loads(
            b64url_decode(
                header_b64
            )
        )
        claims = json.loads(
            b64url_decode(
                claims_b64
            )
        )
        self.assertEqual(
            header,
            {
                "alg": "ES256",
                "typ": "JWT",
            },
        )
        self.assertEqual(
            claims["aud"],
            "https://fcm.googleapis.com",
        )
        self.assertEqual(
            claims["sub"],
            "https://quizfromnotes.com",
        )
        self.assertEqual(
            claims["exp"],
            int(now.timestamp())
            + 12 * 60 * 60,
        )
        self.assertEqual(
            key,
            vapid_public_key(
                private
            ),
        )

        raw = b64url_decode(
            signature_b64
        )
        self.assertEqual(
            len(raw),
            64,
        )
        r = int.from_bytes(
            raw[:32],
            "big",
        )
        s = int.from_bytes(
            raw[32:],
            "big",
        )
        der = encode_dss_signature(
            r,
            s,
        )
        signing_input = (
            header_b64
            + "."
            + claims_b64
        ).encode("ascii")
        private.public_key().verify(
            der,
            signing_input,
            ec.ECDSA(
                hashes.SHA256()
            ),
        )

    def test_aes128gcm_web_push_round_trip(self):
        receiver = (
            ec.derive_private_key(
                11,
                ec.SECP256R1(),
            )
        )
        receiver_public = (
            receiver.public_key()
            .public_bytes(
                Encoding.X962,
                PublicFormat.UncompressedPoint,
            )
        )
        auth_secret = (
            b"0123456789abcdef"
        )
        sender = (
            ec.derive_private_key(
                13,
                ec.SECP256R1(),
            )
        )
        salt = (
            b"abcdef0123456789"
        )
        payload = (
            b'{"title":"Study review ready","body":"3 cards"}'
        )

        encrypted = (
            encrypt_web_push(
                payload,
                p256dh=
                    b64url_encode(
                        receiver_public
                    ),
                auth=
                    b64url_encode(
                        auth_secret
                    ),
                salt=salt,
                sender_private=
                    sender,
                record_size=128,
            )
        )

        self.assertEqual(
            encrypted[:16],
            salt,
        )
        record_size = (
            struct.unpack(
                "!L",
                encrypted[16:20],
            )[0]
        )
        self.assertEqual(
            record_size,
            128,
        )
        key_id_length = (
            encrypted[20]
        )
        sender_public = (
            encrypted[
                21:
                21 + key_id_length
            ]
        )
        content = encrypted[
            21 + key_id_length:
        ]

        sender_public_key = (
            ec.EllipticCurvePublicKey
            .from_encoded_point(
                ec.SECP256R1(),
                sender_public,
            )
        )
        shared = (
            receiver.exchange(
                ec.ECDH(),
                sender_public_key,
            )
        )
        context = (
            b"WebPush: info\x00"
            + receiver_public
            + sender_public
        )
        ikm = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=auth_secret,
            info=context,
        ).derive(shared)
        key = HKDF(
            algorithm=hashes.SHA256(),
            length=16,
            salt=salt,
            info=(
                b"Content-Encoding: "
                b"aes128gcm\x00"
            ),
        ).derive(ikm)
        nonce = HKDF(
            algorithm=hashes.SHA256(),
            length=12,
            salt=salt,
            info=(
                b"Content-Encoding: "
                b"nonce\x00"
            ),
        ).derive(ikm)

        plaintext = bytearray()
        for counter, start in enumerate(
            range(
                0,
                len(content),
                record_size,
            )
        ):
            record = content[
                start:
                start + record_size
            ]
            suffix = int.from_bytes(
                nonce[4:],
                "big",
            )
            record_nonce = (
                nonce[:4]
                + (
                    suffix ^ counter
                ).to_bytes(
                    8,
                    "big",
                )
            )
            clear = AESGCM(
                key
            ).decrypt(
                record_nonce,
                record,
                None,
            )
            delimiter = clear[-1]
            self.assertIn(
                delimiter,
                (1, 2),
            )
            plaintext.extend(
                clear[:-1]
            )

        self.assertEqual(
            bytes(plaintext),
            payload,
        )


if __name__ == "__main__":
    unittest.main()
