# Security Policy

## Reporting a Vulnerability

If you find a security issue in warden, please report it privately instead of opening a public issue.

Use [GitHub's private vulnerability reporting](../../security/advisories/new) for this repo (Security tab → Report a vulnerability).

Please include:

- A description of the issue and its potential impact
- Steps to reproduce (a minimal repro is ideal)
- Any relevant logs or transcripts (redact anything sensitive)

## Scope

Warden runs as an advisory/enforcement layer between an AI coding harness and its actuator layer. Things worth reporting here:

- A rule that can be bypassed to allow an action it should block
- Ways to make warden silently fail closed/open in a harness it claims to support
- Any code execution or injection path through decide.js, an actuator, or a harness adapter

Not in scope: the underlying harnesses themselves (Claude Code, Codex, etc.) — report those to their respective maintainers.
