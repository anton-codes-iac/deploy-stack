import { normalizeArgv } from '../utils/args.js';

export function parseCliArgs(processArgs) {
    const argv = normalizeArgv(processArgs);
    // 1. Extract telemetry flag safely
    const hasNoTelemetry = argv.some(arg => arg === '--no-telemetry' || (typeof arg === 'string' && arg.startsWith('--no-telemetry=')));

    // 2. Filter out telemetry flag
    const args = argv.filter(arg => arg !== '--no-telemetry' && !(typeof arg === 'string' && arg.startsWith('--no-telemetry=')));

    // 3. Isolate positional commands (non-string elements are positionals)
    const isFlag = (arg) => typeof arg === 'string' && arg.startsWith('--');
    const positionalArgs = args.filter(arg => !isFlag(arg));
    const baseCommand = positionalArgs.length > 0 ? positionalArgs.slice(0, 2).join(' ') : 'init';

    // 4. Parse execution flags
    const isHeadless = args.includes('--headless');
    const isDryRun = args.includes('--dry-run');

    const getFlag = (flagName) => {
        const match = args.find(a => a === `--${flagName}` || (typeof a === 'string' && a.startsWith(`--${flagName}=`)));
        if (match === `--${flagName}`) return true;
        return typeof match === 'string' ? match.split('=')[1] : undefined;
    };

    const headlessOptions = isHeadless ? {
        dir: getFlag('dir'),
        framework: getFlag('framework'),
        region: getFlag('region'),
        port: getFlag('port'),
        size: getFlag('size'),
        healthCheckPath: getFlag('healthCheckPath'),
        desiredCount: getFlag('desiredCount'),
        branch: getFlag('branch'),
        needsDatabase: getFlag('needsDatabase'),
        enablePrPreviews: getFlag('enablePrPreviews')
    } : {};

    // 5. Init composition flags (populated in both modes; only the init
    // path consumes them). Unlike legacy getFlag, these support both
    // `--flag=value` and `--flag value` spellings.
    const isPreconfigured = args.includes('--preconfigured');

    const getValueFlag = (flagName) => {
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (typeof arg !== 'string') continue;
            if (arg.startsWith(`--${flagName}=`)) {
                const value = arg.slice(flagName.length + 3);
                return value === '' ? null : value;
            }
            if (arg === `--${flagName}`) {
                const next = args[i + 1];
                if (typeof next === 'string' && next !== '' && !next.startsWith('--')) return next;
                return null;
            }
        }
        return null;
    };

    const parseWithFlag = () => {
        const values = [];
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (typeof arg !== 'string') continue;
            if (arg === '--with') {
                const next = args[i + 1];
                if (typeof next === 'string' && next !== '' && !next.startsWith('--')) {
                    values.push(...next.split(','));
                }
                continue;
            }
            if (arg.startsWith('--with=')) {
                values.push(...arg.slice('--with='.length).split(','));
            }
        }
        const seen = new Set();
        const deduped = [];
        for (const raw of values) {
            const value = String(raw).trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            deduped.push(value);
        }
        return deduped;
    };

    const initOptions = {
        with: parseWithFlag(),
        model: getValueFlag('model'),
        domain: getValueFlag('domain'),
        zoneId: getValueFlag('zone-id'),
        fromEmail: getValueFlag('from-email'),
        dbEngine: getValueFlag('db-engine'),
        setupCiMigrate: args.includes('--setup-ci-migrate'),
    };

    return {
        hasNoTelemetry,
        positionalArgs,
        baseCommand,
        isHeadless,
        isDryRun,
        isPreconfigured,
        headlessOptions,
        initOptions
    };
}