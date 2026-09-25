import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://starlight.astro.build/reference/configuration/
export default defineConfig({
  site: 'https://anton-codes-iac.github.io',
  base: '/deploy-stack',
  redirects: {
    '/adrs/001-initial-architecture/': '/deploy-stack/adrs/0001-s3-native-state-locking/',
  },
  integrations: [
    starlight({
      title: 'deploy-stack',
      description: 'Provision production-ready AWS infrastructure and CI/CD pipelines in seconds.',
      customCss: ['./src/custom.css'],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/anton-codes-iac/deploy-stack' },
      ],
      editLink: {
        baseUrl: 'https://github.com/anton-codes-iac/deploy-stack/edit/main/apps/docs/',
      },
      lastUpdated: true,
      sidebar: [
        {
          label: 'Deployment Guides',
          items: [
            { label: 'Quickstart (5 minutes)', slug: 'guides/quickstart' },
            { label: 'CI/CD Pipeline & First Deploy', slug: 'guides/cicd-pipeline' },
            { label: 'Supported Frameworks', slug: 'guides/frameworks' },
            { label: 'Reference Implementations & Examples', slug: 'guides/examples' },
            { label: 'Dockerfiles & Containers', slug: 'guides/dockerfiles' },
            { label: 'Docker Compose', slug: 'guides/docker-compose' },
            { label: 'Managed Database Connections', slug: 'guides/database-connections' },
            { label: 'Secrets Management', slug: 'guides/secrets-management' },
            { label: 'Ephemeral PR Previews', slug: 'guides/ephemeral-pr-previews' },
            { label: 'Troubleshooting AWS Credentials', slug: 'guides/aws-credentials' },
            { label: 'Re-running Init Safely', slug: 'guides/rerun-init' },
            { label: 'Headless Mode & Automation', slug: 'guides/headless' },
          ],
        },
        {
          label: 'CLI Reference',
          items: [
            { label: 'npx deploy-stack (init)', slug: 'cli/init' },
            { label: 'apply', slug: 'cli/apply' },
            { label: 'destroy', slug: 'cli/destroy' },
            { label: 'secrets', slug: 'cli/secrets' },
            { label: 'diagnose', slug: 'cli/diagnose' },
            { label: 'logs', slug: 'cli/logs' },
            { label: 'status', slug: 'cli/status' },
            { label: 'rollback', slug: 'cli/rollback' },
            { label: 'exec', slug: 'cli/exec' },
            { label: 'db connect', slug: 'cli/db' },
            { label: 'gc', slug: 'cli/gc' },
            { label: 'doctor', slug: 'cli/doctor' },
            { label: 'eject', slug: 'cli/eject' },
            { label: 'sync-ai', slug: 'cli/sync-ai' },
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
