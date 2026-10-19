// Installs the Claudinite engine a repository pins and links
// .claudinite/bin/cn to it.
//
// In an adopted repository it reads engine.version, engine.manifest,
// engine.package and engine.releases from .claudinite/settings.yaml,
// downloads that release's manifest.json and this platform's binary from
// the npm registry, or from the GitHub releases of the repository
// engine.releases names, and checks the manifest against the pin, its
// signature against the roots below and the binary against the manifest.
// In a repository with no settings.yaml it installs the version asked for,
// or else the latest @claudinite/cli, checked against npm's integrity and
// the signature alone, for cn adopt to run from.
//
// The verified files are cached read-only under the user's cache folder
// and checked again on every run, so a warm run downloads nothing.

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import zlib from 'node:zlib';

// The key ceremony's root and standby root, the only roots a released cn
// trusts (ClaudiniteEngine cn/integrations/trust/roots).
export const ROOTS = [
  'zbIx-NsR2QOtuDxN_NRWdaic7korqWlbavM2SGImfwo',
  'AhHHTZ9fOPKENvhdnp4ScvxYooGpxPcwLePrHaRLyKs',
];

const CERT_DOMAIN = 'claudinite-cert-v1\n';
const MANIFEST_DOMAIN = 'claudinite-manifest-v1\n';
const MAX_CERT_VALIDITY_MS = 400 * 24 * 3600 * 1000;
const PACKAGES = ['@claudinite/cli', '@claudinite/cli-rc'];
const MAX_TAR_FILE = 128 << 20;

// Refusal is a configuration or integrity failure; the session stops and
// asks the person.
export class Refusal extends Error {}

// Unreachable is a download that did not complete; nothing unverified is
// cached.
export class Unreachable extends Error {
  constructor(url, cause) {
    super(`could not fetch the engine from ${url}${cause ? ` (${cause})` : ''}`);
    this.url = url;
  }
}

const refuse = (msg) => {
  throw new Refusal(msg);
};

const b64url = (s) => Buffer.from(s, 'base64url');
const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const sha512 = (b) => createHash('sha512').update(b).digest();
export const integrityOf = (b) => 'sha512-' + sha512(b).toString('base64');

// readEngineBlock returns the engine block's quoted values. No YAML parser:
// the values needed are plain quoted strings read with a strict pattern. A
// key absent reads undefined; one present twice, or not holding a non-empty
// quoted string, refuses.
export function readEngineBlock(text, file) {
  const lines = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^engine:[ \t]*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^[^ \t]/.test(line)) inBlock = false;
    if (inBlock) lines.push(line);
  }
  const value = (key) => {
    const found = lines.filter((l) => new RegExp(`^[ \\t]*"?${key}"?[ \\t]*:`).test(l));
    if (found.length === 0) return undefined;
    if (found.length > 1) refuse(`engine.${key} appears twice in ${file}`);
    const m = new RegExp(`^[ \\t]*"?${key}"?[ \\t]*:[ \\t]*"([^"]+)"[ \\t]*$`).exec(found[0]);
    if (!m) refuse(`engine.${key} in ${file} must be a plain quoted string`);
    return m[1];
  };
  return {
    version: value('version'),
    manifest: value('manifest'),
    package: value('package'),
    releases: value('releases'),
  };
}

const isVersion = (v) => typeof v === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v);
const isPin = (p) => typeof p === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(p);
const isRepo = (r) => /^[A-Za-z0-9-]+\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(r);

// platformOf maps Node's names to the release's: linux-x64, darwin-arm64,
// windows-x64 and so on.
export function platformOf(platform = process.platform, arch = process.arch) {
  const osName = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[platform];
  if (!osName) refuse(`unsupported operating system ${platform}`);
  if (arch !== 'x64' && arch !== 'arm64') refuse(`unsupported processor ${arch}`);
  if (osName === 'windows' && arch !== 'x64') refuse(`unsupported platform windows-${arch}`);
  return `${osName}-${arch}`;
}

const binaryName = (platform) => (platform.startsWith('windows-') ? 'cn.exe' : 'cn');

// verifyManifest checks manifest.sig.json: its certificate is signed by
// one of roots for use manifest, and its signature covers manifest. now,
// when given, must fall within the certificate's validity; a pinned
// manifest passes no now, since the pin a person merged already vouches for
// those exact bytes and an old pin must stay installable.
export function verifyManifest(sigText, manifest, roots, now) {
  let sig;
  try {
    sig = JSON.parse(sigText);
  } catch {
    refuse('manifest.sig.json is not JSON');
  }
  const cert = sig?.certificate;
  if (typeof cert?.payload !== 'string' || typeof cert?.signature !== 'string' || typeof sig.signature !== 'string') {
    refuse('manifest.sig.json is malformed');
  }
  const body = b64url(cert.payload);
  let b;
  try {
    b = JSON.parse(body.toString('utf8'));
  } catch {
    refuse('the manifest certificate body is not JSON');
  }
  const fields = ['v', 'keyId', 'publicKey', 'use', 'issuer', 'notBefore', 'notAfter'];
  if (!b || typeof b !== 'object' || Object.keys(b).some((k) => !fields.includes(k))) {
    refuse('the manifest certificate body has unknown fields');
  }
  const signer = roots.find((r) => keyID(b64url(r)) === b.issuer);
  if (!signer || !edVerify(b64url(signer), Buffer.concat([Buffer.from(CERT_DOMAIN), body]), b64url(cert.signature))) {
    refuse('the manifest certificate is not signed by a trusted root');
  }
  if (b.v !== 1) refuse(`certificate version ${b.v} is not supported`);
  if (b.use !== 'manifest') refuse(`the manifest certificate's use is ${JSON.stringify(b.use)}, not "manifest"`);
  const subject = b64url(String(b.publicKey));
  if (subject.length !== 32) refuse('the manifest certificate public key is malformed');
  if (keyID(subject) !== b.keyId) refuse('the manifest certificate keyId does not match its public key');
  const nb = Date.parse(b.notBefore);
  const na = Date.parse(b.notAfter);
  if (Number.isNaN(nb) || Number.isNaN(na)) refuse('the manifest certificate validity times are malformed');
  if (!(na > nb) || na - nb > MAX_CERT_VALIDITY_MS) refuse('the manifest certificate validity exceeds 400 days');
  if (now !== undefined) {
    if (now < nb) refuse('the manifest certificate is not yet valid');
    if (now > na) refuse('the manifest certificate has expired');
  }
  const message = Buffer.concat([Buffer.from(MANIFEST_DOMAIN), sha512(manifest)]);
  if (!edVerify(subject, message, b64url(sig.signature))) refuse('the manifest signature does not verify');
  return b.keyId;
}

function keyID(raw) {
  return sha256hex(raw).slice(0, 16);
}

function edVerify(raw, data, signature) {
  if (raw.length !== 32 || signature.length !== 64) return false;
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
  return verifySignature(null, data, key, signature);
}

// tarFile returns the regular file name from a gzipped tarball, or
// undefined when it holds none.
export function tarFile(tgz, name) {
  let tar;
  try {
    tar = zlib.gunzipSync(tgz, { maxOutputLength: 4 * MAX_TAR_FILE });
  } catch {
    refuse('a downloaded tarball is not gzip');
  }
  let longName;
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((c) => c === 0)) break;
    const field = (a, z) => h.subarray(a, z).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 136).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) refuse('a downloaded tarball is malformed');
    const type = String.fromCharCode(h[156]);
    const prefix = field(257, 263).startsWith('ustar') ? field(345, 500) : '';
    const entry = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    longName = undefined;
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if ((type === '0' || type === '\0') && entry === name) {
      if (size > MAX_TAR_FILE) refuse(`${name} in a downloaded tarball is too large`);
      return Buffer.from(data);
    }
  }
  return undefined;
}

// noProxy reports whether host is listed in NO_PROXY.
function noProxy(host, env) {
  const list = (env.NO_PROXY ?? env.no_proxy ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  host = host.toLowerCase();
  return list.some((e) => {
    if (e === '*') return true;
    const bare = e.replace(/^\*?\./, '');
    return host === bare || host.endsWith('.' + bare);
  });
}

// httpsGet downloads url over HTTPS only, through HTTPS_PROXY where one is
// set, following up to five HTTPS redirects, within maxBytes and timeoutMs.
export function httpsGet(url, { maxBytes, timeoutMs, env = process.env, headers = {} }, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new Refusal(`${url} is not HTTPS`));
    const deadline = setTimeout(() => fail(new Unreachable(url, 'timed out')), timeoutMs);
    let req;
    const fail = (e) => {
      clearTimeout(deadline);
      req?.destroy();
      reject(e);
    };
    const proxy = env.HTTPS_PROXY ?? env.https_proxy;
    const port = Number(u.port || 443);
    const start = (socket) => {
      req = https.request(
        u,
        {
          headers: { 'user-agent': 'claudinite-setup', ...headers },
          minVersion: 'TLSv1.2',
          ...(socket && {
            createConnection: () => tls.connect({ socket, servername: u.hostname, minVersion: 'TLSv1.2' }),
          }),
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            clearTimeout(deadline);
            if (redirects === 0) return reject(new Unreachable(url, 'too many redirects'));
            const next = new URL(res.headers.location, u).href;
            return httpsGet(next, { maxBytes, timeoutMs, env, headers }, redirects - 1).then(resolve, reject);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return fail(new Unreachable(url, `HTTP ${res.statusCode}`));
          }
          if (Number(res.headers['content-length'] ?? 0) > maxBytes) {
            return fail(new Refusal(`${url} is larger than the ${maxBytes}-byte download cap`));
          }
          const chunks = [];
          let n = 0;
          res.on('data', (c) => {
            n += c.length;
            if (n > maxBytes) return fail(new Refusal(`${url} is larger than the ${maxBytes}-byte download cap`));
            chunks.push(c);
          });
          res.on('end', () => {
            clearTimeout(deadline);
            resolve(Buffer.concat(chunks));
          });
          res.on('error', (e) => fail(new Unreachable(url, e.message)));
        },
      );
      req.on('error', (e) => fail(new Unreachable(url, e.message)));
      req.end();
    };
    if (!proxy || noProxy(u.hostname, env)) return start();
    const p = new URL(proxy);
    const connect = http.request({
      host: p.hostname,
      port: Number(p.port || 80),
      method: 'CONNECT',
      path: `${u.hostname}:${port}`,
      headers: { host: `${u.hostname}:${port}` },
    });
    req = connect;
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(new Unreachable(url, `proxy answered ${res.statusCode}`));
      }
      start(socket);
    });
    connect.on('error', (e) => fail(new Unreachable(url, `proxy: ${e.message}`)));
    connect.end();
  });
}

// privateDir makes dir (and its parents) mode 0700, closes to 0700 one this
// user owns that no one else could write to, as actions/cache restores it,
// and refuses one that is a symbolic link, or, off Windows, not mode 0700
// and owned by this user.
function privateDir(dir, windows) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    refuse(`cannot create the cache directory ${dir}`);
  }
  let st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) refuse(`the cache directory ${dir} is a symbolic link`);
  if (windows) return;
  const mode = st.mode & 0o777;
  if (st.isDirectory() && st.uid === process.getuid() && (mode & 0o022) === 0 && mode !== 0o700) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      refuse(`cannot close the cache directory ${dir} to mode 0700`);
    }
    st = fs.lstatSync(dir);
  }
  if ((st.mode & 0o777) !== 0o700 || st.uid !== process.getuid()) {
    refuse(`the cache directory ${dir} must be mode 0700 and owned by you (found ${(st.mode & 0o777).toString(8)}, uid ${st.uid})`);
  }
}

const read = (f) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return undefined;
  }
};

function place(dir, name, data, mode) {
  const tmp = path.join(dir, `.${name}.${process.pid}`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  const dest = path.join(dir, name);
  try {
    fs.chmodSync(dest, 0o644);
  } catch {}
  fs.renameSync(tmp, dest);
}

// install sets up the engine for repo and returns where its binary is.
// The world it reads (roots, registry, GitHub host, download, clock) comes
// in opts, so tests can stand in for each.
export async function install(opts = {}) {
  const env = opts.env ?? process.env;
  const repo = path.resolve(opts.repo ?? '.');
  const roots = opts.roots ?? ROOTS;
  const registry = (opts.registry ?? env.CLAUDINITE_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/$/, '');
  const github = (opts.github ?? env.CLAUDINITE_GITHUB ?? 'https://github.com').replace(/\/$/, '');
  const maxBytes = Number(opts.maxBytes ?? env.CLAUDINITE_MAX_DOWNLOAD_BYTES ?? 64 << 20);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) refuse('CLAUDINITE_MAX_DOWNLOAD_BYTES must be a number');
  const timeoutMs = Math.max(30, Math.floor(maxBytes / 220000)) * 1000;
  const get = opts.get ?? ((url, headers) => httpsGet(url, { maxBytes, timeoutMs, env, headers }));
  const now = opts.now ?? Date.now();
  const platform = opts.platform ?? platformOf();
  const bin = binaryName(platform);
  const windows = platform.startsWith('windows-');
  const linkDir = path.join(repo, '.claudinite', 'bin');

  try {
    const settingsFile = path.join(repo, '.claudinite', 'settings.yaml');
    const settingsText = read(settingsFile);
    let version, pin, pkg, releases;
    if (settingsText !== undefined) {
      if (opts.version) refuse(`--version applies only before adoption; ${settingsFile} pins engine.version`);
      const e = readEngineBlock(settingsText.toString('utf8'), settingsFile);
      ({ version, manifest: pin, releases } = e);
      pkg = e.package ?? '@claudinite/cli';
      if (!isVersion(version)) refuse(`engine.version in ${settingsFile} must be a quoted version like "1.60928.1"`);
      if (!isPin(pin)) refuse(`engine.manifest in ${settingsFile} must be a quoted sha512-... integrity string`);
      if (!PACKAGES.includes(pkg)) refuse(`engine.package in ${settingsFile} must be "@claudinite/cli" or "@claudinite/cli-rc"`);
      if (releases !== undefined && !isRepo(releases)) {
        refuse(`engine.releases in ${settingsFile} must be a quoted GitHub repository like "owner/name"`);
      }
    } else {
      pkg = '@claudinite/cli';
      version = opts.version;
      if (version !== undefined && !isVersion(version)) refuse(`--version must be a version like 1.60928.1`);
    }
    const name = pkg.slice('@claudinite/'.length);

    // A repository not yet adopted takes the version from npm, and the
    // channel tarball's integrity from the same packument.
    let integrity;
    if (pin === undefined) {
      const url = `${registry}/${pkg}`;
      let doc;
      try {
        doc = JSON.parse((await get(url, { accept: 'application/vnd.npm.install-v1+json' })).toString('utf8'));
      } catch (e) {
        if (e instanceof Refusal || e instanceof Unreachable) throw e;
        refuse(`${url} is not a packument`);
      }
      version ??= doc?.['dist-tags']?.latest;
      if (!isVersion(version)) refuse(`${pkg} has no latest version`);
      integrity = doc?.versions?.[version]?.dist?.integrity;
      if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) refuse(`${pkg} has no ${version}`);
    }

    if (!env.XDG_CACHE_HOME && !env.HOME && !opts.cacheRoot) {
      refuse('HOME is not set, so there is no cache folder (set HOME or XDG_CACHE_HOME)');
    }
    const cacheRoot = opts.cacheRoot ?? path.join(env.XDG_CACHE_HOME || path.join(env.HOME, '.cache'), 'claudinite');
    const vdir = path.join(cacheRoot, version);
    privateDir(cacheRoot, windows);
    privateDir(vdir, windows);

    // The manifest a pin names, or, unpinned, the one whose signature
    // verifies now; then this platform's entry in it.
    const accept = (manifest, sigText) => {
      if (pin !== undefined && integrityOf(manifest) !== pin) {
        refuse(`manifest.json of ${pkg} ${version} does not match the pin in ${path.join(repo, '.claudinite', 'settings.yaml')}`);
      }
      verifyManifest(sigText, manifest, roots, pin === undefined ? now : undefined);
      let m;
      try {
        m = JSON.parse(manifest.toString('utf8'));
      } catch {
        refuse('manifest.json is not JSON');
      }
      if (m.version !== version) refuse(`manifest.json is for ${m.version}, not ${version}`);
      const entry = m.binaries?.[platform];
      if (!entry || entry.file !== bin || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
        refuse(`${pkg} ${version} lists no binary for ${platform}`);
      }
      return entry;
    };

    const cached = () => {
      const manifest = read(path.join(vdir, 'manifest.json'));
      const sigText = read(path.join(vdir, 'manifest.sig.json'));
      const binary = read(path.join(vdir, bin));
      if (!manifest || !sigText || !binary) return false;
      if (pin !== undefined && integrityOf(manifest) !== pin) return false;
      let entry;
      try {
        entry = accept(manifest, sigText.toString('utf8'));
      } catch (e) {
        if (e instanceof Refusal) return false;
        throw e;
      }
      return sha256hex(binary) === entry.sha256 && binary.length === entry.size;
    };

    if (!cached()) {
      const base = releases ? `${github}/${releases}/releases/download/v${version}` : undefined;
      const channelURL = base ? `${base}/${name}-${version}.tgz` : `${registry}/${pkg}/-/${name}-${version}.tgz`;
      const binaryURL = base
        ? `${base}/${name}-${platform}-${version}.tgz`
        : `${registry}/${pkg}-${platform}/-/${name}-${platform}-${version}.tgz`;
      const channel = await get(channelURL);
      if (integrity !== undefined && integrityOf(channel) !== integrity) {
        refuse(`${channelURL} does not match npm's integrity for ${pkg} ${version}`);
      }
      const manifest = tarFile(channel, 'package/manifest.json') ?? refuse(`${channelURL} holds no package/manifest.json`);
      const sig = tarFile(channel, 'package/manifest.sig.json') ?? refuse(`${channelURL} holds no package/manifest.sig.json`);
      const entry = accept(manifest, sig.toString('utf8'));
      const binary = tarFile(await get(binaryURL), `package/bin/${bin}`) ?? refuse(`${binaryURL} holds no package/bin/${bin}`);
      if (sha256hex(binary) !== entry.sha256 || binary.length !== entry.size) {
        refuse(`the ${platform} binary of ${pkg} ${version} does not match its manifest entry`);
      }
      try {
        place(vdir, bin, binary, 0o555);
        place(vdir, 'manifest.sig.json', sig, 0o444);
        place(vdir, 'manifest.json', manifest, 0o444);
      } catch {
        refuse(`cannot place the engine in ${vdir}`);
      }
    }

    const target = path.join(vdir, bin);
    const link = path.join(linkDir, bin);
    let same = false;
    try {
      same = fs.realpathSync(link) === fs.realpathSync(target);
    } catch {}
    if (!same) {
      try {
        fs.mkdirSync(linkDir, { recursive: true });
        fs.rmSync(link, { force: true });
        try {
          fs.symlinkSync(target, link);
        } catch {
          fs.copyFileSync(target, link);
          fs.chmodSync(link, 0o555);
        }
      } catch {
        refuse(`cannot link or copy the engine into ${linkDir}`);
      }
    }
    return target;
  } catch (e) {
    // The engine never runs unverified, so the link to it goes.
    if (e instanceof Refusal || e instanceof Unreachable) {
      for (const b of ['cn', 'cn.exe']) fs.rmSync(path.join(linkDir, b), { force: true });
    }
    throw e;
  }
}
