#!/usr/bin/env node
// npx @claudinite/setup@<version> [--repo DIR] [--version V]
//
// Installs the engine DIR (default: the working directory) pins and links
// DIR/.claudinite/bin/cn to it. --version picks the engine for a repository
// not yet adopted; without it that repository gets the latest @claudinite/cli.
// On a failure it removes that link, says why on stderr, prints a line
// telling the session to stop and ask the person on stdout, and exits 1.
import { install, Refusal, Unreachable } from '../install.mjs';

const usage = 'usage: npx @claudinite/setup@<version> [--repo DIR] [--version V]';

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(repo|version)(?:=(.*))?$/.exec(a);
    if (!m) return { error: `unknown argument ${a}` };
    const v = m[2] ?? argv[++i];
    if (v === undefined || v === '') return { error: `--${m[1]} needs a value` };
    out[m[1]] = v;
  }
  return out;
}

const args = parse(process.argv.slice(2));
if (args.error) {
  console.error(`claudinite setup: ${args.error}\n${usage}`);
  process.exit(2);
}
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
