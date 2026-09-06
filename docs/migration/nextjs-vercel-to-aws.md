# Migrating Next.js from Vercel to AWS Fargate

If you are seeing a warning from `deploy-stack` about `output: 'standalone'`, your Next.js configuration is missing a crucial setting required for containerized environments.

By default, Next.js requires your entire `node_modules` folder to run the production server. This creates massive, bloated Docker containers that boot slowly and cost more to host. The `standalone` output mode tells Next.js to trace your code and bundle *only* the specific files and dependencies actually used in production, creating an ultra-lean deployment artifact.

## How to Fix

### 1. Update `next.config.js` (or `.mjs` / `.cjs`)
Open your Next.js configuration file in the root of your project and add `output: 'standalone'` to the configuration object.

**Before (Vercel Default):**
```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Other existing config...
};

export default nextConfig;
```

**After (AWS Ready):**
```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // <-- Add this line
  // Other existing config...
};

export default nextConfig;
```

### 2. (Optional) Define a Health Check Route
AWS Application Load Balancers require a route to ping to ensure your app is healthy. If you don't already have one, create a simple API route in your app (e.g., `app/api/health/route.ts` for App Router, or `pages/api/health.ts` for Pages Router) that returns a `200 OK` status.

When running `deploy-stack`, choose **Advanced Configuration** and set your ALB Health Check Path to this route (e.g., `/api/health`).

### 3. Deploy
Your Next.js app is now perfectly optimized for AWS ECS Fargate! 

Run `npx deploy-stack apply`. The CLI's generated `Dockerfile` will automatically target your new `.next/standalone` directory and deploy the optimized build to the cloud.