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

            // Explicit SvelteKit SSR Detection
            if (deps['@sveltejs/kit']) return { id: 'svelte', name: 'SvelteKit SSR', buildDir: 'build' };

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

// Parses a vercel.json file to extract routing and edge rules
export function parseVercelConfig(targetDir) {
    const vercelConfigPath = path.join(targetDir, 'vercel.json');
    if (!fsSync.existsSync(vercelConfigPath)) return null;

    try {
        const content = fsSync.readFileSync(vercelConfigPath, 'utf-8');
        const vercelJson = JSON.parse(content);

        // We only care about network-level edge rules that AWS needs to handle
        const rules = {
            redirects: vercelJson.redirects || null,
            headers: vercelJson.headers || null,
            rewrites: vercelJson.rewrites || null
        };

        // If it's just an empty vercel.json, return null
        if (!rules.redirects && !rules.headers && !rules.rewrites) {
            return null;
        }

        return rules;
    } catch (e) {
        // Silently fail on malformed JSON
        return null;
    }
}

// Checks if Next.js is configured for 'standalone' output
export function analyzeNextConfig(targetDir) {
    const extensions = ['js', 'mjs', 'cjs', 'ts'];
    let configPath = null;
    let configContent = '';

    for (const ext of extensions) {
        const tempPath = path.join(targetDir, `next.config.${ext}`);
        if (fsSync.existsSync(tempPath)) {
            configPath = tempPath;
            configContent = fsSync.readFileSync(tempPath, 'utf-8');
            break;
        }
    }

    if (!configPath) return { hasConfig: false, isStandalone: false };

    // Regex looks for output: 'standalone' or output: "standalone" (handling spacing)
    const isStandalone = /output\s*:\s*['"`]standalone['"`]/.test(configContent);

    return {
        hasConfig: true,
        isStandalone: isStandalone,
        configPath: configPath
    };
}

// Checks if SvelteKit is locked into Vercel
export function analyzeSvelteConfig(targetDir) {
    const configPath = path.join(targetDir, 'svelte.config.js');
    if (!fsSync.existsSync(configPath)) return { hasConfig: false, adapter: 'unknown' };

    const content = fsSync.readFileSync(configPath, 'utf-8');

    let adapter = 'unknown';
    if (content.includes('@sveltejs/adapter-vercel')) adapter = 'vercel';
    else if (content.includes('@sveltejs/adapter-node')) adapter = 'node';
    else if (content.includes('@sveltejs/adapter-static')) adapter = 'static';
    else if (content.includes('@sveltejs/adapter-auto')) adapter = 'auto'; // Vercel's default

    return { hasConfig: true, adapter };
}

// Checks if Astro is locked into Vercel
export function analyzeAstroConfig(targetDir) {
    const extensions = ['mjs', 'js', 'ts', 'cjs'];
    let configPath = null;
    let content = '';

    for (const ext of extensions) {
        const tempPath = path.join(targetDir, `astro.config.${ext}`);
        if (fsSync.existsSync(tempPath)) {
            configPath = tempPath;
            content = fsSync.readFileSync(tempPath, 'utf-8');
            break;
        }
    }

    if (!configPath) return { hasConfig: false, adapter: 'unknown' };

    let adapter = 'unknown';
    if (content.includes('@astrojs/vercel')) adapter = 'vercel';
    else if (content.includes('@astrojs/node')) adapter = 'node';

    return { hasConfig: true, adapter };
}