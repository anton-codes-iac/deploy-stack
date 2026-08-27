import fs from 'fs';
import path from 'path';
import { intro, outro, confirm, spinner, cancel } from '@clack/prompts';
import color from 'picocolors';

export async function ejectStack() {
    intro(color.bgRed(color.white(' deploy-stack eject ⏏️  ')));

    console.log(color.yellow('This will permanently decouple your infrastructure from the deploy-stack CLI.'));
    console.log(color.gray('It removes all ManagedBy tags and tool-specific metadata from your local files.'));
    console.log(color.gray('Your infrastructure will remain fully operational as raw, standalone Terraform.'));

    const shouldEject = await confirm({
        message: 'Are you sure you want to eject? (This cannot be undone)',
        initialValue: false,
    });

    if (!shouldEject || typeof shouldEject === 'symbol') {
        cancel('Eject cancelled. You are still managed by deploy-stack.');
        process.exit(0);
    }

    const s = spinner();
    s.start('Ejecting deploy-stack metadata...');

    const targetDir = process.cwd();
    const tfDir = path.join(targetDir, 'terraform');
    const mainTfPath = path.join(tfDir, 'main.tf');
    const gitignorePath = path.join(targetDir, '.gitignore');

    // 1. Clean main.tf
    if (fs.existsSync(mainTfPath)) {
        let content = fs.readFileSync(mainTfPath, 'utf8');

        // Remove the top header comment
        content = content.replace(/# deploy-stack generated infrastructure\n?/g, '');

        // Safely remove the default_tags block
        const defaultTagsRegex = /[ \t]*default_tags\s*\{\s*tags\s*=\s*\{\s*ManagedBy\s*=\s*"deploy-stack"\s*\}\s*\}\n?/g;
        content = content.replace(defaultTagsRegex, '');

        fs.writeFileSync(mainTfPath, content.trim() + '\n');
    }

    // 2. Clean up .gitignore
    if (fs.existsSync(gitignorePath)) {
        let gitignore = fs.readFileSync(gitignorePath, 'utf8');
        // Remove the exact block we injected in backup.js
        gitignore = gitignore.replace(/\n# deploy-stack backups\n\*\.bak\.\*\n/g, '\n');
        fs.writeFileSync(gitignorePath, gitignore.trim() + '\n');
    }

    // 3. Purge all local `.bak` files to leave a pristine directory
    const cleanBackups = (dir) => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (file.includes('.bak.')) {
                fs.rmSync(fullPath, { recursive: true, force: true });
            } else if (fs.statSync(fullPath).isDirectory() && file !== 'node_modules' && file !== '.git') {
                cleanBackups(fullPath); // Recursively check subdirectories like .github/workflows
            }
        }
    };

    cleanBackups(targetDir);

    s.stop('Ejection complete.');

    outro(`
    ${color.green('✅ Successfully ejected from deploy-stack!')}
    
    Your Terraform and CI/CD files are now 100% vanilla. 
    
    ${color.blue('Next Step:')}
    Run ${color.cyan('terraform apply')} inside your terraform/ folder. 
    AWS will sync your state and automatically remove the 'ManagedBy' tags from your live cloud resources.

    ${color.magenta('Godspeed! You are now the sole owner of your infrastructure.')}
    `);
}