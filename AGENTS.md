# Local Release Notes

This file records local operating rules for this repository. It should stay out of npm packages.

## Release Rules

0. Unless the user explicitly asks to publish or push, do not publish to npm, do not commit git, and do not push git.
1. Bump the package version before publishing.
2. Run the pre-publish check before every release:
   - `npm run publish:check`
   - confirm `npm pack --dry-run` does not include source, tests, sourcemaps, local notes, or internal design docs
3. Publish to npm first.
4. Only after npm publish succeeds, commit the version bump and related release changes, then push to GitHub.

## Auth And Remotes

- npm publishes from this machine use access-token auth.
- GitHub pushes use SSH.
- Canonical GitHub remote: `git@github.com:rongyan6/crewline.git`
- Before modifying the project, ensure the local branch has pulled the latest code from the remote.

## Packaging Safety

- Do not publish `src/`, `tests/`, `.omx/`, sourcemaps, or local-only files.
- Do not publish `docs/architecture/` or `docs/design/`.
- Check the packed file list before publishing and keep the package limited to sanitized runtime assets and user-facing docs.

## Environment Habit Split

- Treat `crewline ...` commands as the formal/production-style service entrypoints.
- Treat ad-hoc `node ...`, `node dist/...`, or `npm run ...` startup flows as local development habits.
- Do not reinterpret the production CLI as a development-only shortcut unless the user explicitly asks for that change.

## Common Dev Commands

- Start local development service: `npm run dev`
- Start local development service directly: `node src/app/main.js`
- Run the built app locally: `node dist/main.js`
- Rebuild production artifacts: `npm run build`
- Run the full test suite: `npm test`
- Run publish readiness checks without publishing: `npm run publish:check`
- Pass arguments to the dev script with npm's separator, for example: `npm run dev -- --help`
