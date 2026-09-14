export function parseCliArgs(processArgs) {
    // 1. Extract telemetry flag safely
    const hasNoTelemetry = processArgs.some(arg => arg === '--no-telemetry' || arg.startsWith('--no-telemetry='));

    // 2. Filter out telemetry flag
    const args = processArgs.filter(arg => arg !== '--no-telemetry' && !arg.startsWith('--no-telemetry='));

    // 3. Isolate positional commands
    const positionalArgs = args.filter(arg => !arg.startsWith('--'));
    const baseCommand = positionalArgs.length > 0 ? positionalArgs.slice(0, 2).join(' ') : 'init';

    // 4. Parse execution flags
    const isHeadless = args.includes('--headless');
    const isDryRun = args.includes('--dry-run');

    const getFlag = (flagName) => {
        const match = args.find(a => a === `--${flagName}` || a.startsWith(`--${flagName}=`));
        if (match === `--${flagName}`) return true;
        return match ? match.split('=')[1] : undefined;
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