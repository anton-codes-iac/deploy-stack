import fsSync from 'fs';
import path from 'path';

export function detectFramework(targetDir) {
    const packageJsonPath = path.join(targetDir, 'package.json');
    const requirementsTxtPath = path.join(targetDir, 'requirements.txt');

    // 1. Detect Node.js Frameworks
    if (fsSync.existsSync(packageJsonPath)) {
        try {
            const pkg = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8'));
            // Merge dependencies and devDependencies to check both
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

            if (deps['next']) return { id: 'nextjs', name: 'Next.js' };
            if (deps['vite'] || deps['astro'] || deps['@sveltejs/kit'] || deps['gatsby'] || deps['react-scripts'] || deps['@vue/cli-service']) return { id: 'static', name: 'Static Site (Vite, Astro, React)' };
            if (deps['express']) return { id: 'node', name: 'Node.js / Express' };
        } catch (e) {
            // Silently fail if package.json is malformed
        }
    }

    // 2. Detect Python Frameworks
    if (fsSync.existsSync(requirementsTxtPath)) {
        try {
            const reqs = fsSync.readFileSync(requirementsTxtPath, 'utf-8').toLowerCase();
            if (reqs.includes('fastapi')) return { id: 'python', name: 'Python FastAPI' };
        } catch (e) {
            // Silently fail
        }
    }

    // 3. Fallback
    return null;
}