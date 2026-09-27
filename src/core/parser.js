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

    return {
        hasNoTelemetry,
        positionalArgs,
        baseCommand,
        isHeadless,
        isDryRun,
        headlessOptions
    };
}