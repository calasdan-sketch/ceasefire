# Publish checklist for ceasefire 0.3.0 (Dan: nothing here has been run, and this file never runs anything for you)

Version to release: **0.3.0**. It is already the version in `package.json`, so do not change it. npm currently has 0.0.1, an
empty placeholder, so 0.3.0 is a normal upgrade. The package owner shown inside the package is **Calas Automations Inc.**
(npm will still list your npm account, `decnutz`, as the maintainer; that is normal).

## Check first

1. You are on branch `expert-2` and happy with it. Merge it into the branch you release from.
2. Open a terminal in the ceasefire folder. Run `npm whoami`. It should print `decnutz`. If not, run `npm login`.
3. Your npm account has two-factor login turned on; npm will ask for a code when you publish.
4. In `CHANGELOG.md` change "0.3.0 — unreleased" to "0.3.0 — <today's date>".
5. Optional but wise: push the branch to GitHub first. The file `.github/workflows/ci.yml` then runs the tests on Linux, macOS
   and Windows. It has never run, and Windows and macOS have never been tried, so a red job there is useful news, not
   a reason to panic. Fix or accept it before you publish.

## Run, in this order (the same on Windows PowerShell, macOS and Linux)

```sh
npm ci
npm test                      # expect: 290 pass, 0 fail (takes 2-5 minutes)
npm pack --dry-run            # expect: 32 files, about 84 kB, LICENSE and README.md listed, no .map files
npm publish                   # the real one. It runs the tests again by itself, then asks for your two-factor code.
```

`npm publish` is the only step that changes anything on the internet, and it cannot be undone. Free for a public package.

## After it is live

```sh
npm view ceasefire version                       # expect 0.3.0
npx ceasefire@0.3 --version                      # expect: ceasefire 0.3.0   (run it from any empty folder)
git tag v0.3.0
git push origin v0.3.0
```

Then edit `README.md`: delete the paragraph that starts "**Version note**" (it explains that npm still has 0.0.1) and commit.

## Cannot be undone

npm does not let you re-publish the same version number. If something is wrong after publishing, the fix is 0.3.1.

## Not checked on this machine

Windows and macOS, Node 22.13 and Node 24 (the CI file above tests them the first time it runs). The README says so. Your first Windows user is the real test.
