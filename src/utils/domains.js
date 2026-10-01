// Shared domain/zone/email validation and `domain.tf` parsing for the
// `domain` command and `add email:ses`. Both commands consume this module
// so their normalization rules can never drift apart. Dependency-free.
export const DOMAIN_REGEX = /^(?=.{1,253}$)(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
export const ZONE_ID_REGEX = /^(?:\/hostedzone\/)?(Z[A-Z0-9]{1,32})$/;
export const FROM_EMAIL_REGEX = /^[^\s@"'\\]+@[^\s@"'\\]+\.[^\s@"'\\]+$/;

export const DOMAIN_MODES = ['route53', 'external-pending', 'external-active'];

// Trims whitespace, strips one trailing FQDN dot, and lowercases.
// Non-string input normalizes to '' so callers fail validation instead
// of throwing.
export function normalizeDomain(input) {
    if (typeof input !== 'string') return '';
    return input.trim().toLowerCase().replace(/\.$/, '');
}

// Validates a normalized domain (with an optional `*.` wildcard prefix).
export function isValidDomain(domain) {
    return DOMAIN_REGEX.test(normalizeDomain(domain));
}

// Strips an optional `/hostedzone/` prefix (as copied from the AWS
// console) and validates the `Z...` shape. Returns the canonical zone
// ID, or null when invalid.
export function normalizeZoneId(input) {
    if (typeof input !== 'string') return null;
    const match = ZONE_ID_REGEX.exec(input.trim());
    return match ? match[1] : null;
}

// Validates sender-address syntax and that the address belongs to
// `expectedDomain` (or one of its subdomains), so SES sends never fail
// at runtime against an unverified identity. Wildcards are rejected on
// both sides: SES domain identities do not support them.
export function isValidFromEmail(email, expectedDomain) {
    if (typeof email !== 'string' || typeof expectedDomain !== 'string') return false;
    const address = email.trim();
    if (!FROM_EMAIL_REGEX.test(address)) return false;
    if (address.includes('*')) return false;
    const domain = normalizeDomain(expectedDomain);
    if (!domain || domain.includes('*')) return false;
    const addressDomain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
    return addressDomain === domain || addressDomain.endsWith(`.${domain}`);
}

// Parses a `terraform/domain.tf` document into `{ domain, mode, zoneId }`
// (fields are null when absent). Mode comes from the
// `# grada:domain-mode=<mode>` marker (legacy `# deploy-stack:` files
// still parse) with structural fallbacks for hand-edited files; the
// zone ID prefers the explicit `# grada:zone-id=<id>` marker over
// `zone_id` attributes.
export function parseDomainTf(content) {
    const text = String(content ?? '');
    if (!text.trim()) return null;
    const modeMatch = text.match(/#\s*(?:grada|deploy-stack):domain-mode=([a-z-]+)/);
    let mode = modeMatch && DOMAIN_MODES.includes(modeMatch[1]) ? modeMatch[1] : null;
    if (!mode) {
        if (text.includes('"cdn_alias_a"')) mode = 'route53';
        else if (text.includes('"aws_acm_certificate_validation"')) mode = 'external-active';
        else if (text.includes('"aws_acm_certificate"')) mode = 'external-pending';
    }
    const domainMatch = text.match(/domain_name\s*=\s*"([^"]+)"/);
    const domain = domainMatch ? normalizeDomain(domainMatch[1]) : null;
    let zoneId = null;
    const zoneMarker = text.match(/#\s*(?:grada|deploy-stack):zone-id=([A-Za-z0-9/_-]+)/);
    if (zoneMarker) zoneId = normalizeZoneId(zoneMarker[1]);
    if (!zoneId) {
        const zoneAttr = text.match(/zone_id\s*=\s*"([^"]+)"/);
        if (zoneAttr) zoneId = normalizeZoneId(zoneAttr[1]);
    }
    return { domain: domain || null, mode, zoneId };
}
