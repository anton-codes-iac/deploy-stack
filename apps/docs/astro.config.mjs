import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://starlight.astro.build/reference/configuration/
export default defineConfig({
  site: 'https://anton-codes-iac.github.io',
  base: '/deploy-stack',
  integrations: [
    starlight({
      title: 'deploy-stack',
      description: 'Provision production-ready AWS infrastructure and CI/CD pipelines in seconds.',
      customCss: ['./src/custom.css'],
      sidebar: [
        {
          label: 'CLI Commands',
          items: [
            { label: 'npx deploy-stack (init)', slug: 'cli/init' },
            { label: 'apply', slug: 'cli/apply' },
            { label: 'destroy', slug: 'cli/destroy' },
            { label: 'secrets push', slug: 'cli/secrets' },
            { label: 'diagnose', slug: 'cli/diagnose' },
            { label: 'logs', slug: 'cli/logs' },
            { label: 'status', slug: 'cli/status' },
            { label: 'exec', slug: 'cli/exec' },
            { label: 'doctor', slug: 'cli/doctor' },
            { label: 'eject', slug: 'cli/eject' },
            { label: 'sync-ai', slug: 'cli/sync-ai' },
          ],
        },
        {
          label: 'Deployment Guides',
          items: [
            { label: 'CI/CD Pipeline & First Deploy', slug: 'guides/cicd-pipeline' },
            { label: 'Supported Frameworks', slug: 'guides/frameworks' },
            { label: 'Examples', slug: 'guides/examples' },
            { label: 'AWS Credentials & Auth', slug: 'guides/aws-credentials' },
            { label: 'Database Connections', slug: 'guides/database-connections' },
            { label: 'Secrets Management', slug: 'guides/secrets-management' },
            { label: 'Dockerfiles & Containers', slug: 'guides/dockerfiles' },
            { label: 'Docker Compose', slug: 'guides/docker-compose' },
            { label: 'Ephemeral PR Previews', slug: 'guides/ephemeral-pr-previews' },
            { label: 'Headless Mode & Automation', slug: 'guides/headless' },
            { label: 'Re-running Init', slug: 'guides/rerun-init' },
          ],
        },
        {
          label: 'Platform Migrations',
          items: [
            { label: 'Vercel (Next.js)', slug: 'migrations/nextjs-vercel-to-aws' },
            { label: 'Heroku (Procfile)', slug: 'migrations/heroku-procfile-to-aws' },
            { label: 'Vercel (Astro)', slug: 'migrations/astro-vercel-to-aws' },
            { label: 'Vercel (SvelteKit)', slug: 'migrations/sveltekit-vercel-to-aws' },
          ],
        },
        {
          label: 'Project Details',
          items: [
            { label: 'Roadmap', slug: 'roadmap' },
            { label: 'Testing Strategy', slug: 'testing-strategy' },
          ],
        },
        {
          label: 'Architecture (ADRs)',
          items: [
            { autogenerate: { directory: 'adrs' } }
          ],
        },
      ],
    }),
  ],
});
