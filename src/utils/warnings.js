import color from 'picocolors';

export function getFrameworkWarning(frameworkId) {
    switch (frameworkId) {
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
        // Python / FastAPI warnings can be added here easily!
        default:
            return '';
    }
}