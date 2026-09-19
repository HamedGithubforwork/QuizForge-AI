# Disposable frontend hosting

Run **AWS frontend staging → main → run**. The workflow builds the exact reviewed
application PR (default #97), deploys private S3 in ca-central-1 with CloudFront,
tests the public HTTPS site, and always destroys the environment. **stop** and an
hourly schedule independently repeat cleanup. There is no persistent start mode.
CloudFront deployment/deletion can take several minutes; wait for the final AWS
absence check, not just completion of the browser test. Workflow concurrency keeps
cleanup and deployment serialized. A one-hour edge expiry also denies access if
a runner is lost; expiry alone is not a substitute for resource deletion.

This is a **hosting-only** test. It renders the reviewed React staging sign-in
screen using synthetic Cognito settings and reserved `.invalid` API endpoints.
No real authentication provider or API is connected. Do not attempt signup here.
The build strips environment files, passes only explicit build environment values,
and has no production credentials. CSP blocks all API connections. Full Cognito
login/enrollment/recovery was tested separately. Connecting this frontend to a
real HTTPS API is a subsequent milestone; the HTTP staging ALB cannot be used
from an HTTPS browser. Application PR #97 remains unmerged to preserve production.

The S3 origin uses BucketOwnerEnforced, all four public access blocks, SSE-S3 and
a bucket policy permitting only this CloudFront distribution to read objects.
OAC always signs origin requests (HTTPS). Viewer HTTP redirects to HTTPS using
the default CloudFront certificate. There are no custom domains yet. The response
policy sets CSP, HSTS, no-referrer, nosniff, frame denial, permissions restrictions
and noindex. Only the existing `/auth/callback` SPA path is rewritten; missing
assets/API routes do not turn into successful HTML responses. HTML is not cached;
content-hashed assets are immutable. No broad error-page fallback is configured.

PR validation tests artifact/path/size guards, cleanup error handling, route
selection and expiry, Terraform and the reviewed application build. Live checks
inspect the actual AWS bucket policy/encryption/OAC, then independently test
anonymous S3 denial, HTTPS redirect, headers, callback routing, missing paths,
build hashes, CloudFront cache hit, desktop/mobile rendering, no external requests
and no CSP violations. Browser validation runs without AWS credentials on its own
runner. It makes no OpenAI calls and does not use production data.

Cost: standard pay-as-you-go CloudFront, PriceClass_100, a small S3 Standard build,
and one viewer-request CloudFront Function. No monthly savings commitment or paid
bundle, WAF, Origin Shield, real-time logs, NAT, compute, DB or cache is created.
For this brief low-traffic test, expect cents or less before credits, subject to
account-wide usage. CloudFront currently includes 1 TB transfer, 10 million
HTTP(S) requests and 2 million function invocations monthly; these allowances are
shared across the account. S3 storage/PUT/GET and retained remote-state versions
can still incur small charges. Check actual billing rather than assuming zero.

References: [CloudFront pay-as-you-go](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/),
[S3 pricing](https://aws.amazon.com/s3/pricing/),
[OAC and private S3](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html).
