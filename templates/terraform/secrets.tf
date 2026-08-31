# --- AWS Secrets Manager ---
resource "aws_secretsmanager_secret" "app_secrets" {
  name                    = "{{PROJECT_NAME}}-secrets"
  description             = "Environment variables for {{PROJECT_NAME}}"
  recovery_window_in_days = 0 # Allows instant deletion for dev/POC environments
}

# Fallback dummy key for CI/CD environments where the real key isn't present
variable "rails_master_key" {
  type    = string
  default = "1234567890abcdef1234567890abcdef"
}

# Initial placeholder secret so the ECS task doesn't fail on first boot
resource "aws_secretsmanager_secret_version" "app_secrets_initial" {
  secret_id = aws_secretsmanager_secret.app_secrets.id
  secret_string = jsonencode({{INITIAL_SECRET_MAP}})

  lifecycle {
    ignore_changes = [secret_string]
  }
}
