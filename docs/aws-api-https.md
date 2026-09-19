# Staging API HTTPS preparation

The existing production Vercel, Render and Supabase services remain unchanged.
Application PR #97 remains unmerged. This prepares HTTPS for the disposable AWS
ALB; it does not claim that the CloudFront/Cognito/backend browser flow has been
integrated or validated yet.

## Read-only inventory

Use **AWS staging environment → main → inspect-https**. This operation uses GitHub
OIDC with a read-only session policy to count public Route 53 zones, registered
domains, and ACM certificates in ca-central-1 and us-east-1. It does not initialize
Terraform state or create/modify DNS, certificates, or staging resources. Unrelated
domain names and contact data are not published in logs. A successful inventory is
not a successful live HTTPS validation; the output explicitly reports readiness.

## Domain prerequisites

The user must choose a domain they control. No domain purchase, nameserver change,
hosted-zone creation, or certificate request is automated by this PR. Prepare a
dedicated **staging-api.<owned-domain>** hostname, a delegated public Route 53 zone,
and an issued, non-exportable public ACM certificate covering that hostname in
**ca-central-1**. CloudFront custom certificates later require **us-east-1**.
The current default CloudFront hostname already has AWS-managed HTTPS.

Set these repository **variables**, not secrets, after choosing and validating DNS:

| Variable | Value |
| --- | --- |
| `AWS_STAGING_API_HOSTNAME` | Dedicated `staging-api` hostname |
| `AWS_STAGING_CERTIFICATE_ARN` | Existing issued ca-central-1 ACM certificate ARN |
| `AWS_STAGING_ZONE_ID` | Existing public zone ID, starting with `Z` |

The workflow refuses a partial configuration, wrong region/account, private or
unissued certificate, expiry within seven days, hostname mismatch, private/wrong
zone, or an existing record of any type at the proposed staging hostname. Existing
DNS records are never overwritten. The certificate and zone are prerequisites
retained outside ephemeral staging; the temporary ALB alias is destroyed on stop.

## On-demand validation

After prerequisites are ready, run **main → start → https_validation=true** with
functional/history validation unchecked. This mode performs no OpenAI calls.
Readiness is checked before paid resources are started. TLS 1.2/1.3 is enabled on
443; HTTP redirects preserve path/query and use a fixed canonical staging host.
Unknown HTTPS Host headers receive 404. Private Valkey and the application security
group boundary are unchanged. ALB-to-FastAPI HTTP remains inside the VPC behind
the existing security-group restriction; this is not a claim of TLS to the container.

The live check verifies the real certificate/hostname with normal trust checking,
canonical redirects, health, unauthenticated rejection and host isolation. The
existing authenticated Supabase canary and managed Valkey PING/SET/GET/Lua probes
then run over this staging setup. Cleanup is automatic for HTTPS validation, with
an independent final cleanup job plus the existing daily stop as backup. Stop also
removes the temporary DNS alias. Do not treat successful Terraform planning as live
HTTPS evidence.

Existing HTTP-only rehearsals remain available without the HTTPS option. Legacy
functional/history URL guards continue to reject arbitrary hosts; they have not
been broadened or weakened. Their HTTPS migration and integrated Cognito/frontend
deployment are subsequent work.

## Cost

The read-only inventory creates no billable infrastructure. Non-exportable public
ACM certificates for integrated AWS services have no certificate charge. Domain
registration and Route 53 hosted zones have separate charges and require a concrete
domain choice before setup. Running HTTPS staging incurs the same temporary ALB,
Fargate, public IPv4 and Valkey usage as the existing rehearsal; it is always stopped
after validation. No NAT, private CA, exportable certificate, new WAF or other paid
security service is introduced.

References: [ALB HTTPS listeners](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html),
[ACM DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html),
[ACM pricing](https://aws.amazon.com/certificate-manager/pricing/).
