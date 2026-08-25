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

            // Next.js & Express
            if (deps['next']) return { id: 'nextjs', name: 'Next.js' };
            if (deps['express']) return { id: 'node', name: 'Node.js / Express' };

            // Static Site Generators & SPAs (with precise build directories)
            if (deps['@sveltejs/kit']) return { id: 'static', name: 'SvelteKit', buildDir: 'build' };
            if (deps['react-scripts']) return { id: 'static', name: 'Create React App', buildDir: 'build' };
            if (deps['gatsby']) return { id: 'static', name: 'Gatsby', buildDir: 'public' };
            if (deps['nuxt']) return { id: 'static', name: 'Nuxt', buildDir: '.output/public' };
            if (deps['astro']) return { id: 'static', name: 'Astro', buildDir: 'dist' };
            if (deps['vite']) return { id: 'static', name: 'Vite', buildDir: 'dist' };
            if (deps['@vue/cli-service']) return { id: 'static', name: 'Vue.js', buildDir: 'dist' };
            if (deps['@angular/cli']) return { id: 'static', name: 'Angular', buildDir: 'dist' };
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