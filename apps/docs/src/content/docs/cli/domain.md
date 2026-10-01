---
title: domain
description: Attach a custom domain to your CloudFront distribution with automated ACM TLS certificates and DNS verification.
---

Serve your application from your own domain with automated edge TLS — no manual certificate requests, validation emails, or CloudFront console edits.

## What it does

- `domain add <domain>` provisions an ACM TLS certificate in `us-east-1` (required by CloudFront) and wires it into your distribution's `aliases` and `viewer_certificate`.
- With `--zone-id <id>`, validation and routing are fully automated: deploy-stack creates the ACM validation records plus apex `A`/`AAAA` alias records in your Route 53 hosted zone, then binds the certificate to CloudFront in a single `apply`.
- Without `--zone-id`, you get a guided 2-step flow for external DNS providers (Cloudflare, Namecheap): `domain add` stages the certificate, `domain status` shows the exact CNAME records to paste, and `domain verify` activates the domain once DNS is in place.
- `domain status` shows the configured domain, its mode, whether CloudFront is wired, and a copy-paste DNS record table.
- `domain remove` deletes the domain configuration and restores the free `*.cloudfront.net` default certificate.
- PR preview workspaces are unaffected: domain resources are scoped to the production workspace, so previews keep serving over their own `*.cloudfront.net` URL and teardowns never touch your certificate, aliases, or DNS.
- Domain configuration lives in `terraform/domain.tf`, so `destroy` tears it down and `eject` keeps it automatically.
- Emits a `domain_run` telemetry event recording the subcommand and outcome.

## Usage

```bash
# Route 53, fully automated (one step)
npx deploy-stack domain add example.com --zone-id Z1234567890ABC
npx deploy-stack apply

# External DNS, guided (two steps)
npx deploy-stack domain add example.com
npx deploy-stack apply
# add the printed CNAMEs at your DNS provider, then:
npx deploy-stack domain verify
npx deploy-stack apply

# Inspect or remove
npx deploy-stack domain status
npx deploy-stack domain remove
```

To replace a configured domain, run `domain add <new-domain>` again with `--force` — the old domain is swapped out of CloudFront cleanly.

## Flags

| Flag | Description |
| ---- | ----------- |
| `--zone-id <id>` | Route 53 hosted zone ID for automated validation and routing. Accepts a bare ID (`Z123…`) or the console's `/hostedzone/Z123…` form. Only applies to `domain add`. |
| `--activate` | Activate immediately in external-DNS mode (skips the pending stage). Make sure your validation CNAMEs exist first — `apply` waits on DNS propagation. Only applies to `domain add`. |
| `--force` | Replace an already-configured domain. Without it, re-adding refuses to clobber your configuration. Only applies to `domain add`. |
| `--yes` | Skip the confirmation prompt. Required in headless/CI mode. Only applies to `domain remove`. |

Requires a project initialized with `deploy-stack` (`terraform/cloudfront.tf` must exist).

> **One domain per project:** each project manages a single custom domain. Need apex plus `www`? Configure the apex here and add a redirect rule for `www` at your DNS provider.

## See also

- [add](/deploy-stack/cli/add/) (provision `email:ses` on the same domain)
- [apply](/deploy-stack/cli/apply/)
- [destroy](/deploy-stack/cli/destroy/)
