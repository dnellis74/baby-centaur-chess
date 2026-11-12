#!/usr/bin/env node
/*
 * flush-rooms.mjs — delete EVERY stored game in the rooms
 * Durable Object namespace.
 *
 * There is no API to empty a DO namespace or list its objects,
 * so this does the documented equivalent: rename the DO class
 * (Room -> Room2 -> Room3 ...), and deploy migrations that
 * delete the old class (destroying all its stored objects) and
 * create the new one empty. The worker URL and the ROOMS
 * binding name never change, and the game client needs no
 * update: it only ever talks to the binding.
 *
 * Usage (from anywhere; paths resolve relative to this file):
 *   node flush-rooms.mjs [--yes] [--dry-run] [--no-deploy]
 *
 * Requires npx wrangler, logged in (Dave's MacBook). If the
 * deploy fails, the file edits are rolled back and nothing is
 * flushed. After a successful flush, tell Muse the new class
 * name so the repo copy of the worker stays in sync.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

const dir = dirname(fileURLToPath(import.meta.url));
const tomlPath = join(dir, 'wrangler.toml');
const srcPath = join(dir, 'src', 'index.js');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const noDeploy = args.has('--no-deploy');
const assumeYes = args.has('--yes');

const toml = readFileSync(tomlPath, 'utf8');
const src = readFileSync(srcPath, 'utf8');

const classMatch = toml.match(/class_name\s*=\s*"([^"]+)"/);
if (!classMatch) fail('No class_name found in wrangler.toml.');
const oldClass = classMatch[1];
const parts = oldClass.match(/^(.*?)(\d*)$/);
const nextClass = `${parts[1]}${(parts[2] ? parseInt(parts[2], 10) : 1) + 1}`;

if (!src.includes(`export class ${oldClass}`)) {
  fail(`src/index.js does not export class ${oldClass}; refusing to guess.`);
}
const tags = [...toml.matchAll(/tag\s*=\s*"v(\d+)"/g)].map((x) => parseInt(x[1], 10));
const lastTag = tags.length ? Math.max(...tags) : 0;

const newSrc = src.replace(`export class ${oldClass}`, `export class ${nextClass}`);
const newToml = toml.replace(
  `class_name = "${oldClass}"`,
  `class_name = "${nextClass}"`,
) + `
[[migrations]]
tag = "v${lastTag + 1}"
deleted_classes = ["${oldClass}"]

[[migrations]]
tag = "v${lastTag + 2}"
new_sqlite_classes = ["${nextClass}"]
`;

console.log(`Flush plan: delete class ${oldClass} (ALL stored games go with it) and recreate the namespace as ${nextClass}.`);
console.log(`Migrations: v${lastTag + 1} deletes ${oldClass}; v${lastTag + 2} creates ${nextClass}.`);
if (dryRun) {
  console.log('Dry run: nothing changed.');
  process.exit(0);
}

if (!assumeYes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type yes to continue: ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('Aborted; nothing changed.');
    process.exit(0);
  }
}

writeFileSync(srcPath, newSrc);
writeFileSync(tomlPath, newToml);
console.log('Files updated.');

if (noDeploy) {
  console.log('Skipping deploy (--no-deploy). Run `npx wrangler deploy` in this folder to apply the flush.');
  process.exit(0);
}

const res = spawnSync('npx', ['wrangler', 'deploy'], { cwd: dir, stdio: 'inherit' });
if (res.status !== 0) {
  writeFileSync(srcPath, src);
  writeFileSync(tomlPath, toml);
  fail('wrangler deploy failed, so the file edits were rolled back. Nothing was flushed.');
}
console.log(`Done. All rooms flushed; the namespace now uses class ${nextClass}.`);
console.log('Tell Muse the new class name so the repo copy stays in sync.');
