# Preparation only. Independent of the managed-stack and disposable test state.
terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "6.64.0" }
  }
  backend "s3" {}
}
provider "aws" {
  region = "ca-central-1"
  default_tags {
    tags = { Project = "QuizForge-AI", Environment = "production-lightsail", Temporary = "false" }
  }
}
data "aws_caller_identity" "current" {}
variable "monthly_budget_usd" {
  type = number
  validation {
    condition     = var.monthly_budget_usd >= 12 && var.monthly_budget_usd <= 1000
    error_message = "Choose an explicit AWS alert budget of USD 12–1000; this is not a spending stop."
  }
}
variable "alert_email" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.alert_email)) && !endswith(var.alert_email, ".invalid")
    error_message = "Supply the owner's real alert recipient."
  }
}
variable "ssh_public_key" {
  type = string
  validation {
    condition     = can(regex("^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [^\\r\\n]+)?$", var.ssh_public_key))
    error_message = "Use an operator-owned Ed25519 public key; never a private key."
  }
}
variable "admin_ipv4_cidr" {
  type = string
  validation {
    condition     = can(cidrnetmask(var.admin_ipv4_cidr)) && endswith(var.admin_ipv4_cidr, "/32")
    error_message = "SSH requires one explicit operator IPv4 /32."
  }
}
variable "public_signup" {
  type    = bool
  default = false
}
locals {
  name   = "quizforge-production-lightsail"
  origin = "https://quizfromnotes.com"
  domain = "quizforge-${data.aws_caller_identity.current.account_id}"
}
resource "aws_lightsail_key_pair" "operator" {
  name       = "quizforge-production-operator"
  public_key = var.ssh_public_key
  lifecycle { prevent_destroy = true }
}
resource "aws_lightsail_instance" "server" {
  name              = local.name
  availability_zone = "ca-central-1a"
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = "small_3_0"
  ip_address_type   = "ipv4"
  key_pair_name     = aws_lightsail_key_pair.operator.name
  user_data         = file("${path.module}/../../../scripts/production/lightsail/bootstrap.sh")
  lifecycle { prevent_destroy = true }
}
resource "aws_lightsail_static_ip" "server" {
  name = local.name
  lifecycle { prevent_destroy = true }
}
resource "aws_lightsail_static_ip_attachment" "server" {
  static_ip_name = aws_lightsail_static_ip.server.id
  instance_name  = aws_lightsail_instance.server.id
}
resource "aws_lightsail_instance_public_ports" "server" {
  instance_name = aws_lightsail_instance.server.name
  port_info {
    protocol          = "tcp"
    from_port         = 22
    to_port           = 22
    cidrs             = [var.admin_ipv4_cidr]
    ipv6_cidrs        = []
    cidr_list_aliases = []
  }
  dynamic "port_info" {
    for_each = toset([80, 443])
    content {
      protocol          = "tcp"
      from_port         = port_info.value
      to_port           = port_info.value
      cidrs             = ["0.0.0.0/0"]
      ipv6_cidrs        = []
      cidr_list_aliases = []
    }
  }
}
# No DNS resource, cloud-init application startup, IAM keys or paid snapshots.
output "server_ipv4" { value = aws_lightsail_static_ip.server.ip_address }
output "pool_id" { value = aws_cognito_user_pool.browser.id }
output "client_id" { value = aws_cognito_user_pool_client.browser.id }
output "auth_origin" { value = "https://${local.domain}.auth.ca-central-1.amazoncognito.com" }
