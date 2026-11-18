# Security

## Reporting a vulnerability

Please report security problems privately through [GitHub security advisories](https://github.com/pairlint/pairlint/security/advisories/new). Do not open a public issue.

You will get a reply within 3 business days. Once a fix is ready, we publish a release and an advisory, and credit you unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes.

## What pairlint promises

These are checked in CI on every change:

- **No runtime dependencies** outside the `@pairlint` packages in this repository.
- **No network access.** Published code does not import `http`, `https`, `net` or similar modules, and does not call `fetch`.
- **No code execution.** No `eval`, no `new Function`, no `require` or dynamic `import()`, no child processes.
- **No install scripts** in any published package.
- **Files stay in the project.** pairlint reads only files inside the folder that holds its config, including through symlinks, and refuses files larger than 10 MB.
- **Bounded work.** Nesting depth, alias chains and the number of checks are capped, so a hostile token file cannot hang CI.

## Releases

Releases are published from GitHub Actions using npm trusted publishing. No npm token is stored in the repository, and every release carries an npm provenance attestation that links it to the commit and workflow that built it. You can verify it with:

```sh
npm audit signatures
```
