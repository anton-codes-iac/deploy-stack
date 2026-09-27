#!/usr/bin/env node
// Maintainer script: refresh the bundled Bedrock model catalog from live AWS
// data, pruning models that are no longer available. Run with local AWS
// credentials (`npm run sync:bedrock-models`) or via the weekly workflow.
// Exits non-zero when live models arrive without family hint rules so the
// catalog never silently accumulates generic entries.
import path from 'path';
import { refreshBedrockCatalog, validateCatalogHints } from '../src/utils/bedrock-catalog.js';

const target = path.resolve('src/data/bedrock-models.json');
const catalog = await refreshBedrockCatalog({ cachePath: target, pruneMissing: true });
const modelCount = catalog.providers.reduce((total, group) => total + group.models.length, 0);
console.log(
    `Synced ${modelCount} models across ${catalog.providers.length} providers ` +
    `to src/data/bedrock-models.json (updatedAt=${catalog.updatedAt}).`
);

const result = validateCatalogHints(catalog);
if (!result.ok) {
    console.error(`::error file=src/utils/bedrock-catalog.js::Unrecognized Bedrock model families missing hint rules: ${result.unmatchedModels.map(m => m.id).join(', ')}. Update generateHintForModel() in src/utils/bedrock-catalog.js.`);
    process.exit(1);
}
