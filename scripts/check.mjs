import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
let count = 0;
for (const dir of ['js', 'scripts', 'tests']) {
  for (const name of readdirSync(new URL(dir + '/', root))) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(`${dir}/${name}`, root))], { stdio: 'pipe' }); count++;
  }
}
for (const file of ['index.html', 'phone.html', 'desktop.html']) {
  const html = readFileSync(new URL(file, root), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate element IDs in ${file}`);
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (/^(https?:|data:|mailto:)/.test(match[1])) continue;
    const name = match[1].split(/[?#]/)[0];
    if (!existsSync(new URL(name, root))) throw new Error(`Missing ${name} referenced by ${file}`);
  }
}
console.log(`Syntax checked ${count} JavaScript files; HTML IDs and local references checked.`);
