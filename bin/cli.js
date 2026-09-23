#!/usr/bin/env node
import path from 'path';
import { mainStack } from '../src/commands/init.js';
import { destroyStack } from '../src/commands/destroy.js';
import { runDoctor } from '../src/commands/doctor.js';
import { pushSecrets, pullSecrets, auditSecrets } from '../src/commands/secrets.js';
import { ejectStack } from '../src/commands/eject.js';
import { applyStack } from '../src/commands/apply.js';
import { runDiagnose } from '../src/commands/diagnose.js';
import { syncAi } from '../src/commands/sync-ai.js';
import { runLogs, parseLogsArgs } from '../src/commands/logs.js';
import { runStatus, parseStatusArgs } from '../src/commands/status.js';
import { runExec, parseExecArgs } from '../src/commands/exec.js';
import { runGc, parseGcArgs } from '../src/commands/gc.js';
import { parseCliArgs } from '../src/core/parser.js';

const HELP_TEXT = [
    'deploy-stack — Provision production-ready AWS infrastructure in seconds.',
    '',
    'Usage:',
    '  deploy-stack [command] [options]',
    '',
    'Commands:',
    '  init                 Provision infrastructure and CI/CD pipelines',
    '  apply                Apply infrastructure changes',
    '  destroy              Tear down infrastructure',
    '  doctor               Run pre-flight dependency checks',
    '  logs [service]       Stream CloudWatch logs (--tail, -f/--follow, --error, --since, --region)',
    '  status               Service health dashboard (--region, --json)',
    '  exec                 Open an interactive shell in a running container (--cluster, --service, --container, --command, --region)',
    '  gc                   Discover and delete orphaned ECR images, log groups, and Elastic IPs (--region)',
    '  secrets push         Push environment secrets',
    '  secrets pull         Pull environment secrets',
    '  secrets audit        Audit local vs remote secrets drift',
    '  eject                Eject to self-managed configs',
    '  sync-ai              Sync AI assistant rules',
];

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
} else if (positionalArgs[0] === 'secrets' && positionalArgs[1] === 'pull') {
    const envFile = positionalArgs[2] || '.env';
    const projectName = path.basename(process.cwd());
    pullSecrets(envFile, projectName, { isHeadless }).catch(e => { console.error(e); process.exit(1); });
} else if (positionalArgs[0] === 'secrets' && positionalArgs[1] === 'audit') {
    const envFile = positionalArgs[2] || '.env';
    const projectName = path.basename(process.cwd());
    auditSecrets(envFile, projectName).catch(e => { console.error(e); process.exit(1); });
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
} else if (positionalArgs[0] === 'logs') {
    runLogs(parseLogsArgs(rawArgs)).catch(e => { console.error(e); process.exit(1); });
} else if (positionalArgs[0] === 'status') {
    runStatus(parseStatusArgs(rawArgs)).catch(e => { console.error(e); process.exit(1); });
} else if (positionalArgs[0] === 'exec') {
    runExec(parseExecArgs(rawArgs)).catch(e => { console.error(e); process.exit(1); });
} else if (positionalArgs[0] === 'gc') {
    runGc(parseGcArgs(rawArgs)).catch(e => { console.error(e); process.exit(1); });
} else if (positionalArgs[0] === 'help' || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log(HELP_TEXT.join('\n'));
} else {
    mainStack({ isHeadless, headlessOptions }).catch(e => { console.error(e); process.exit(1); });
}