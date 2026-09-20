"""Test-only authentication adapter; isolated image, no external network.

Production source is unchanged. This laboratory measures resource use, not
Cognito delivery, identity proofs, production TLS or external model latency.
"""
import os
from pathlib import Path

if not Path('/capacity-test-image').is_file() or os.environ.get('CAPACITY_TEST_ONLY') != 'synthetic-no-network':
    raise RuntimeError('Capacity adapters may run only in the isolated test image')

from fastapi import Header, HTTPException
from app_shared import AuthenticatedUser, get_current_user
from main import app


async def synthetic_user(authorization: str | None = Header(default=None)):
    if authorization not in ('Bearer capacity-1', 'Bearer capacity-2'):
        raise HTTPException(401, 'Synthetic capacity credential required')
    number = int(authorization[-1])
    from uuid import UUID
    subject = str(UUID(int=number))
    return AuthenticatedUser(id='cognito:ca-central-1_Capacity:' + subject,
                             provider='cognito', subject=subject,
                             issuer='https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Capacity')


app.dependency_overrides[get_current_user] = synthetic_user
