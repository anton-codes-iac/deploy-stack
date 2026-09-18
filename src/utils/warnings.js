import color from 'picocolors';

export function getFrameworkWarning(frameworkId) {
    switch (frameworkId) {
        case 'nestjs':
            return (
                color.bgYellow(color.black(' ⚠️  IMPORTANT: NESTJS SETUP REQUIRED ')) +
                color.yellow('\n    You must ensure your app binds to 0.0.0.0 to receive traffic in AWS Fargate.') +
                color.yellow('\n    In src/main.ts, update your bootstrap function to:') +
                color.green('\n    await app.listen(process.env.PORT ?? 3000, \'0.0.0.0\');\n\n')
            );
        case 'nextjs':
            return (
                color.bgYellow(color.black(' ⚠️  IMPORTANT: NEXT.JS SETUP REQUIRED ')) +
                color.yellow('\n    You must modify your next.config file and create a health check route before deploying.') +
                color.yellow('\n    See the "Critical Application Prerequisites" section in your README.md for copy-paste code.\n\n')
            );
        case 'node':
            return (
                color.bgYellow(color.black(' ⚠️  IMPORTANT: NODE.JS SETUP REQUIRED ')) +
                color.yellow('\n    1. Ensure your package.json has a "start" script (e.g., "start": "node index.js").') +
                color.yellow('\n    2. Your app must listen on 0.0.0.0 (not localhost) to receive traffic in Docker.\n\n')
            );
        case 'python':
            return (
                color.bgYellow(color.black(' ⚠️  IMPORTANT: PYTHON SETUP REQUIRED ')) +
                color.yellow('\n    1. Ensure your requirements.txt includes your web framework (e.g., fastapi, uvicorn).') +
                color.yellow('\n    2. Your app must listen on 0.0.0.0 (not localhost) to receive traffic in Docker.') +
                color.yellow('\n    3. Ensure your app has a health check route returning 200 OK.\n\n')
            );
        case 'rails':
            return (
                color.bgYellow(color.black(' ℹ️  RAILS DOCKERFILE REPLACED ')) +
                color.yellow('\n    1. We safely backed up your default Rails Dockerfile to Dockerfile.bak.') +
                color.yellow('\n    2. We replaced it with an Alpine multi-stage build to guarantee 0 CVEs and AWS ALB compatibility.') +
                color.yellow('\n    3. If you use SQLite locally but provisioned RDS, ensure the "pg" gem is in your Gemfile.\n\n')
            );
        case 'static':
            return (
                color.bgYellow(color.black(' ⚠️  IMPORTANT: STATIC SITE SETUP REQUIRED ')) +
                color.yellow('\n    1. Open your generated Dockerfile.') +
                color.yellow('\n    2. We defaulted your output folder to /app/dist.') +
                color.yellow('\n    3. If your framework uses a different folder (like build/ or out/), change it in the COPY command.') +
                color.yellow('\n    4. Ensure your package.json has a "build" script (e.g., "vite build").\n\n')
            );
        default:
            return '';
    }
}