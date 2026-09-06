# Migrating SvelteKit from Vercel to AWS Fargate

If you are seeing a warning from `deploy-stack` about your SvelteKit adapter, your project is currently using `@sveltejs/adapter-auto` (which often defaults to Vercel) or the explicit `@sveltejs/adapter-vercel`.

These adapters are designed specifically for proprietary serverless edge networks. To run your SvelteKit app in a scalable, standard Docker container on AWS Fargate, you need to switch to Svelte's official Node adapter.

## How to Fix

### 1. Install the Node Adapter
Run the following command in your terminal to install the Node adapter and remove the Vercel/Auto adapter:

```bash
npm install -D @sveltejs/adapter-node
npm uninstall @sveltejs/adapter-auto @sveltejs/adapter-vercel
```

### 2. Update `svelte.config.js`
Open your `svelte.config.js` file and change the adapter import at the top of the file.

**Before (Locked into Vercel/Auto):**
```javascript
import adapter from '@sveltejs/adapter-auto'; // or '@sveltejs/adapter-vercel'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter()
	}
};

export default config;
```

**After (AWS Ready):**
```javascript
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter()
	}
};

export default config;
```

### 3. Deploy
Your SvelteKit app is now decoupled! 

Run `npx deploy-stack apply`. The CLI will automatically detect the standard Node build output, package it into a hardened Docker container, and deploy it to your AWS cluster.