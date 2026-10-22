// The world the installer's tests stand up: a signing authority, engine
// releases as the registry serves them and a repository with a cache.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { integrityOf } from '../install.mjs';

export const PLATFORM = 'linux-x64';
export const DAY = 24 * 3600 * 1000;
export const NOW = Date.parse('2026-10-19T00:00:00Z');

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { raw: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'), privateKey };
}
const keyID = (raw) => createHash('sha256').update(raw).digest('hex').slice(0, 16);

// An authority like the release's: a root certifies a release key, which
// signs the manifest.
export function authority({ notBefore = NOW - DAY, notAfter = NOW + 300 * DAY, use = 'manifest' } = {}) {
  const root = keyPair();
  const release = keyPair();
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      keyId: keyID(release.raw),
      publicKey: release.raw.toString('base64url'),
      use,
      issuer: keyID(root.raw),
      notBefore: new Date(notBefore).toISOString().replace(/\.000Z$/, 'Z'),
      notAfter: new Date(notAfter).toISOString().replace(/\.000Z$/, 'Z'),
    }),
  );
  const certificate = {
    payload: body.toString('base64url'),
    signature: sign(null, Buffer.concat([Buffer.from('claudinite-cert-v1\n'), body]), root.privateKey).toString('base64url'),
  };
  return {
    roots: [root.raw.toString('base64url')],
    sign(manifest) {
      const digest = createHash('sha512').update(manifest).digest();
      const signature = sign(null, Buffer.concat([Buffer.from('claudinite-manifest-v1\n'), digest]), release.privateKey);
      return Buffer.from(JSON.stringify({ certificate, signature: signature.toString('base64url') }));
    },
  };
}

export function tgz(files) {
  const blocks = [];
  for (const [name, data] of Object.entries(files)) {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const c of h) sum += c;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

// release builds one engine version's two tarballs as the registry serves
// them.
export function release(version, auth, { binary = Buffer.from(`cn ${version}\n`), listed = binary } = {}) {
  const manifest = Buffer.from(
    JSON.stringify({
      version,
      binaries: {
        [PLATFORM]: { file: 'cn', sha256: createHash('sha256').update(listed).digest('hex'), size: listed.length },
      },
    }),
  );
  const channel = tgz({
    'package/package.json': Buffer.from('{}'),
    'package/manifest.json': manifest,
    'package/manifest.sig.json': auth.sign(manifest),
  });
  return { manifest, channel, platform: tgz({ 'package/bin/cn': binary }), pin: integrityOf(manifest) };
}

export function world(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudinite-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, '.claudinite'), { recursive: true });
  const fetched = [];
  const get = async (url) => {
    fetched.push(url);
    if (!(url in files)) throw new Error(`no ${url}`);
    return files[url];
  };
  const settings = (lines) => fs.writeFileSync(path.join(repo, '.claudinite', 'settings.yaml'), `engine:\n${lines}\n`);
  const serve = (more) => Object.assign(files, more);
  return { dir, repo, fetched, get, settings, serve, cacheRoot: path.join(dir, 'cache', 'claudinite') };
}

export const R = 'https://registry.example';
export const npmFiles = (v, rel) => ({
  [`${R}/@claudinite/cli/-/cli-${v}.tgz`]: rel.channel,
  [`${R}/@claudinite/cli-${PLATFORM}/-/cli-${PLATFORM}-${v}.tgz`]: rel.platform,
});
