import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

const manifests = [
  'src/plugin/.claude-plugin/plugin.json',
  'src/plugin/.codex-plugin/plugin.json',
];

for (const path of manifests) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`synced ${path} to ${version}`);
}
