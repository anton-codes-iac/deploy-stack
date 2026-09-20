#!/usr/bin/env node
import path from 'path';
import { mainStack } from '../src/commands/init.js';
import { destroyStack } from '../src/commands/destroy.js';
import { runDoctor } from '../src/commands/doctor.js';
import { pushSecrets } from '../src/commands/secrets.js';
import { ejectStack } from '../src/commands/eject.js';
import { applyStack } from '../src/commands/apply.js';
import { runDiagnose } from '../src/commands/diagnose.js';
import { syncAi } from '../src/commands/sync-ai.js';
import { parseCliArgs } from '../src/core/parser.js';

const rawArgs = process.argv.slice(2);
const parsed = parseCliArgs(rawArgs);

if (parsed.hasNoTelemetry) {
    process.env.DO_NOT_TRACK = '1';
}
process.env.CLI_COMMAND = parsed.baseCommand;

const { positionalArgs, isHeadless, isDryRun, headlessOptions } = parsed;

if (positionalArgs[0] === 'secrets' && positionalArgs[1] === 'push') {
    const envFile = positionalArgs[2] || '.env';
    const projectName = path.basename(process.cwd());
    pushSecrets(envFile, projectName).catch(e => { console.error(e); process.exit(1); });
} else if (positionalArgs[0] === 'apply') {
    applyStack({ isDryRun }).catch(e => { console.error(e); process.exit(1); });
} else if (positionalArgs[0] === 'doctor') {
    runDoctor().catch(e => { console.error(e); process.exit(1); });
} else if (positionalArgs[0] === 'destroy') {
    destroyStack().catch(e => { console.error(e); process.exit(1); });
} else if (positionalArgs[0] === 'eject') {
    ejectStack().catch(e => { console.error(e); process.exit(1); });
} else if (positionalArgs[0] === 'sync-ai') {
    syncAi().catch(e => { console.error(e); process.exit(1); });
} else if (positionalArgs[0] === 'diagnose' || positionalArgs[0] === 'wtf') {
    runDiagnose(headlessOptions).catch(e => { console.error(e); process.exit(1); });
} else {
    mainStack({ isHeadless, headlessOptions }).catch(e => { console.error(e); process.exit(1); });
}