import fsSync from 'fs';
import path from 'path';

// Detects the framework based on the presence of framework-specific files.
export function detectFramework(targetDir) {
    const packageJsonPath = path.join(targetDir, 'package.json');
    const requirementsTxtPath = path.join(targetDir, 'requirements.txt');
    const managePyPath = path.join(targetDir, 'manage.py');
    const goModPath = path.join(targetDir, 'go.mod');
    const gemfilePath = path.join(targetDir, 'Gemfile');

    // 1. Detect Node.js Frameworks
    if (fsSync.existsSync(packageJsonPath)) {
        try {
            const pkg = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8'));
            // Merge dependencies and devDependencies to check both
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

            // Fullstack / API
            if (deps['next']) return { id: 'nextjs', name: 'Next.js' };
            if (deps['nuxt']) return { id: 'nuxt', name: 'Nuxt 3 (SSR)' };
            if (deps['express']) return { id: 'node', name: 'Node.js / Express' };

            // Static Site Generators & SPAs (with precise build directories)
            if (deps['@sveltejs/kit']) return { id: 'static', name: 'SvelteKit', buildDir: 'build' };
            if (deps['react-scripts']) return { id: 'static', name: 'Create React App', buildDir: 'build' };
            if (deps['gatsby']) return { id: 'static', name: 'Gatsby', buildDir: 'public' };
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
            if (reqs.includes('django')) return { id: 'django', name: 'Django' };
        } catch (e) {
            // Silently fail
        }
    }

    // Fallback Django detection (sometimes requirements.txt is named differently)
    if (fsSync.existsSync(managePyPath)) return { id: 'django', name: 'Django' };

    // 3. Detect Ruby on Rails
    if (fsSync.existsSync(gemfilePath)) {
        try {
            const gemfile = fsSync.readFileSync(gemfilePath, 'utf-8').toLowerCase();
            if (/gem\s+['"]rails['"]/i.test(gemfile)) { return { id: 'rails', name: 'Ruby on Rails' }; }
        } catch (e) {
            // Silently fail
        }
    }

    // 4. Detect Go
    if (fsSync.existsSync(goModPath)) return { id: 'go', name: 'Go' };

    // 5. Fallback
    return null;
}

// Parses a Heroku/Render Procfile and formats the commands for Terraform ECS.
export function parseProcfile(targetDir) {
    const procfilePath = path.join(targetDir, 'Procfile');

    if (!fsSync.existsSync(procfilePath)) return null;

    const content = fsSync.readFileSync(procfilePath, 'utf-8');
    const processes = {};

    // Match lines like "web: gunicorn myapp.wsgi"
    const lines = content.split('\n');
    const procRegex = /^([A-Za-z0-9_-]+):\s*(.+)$/;

    for (const line of lines) {
        const match = line.trim().match(procRegex);
        if (match) {
            const type = match[1].toLowerCase();
            const rawCommand = match[2].trim();

            // Terraform requires the command as a JSON array of strings
            // This splits by spaces but respects single and double quotes
            const commandArray = rawCommand.match(/[^\s"']+|"([^"]*)"|'([^']*)'/g)
                .map(str => str.replace(/^["']|["']$/g, '')); // Strip the quotes

            processes[type] = commandArray;
        }
    }

    return Object.keys(processes).length > 0 ? processes : null;
}