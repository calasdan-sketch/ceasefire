# Publish checklist for ceasefire 0.3.0 (Dan: nothing here has been run)

Version to release: **0.3.0**. It is already the version in `package.json`, so do not bump it. npm currently has 0.0.1, an empty placeholder, so 0.3.0 is a normal upgrade.

## Check first

1. You are on branch `expert-2` and happy with it. Merge it to your main branch if that is where you release from.
2. `npm whoami` prints `decnutz` (the account that owns the name). If not, run `npm login`.
3. Your npm account has two-factor login turned on; npm will ask for a code when you publish.
4. In `CHANGELOG.md` change "0.3.0 — unreleased" to "0.3.0 — <today's date>".

## Run, in this order

```sh
npm ci
npm test                      # expect: 265 pass, 0 fail (takes 2-5 minutes)
npm pack --dry-run            # expect: 32 files, about 82 kB, LICENSE and README.md listed, no .map files
npm publish --dry-run         # prints what would be sent, sends nothing
npm publish                   # the real one; asks for your two-factor code. Free for a public package.
```

## After it is live

```sh
npm view ceasefire version            # expect 0.3.0
cd "$(mktemp -d)" && npx ceasefire@0.3 --version     # expect: ceasefire 0.3.0
git tag v0.3.0 && git push origin v0.3.0
```

Then edit `README.md`: delete the paragraph that starts "**Version note**" (it explains that npm still has 0.0.1) and commit.

## Cannot be undone

npm does not let you re-publish the same version number. If something is wrong after publishing, the fix is 0.3.1.

## Not checked on this machine

Windows and macOS, Node 22.13 and Node 24. The README says so. Your first Windows user is the real test.
