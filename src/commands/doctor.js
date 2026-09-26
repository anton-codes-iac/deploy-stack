import { intro, outro, spinner } from '@clack/prompts';
import color from 'picocolors';
import { checkDependency } from '../utils/system.js';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';

// Stable snake_case identifiers for the binary presence checks below.
// Only these static IDs ever reach telemetry — never paths or error text.
export const DOCTOR_CHECKS = [
    { id: 'terraform', label: 'Terraform', binary: 'terraform' },
    { id: 'aws_cli', label: 'AWS CLI', binary: 'aws' },
    { id: 'docker', label: 'Docker', binary: 'docker' },
    { id: 'git', label: 'Git', binary: 'git' },
];

const INSTALL_HINTS = {
    terraform: {
        default: 'Install via Homebrew: brew install terraform',
        linux: 'Install via the HashiCorp apt repo: https://developer.hashicorp.com/terraform/install',
        win32: 'Install via winget: winget install Hashicorp.Terraform',
    },
    aws_cli: {
        default: 'Install via Homebrew: brew install awscli',
        linux: 'Install AWS CLI v2 for Linux: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
        win32: 'Install via winget: winget install Amazon.AWSCLI',
    },
    docker: {
        default: 'Install via Homebrew: brew install docker',
        linux: 'Install Docker Engine for your distro: https://docs.docker.com/engine/install/',
        win32: 'Install via winget: winget install Docker.DockerDesktop',
    },
    git: {
        default: 'Install via Homebrew: brew install git',
        linux: 'Install via your package manager: sudo apt-get install -y git (Debian/Ubuntu) or sudo dnf install -y git (RHEL/Fedora)',
        win32: 'Install via winget: winget install Git.Git',
    },
};

export function installHint(checkId) {
    const hints = INSTALL_HINTS[checkId];
    if (!hints) return '';
    if (process.platform === 'linux' && hints.linux) return hints.linux;
    if (process.platform === 'win32' && hints.win32) return hints.win32;
    return hints.default;
}

export async function runDoctor() {
    intro(color.bgCyan(color.black(' deploy-stack ☁️  ')));

    const s = spinner();
    s.start('Running pre-flight checks...');

    const results = await Promise.all(
        DOCTOR_CHECKS.map(async (check) => ({
            ...check,
            ok: await checkDependency(check.binary),
        }))
    );

    s.stop('Pre-flight checks complete.\n');

    const printStatus = (ok, label, fix) => {
        const icon = ok ? color.green('✅') : color.red('❌');
        const message = ok ? `${label} (✓)` : `${label} (✗)`;
        console.log(`   ${icon} ${message}`);
        if (!ok) {
            console.log(`      ┌─ Try: ${color.dim(fix)}`);
        }
    };

    for (const check of results) {
        printStatus(check.ok, check.label, installHint(check.id));
    }

    const passedChecks = results.filter((check) => check.ok).map((check) => check.id);
    const failedChecks = results.filter((check) => !check.ok).map((check) => check.id);

    if (failedChecks.length === 0) {
        outro(color.green('Your system is 100% ready to provision and deploy! 🚀'));
    } else {
        outro(color.yellow('Please install the missing dependencies before running the provisioning tool.'));
    }

    trackEvent('doctor_run', {
        success: failedChecks.length === 0,
        passed_checks: passedChecks,
        failed_checks: failedChecks,
        total_failed: failedChecks.length,
    });
    await flushTelemetry();
}
