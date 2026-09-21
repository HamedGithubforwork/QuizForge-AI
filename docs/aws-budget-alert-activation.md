# Approved USD20 AWS budget activation

The owner approved a USD20 monthly AWS alert budget and privately supplied its
recipient. `Approved AWS budget alerts` can inspect or activate that exact
account-wide budget independently of permanent hosting. It creates no compute,
database, DNS, IAM principal, access key or budget action. It is a notification
budget, not a spending cap.

Store the recipient in the encrypted `AWS_BUDGET_ALERT_EMAIL` repository secret.
Dispatch the workflow on `main` with `activate`. Pull requests run credential-free
tests only. `inspect` uses read-only session permissions; activation adds only
`budgets:ModifyBudget` on the exact budget name. Existing role permissions must
also permit the operation; this workflow never edits its own IAM permissions.

The controller creates `quizforge-monthly-account-cost` at USD20/month with actual
cost notifications above 50%, 80% and 100%, and a forecast notification above 100%.
Credit and refund offsets are excluded. Notifications use the approved email
directly, so budget activation does not depend on provisioning the later SNS
monitoring stack. It reads back the amount, account-wide coverage, all cost flags,
four notification thresholds and the exact recipient without logging the address,
account identifier or current spend. Read-back is configuration evidence; it does
not claim inbox delivery. There is no create retry after an ambiguous response.

An existing mismatched budget, subscriber, missing notification or denied read
fails closed without modifying or deleting anything. Inspect a partial result
before reconciling it; do not delete and recreate an existing budget automatically.

## Adopt into the future permanent Terraform state

The permanent candidate already declares the same budget name. Before applying
that candidate, **import the existing budget** as `aws_budgets_budget.monthly`
using AWS's `<account-id>:quizforge-monthly-account-cost` import identifier.
Use only the selected Lightsail state, never the alternate managed-stack state.
Inspect the resulting plan; it must not create a second budget or replace this
one. Keep direct email notifications active until the SNS subscription is
confirmed and an actual test message is received. Switching budget notifications
to SNS is then an explicit reviewed update. The budget alone does not prove host,
backup or missing-heartbeat alarms work.

API reference: [AWS CreateBudget](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_budgets_CreateBudget.html).
