# Staging API HTTPS preparation

The existing production Vercel, Render and Supabase services remain unchanged.
Application PR #97 remains unmerged. This prepares HTTPS for the disposable AWS
ALB; it does not claim that the CloudFront/Cognito/backend browser flow has been
integrated or validated yet.

## Verified checkpoint — 2026-09-19

The custom-domain HTTPS rehearsal passed on main commit
`658c15c2e3c68dd9efce7170ca3990dd76b7a764` in
[run 35422836790](https://github.com/HamedGithubforwork/QuizForge-AI/actions/runs/35422836790).
The run checked the issued certificate and unused DNS name before provisioning,
then verified trusted TLS at `staging-api.quizfromnotes.com`, canonical HTTP
redirects, API health, unauthenticated rejection, and host isolation. The
authenticated Supabase canary and managed Valkey runtime smoke test also passed.
The full generation and history validations were skipped; this run made no
OpenAI calls and does not establish integrated Cognito browser coverage.

Terraform destroyed all **12 temporary resources** at **05:20:14 UTC**. At
**05:20:38 UTC**, the independent cleanup job verified absence of the staging
ALB, active ECS service, Fargate tasks, Valkey, and temporary DNS alias, with
empty Terraform outputs. The reusable hosted zone, certificate, and validation
record remain outside staging state. Later successful scheduled stop runs are
cleanup checks, not additional live HTTPS validations.

The next milestone is integrated temporary **CloudFront frontend + Cognito +
HTTPS backend** staging, including browser authentication and application API
access with verified teardown. The earlier CloudFront test used synthetic
authentication settings and blocked API connections, so hosting and API success
must not be presented as a completed end-to-end browser test. Application PR #97
remains unmerged; this checkpoint does not move production from Vercel, Render,
or Supabase.

## Read-only inventory

Use **AWS staging environment → main → inspect-https**. This operation uses GitHub
OIDC with a read-only session policy to count public Route 53 zones, registered
domains, and ACM certificates in ca-central-1 and us-east-1. It does not initialize
Terraform state or create/modify DNS, certificates, or staging resources. Unrelated
domain names and contact data are not published in logs. A successful inventory is
not a successful live HTTPS validation; the output explicitly reports readiness.
The current AWS Free Tier plan rejects the optional Route 53 Domains registration
API. That exact service-plan restriction is reported as **UNAVAILABLE / UNKNOWN**,
never as zero registered domains. Other access errors still fail inspection. A
domain can be registered elsewhere; certificate and public DNS checks remain
mandatory before HTTPS staging can start. No account-plan upgrade is automated.

## Domain prerequisites

The owner registered **quizfromnotes.com** at Porkbun. Use **AWS domain
prerequisites → main → prepare** to create only its public Route 53 hosted zone,
one non-exportable public ACM certificate for **staging-api.quizfromnotes.com**
in **ca-central-1**, and its DNS validation CNAME. This uses a separate encrypted
state key (`quizforge/domain/terraform.tfstate`) that staging cleanup never opens.
The plan guard permits only creation/no-op of those three resources. Existing
unmanaged zones, replacements, updates, deletions, and DNS overwrites are rejected.
The OIDC session cannot delete zones/certificates, publish application records,
request other certificate names, or enable certificate export. The resources also
have Terraform destruction protection. No registrar password/API key is needed.

The prepare run reports four exact nameservers. At Porkbun, open the domain's
**Nameservers** setting and replace its existing nameservers with those four.
Do not change DNS for the existing Vercel, Render or Supabase production domains.
No registrar changes, account upgrade, or domain purchase are automated.
Preparation intentionally does not wait for issuance, which needs delegation.
After DNS propagates, run **AWS domain prerequisites → main → verify**. This must
confirm public NS delegation, the actual ACM validation CNAME, issued certificate
account/region/validity/non-exportability, and the unused staging hostname.
A pending certificate is explicitly not HTTPS readiness. ACM requests can time
out after 72 hours without validation; a replacement then needs a reviewed change.

CloudFront custom certificates later require **us-east-1**.
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
registration is already purchased separately. The retained Route 53 hosted zone
costs **USD 0.50/month** plus applicable DNS queries, even while staging is off.
The certificate and its validation record remain for reuse; no ALB/ECS/cache/database
is started by the domain workflow. Running HTTPS staging incurs the same temporary ALB,
Fargate, public IPv4 and Valkey usage as the existing rehearsal; it is always stopped
after validation. No NAT, private CA, exportable certificate, new WAF or other paid
security service is introduced.

References: [ALB HTTPS listeners](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html),
[ACM DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html),
[ACM pricing](https://aws.amazon.com/certificate-manager/pricing/).
