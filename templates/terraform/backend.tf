terraform {
  backend "s3" {
    bucket       = "{{STATE_BUCKET}}"
    key          = "state/terraform.tfstate"
    region       = "{{REGION}}"
    encrypt      = true
    use_lockfile = true
  }
}