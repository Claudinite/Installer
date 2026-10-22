import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { install, integrityOf, readEngineBlock, Refusal, tarFile } from '../install.mjs';
import { authority, DAY, npmFiles, NOW, PLATFORM, R, release, tgz, world } from '../fixtures/world.mjs';

function run(w, auth, extra = {}) {
  return install({ repo: w.repo, roots: auth.roots, registry: R, get: w.get, now: NOW, platform: PLATFORM, cacheRoot: w.cacheRoot, ...extra });
}

test('a pinned engine is installed and linked, and a warm run downloads nothing', async (t) => {
  const auth = authority();
  const rel = release('1.61019.1', auth);
  const w = world(t, npmFiles('1.61019.1', rel));
  w.settings(`  version: "1.61019.1"\n  manifest: "${rel.pin}"`);
  await run(w, auth);
  const link = path.join(w.repo, '.claudinite', 'bin', 'cn');
  assert.equal(fs.readFileSync(link, 'utf8'), 'cn 1.61019.1\n');
  assert.equal(fs.statSync(path.join(w.cacheRoot, '1.61019.1')).mode & 0o777, 0o700);
  assert.equal(w.fetched.length, 2);
  await run(w, auth);
  assert.equal(w.fetched.length, 2);
});

test('a staging member reads the release from the GitHub repository engine.releases names', async (t) => {
  const auth = authority();
  const rel = release('1.61019.2', auth);
  const base = 'https://github.example/Claudinite/StagingReleases/releases/download/v1.61019.2';
  const w = world(t, { [`${base}/cli-1.61019.2.tgz`]: rel.channel, [`${base}/cli-${PLATFORM}-1.61019.2.tgz`]: rel.platform });
  w.settings(`  version: "1.61019.2"\n  manifest: "${rel.pin}"\n  releases: "Claudinite/StagingReleases"`);
  await run(w, auth, { github: 'https://github.example' });
  assert.equal(fs.readFileSync(path.join(w.repo, '.claudinite', 'bin', 'cn'), 'utf8'), 'cn 1.61019.2\n');
});

test('a manifest the pin does not name is refused and the link removed', async (t) => {
  const auth = authority();
  const rel = release('1.61019.1', auth);
  const other = release('1.61019.1', auth, { binary: Buffer.from('other\n') });
  const w = world(t, npmFiles('1.61019.1', rel));
  fs.mkdirSync(path.join(w.repo, '.claudinite', 'bin'));
  fs.writeFileSync(path.join(w.repo, '.claudinite', 'bin', 'cn'), 'stale');
  w.settings(`  version: "1.61019.1"\n  manifest: "${other.pin}"`);
  await assert.rejects(run(w, auth), (e) => e instanceof Refusal && /does not match the pin/.test(e.message));
  assert.equal(fs.existsSync(path.join(w.repo, '.claudinite', 'bin', 'cn')), false);
});

test('a manifest signed under a root the installer does not trust is refused, pin or no pin', async (t) => {
  const rel = release('1.61019.1', authority());
  const w = world(t, npmFiles('1.61019.1', rel));
  w.settings(`  version: "1.61019.1"\n  manifest: "${rel.pin}"`);
  await assert.rejects(run(w, authority()), /not signed by a trusted root/);
});

test('a binary that does not match its manifest entry is refused', async (t) => {
  const auth = authority();
  const rel = release('1.61019.1', auth, { binary: Buffer.from('evil\n'), listed: Buffer.from('good\n') });
  const w = world(t, npmFiles('1.61019.1', rel));
  w.settings(`  version: "1.61019.1"\n  manifest: "${rel.pin}"`);
  await assert.rejects(run(w, auth), /does not match its manifest entry/);
});

test('a tampered cached binary is downloaded again', async (t) => {
  const auth = authority();
  const rel = release('1.61019.1', auth);
  const w = world(t, npmFiles('1.61019.1', rel));
  w.settings(`  version: "1.61019.1"\n  manifest: "${rel.pin}"`);
  await run(w, auth);
  const cached = path.join(w.cacheRoot, '1.61019.1', 'cn');
  fs.chmodSync(cached, 0o755);
  fs.writeFileSync(cached, 'evil\n');
  await run(w, auth);
  assert.equal(w.fetched.length, 4);
  assert.equal(fs.readFileSync(cached, 'utf8'), 'cn 1.61019.1\n');
});

test('an expired certificate still installs a pinned engine but never an unpinned one', async (t) => {
  const auth = authority({ notBefore: NOW - 400 * DAY, notAfter: NOW - 50 * DAY });
  const rel = release('1.61019.1', auth);
  const packument = Buffer.from(
    JSON.stringify({ 'dist-tags': { latest: '1.61019.1' }, versions: { '1.61019.1': { dist: { integrity: integrityOf(rel.channel) } } } }),
  );
  const pinned = world(t, npmFiles('1.61019.1', rel));
  pinned.settings(`  version: "1.61019.1"\n  manifest: "${rel.pin}"`);
  await run(pinned, auth);
  const unpinned = world(t, { ...npmFiles('1.61019.1', rel), [`${R}/@claudinite/cli`]: packument });
  fs.rmSync(path.join(unpinned.repo, '.claudinite'), { recursive: true });
  await assert.rejects(run(unpinned, auth), /certificate has expired/);
});

test('a repository not yet adopted gets the latest engine, checked against npm integrity', async (t) => {
  const auth = authority();
  const rel = release('1.61019.3', auth);
  const packument = (integrity) =>
    Buffer.from(JSON.stringify({ 'dist-tags': { latest: '1.61019.3' }, versions: { '1.61019.3': { dist: { integrity } } } }));
  const w = world(t, { ...npmFiles('1.61019.3', rel), [`${R}/@claudinite/cli`]: packument(integrityOf(rel.channel)) });
  fs.rmSync(path.join(w.repo, '.claudinite'), { recursive: true });
  await run(w, auth);
  assert.equal(fs.readFileSync(path.join(w.repo, '.claudinite', 'bin', 'cn'), 'utf8'), 'cn 1.61019.3\n');

  const bad = world(t, { ...npmFiles('1.61019.3', rel), [`${R}/@claudinite/cli`]: packument(integrityOf(Buffer.from('x'))) });
  fs.rmSync(path.join(bad.repo, '.claudinite'), { recursive: true });
  await assert.rejects(run(bad, auth), /does not match npm's integrity/);
});

test('--version is refused in an adopted repository, where settings.yaml pins the engine', async (t) => {
  const auth = authority();
  const w = world(t, {});
  w.settings(`  version: "1.61019.1"\n  manifest: "${release('1.61019.1', auth).pin}"`);
  await assert.rejects(run(w, auth, { version: '1.61019.2' }), /--version applies only before adoption/);
});

test('a cache folder others could write to is refused', async (t) => {
  const auth = authority();
  const rel = release('1.61019.1', auth);
  for (const mode of [0o775, 0o757, 0o777]) {
    const w = world(t, npmFiles('1.61019.1', rel));
    w.settings(`  version: "1.61019.1"\n  manifest: "${rel.pin}"`);
    fs.mkdirSync(w.cacheRoot, { recursive: true });
    fs.chmodSync(w.cacheRoot, mode);
    await assert.rejects(run(w, auth), /must be mode 0700/, mode.toString(8));
  }
});

test('a cache folder only its owner could write to, as actions/cache restores it, is closed and used', async (t) => {
  const auth = authority();
  const rel = release('1.61019.1', auth);
  const w = world(t, npmFiles('1.61019.1', rel));
  w.settings(`  version: "1.61019.1"\n  manifest: "${rel.pin}"`);
  await run(w, auth);
  const vdir = path.join(w.cacheRoot, '1.61019.1');
  fs.chmodSync(w.cacheRoot, 0o755);
  fs.chmodSync(vdir, 0o755);
  await run(w, auth);
  assert.equal(w.fetched.length, 2);
  assert.equal(fs.statSync(w.cacheRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(vdir).mode & 0o777, 0o700);
});

test('the engine block is read strictly', () => {
  const read = (s) => readEngineBlock(s, 'settings.yaml');
  assert.deepEqual(read('engine:\n  version: "1.2.3"\n  manifest: "m"\npacks:\n  version: "9.9.9"\n'), {
    version: '1.2.3',
    manifest: 'm',
    package: undefined,
    releases: undefined,
    channel: undefined,
  });
  assert.throws(() => read('engine:\n  version: "1.2.3"\n  version: "1.2.4"\n'), /appears twice/);
  assert.throws(() => read('engine:\n  version: 1.2.3\n'), /plain quoted string/);
});

test('tarFile reads one regular file and nothing else', () => {
  const t = tgz({ 'package/a': Buffer.from('A'), 'package/b': Buffer.from('B') });
  assert.equal(tarFile(t, 'package/b').toString(), 'B');
  assert.equal(tarFile(t, 'package/c'), undefined);
});
