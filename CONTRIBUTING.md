# Contributing to hydradb-mcp

Welcome, and thank you for your interest in contributing to hydradb-mcp. This project is a HydraDB MCP (Model Context Protocol) server plugin, and we appreciate contributions of all kinds -- bug reports, documentation improvements, new features, and code reviews.

All participants in this project are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please read it before contributing.

---

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) instead of a Contributor License Agreement (CLA). The DCO is a lightweight mechanism that certifies you have the right to submit the code you are contributing. Every commit you submit **must** include a `Signed-off-by` line, and this requirement is enforced by CI.

### How to sign off your commits

Add the `-s` flag when committing:

```bash
git commit -s -m "feat: add new handler"
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

Install dependencies:

```bash
npm install
```

If the project includes a `Makefile`, you can also use:

```bash
make bootstrap
```

### Configure environment variables

Copy the example environment file and fill in your API keys:

```bash
cp .env.example .env
```

Edit `.env` and add the required configuration. Never commit this file -- it is already in `.gitignore`.

### Run a smoke test

Verify your setup by building the project:

```bash
npm run build
```

If this completes without errors, your environment is ready.

---

## Branch Naming Convention

Create a new branch from `main` for every change. Use the following prefixes:

- `feat/` -- new features (e.g., `feat/new-tool-handler`)
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
feat(tools): add search tool handler
fix(transport): handle connection timeout
docs(readme): add configuration guide
chore(ci): update Node.js version in CI
```

### Signing off

Every commit must include the DCO sign-off. A complete commit message looks like:

```
feat(tools): add search tool handler

Implement the search tool for querying HydraDB collections.

Signed-off-by: Jane Developer <jane@example.com>
```

---

## Pull Request Guidelines

- **Reference an issue.** Every PR must reference an existing GitHub issue. If no issue exists for your change, create one first and wait for acknowledgment from a maintainer before starting work.
- **Fill out the PR template completely.** Do not delete sections from the template.
- **Keep PRs focused.** Each PR should contain one logical change. Avoid bundling unrelated fixes or features.
- **All CI checks must pass.** This includes linting, building, and DCO verification.
- **At least one maintainer review is required** before any PR can be merged.
- **Rebase on `main` before requesting review.** Ensure your branch is up to date and has no merge conflicts:

```bash
git fetch upstream
git rebase upstream/main
```

---

## Code Style

- **TypeScript** is used throughout. Use type annotations on all function signatures.
- **Formatting and linting** should be checked before committing:

```bash
npm run lint
npm run build
```

- **No hardcoded credentials.** API keys, tokens, and secrets must always come from environment variables. Never embed them in source code, configuration files, or tests.

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
2. **Read the README.** It contains a high-level overview of the project architecture and usage.
3. **Ask questions.** If anything is unclear, open a thread in [GitHub Discussions](https://github.com/usecortex/hydradb-mcp/discussions). There are no bad questions.

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
