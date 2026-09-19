# Spec: Starlight Documentation Hub

## Objective
Initialize an Astro Starlight documentation site inside the monorepo to serve as the official, version-controlled developer portal for `deploy-stack`.

## Requirements
1. **Scaffolding:** Initialize a new Astro Starlight project inside the `apps/docs/` directory.
2. **Information Architecture:** Configure `astro.config.mjs` to render a sidebar with three main sections:
   - **Core Concepts:** (Link to ADRs and architectural decisions).
   - **Guides:** (Link to deployment guides and PaaS migrations).
   - **CLI Reference:** (Command reference for init, apply, diagnose).
3. **Migration:** Move all existing Markdown files from the root `docs/adrs/` folder into `apps/docs/src/content/docs/adrs/` so they are immediately searchable.

## Constraints
- Use the standard Astro Starlight dependency tree. 
- Ensure a script (e.g., `"docs:dev": "npm run dev --workspace=apps/docs"`) is added to the root `package.json` to allow starting the docs from the top level.