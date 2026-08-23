import { intro, outro, spinner } from '@clack/prompts';
import color from 'picocolors';
import { checkDependency } from '../utils/system.js';

export async function runDoctor() {
    intro(color.bgCyan(color.black(' deploy-stack ☁️  ')));

    const s = spinner();
    s.start('Running pre-flight checks...');

    const [hasTerraform, hasAws, hasDocker, hasGit] = await Promise.all([
        checkDependency('terraform'),
        checkDependency('aws'),
        checkDependency('docker'),
        checkDependency('git')
    ]);

    s.stop('Pre-flight checks complete.\n');

    const printStatus = (ok, label, fix) => {
        const icon = ok ? color.green('✅') : color.red('❌');
        const message = ok ? `${label} (✓)` : `${label} (✗)`;
        console.log(`   ${icon} ${message}`);
        if (!ok) {
            console.log(`      ┌─ Try: ${color.dim(fix)}`);
        }
    };

    printStatus(hasTerraform, 'Terraform', 'Install via Homebrew: brew install terraform');
    printStatus(hasAws, 'AWS CLI', 'Install via Homebrew: brew install awscli');
    printStatus(hasDocker, 'Docker', 'Install via Homebrew: brew install docker');
    printStatus(hasGit, 'Git', 'Install via Homebrew: brew install git');

    if (hasTerraform && hasAws && hasDocker && hasGit) {
        outro(color.green('Your system is 100% ready to provision and deploy! 🚀'));
    } else {
        outro(color.yellow('Please install the missing dependencies before running the provisioning tool.'));
    }
}