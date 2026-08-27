#!/usr/bin/env node
import path from 'path';
import { mainStack } from '../src/commands/init.js';
import { destroyStack } from '../src/commands/destroy.js';
import { runDoctor } from '../src/commands/doctor.js';
import { pushSecrets } from '../src/commands/secrets.js';
import { ejectStack } from '../src/commands/eject.js';

// 1. Extract the telemetry flag and set the environment variable
const rawArgs = process.argv.slice(2);
const hasNoTelemetry = rawArgs.includes('--no-telemetry');

if (hasNoTelemetry) {
    process.env.DO_NOT_TRACK = '1';
}

// 2. Filter out the telemetry flag from the args so the subcommands don't see it
const args = rawArgs.filter((arg) => arg !== '--no-telemetry');

// 3. Handle commands
if (args[0] === 'secrets' && args[1] === 'push') {
    const envFile = args[2] || '.env';
    const projectName = path.basename(process.cwd());
    pushSecrets(envFile, projectName).catch(console.error);
} else if (args[0] === 'doctor') {
    runDoctor().catch(console.error);
} else if (args[0] === 'destroy') {
    destroyStack().catch(console.error);
} else if (args[0] === 'eject') {
    ejectStack().catch(console.error);
} else {
    mainStack().catch(console.error);
}