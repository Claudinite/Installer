# @claudinite/setup

Installs the Claudinite engine a repository pins, and links `.claudinite/bin/cn` to it.

```sh
npx --yes @claudinite/setup@1.0.0
```

Run it in the repository (or pass `--repo DIR`). Then run `.claudinite/bin/cn`.

## In an adopted repository

The installer reads `engine.version` and `engine.manifest` from `.claudinite/settings.yaml`. It downloads
that release's `manifest.json` and this platform's binary from npm. If `engine.releases` names a GitHub
repository, it reads that repository's releases instead. It then checks three things:

- the manifest's sha512 against the `engine.manifest` pin;
- the manifest's signature against the roots of the Claudinite key ceremony, which are in `install.mjs`;
- the binary's sha256 against the manifest.

Verified files are cached read-only in `${XDG_CACHE_HOME:-~/.cache}/claudinite/<version>`, and the
cache folder must be mode 0700. Each run checks the cache again, so a warm run downloads nothing.

The engine version always comes from `settings.yaml`. The installer version you name after `@` only
fixes the code that downloads and checks it. Name an exact version: `latest` would run whatever is
published next.

## Adopting a repository

With no `settings.yaml`, the installer installs the latest `@claudinite/cli`, or the version given with
`--version`. The download is checked against npm's integrity and the signature, so you can run cn adopt
from it:

```sh
npx --yes @claudinite/setup@1.0.0 && .claudinite/bin/cn adopt <packs>
```

## In GitHub Actions

```yaml
      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: |
            ~/.cache/claudinite
            ~/.npm/_cacache
          key: cn-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('.claudinite/settings.yaml') }}
          restore-keys: cn-${{ runner.os }}-${{ runner.arch }}-
      - run: npx --yes --prefer-offline @claudinite/setup@1.0.0
```

## When it fails

It removes `.claudinite/bin/cn`, so no other engine runs in its place. It explains why on stderr,
prints one line on stdout telling a Claude session to stop and ask the person, and exits 1. Bad
arguments exit 2.

`HTTPS_PROXY` and `NO_PROXY` are honoured. `CLAUDINITE_REGISTRY`, `CLAUDINITE_GITHUB` and
`CLAUDINITE_MAX_DOWNLOAD_BYTES` change the registry, the GitHub host and the download cap (64 MiB).

## Releasing

Raise `version` in `package.json`, merge, and dispatch the `release` workflow. Versions are immutable
and change only when the install logic does.
