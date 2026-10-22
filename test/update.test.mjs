import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { integrityOf, Refusal } from '../install.mjs';
import { candidate, update } from '../update.mjs';
import { authority, NOW, npmFiles, PLATFORM, R, release, world } from '../fixtures/world.mjs';

const GH = 'https://github.example';

// engine is a release whose binary is a script: selftest prints its
// version and fails the probes named in fail, and update apply logs its
// arguments and, unless apply is 'refuse', moves the pin in settings.yaml
// to its own version.
function engine(w, version, auth, { fail = [], apply = 'move' } = {}) {
  const log = path.join(w.dir, 'apply.log');
  const settings = path.join(w.repo, '.claudinite', 'settings.yaml');
  const script = [
    '#!/bin/sh',
    'if [ "$1" = selftest ]; then',
    `  echo "version ${version}"`,
    ...fail.map((p) => `  echo "fail ${p} broken"`),
    `  exit ${fail.length ? 1 : 0}`,
    'fi',
    `echo "${version} $*" >> "${log}"`,
    apply === 'move'
      ? `sed -i.bak -e 's/^  version: ".*"$/  version: "${version}"/' "${settings}" && rm -f "${settings}.bak"`
      : 'exit 1',
  ].join('\n');
  return { ...release(version, auth, { binary: Buffer.from(script + '\n') }), log };
}

const applied = (w) => {
  try {
    return fs.readFileSync(path.join(w.dir, 'apply.log'), 'utf8').trim().split('\n');
  } catch {
    return [];
  }
};
const linked = (w) => {
  try {
    return fs.realpathSync(path.join(w.repo, '.claudinite', 'bin', 'cn'));
  } catch {
    return undefined;
  }
};

function packument(tags, rels, deprecated = {}) {
  const versions = {};
  for (const [v, rel] of Object.entries(rels)) {
    versions[v] = { dist: { integrity: integrityOf(rel.channel) }, ...(deprecated[v] && { deprecated: deprecated[v] }) };
  }
  return Buffer.from(JSON.stringify({ 'dist-tags': tags, versions }));
}

// stand builds a world holding the pinned release and the others, with
// npm's packument for them.
function stand(t, { pin, others = [], tags, deprecated, settings = '', opts = {} }) {
  const auth = authority();
  const w = world(t, {});
  const rels = {};
  for (const v of [pin, ...others]) rels[v] = engine(w, v, auth, opts[v]);
  const files = { [`${R}/@claudinite/cli`]: packument(tags, rels, deprecated) };
  for (const [v, rel] of Object.entries(rels)) Object.assign(files, npmFiles(v, rel));
  w.serve(files);
  w.settings(`  version: "${pin}"\n  manifest: "${rels[pin].pin}"${settings}`);
  const said = [];
  const run = (extra = {}) =>
    update({ repo: w.repo, roots: auth.roots, registry: R, github: GH, get: w.get, now: NOW, platform: PLATFORM, cacheRoot: w.cacheRoot, say: (l) => said.push(l), env: process.env, ...extra });
  return { w, rels, said, run, auth };
}

test('update moves to the newest version the channel offers, smoke-tests it and hands it apply', async (t) => {
  const { w, said, run } = stand(t, { pin: '1.61019.1', others: ['1.61019.2', '1.61019.3'], tags: { latest: '1.61019.2', staging: '1.61019.3' } });
  assert.equal(await run({ flags: ['--strict'] }), 0);
  const [line] = applied(w);
  assert.match(line, new RegExp(`^1\\.61019\\.2 update apply --repo ${w.repo} --manifest \\S+/1\\.61019\\.2/manifest\\.json --strict$`));
  assert.equal(linked(w), fs.realpathSync(path.join(w.cacheRoot, '1.61019.2', 'cn')));
  assert.deepEqual(said, []);
});

test('a staging member takes the staging dist-tag too', async (t) => {
  const { w, run } = stand(t, {
    pin: '1.61019.1',
    others: ['1.61019.2', '1.61019.3'],
    tags: { latest: '1.61019.2', staging: '1.61019.3' },
    settings: '\n  channel: "staging"',
  });
  assert.equal(await run(), 0);
  assert.match(applied(w)[0], /^1\.61019\.3 update apply/);
});

test('a held, revoked or deprecated newer version is skipped and said why', async (t) => {
  for (const msg of ['held: canary failed', 'revoked: corrupts settings', 'use another']) {
    const { w, said, run } = stand(t, {
      pin: '1.61019.1',
      others: ['1.61019.2', '1.61019.3'],
      tags: { latest: '1.61019.3', staging: '1.61019.2' },
      settings: '\n  channel: "staging"',
      deprecated: { '1.61019.3': msg },
    });
    assert.equal(await run(), 0);
    assert.match(applied(w)[0], /^1\.61019\.2 update apply/);
    assert.match(said[0], /^moving to 1\.61019\.2; 1\.61019\.3 skipped, (held|revoked|deprecated)$/);
  }
});

test('with nothing newer, update says so and the pinned engine applies the packs alone', async (t) => {
  const { w, said, run } = stand(t, { pin: '1.61019.2', others: ['1.61019.1', '2.61019.1'], tags: { latest: '2.61019.1', staging: '1.61019.1' } });
  assert.equal(await run(), 0);
  assert.deepEqual(said, ['up to date at 1.61019.2; 2.61019.1 skipped, a new major; take it with --to 2.61019.1']);
  assert.deepEqual(applied(w), [`1.61019.2 update apply --repo ${w.repo}`]);
  assert.equal(await run({ flags: ['--engine-only'] }), 0);
  assert.equal(applied(w).length, 1);
});

test('a revoked pin is named with its reason', async (t) => {
  const { said, run } = stand(t, { pin: '1.61019.2', tags: { latest: '1.61019.2' }, deprecated: { '1.61019.2': 'revoked: loses packs' } });
  await run();
  assert.equal(said[0], 'the pinned 1.61019.2 is revoked: loses packs');
});

test('a candidate whose selftest fails a probe is refused before apply runs, and the link stays', async (t) => {
  const { w, run } = stand(t, {
    pin: '1.61019.1',
    others: ['1.61019.2'],
    tags: { latest: '1.61019.2' },
    opts: { '1.61019.2': { fail: ['hooks', 'mount'] } },
  });
  fs.mkdirSync(path.join(w.repo, '.claudinite', 'bin'));
  fs.writeFileSync(path.join(w.repo, '.claudinite', 'bin', 'cn'), 'old');
  await assert.rejects(run(), (e) => e instanceof Refusal && /selftest of 1\.61019\.2 failed \(hooks, mount\)/.test(e.message));
  assert.deepEqual(applied(w), []);
  assert.equal(fs.readFileSync(path.join(w.repo, '.claudinite', 'bin', 'cn'), 'utf8'), 'old');
});

test('apply that leaves the pin where it was leaves the link too, and its exit code is update\'s', async (t) => {
  const { w, run } = stand(t, { pin: '1.61019.1', others: ['1.61019.2'], tags: { latest: '1.61019.2' }, opts: { '1.61019.2': { apply: 'refuse' } } });
  assert.equal(await run(), 1);
  assert.equal(applied(w).length, 1);
  assert.equal(linked(w), undefined);
});

test('--to takes an exact version, older ones included, and passes it on', async (t) => {
  const { w, run } = stand(t, { pin: '1.61019.2', others: ['1.61019.1'], tags: { latest: '1.61019.2' } });
  assert.equal(await run({ to: '1.61019.1' }), 0);
  assert.match(applied(w)[0], /^1\.61019\.1 update apply --repo \S+ --manifest \S+ --to 1\.61019\.1$/);
});

test('--to a revoked version is refused', async (t) => {
  const { run } = stand(t, { pin: '1.61019.2', others: ['1.61019.1'], tags: { latest: '1.61019.2' }, deprecated: { '1.61019.1': 'revoked: bad' } });
  await assert.rejects(run({ to: '1.61019.1' }), /1\.61019\.1 is revoked: bad/);
});

test('a member on engine.releases moves to that repository\'s latest release, checked against its pin', async (t) => {
  const auth = authority();
  const w = world(t, {});
  const old = engine(w, '1.61019.1', auth);
  const rel = engine(w, '1.61019.2', auth);
  const base = `${GH}/Claudinite/StagingReleases/releases`;
  const latest = (manifest) => Buffer.from(JSON.stringify({ version: '1.61019.2', manifest, commit: 'a'.repeat(40) }));
  w.serve({
    [`${base}/latest/download/release.json`]: latest(rel.pin),
    [`${base}/download/v1.61019.2/cli-1.61019.2.tgz`]: rel.channel,
    [`${base}/download/v1.61019.2/cli-${PLATFORM}-1.61019.2.tgz`]: rel.platform,
  });
  w.settings(`  version: "1.61019.1"\n  manifest: "${old.pin}"\n  releases: "Claudinite/StagingReleases"`);
  const run = () => update({ repo: w.repo, roots: auth.roots, github: GH, get: w.get, now: NOW, platform: PLATFORM, cacheRoot: w.cacheRoot, say: () => {} });
  assert.equal(await run(), 0);
  assert.match(applied(w)[0], /^1\.61019\.2 update apply/);

  w.settings(`  version: "1.61019.1"\n  manifest: "${old.pin}"\n  releases: "Claudinite/StagingReleases"`);
  w.serve({ [`${base}/latest/download/release.json`]: latest(old.pin) });
  fs.rmSync(path.join(w.cacheRoot, '1.61019.2'), { recursive: true });
  await assert.rejects(run(), /does not match the pin/);
});

test('a repository not yet adopted is refused', async (t) => {
  const w = world(t, {});
  await assert.rejects(update({ repo: w.repo, cacheRoot: w.cacheRoot, platform: PLATFORM, get: w.get }), /adopt the repository first/);
});

test('candidate keeps to the channel\'s tags and the pin\'s major', () => {
  const doc = {
    'dist-tags': { latest: '1.2.3', staging: '1.2.4', next: '1.2.9' },
    versions: { '1.2.3': {}, '1.2.4': {}, '1.2.9': {}, '1.2.2': {} },
  };
  assert.deepEqual(candidate('1.2.2', 'stable', doc), { version: '1.2.3', skipped: undefined });
  assert.deepEqual(candidate('1.2.2', 'staging', doc), { version: '1.2.4', skipped: undefined });
  assert.deepEqual(candidate('1.2.4', 'staging', doc), { version: undefined, skipped: { version: '1.2.4', reason: 'not newer' } });
  assert.deepEqual(candidate('1.2.10', 'stable', doc).version, undefined);
});
