import { spawn } from 'child_process';
import color from 'picocolors';

// Runs a terraform command while piping the latest stdout line into a
// @clack spinner. Resolves on exit 0; rejects with the captured stderr
// (or the exit code) otherwise.
export function runTerraformCommand(args, cwd, spin, loadingPrefix) {
    return new Promise((resolve, reject) => {
        const child = spawn('terraform', args, { cwd });
        let errorOutput = '';
        let isDone = false;

        child.stdout.on('data', (data) => {
            if (isDone) return;
            const lines = data.toString().split('\n').filter(line => line.trim() !== '');
            if (lines.length > 0) {
                const latestLine = lines[lines.length - 1].trim();
                const display = latestLine.length > 120 ? latestLine.substring(0, 117) + '...' : latestLine;
                spin.message(`${loadingPrefix} - ${color.dim(display)}`);
            }
        });

        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        child.on('close', (code) => {
            isDone = true;
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(errorOutput || `Terraform exited with code ${code}`));
            }
        });

        child.on('error', (err) => {
            isDone = true;
            reject(err);
        });
    });
}

// Pulls JSON outputs from Terraform. Never throws: unparseable output,
// non-zero exit, and spawn errors all resolve to an empty object.
export function getTerraformOutputs(cwd) {
    return new Promise((resolve) => {
        const child = spawn('terraform', ['output', '-json'], { cwd });
        let outputData = '';

        child.stdout.on('data', (data) => {
            outputData += data.toString();
        });

        child.on('close', (code) => {
            if (code === 0) {
                try {
                    resolve(JSON.parse(outputData));
                } catch {
                    resolve({});
                }
            } else {
                resolve({});
            }
        });

        child.on('error', () => {
            resolve({});
        });
    });
}
