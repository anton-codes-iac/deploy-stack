import fs from 'fs';
import path from 'path';
import { select, isCancel, cancel } from '@clack/prompts';
import color from 'picocolors';

export async function handleExistingFiles(targetDir) {
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

    const overwriteDecision = await select({
        message: color.yellow('⚠️  deploy-stack configurations already exist. What would you like to do?'),
        options: [
            { value: 'cancel', label: 'Cancel', hint: 'Exit without making changes' },
            { value: 'backup', label: 'Backup & Regenerate', hint: 'Move old configs to .bak (ignored by Git) and regenerate' }
        ]
    });

    if (isCancel(overwriteDecision) || overwriteDecision === 'cancel') {
        cancel('Operation cancelled to protect existing files.');
        process.exit(0);
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