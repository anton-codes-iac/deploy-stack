#!/usr/bin/env node
import path from 'path';
import { runDoctor } from '../src/commands/doctor.js';
import { pushSecrets } from '../src/commands/secrets.js';
import { mainStack } from '../src/commands/init.js';

const args = process.argv.slice(2);

if (args[0] === 'secrets' && args[1] === 'push') {
    const envFile = args[2] || '.env';
    const projectName = path.basename(process.cwd());
    pushSecrets(envFile, projectName).catch(console.error);
} else if (args[0] === 'doctor') {
    runDoctor().catch(console.error);
} else {
    mainStack().catch(console.error);
}