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
            { label: 'npx deploy-stack (init)', link: '/cli/init/' },
            { label: 'apply', link: '/cli/apply/' },
            { label: 'destroy', link: '/cli/destroy/' },
            { label: 'secrets push', link: '/cli/secrets/' },
            { label: 'diagnose', link: '/cli/diagnose/' },
            { label: 'doctor', link: '/cli/doctor/' },
            { label: 'eject', link: '/cli/eject/' },
            { label: 'sync-ai', link: '/cli/sync-ai/' },
          ],
        },
        {
          label: 'Deployment Guides',
          items: [
            { label: 'CI/CD Pipeline & First Deploy', link: '/guides/cicd-pipeline/' },
            { label: 'Supported Frameworks', link: '/guides/frameworks/' },
            { label: 'Examples', link: '/guides/examples/' },
            { label: 'AWS Credentials & Auth', link: '/guides/aws-credentials/' },
            { label: 'Database Connections', link: '/guides/database-connections/' },
            { label: 'Secrets Management', link: '/guides/secrets-management/' },
            { label: 'Dockerfiles & Containers', link: '/guides/dockerfiles/' },
            { label: 'Docker Compose', link: '/guides/docker-compose/' },
            { label: 'Ephemeral PR Previews', link: '/guides/ephemeral-pr-previews/' },
            { label: 'Headless Mode & Automation', link: '/guides/headless/' },
            { label: 'Re-running Init', link: '/guides/rerun-init/' },
          ],
        },
        {
          label: 'Platform Migrations',
          items: [
            { label: 'Vercel (Next.js)', link: '/migrations/nextjs-vercel-to-aws/' },
            { label: 'Heroku (Procfile)', link: '/migrations/heroku-procfile-to-aws/' },
            { label: 'Vercel (Astro)', link: '/migrations/astro-vercel-to-aws/' },
            { label: 'Vercel (SvelteKit)', link: '/migrations/sveltekit-vercel-to-aws/' },
          ],
        },
        {
          label: 'Project Details',
          items: [
            { label: 'Roadmap', link: '/roadmap/' },
            { label: 'Testing Strategy', link: '/testing-strategy/' },
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
