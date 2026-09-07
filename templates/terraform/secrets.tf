# --- Shared AWS Secrets Manager ---

# 1. Only create the Secret Vault in the default (production) workspace
resource "aws_secretsmanager_secret" "app_secrets" {
  count                   = terraform.workspace == "default" ? 1 : 0
  name                    = "{{PROJECT_NAME}}-secrets"
  description             = "Environment variables for {{PROJECT_NAME}}"
  recovery_window_in_days = 0 # Allows instant deletion for dev/POC environments
}

# 2. Fetch the existing Secret Vault when running in a PR workspace
data "aws_secretsmanager_secret" "existing_secrets" {
  count = terraform.workspace != "default" ? 1 : 0
  name  = "{{PROJECT_NAME}}-secrets"
}

# 3. Export a single local variable that works in both environments
locals {
  secret_arn = terraform.workspace == "default" ? aws_secretsmanager_secret.app_secrets[0].arn : data.aws_secretsmanager_secret.existing_secrets[0].arn
}

# Fallback dummy key for CI/CD environments where the real key isn't present
variable "rails_master_key" {
  type    = string
  default = "1234567890abcdef1234567890abcdef"
}

# Initial placeholder secret so the ECS task doesn't fail on first boot
resource "aws_secretsmanager_secret_version" "app_secrets_initial" {
  count         = terraform.workspace == "default" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.app_secrets[0].id
  secret_string = jsonencode({{INITIAL_SECRET_MAP}})

  lifecycle {
    ignore_changes = [secret_string]
  }
}
