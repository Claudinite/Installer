// Moves an adopted repository's engine to the newest release its channel
// offers, then hands the rest of the update to that release.
//
// It reads the pin, package, channel and releases repository from
// .claudinite/settings.yaml and picks the candidate: the newest version a
// dist-tag of the channel points at that is newer than the pin, of the
// pin's major, and neither deprecated, held: nor revoked:, or, where
// engine.releases names a repository, that repository's latest release.
// --to names the exact target instead, the one way to an older version or
// a new major. It fetches and verifies the candidate as install does,
// smoke-tests it with `<new cn> selftest --repo`, and runs
// `<new cn> update apply`, which writes the pin, the settings, the
// workflows and the packs. With nothing newer, the pinned engine runs
// `update apply` for the packs alone.
//
// The installer writes nothing in the repository but the uncommitted
// .claudinite/bin/cn link, and moves that only once the pin names the
// engine it points at.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

import { context, fetchEngine, isVersion, linkEngine, packument, readSettings, refuse, Refusal, Unreachable } from './install.mjs';

const SELFTEST_TIMEOUT_MS = 2 * 60 * 1000;

// The flags update passes on to `cn update apply`.
export const APPLY_FLAGS = ['--engine-only', '--packs-only', '--dry-run', '--json', '--strict'];

// The exit codes of update, which `cn update apply` shares: 0 updated or up
// to date, 1 refused with nothing written, 2 updated with a blocking
// finding under --strict, 3 could not run.
export const EXIT = { ok: 0, refused: 1, strict: 2, failed: 3 };

// The environment a binary not yet trusted runs with: enough to find its
// cache, a temp dir and the Go toolchain's caches, never a token.
const SCRUBBED = ['PATH', 'HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'SYSTEMROOT', 'USERPROFILE', 'GOCACHE', 'GOROOT', 'GOPATH', 'GOMODCACHE'];

const compare = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};
const major = (v) => v.split('.')[0];

// The dist-tags a channel takes releases from: its own and every more
// stable one's.
export function channelTags(channel) {
  switch (channel) {
    case 'stable':
      return ['latest'];
    case 'staging':
    case 'canary':
      return ['latest', 'staging'];
  }
  return [];
}

// deprecation reads npm's deprecation message: held:, revoked: or plain.
export function deprecation(msg) {
  if (!msg) return undefined;
  for (const kind of ['held', 'revoked']) {
    if (msg.startsWith(`${kind}:`)) return { kind, reason: msg.slice(kind.length + 1).trim() };
  }
  return { kind: 'deprecated', reason: msg };
}

// candidate picks, among the versions doc's channel tags point at, the
// newest of pin's major that is newer than pin and not deprecated, held or
// revoked, and the newest version it passed over above that, with why.
export function candidate(pin, channel, doc) {
  const tagged = new Set(channelTags(channel).map((t) => doc?.['dist-tags']?.[t]).filter(Boolean));
  let version;
  let skipped;
  for (const [v, e] of Object.entries(doc?.versions ?? {})) {
    if (!isVersion(v) || !tagged.has(v)) continue;
    let reason = deprecation(e?.deprecated)?.kind;
    if (!reason && compare(v, pin) <= 0) reason = 'not newer';
    if (!reason && major(v) !== major(pin)) reason = `a new major; take it with --to ${v}`;
    if (!reason) {
      if (version === undefined || compare(v, version) > 0) version = v;
    } else if (skipped === undefined || compare(v, skipped.version) > 0) {
      skipped = { version: v, reason };
    }
  }
  if (skipped && version && compare(skipped.version, version) <= 0) skipped = undefined;
  return { version, skipped };
}

// choose returns the engine to move to as fetchEngine takes it, or
// undefined when there is none, after saying why.
async function choose(ctx, s, to, say) {
  const channel = s.channel ?? (s.pkg === '@claudinite/cli-rc' ? 'staging' : 'stable');
  if (s.releases) {
    if (to) return { version: to, pkg: s.pkg, releases: s.releases };
    const url = `${ctx.github}/${s.releases}/releases/latest/download/release.json`;
    let latest;
    try {
      latest = JSON.parse((await ctx.get(url)).toString('utf8'));
    } catch (e) {
      if (e instanceof Refusal || e instanceof Unreachable) throw e;
      refuse(`${url} is not JSON`);
    }
    if (!isVersion(latest?.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(latest?.manifest ?? '')) {
      refuse(`${url} must name a version and a sha512-... manifest`);
    }
    if (compare(latest.version, s.version) <= 0) {
      say(`up to date at ${s.version}: the latest release of ${s.releases} is ${latest.version}`);
      return undefined;
    }
    if (major(latest.version) !== major(s.version)) {
      say(`up to date at ${s.version}: ${latest.version}, the latest release of ${s.releases}, is a new major; take it with --to ${latest.version}`);
      return undefined;
    }
    return { version: latest.version, pin: latest.manifest, pkg: s.pkg, releases: s.releases };
  }
  const doc = await packument(ctx, s.pkg);
  const pinned = deprecation(doc?.versions?.[s.version]?.deprecated);
  if (pinned?.kind === 'revoked') say(`the pinned ${s.version} is revoked: ${pinned.reason}`);
  let version = to;
  if (to) {
    const d = deprecation(doc?.versions?.[to]?.deprecated);
    if (d?.kind === 'revoked') refuse(`${s.pkg} ${to} is revoked: ${d.reason}`);
  } else {
    const c = candidate(s.version, channel, doc);
    const skip = c.skipped ? `; ${c.skipped.version} skipped, ${c.skipped.reason}` : '';
    if (!c.version) {
      say(`up to date at ${s.version}${skip}`);
      return undefined;
    }
    if (skip) say(`moving to ${c.version}${skip}`);
    version = c.version;
  }
  const integrity = doc?.versions?.[version]?.dist?.integrity;
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) refuse(`${s.pkg} has no ${version}`);
  return { version, integrity, pkg: s.pkg };
}

// selftest runs `<binary> selftest --repo` with a scrubbed environment and
// refuses a binary that is not the version asked for or fails a probe.
function selftest(binary, version, repo, env) {
  const scrubbed = Object.fromEntries(SCRUBBED.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
  const r = spawnSync(binary, ['selftest', '--repo', repo], { env: scrubbed, timeout: SELFTEST_TIMEOUT_MS, encoding: 'utf8' });
  if (r.error?.code === 'ETIMEDOUT') refuse(`selftest of ${version} did not finish within 2 minutes`);
  if (r.error) refuse(`selftest of ${version} could not run: ${r.error.message}`);
  const out = r.stdout ?? '';
  const first = out.split('\n')[0].trim();
  if (first !== `version ${version}`) refuse(`selftest reports ${JSON.stringify(first)}, not version ${version}`);
  if (r.status !== 0) {
    const probes = [...out.matchAll(/^fail ([a-z]+)\b/gm)].map((m) => m[1]);
    refuse(`selftest of ${version} failed${probes.length ? ` (${probes.join(', ')})` : ''}:\n${out.trim()}`);
  }
}

function run(binary, args, env) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: 'inherit', env });
    child.on('error', () => resolve(EXIT.failed));
    child.on('close', (code) => resolve(code ?? EXIT.failed));
  });
}

// update runs the update in opts.repo and returns its exit code. say
// receives the installer's own lines.
export async function update(opts = {}) {
  const ctx = context(opts);
  const say = opts.say ?? ((line) => console.error(`claudinite update: ${line}`));
  const flags = opts.flags ?? [];
  for (const f of flags) if (!APPLY_FLAGS.includes(f)) refuse(`unknown flag ${f}`);
  if (flags.includes('--engine-only') && flags.includes('--packs-only')) refuse('--engine-only and --packs-only exclude each other');
  if (opts.to !== undefined && !isVersion(opts.to)) refuse('--to must be a version like 1.61022.1');
  if (opts.to !== undefined && flags.includes('--packs-only')) refuse('--to moves the engine, which --packs-only leaves');
  const s = readSettings(ctx.repo) ?? refuse(`${path.join(ctx.repo, '.claudinite', 'settings.yaml')} is missing; adopt the repository first`);

  const target = flags.includes('--packs-only') ? undefined : await choose(ctx, s, opts.to, say);
  if (target === undefined && flags.includes('--engine-only')) return EXIT.ok;
  const pinned = { version: s.version, pin: s.pin, pkg: s.pkg, releases: s.releases, pinFile: s.file };
  const { binary, manifest } = await fetchEngine(ctx, target ? { ...target, fresh: true } : pinned);
  const version = target?.version ?? s.version;
  selftest(binary, version, ctx.repo, ctx.env);

  const args = ['update', 'apply', '--repo', ctx.repo];
  if (target) args.push('--manifest', manifest);
  if (opts.to !== undefined) args.push('--to', opts.to);
  const code = await run(binary, [...args, ...flags], ctx.env);
  if (readSettings(ctx.repo)?.version === version) linkEngine(ctx, binary);
  return code;
}
