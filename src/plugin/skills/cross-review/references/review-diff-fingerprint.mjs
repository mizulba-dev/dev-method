#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const requestedCwd = process.argv[2] ?? process.cwd();
const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: requestedCwd,
  encoding: 'utf8',
});
if (rootResult.error) throw rootResult.error;
if (rootResult.status !== 0) {
  console.error(rootResult.stderr.trim() || 'review-diff-fingerprint: git リポジトリではありません');
  process.exit(1);
}
const cwd = rootResult.stdout.trim();
const hash = createHash('sha256');

function lengthBuffer(length) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(length));
  return buffer;
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd, encoding: null, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.toString('utf8').trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function hashTrackedDiff() {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = [];
    child.stdout.on('data', (chunk) => hash.update(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || 'git diff failed'));
    });
  });
}

function absolutePath(relativePath) {
  return Buffer.concat([Buffer.from(`${cwd}/`), relativePath]);
}

async function hashFile(path, size) {
  hash.update(lengthBuffer(size));
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
}

async function main() {
  hash.update('dev-method-review-diff-v1\0tracked\0');
  await hashTrackedDiff();
  hash.update('\0untracked\0');

  const paths = git(['ls-files', '--others', '--exclude-standard', '-z'])
    .subarray(0, -1)
    .toString('binary')
    .split('\0')
    .filter(Boolean)
    .map((path) => Buffer.from(path, 'binary'))
    .sort(Buffer.compare);

  for (const relativePath of paths) {
    const path = absolutePath(relativePath);
    const stat = lstatSync(path);
    hash.update('path\0');
    hash.update(lengthBuffer(relativePath.length));
    hash.update(relativePath);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path, { encoding: 'buffer' });
      hash.update('symlink\0');
      hash.update(lengthBuffer(target.length));
      hash.update(target);
    } else if (stat.isFile()) {
      hash.update('file\0');
      await hashFile(path, stat.size);
    } else {
      throw new Error(`未追跡の特殊ファイルは指紋化できません: ${relativePath.toString('utf8')}`);
    }
  }

  process.stdout.write(`${hash.digest('hex')}\n`);
}

main().catch((error) => {
  console.error(`review-diff-fingerprint: ${error.message}`);
  process.exit(1);
});
