# Support policy

The project provides community, local-first support with no SLA. Never attach a Vault, `.brain`,
runtime state, tokens, transcripts, or private paths to an issue; use synthetic, sanitized repros.

## Window

- `0.90`: current line; receives security, integrity, regression, and compatibility fixes.
- `0.89`: previous maintenance line; receives critical fixes when a backport is safe.
- `0.88`: last prior security line; receives only justified critical fixes.
- Older lines: upgrade recommended; no backport commitment.

Support is best effort, with no SLA for response or resolution. Report vulnerabilities through
GitHub Security Advisories; public bugs require a minimal reproduction with no real data.

## Gates and platforms

Candidate required checks are versioned in `.github/required-checks.json`. Running
`node scripts/required-checks.mjs` only validates and renders the payload; it never changes `main`
protection. The maintainer applies remote configuration only after observing those names green.

See [compatibility](compatibility.md) and the [architecture](architecture.md).
