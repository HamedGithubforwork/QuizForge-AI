mock_provider "aws" {}

run "deletion_only" {
  command = plan
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
  override_resource {
    target          = aws_scheduler_schedule_group.capacity
    override_during = plan
    values          = { arn = "arn:aws:scheduler:ca-central-1:123456789012:schedule-group/quizforge-capacity-test" }
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.cleanup.policy).Statement[0].Action == ["lightsail:DeleteInstance"]
    error_message = "Cleanup must have deletion-only permissions."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.cleanup.policy).Statement[0].Condition.StringEquals["aws:ResourceTag/Purpose"] == "quizforge-capacity-test"
    error_message = "Cleanup must require the isolated test tag."
  }
  assert {
    condition     = jsondecode(aws_iam_role.cleanup.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "123456789012"
    error_message = "Scheduler trust must require the same AWS account."
  }
  assert {
    condition     = jsondecode(aws_iam_role.cleanup.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceArn"] == "arn:aws:scheduler:ca-central-1:123456789012:schedule-group/quizforge-capacity-test"
    error_message = "Only the dedicated schedule group may assume the cleanup role."
  }
}
