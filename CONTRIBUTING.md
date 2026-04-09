# Contributing to hydradb-mcp

Welcome, and thank you for your interest in contributing to hydradb-mcp. This project is an MCP server for HydraDB providing agentic memory with recall, ingest, and knowledge graph context, and we appreciate contributions of all kinds -- bug reports, documentation improvements, new features, and code reviews.

All participants in this project are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please read it before contributing.

---

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) instead of a Contributor License Agreement (CLA). The DCO is a lightweight mechanism that certifies you have the right to submit the code you are contributing. Every commit you submit **must** include a `Signed-off-by` line, and this requirement is enforced by CI.

### How to sign off your commits

Add the `-s` flag when committing:

```bash
git commit -s -m "feat: add new tool"
```

This appends a line like the following to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must match your Git configuration. You can verify your settings with:

```bash
git config user.name
git config user.email
```

If you have already made commits without signing off, you can amend the most recent commit:

```bash
git commit --amend -s --no-edit
```

Or rebase to sign off multiple commits:

```bash
git rebase --signoff HEAD~N
```

where `N` is the number of commits to update.

**Commits without a valid `Signed-off-by` line will be rejected by CI and cannot be merged.**

For the full text of the DCO, see: https://developercertificate.org/

---

## Getting Started

### Prerequisites

- Node.js 18 or later
- npm
- Git

### Fork and clone

1. Fork the repository on GitHub.
2. Clone your fork locally:

```bash
git clone https://github.com/<your-username>/hydradb-mcp.git
cd hydradb-mcp
```

3. Add the upstream remote:

```bash
git remote add upstream https://github.com/usecortex/hydradb-mcp.git
```

### Set up the development environment

The fastest way to get a working environment is with `make`:

```bash
make bootstrap
```

This installs dependencies, builds the project, and creates a `.env` file from `.env.example`. If you prefer to do it manually:

```bash
npm ci
npm run build
cp .env.example .env
```

### Configure environment variables

Edit `.env` and add your HydraDB credentials:

- `HYDRA_DB_API_KEY` -- your HydraDB API key (get one at https://app.hydradb.com)
- `HYDRA_DB_TENANT_ID` -- your tenant ID from the HydraDB dashboard

Never commit this file -- it is already in `.gitignore`.

### Verify your setup

```bash
make check-types    # type-check passes
make test           # unit tests pass
make dev            # MCP server starts in dev mode
```

If these complete without errors, your environment is ready.

---

## Branch Naming Convention

Create a new branch from `main` for every change. Use the following prefixes:

- `feat/` -- new features (e.g., `feat/new-tool`)
- `fix/` -- bug fixes (e.g., `fix/timeout-handling`)
- `docs/` -- documentation changes (e.g., `docs/update-readme`)
- `chore/` -- maintenance, CI, and tooling (e.g., `chore/update-dependencies`)

---

## Commit Message Format

This project follows the [Conventional Commits](https://www.conventionalcommits.org/) specification.

### Format

```
type(scope): description
```

### Types

| Type       | Purpose                                  |
|------------|------------------------------------------|
| `feat`     | A new feature                            |
| `fix`      | A bug fix                                |
| `docs`     | Documentation-only changes               |
| `chore`    | Maintenance, CI, or tooling changes      |
| `refactor` | Code restructuring without behavior change |
| `test`     | Adding or updating tests                 |
| `perf`     | Performance improvements                 |

### Examples

```
feat(server): add knowledge graph recall tool
fix(client): handle timeout on large uploads
docs(readme): add installation instructions for Windows
chore(ci): update TypeScript to v5.5
```

### Signing off

Every commit must include the DCO sign-off. A complete commit message looks like:

```
feat(server): add knowledge graph recall tool

Implement knowledge graph context retrieval via the MCP protocol.

Signed-off-by: Jane Developer <jane@example.com>
```

---

## Pull Request Guidelines

- **Reference an issue.** Every PR must reference an existing GitHub issue. If no issue exists for your change, create one first and wait for acknowledgment from a maintainer before starting work.
- **Fill out the PR template completely.** Do not delete sections from the template.
- **Keep PRs focused.** Each PR should contain one logical change. Avoid bundling unrelated fixes or features.
- **All CI checks must pass.** This includes type checking, building, testing, and DCO verification.
- **At least one maintainer review is required** before any PR can be merged.
- **Rebase on `main` before requesting review.** Ensure your branch is up to date and has no merge conflicts:

```bash
git fetch upstream
git rebase upstream/main
```

---

## Code Style

- **TypeScript** is required for all source code. Use strict type annotations.
- **Type checking** is enforced by the TypeScript compiler. Run before committing:

```bash
npm run check-types    # or: make check-types
```

- **No hardcoded credentials.** API keys, tokens, and secrets must always come from environment variables. Never embed them in source code, configuration files, or tests.

---

## Testing

### Running tests

```bash
make test                # unit tests
make test-all            # unit + integration tests
npm run test:unit        # unit tests (npm directly)
npm run test:integration # integration tests (requires credentials)
```

### Writing tests

- Place test files in `tests/` with the `.test.ts` suffix for unit tests or `.integration.spec.ts` for integration tests.
- Follow the existing patterns in `tests/client.test.ts` and `tests/context.test.ts`.
- Mock external dependencies to avoid real API calls in unit tests.

---

## What We Will NOT Accept

To maintain project quality and protect contributors, the following will not be merged:

- PRs without a linked issue.
- Large dependency additions without prior discussion and approval in an issue.
- Breaking changes without an approved issue describing the rationale and migration path.
- Code that introduces hardcoded secrets or credentials.
- PRs that do not pass CI checks.
- Cosmetic-only changes (whitespace, formatting) unless they are part of a larger, substantive fix.

---

## First-Time Contributors

If this is your first contribution, here is how to get started:

1. **Find a good first issue.** Look for issues labeled [`good first issue`](https://github.com/usecortex/hydradb-mcp/labels/good%20first%20issue) -- these are scoped, well-defined tasks suitable for newcomers.
2. **Read the README.** It contains a high-level overview of the project architecture and available MCP tools.
3. **Ask questions.** If anything is unclear, open an issue with your question. There are no bad questions.

---

## Review Process

All pull requests go through code review before merging:

1. **At least one maintainer** will review every PR.
2. Reviews focus on **correctness**, **security**, and **alignment with project conventions**.
3. Maintainers may request changes. Address all review comments before re-requesting review.
4. Once a PR is approved and all CI checks pass, a maintainer will merge it.

Please be patient -- maintainers review on a best-effort basis. If your PR has not received a review within a reasonable time, a polite comment on the PR is welcome.

---

## Reporting Bugs and Requesting Features

### Bug reports

Use the **Bug Report** issue template. Include:

- A clear description of the problem.
- Steps to reproduce.
- Expected behavior versus actual behavior.
- Your environment (OS, Node.js version, relevant dependency versions).

### Feature requests

Use the **Feature Request** issue template. Include:

- The problem or use case your feature addresses.
- A proposed solution or approach.
- Any alternative approaches you considered.

**Before opening a new issue, search existing issues to avoid duplicates.**

---

## Thank You

Every contribution -- whether it is a bug report, a documentation fix, or a new feature -- makes hydradb-mcp better. We appreciate your time and effort.
