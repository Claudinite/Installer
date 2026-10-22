#!/usr/bin/env node
// npx @claudinite/setup@<version> [--repo DIR] [--version V]
// npx @claudinite/setup@<version> update [--repo DIR] [--to V] [flags]
//
// Installs the engine DIR (default: the working directory) pins and links
// DIR/.claudinite/bin/cn to it. --version picks the engine for a repository
// not yet adopted; without it that repository gets the latest @claudinite/cli.
// On a failure it removes that link, says why on stderr, prints a line
// telling the session to stop and ask the person on stdout, and exits 1.
//
// update moves the engine to the newest release the repository's channel
// offers and runs that release's `cn update apply` with the flags given;
// its exit code is apply's, 1 when it refused with nothing written and 3
// when it could not run.
import { install, Refusal, Unreachable } from '../install.mjs';
import { APPLY_FLAGS, EXIT, update } from '../update.mjs';

const usage = [
  'usage: npx @claudinite/setup@<version> [--repo DIR] [--version V]',
  `       npx @claudinite/setup@<version> update [--repo DIR] [--to V] [${APPLY_FLAGS.join('] [')}]`,
].join('\n');

function parse(argv, valued, bare = []) {
  const out = { flags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (bare.includes(a)) {
      out.flags.push(a);
      continue;
    }
    const m = new RegExp(`^--(${valued.join('|')})(?:=(.*))?$`).exec(a);
    if (!m) return { error: `unknown argument ${a}` };
    const v = m[2] ?? argv[++i];
    if (v === undefined || v === '') return { error: `--${m[1]} needs a value` };
    out[m[1]] = v;
  }
  return out;
}

const argv = process.argv.slice(2);
const updating = argv[0] === 'update';
const args = updating ? parse(argv.slice(1), ['repo', 'to'], APPLY_FLAGS) : parse(argv, ['repo', 'version']);
if (args.error) {
  console.error(`claudinite setup: ${args.error}\n${usage}`);
  process.exit(2);
}
if (updating) {
  try {
    process.exitCode = await update(args);
  } catch (e) {
    console.error(`claudinite update: ${e instanceof Refusal || e instanceof Unreachable ? e.message : (e?.stack ?? e)}`);
    process.exitCode = e instanceof Refusal ? EXIT.refused : EXIT.failed;
  }
} else {
  try {
    await install(args);
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`claudinite setup: ${e.message}`);
      console.log(`Claudinite refused to set up its engine: ${e.message}: stop and ask the person before continuing.`);
    } else if (e instanceof Unreachable) {
      console.error(`claudinite setup: ${e.message}`);
      console.log(`Claudinite could not fetch its engine from ${e.url}: stop and ask the person before continuing.`);
    } else {
      console.error(`claudinite setup: ${e?.stack ?? e}`);
      console.log(`Claudinite could not set up its engine: stop and ask the person before continuing.`);
    }
    process.exit(1);
  }
}
