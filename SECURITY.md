# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in hydradb-mcp, please report it responsibly. **Do not open a public GitHub issue for security vulnerabilities.**

### How to Report

Send an email to **security@hydradb.com** with the following information:

- A description of the vulnerability and its potential impact.
- Steps to reproduce the issue, including any relevant configuration or environment details.
- The affected version(s) of hydradb-mcp.
- Any suggested fix or mitigation, if you have one.

### What to Expect

- **Acknowledgment**: We will acknowledge receipt of your report within 3 business days.
- **Assessment**: We will investigate and assess the severity of the vulnerability. We may reach out to you for additional details.
- **Resolution**: We aim to provide a fix or mitigation within 30 days of confirming the vulnerability, depending on complexity.
- **Disclosure**: Once a fix is released, we will coordinate with you on public disclosure. We follow a responsible disclosure timeline and will credit you (unless you prefer to remain anonymous).

## Scope

This security policy covers the hydradb-mcp repository, including:

- All TypeScript source code in `src/`.
- Configuration handling and environment variable processing.
- Dependencies declared in `package.json`.
- CI/CD workflows in `.github/workflows/`.

### Out of Scope

- The HydraDB API service itself (report those to HydraDB directly via https://docs.hydradb.com).
- Third-party dependencies (report those to the respective maintainers, but let us know if a dependency vulnerability affects hydradb-mcp).
- Issues that require physical access to a machine running the tool.

## Supported Versions

We provide security fixes for the latest release on the `main` branch. Older versions are not actively maintained.

| Version | Supported |
|---------|-----------|
| `main` (latest) | Yes |
| Older releases | No |

## Best Practices for Contributors

When contributing to hydradb-mcp, follow these security practices:

- Never commit API keys, tokens, passwords, or other credentials to the repository.
- Use environment variables for all sensitive configuration (see `.env.example`).
- Review your changes for accidental inclusion of secrets before submitting a PR.
- Keep dependencies up to date and report any known vulnerabilities in project dependencies.
