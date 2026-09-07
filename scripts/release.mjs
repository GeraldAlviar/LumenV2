// Maintainer command only. End users upload the already generated manifest.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BUILD } from '../js/config.js';
const root = new URL('../', import.meta.url);
const paths = ['index.html', 'phone.html', 'desktop.html',
  ...['js', 'css'].flatMap(dir => readdirSync(new URL(dir + '/', root)).filter(n => /\.(js|css)$/.test(n)).map(n => dir + '/' + n))].sort();
const manifest = { build: BUILD, algorithm: 'SHA-256', files: paths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex') })) };
const text = JSON.stringify(manifest, null, 2) + '\n';
const file = new URL('release-manifest.json', root);
if (process.argv.includes('--check')) {
  if (readFileSync(file, 'utf8') !== text) throw new Error('Release manifest is stale. Run npm run release after final runtime edits.');
  console.log(`Release ${BUILD}: all ${paths.length} runtime hashes match.`);
} else { writeFileSync(file, text); console.log(`Generated ${BUILD} manifest for ${paths.length} runtime files.`); }
