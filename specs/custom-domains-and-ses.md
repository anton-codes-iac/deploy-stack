# Spec: Custom Domains, Edge TLS (`domain`) & Transactional Email (`add email:ses`)

## Overview
Eliminate the primary production triggers that force developers into the AWS Management Console:
1. **Shared Foundation & Pre-Refactors (`src/utils/hcl.js`, `src/utils/domains.js`, `src/commands/add.js`):** Extract a shared HCL block-manipulation toolkit, a shared domain/zone validation and `domain.tf` parser module, and per-addon option resolution (`resolveAddonOptions`) with generalized placeholder/conditional-section template rendering.
2. **Custom Domains & Automated Edge SSL (`deploy-stack domain <add|verify|status|remove>`):** Provision ACM TLS certificates in `us-east-1` (required by CloudFront) via pure HCL builders, support 1-step Route 53 automated validation/routing (`--zone-id`) and 2-step External DNS verification (Cloudflare, Namecheap), and patch `aws_cloudfront_distribution "cdn"` in `terraform/cloudfront.tf`.
3. **Transactional Email & DKIM Automation (`deploy-stack add email:ses`):** Provision Amazon SES Domain Identities, DKIM tokens, MAIL FROM domain configuration, optional Route 53 DKIM/SPF/DMARC records, container environment variables (`SES_FROM_EMAIL`, `SES_REGION`), and least-privilege `ses:SendEmail` / `ses:SendRawEmail` IAM permissions on `aws_iam_role.task_role`.
4. **Operational Polish (`doctor_run` & `DATABASE_URL` Synthesis):** Verify `doctor_run` telemetry compatibility (preserving `DOCTOR_CHECKS` ordering and reusing `detectCiProvider()`) and provide a pure `buildMigrationCommand` helper in `src/commands/db/migrate.js` that synthesizes `DATABASE_URL` at runtime when `DB_HOST` is present.

---

## Part 0: Pre-Refactors & Shared Utilities

1. **Shared HCL-Editing Toolkit (`src/utils/hcl.js`):**
   * Extract pure, string-literal-aware brace-walking primitives:
     * `findResourceBlock(content, resourceType, resourceName)`
     * `findNestedBlock(blockContent, blockName)`
     * `replaceBlock(content, bounds, replacement)`
     * `upsertAttribute(blockContent, key, valueExpr)`
     * `removeAttribute(blockContent, key)`
   * Rewire existing brace-walking callers (`injectContainerEnvVars` and `ensureWorkerDesiredCountLifecycle` in `src/commands/add.js`, and `upsertSnapshotIdentifier` in `src/commands/db/restore.js`) onto `src/utils/hcl.js` while keeping all existing unit tests green, and build the new CloudFront patcher on top of it.
2. **Shared Domain Validation & `domain.tf` Parser (`src/utils/domains.js`):**
   * Centralize domain/zone/email normalization and validation so `domain.js` and `add.js` (`email:ses`) never drift:
     * `normalizeDomain(input)`: trims whitespace, strips a trailing dot (FQDN), and lowercases.
     * `DOMAIN_REGEX` & `isValidDomain(domain)`: validates standard domains and optional wildcard prefix (`*.example.com`) up to 253 chars.
     * `ZONE_ID_REGEX` (`/^(?:\/hostedzone\/)?(Z[A-Z0-9]{1,32})$/`) & `normalizeZoneId(input)`: strips optional `/hostedzone/` prefix and validates `Z[A-Z0-9]{1,32}`.
     * `isValidFromEmail(email, expectedDomain)`: validates email syntax and checks that the address domain matches `expectedDomain` (or is a subdomain of `expectedDomain`), preventing unverified-identity send failures at runtime.
     * `parseDomainTf(content)`: parses `# deploy-stack:domain-mode=<mode>`, `domain_name`, and `zone_id` (if present) into a structured `{ domain, mode, zoneId }` object used by both `domain status`/`verify`/`remove` and `add email:ses` auto-detection.
3. **Per-Addon Option Resolution & Template Generalization (`src/commands/add.js`, `src/utils/addons.js`):**
   * Extract a `resolveAddonOptions(capability, options, ctx)` dispatch with resolvers for stateful addons (`db:dynamodb`, `ai:bedrock`, `email:ses`), each returning `{ ok: true, templateVars, envVars, upsertKeys }` or a structured validation failure (`{ ok: false, errorCode, reason, message }`).
   * Generalize `renderAddonTemplate(templateContent, templateVars, conditionalBlocks)` to iterate over a placeholder map (`{{REGION}}`, `{{PARTITION_KEY}}`, `{{BEDROCK_MODEL_ID}}`, `{{SES_DOMAIN}}`, `{{SES_FROM_EMAIL}}`) and named conditional blocks (`{{WORKER_AUTOSCALING_BLOCK}}`, `{{SES_ROUTE53_RECORDS_BLOCK}}`).
   * Allow `ADDON_ENV_VARS` entries in `src/utils/addons.js` to accept either static strings or `(ctx) => string` functions so dynamic values (`BEDROCK_MODEL_ID`, `SES_FROM_EMAIL`, `SES_REGION`) resolve cleanly without post-hoc `replaceAll` special cases.

---

## Part 1: Custom Domains & Edge SSL (`src/commands/domain.js`)

### 1. CLI Surface, Telemetry & Error Conventions
* Register `domain` in `bin/cli.js` (`HELP_TEXT` and command router) and create `src/commands/domain.js` exporting `parseDomainArgs(args)`, `runDomain(options = {})`, and the pure HCL builders/patchers.
* **Subcommands:**
  * `deploy-stack domain add <domain> [--zone-id <id>] [--activate] [--force] [--headless]`
  * `deploy-stack domain verify [--headless]` (alias: `activate`)
  * `deploy-stack domain status`
  * `deploy-stack domain remove [--yes] [--headless]`
  * Unknown or missing subcommand fails via `failCommand` with event `'domain_run'`, `errorCode: 'UNKNOWN_DOMAIN_SUBCOMMAND'`, `reason: 'unknown-domain-subcommand'`.
* **Telemetry (`domain_run`):**
  * Emit `trackSuccess('domain_run', { subcommand, mode })` on success and route all failures through `failCommand` with `'domain_run'` (importing all used `track*` / `fail*` helpers to satisfy `tests/commands-import.test.js`).
* **Guard Order & Error Codes:**
  1. Normalize `args` (`normalizeArgv`) and `options` (`normalizeOptions`).
  2. Validate subcommand and input flags (`INVALID_DOMAIN` / `reason: 'invalid-domain'`, `INVALID_ZONE_ID` / `reason: 'invalid-zone-id'`) **before** filesystem guards (matching `add.js` flag validation order).
  3. Resolve `cwd` via `resolveCwd` (failing via `failProjectNotInitialized({ event: 'domain_run' })` on unresolvable `cwd`).
  4. Check that `terraform/cloudfront.tf` exists in `cwd` (failing with `errorCode: 'TERRAFORM_NOT_INITIALIZED'`, `reason: 'terraform-not-initialized'` if missing).

### 2. Pure HCL Builders for `terraform/domain.tf`
Instead of a single static template file, implement pure builder functions in `src/commands/domain.js`:
* **`renderDomainTfRoute53({ domain, zoneId })`:**
  * Header marker: `# deploy-stack:domain-mode=route53` and `# deploy-stack:zone-id=${zoneId}`.
  * `provider "aws" { alias = "us_east_1", region = "us-east-1" }`
  * `resource "aws_acm_certificate" "domain"` (`provider = aws.us_east_1`, `domain_name = "${domain}"`, `validation_method = "DNS"`, `lifecycle { create_before_destroy = true }`).
  * `resource "aws_route53_record" "domain_validation"` using a valid HCL map comprehension for `for_each`:
    `for_each = { for dvo in aws_acm_certificate.domain.domain_validation_options : dvo.domain_name => { name = dvo.resource_record_name, record = dvo.resource_record_value, type = dvo.resource_record_type } }`
    with `zone_id = "${zoneId}"`, `allow_overwrite = true`, `ttl = 60`, `name = each.value.name`, `type = each.value.type`, `records = [each.value.record]`.
  * `resource "aws_acm_certificate_validation" "domain"` (`provider = aws.us_east_1`, `certificate_arn = aws_acm_certificate.domain.arn`, `validation_record_fqdns = [for record in aws_route53_record.domain_validation : record.fqdn]`).
  * `resource "aws_route53_record" "cdn_alias_a"` and `"cdn_alias_aaaa"` (`zone_id = "${zoneId}"`, `name = "${domain}"`, `type = "A"` / `"AAAA"`, `alias` block targeting `aws_cloudfront_distribution.cdn.domain_name`, `aws_cloudfront_distribution.cdn.hosted_zone_id`, and `evaluate_target_health = false`).
  * Outputs: `custom_domain_url = "https://${domain}"`, `acm_certificate_arn = aws_acm_certificate.domain.arn`.
* **`renderDomainTfExternalPending({ domain })`:**
  * Header marker: `# deploy-stack:domain-mode=external-pending`.
  * `provider "aws" { alias = "us_east_1", region = "us-east-1" }` and `resource "aws_acm_certificate" "domain"`.
  * Outputs: `acm_validation_records` (list of `{ name, type, value }` objects from `domain_validation_options`) and `custom_domain_cname_target = aws_cloudfront_distribution.cdn.domain_name`.
* **`appendValidationResource(domainTfContent)`:**
  * Idempotently transitions `external-pending` to `external-active` (no-op if already `external-active` or `route53`), appending `resource "aws_acm_certificate_validation" "domain"` (`provider = aws.us_east_1`, `certificate_arn = aws_acm_certificate.domain.arn`) and `output "custom_domain_url"`.

### 3. CloudFront Patching in `terraform/cloudfront.tf` (`patchCloudFrontDomain` / `unpatchCloudFrontDomain`)
* Scope strictly to `resource "aws_cloudfront_distribution" "cdn"` in `terraform/cloudfront.tf` using `src/utils/hcl.js` (never touching `aws_cloudfront_distribution "storage_cdn"` in `s3.tf`).
* **`patchCloudFrontDomain(cloudfrontTfContent, domain)`:**
  * Upsert `aliases = ["${domain}"]` inside `aws_cloudfront_distribution.cdn` (if an `aliases` list already exists, ensure `domain` is present without clobbering other user-added entries; if replacing a previous `domain.tf` domain on `--force`, replace the old managed domain).
  * Replace the entire `viewer_certificate { ... }` block (removing `cloudfront_default_certificate = true`, which is mutually exclusive with `acm_certificate_arn`) with:
    `acm_certificate_arn = aws_acm_certificate_validation.domain.certificate_arn`, `ssl_support_method = "sni-only"`, `minimum_protocol_version = "TLSv1.2_2021"`.
* **`unpatchCloudFrontDomain(cloudfrontTfContent, domain)`:**
  * Remove `domain` from `aliases` (and remove the `aliases` attribute entirely if no aliases remain).
  * Replace the `viewer_certificate { ... }` block back to `viewer_certificate { cloudfront_default_certificate = true }`.

### 4. Subcommand Behaviors & Idempotency Rules
* **`domain add <domain>`:**
  * If `terraform/domain.tf` already exists:
    * If `--force` is not passed, fail with `errorCode: 'DOMAIN_ALREADY_CONFIGURED'`, `reason: 'domain-already-configured'` (hinting to pass `--force` to overwrite or `domain verify` to activate).
    * If `--force` is passed and a previous domain was patched into `cloudfront.tf`, replace the old domain cleanly.
  * If `--zone-id` is passed (with or without `--activate`): write Route 53 `domain.tf` and immediately patch `terraform/cloudfront.tf` (`mode = 'route53'`).
  * If `--zone-id` is omitted and `--activate` is passed: write external-active `domain.tf` and patch `terraform/cloudfront.tf` (`mode = 'external-active'`).
  * If `--zone-id` is omitted and `--activate` is not passed: write external-pending `domain.tf` and leave `terraform/cloudfront.tf` untouched (`mode = 'external-pending'`).
* **`domain verify` (alias `activate`):**
  * If `terraform/domain.tf` does not exist, fail with `errorCode: 'DOMAIN_NOT_CONFIGURED'`, `reason: 'domain-not-configured'`.
  * If mode is already `route53` or `external-active`, ensure `cloudfront.tf` is patched (idempotent no-op) and return `{ ok: true, mode, alreadyActive: true }`.
  * Otherwise, transition `domain.tf` via `appendValidationResource`, patch `terraform/cloudfront.tf`, remind the user to ensure their external DNS CNAME records are in place before running `npx deploy-stack apply`, and return `{ ok: true, mode: 'external-active' }`.
* **`domain status`:**
  * If `terraform/domain.tf` does not exist, print a friendly non-failing message (`No custom domain configured. Run npx deploy-stack domain add <domain> to get started.`), emit `trackSuccess('domain_run', { subcommand: 'status', configured: false })`, and return `{ ok: true, configured: false }`.
  * Otherwise, parse `domain.tf` via `parseDomainTf` and call `getTerraformOutputs(path.join(cwd, 'terraform'))` from `src/utils/terraform.js` (allowing an optional `options.getOutputs` injection override for unit tests). If `acm_validation_records` / `custom_domain_cname_target` outputs are present, render the copy-paste DNS record table.
* **`domain remove`:**
  * If `terraform/domain.tf` does not exist, fail with `errorCode: 'DOMAIN_NOT_CONFIGURED'`, `reason: 'domain-not-configured'`.
  * Confirmation behavior: if `--yes` is passed, skip the prompt in both TTY and headless modes. If `--yes` is not passed: in headless mode (`resolveHeadless(options)`), fail with `errorCode: 'CONFIRMATION_REQUIRED'`, `reason: 'confirmation-required'`; in interactive mode, prompt with Clack `confirm` (handling `isCancel` cleanly).
  * Unpatch `terraform/cloudfront.tf` (if present) and delete `terraform/domain.tf`.

---

## Part 2: Transactional Email & DKIM Automation (`deploy-stack add email:ses`)

1. **Registry & Visualizer (`src/utils/addons.js`, `src/utils/visualizer.js`):**
   * Add `'email:ses'` to `ADDON_REGISTRY` (`file: 'ses.tf'`, `template: 'ses.tf'`, `label: 'Amazon SES (Transactional Email & DKIM)'`, `cost: { monthlyFixed: 0, summary: '$0/mo fixed baseline; $0.10 per 1,000 emails sent' }`).
   * Add `ADDON_ENV_VARS['email:ses']` with `SES_FROM_EMAIL: (ctx) => ctx.sesFromEmail` and `SES_REGION: (ctx) => ctx.region`, and register `['SES_FROM_EMAIL', 'SES_REGION']` in `upsertKeys`.
2. **Option Resolution & Validation Order (`resolveAddonOptions` in `src/commands/add.js`):**
   * Parse `--domain`, `--from-email`, and `--zone-id` in `parseAddArgs(args)`.
   * **Pre-Guard Flag Validation (before `terraform/main.tf` guard, matching `--model` and `--partition-key`):**
     * If an explicit `--domain` was passed on `email:ses`, validate via `isValidDomain` (failing with `errorCode: 'INVALID_DOMAIN'`, `reason: 'invalid-domain'`).
     * If an explicit `--zone-id` was passed on `email:ses`, validate via `normalizeZoneId` (failing with `errorCode: 'INVALID_ZONE_ID'`, `reason: 'invalid-zone-id'`).
     * If an explicit `--from-email` was passed alongside an explicit `--domain`, validate via `isValidFromEmail(fromEmail, domain)` (failing with `errorCode: 'INVALID_FROM_EMAIL'`, `reason: 'invalid-from-email'`).
   * **Post-Guard Domain Resolution (after `terraform/main.tf` & overwrite guards):**
     1. Use explicit `--domain` if provided.
     2. Else if `terraform/domain.tf` exists in `cwd`, read it via `parseDomainTf` and reuse its `domain` (and its `zoneId` if `--zone-id` was not explicitly passed).
     3. Else if `isInteractive` is true (reusing `add.js`'s existing `isInteractive` check), prompt via Clack `text` and handle cancellation through `add.js`'s existing `cancelSelection` telemetry helper.
     4. Else fail with `errorCode: 'MISSING_SES_DOMAIN'`, `reason: 'missing-ses-domain'`.
     * Validate the resolved `domain` (`INVALID_DOMAIN`) and resolved `fromEmail = options.fromEmail || 'noreply@' + domain` via `isValidFromEmail(fromEmail, domain)` (`INVALID_FROM_EMAIL`).
3. **Template (`templates/terraform/addons/ses.tf`):**
   * Do **not** redeclare `data "aws_caller_identity" "current"` (avoiding collision with `s3.tf`).
   * Use `{{SES_DOMAIN}}`, `{{SES_FROM_EMAIL}}`, `{{REGION}}`, and `{{SES_ROUTE53_RECORDS_BLOCK}}`.
   * Attach `resource "aws_iam_role_policy" "ses_send"` to `role = aws_iam_role.task_role.id` (matching `main.tf`), granting `["ses:SendEmail", "ses:SendRawEmail"]` on `Resource = "*"` with a `StringLike` condition on `"ses:FromAddress": ["*@{{SES_DOMAIN}}", "{{SES_FROM_EMAIL}}"]`.
   * In `aws_route53_record.ses_mail_from_mx` (rendered inside `{{SES_ROUTE53_RECORDS_BLOCK}}` when `zoneId` is present), use `10 feedback-smtp.{{REGION}}.amazonses.com`.

---

## Part 3: `doctor_run` Telemetry & `DATABASE_URL` Runtime Synthesis

1. **`doctor_run` Telemetry (`src/commands/doctor.js`):**
   * Keep `passed_checks`, `failed_checks` (in their existing `DOCTOR_CHECKS` execution order—do **not** sort alphabetically so existing `tests/doctor.test.js` assertions stay untouched), and `total_failed` unchanged.
   * Reuse `detectCiProvider()` from `src/core/telemetry.js` (no new CI detection logic in `doctor.js`).
2. **Pure `buildMigrationCommand` Helper (`src/commands/db/migrate.js`):**
   * Extract `buildMigrationCommand(resolvedCmd, containerDef)` returning `['sh', '-c', ...]`:
     * Inspect `containerDef?.environment` and `containerDef?.secrets` (treating missing arrays as empty).
     * If `DATABASE_URL` is already present in either array, or if `DB_HOST` is **not** present in either array (which also preserves all existing `tests/db.test.js` tests that pass env-less mock task definitions), return `['sh', '-c', resolvedCmd]` unchanged.
     * When `DB_HOST` is present (alongside `DB_USER` and `DB_PASSWORD` in `environment` or `secrets`) and `DATABASE_URL` is absent, return `['sh', '-c', 'export DATABASE_URL="${DATABASE_URL:-postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT:-5432}/${DB_NAME:-postgres}}"; ' + resolvedCmd]`.

---

## Part 4: Documentation, Sidebar & Unit Tests

1. **Documentation & Sidebar (`apps/docs/`):**
   * Create `apps/docs/src/content/docs/cli/domain.md` and add `{ label: 'domain', slug: 'cli/domain' }` to the CLI Reference sidebar in `apps/docs/astro.config.mjs`.
   * Update `apps/docs/src/content/docs/cli/add.md` to document `deploy-stack add email:ses`.
   * Check off **Custom Domains & Automated SSL** and **Transactional Email & DKIM Automation** in both `README.md` and `apps/docs/src/content/docs/roadmap.md`.
2. **Unit Tests (`tests/domain.test.js`, `tests/add.test.js`, `tests/db.test.js`):**
   * Use `stripVTControlCharacters` from `'node:util'` on all captured log assertions.
   * Add unit tests in `tests/domain.test.js` covering `src/utils/hcl.js`, `src/utils/domains.js`, `domain add` (Route 53 1-step vs. External DNS Stage 1 & `--activate`), `domain verify` (Stage 2 transition + idempotency), `domain status` (configured with `getOutputs` override vs. unconfigured), `domain remove` (`--yes`, interactive confirm, headless guard, and `cloudfront.tf` unpatching), and fuzzer-hardened inputs.
   * Append `email:ses` tests to `tests/add.test.js` covering explicit `--domain`, auto-detection from `terraform/domain.tf` (including `zoneId` reuse), interactive prompt & cancel telemetry, pre-guard validation (`INVALID_DOMAIN`, `INVALID_ZONE_ID`, `INVALID_FROM_EMAIL` domain mismatch), `MISSING_SES_DOMAIN`, `aws_iam_role.task_role.id` binding, and `SES_FROM_EMAIL` / `SES_REGION` injection.
   * Append `buildMigrationCommand` unit tests to `tests/db.test.js` covering env-less containers (no-wrap), containers with `DATABASE_URL` already defined (no-wrap), and containers with `DB_HOST` + `DB_USER` + `DB_PASSWORD` (synthesizes `DATABASE_URL`).