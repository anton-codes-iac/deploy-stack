import fs from 'fs';
import path from 'path';
import { load } from 'js-yaml';

// 1. Check if a Docker Compose file exists in the target directory.
export function hasDockerCompose(targetDir) {
    return fs.existsSync(path.join(targetDir, 'docker-compose.yml')) ||
        fs.existsSync(path.join(targetDir, 'docker-compose.yaml'));
}

// 2. Parse docker-compose.yml and normalize it into an array of services.
export function parseDockerCompose(targetDir) {
    let composePath = path.join(targetDir, 'docker-compose.yml');
    if (!fs.existsSync(composePath)) {
        composePath = path.join(targetDir, 'docker-compose.yaml');
    }

    if (!fs.existsSync(composePath)) return null;

    try {
        const fileContents = fs.readFileSync(composePath, 'utf8');
        const data = load(fileContents);

        if (!data || !data.services) return null;

        const services = [];

        for (const [name, config] of Object.entries(data.services)) {
            // Extract the container port (e.g., "8080:80" -> 80)
            let exposedPort = null;
            if (config.ports && config.ports.length > 0) {
                // Handle different port formats like "3000" or "8000:8000" or "127.0.0.1:8001:8001"
                const portMapping = config.ports[0].toString();
                const parts = portMapping.split(':');
                exposedPort = parseInt(parts[parts.length - 1].replace(/[^0-9]/g, ''), 10);
            }

            // Normalize environment variables from Array or Object
            let envVars = {};
            if (Array.isArray(config.environment)) {
                config.environment.forEach(env => {
                    const [key, ...val] = env.split('=');
                    if (key) envVars[key] = val.join('=');
                });
            } else if (typeof config.environment === 'object') {
                envVars = config.environment;
            }

            services.push({
                name,
                build: config.build || null,
                image: config.image || null,
                port: exposedPort,
                command: config.command || null,
                environment: envVars
            });
        }

        return services;
    } catch (e) {
        console.error('⚠️ Failed to parse Docker Compose file:', e.message);
        return null;
    }
}