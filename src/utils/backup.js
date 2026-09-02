import fs from 'fs';
import path from 'path';
import { select, isCancel, cancel } from '@clack/prompts';
import color from 'picocolors';

export async function handleExistingFiles(targetDir, isHeadless = false) {
    const tfPath = path.join(targetDir, 'terraform');
    const dockerfilePath = path.join(targetDir, 'Dockerfile');
    const wfDir = path.join(targetDir, '.github', 'workflows');
    const wfPath = path.join(wfDir, 'deploy.yml');

    const tfExists = fs.existsSync(tfPath);
    const dockerfileExists = fs.existsSync(dockerfilePath);
    const wfExists = fs.existsSync(wfPath);

    if (!tfExists && !dockerfileExists && !wfExists) {
        return; // Clean slate
    }

    const foundFiles = [];
    if (tfExists) foundFiles.push('terraform/');
    if (dockerfileExists) foundFiles.push('Dockerfile');
    if (wfExists) foundFiles.push('.github/workflows/deploy.yml');

    let overwriteDecision = 'backup';

    if (!isHeadless) {
        overwriteDecision = await select({
            message: color.yellow(`⚠️  Conflicting files found (${foundFiles.join(', ')}). To guarantee a secure, 0-CVE deployment, we must use our optimized configurations.`),
            options: [
                { value: 'backup', label: 'Backup & Regenerate', hint: 'Move old configs to .bak and generate secure templates' },
                { value: 'cancel', label: 'Cancel', hint: 'Exit without making changes' }
            ]
        });

        if (isCancel(overwriteDecision) || overwriteDecision === 'cancel') {
            cancel('Operation cancelled to protect existing files.');
            process.exit(0);
        }
    }

    // Execute the safe backup
    const timestamp = Date.now();

    if (tfExists) fs.renameSync(tfPath, `${tfPath}.bak.${timestamp}`);
    if (dockerfileExists) fs.renameSync(dockerfilePath, `${dockerfilePath}.bak.${timestamp}`);
    if (wfExists) fs.renameSync(wfPath, `${wfPath}.bak.${timestamp}`);

    ensureGitIgnore(targetDir);

    console.log(color.cyan(`ℹ️  Existing configuration files were safely backed up locally.`));
}

/**
 * Appends backup patterns to .gitignore so local clutter never reaches GitHub.
 */
function ensureGitIgnore(targetDir) {
    const gitignorePath = path.join(targetDir, '.gitignore');
    const ignoreRules = '\n# deploy-stack backups\n*.bak.*\n';

    if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf8');
        if (!content.includes('*.bak.*')) {
            fs.appendFileSync(gitignorePath, ignoreRules);
        }
    } else {
        fs.writeFileSync(gitignorePath, ignoreRules);
    }
}