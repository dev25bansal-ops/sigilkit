# Memory Index

Pointer to the persistent project memory for SigilKit. It lives OUTSIDE this vault, in
the OS account’s own Claude project-memory directory — on Windows that is
`%USERPROFILE%\.claude\projects\D--SigilKit\memory\`, on macOS/Linux `~/.claude/projects/D--SigilKit/memory/`.

<!-- AUDIT 2026-10-16 ci-security-3: replaced a literal C:\Users\<name>\... path. The
     concrete username plus the session-store layout were disclosed in a git-tracked note;
     the generic form above conveys the same information without naming the account. -->

- `sigilkit-project` — external memory note (lives at the path above, NOT in this vault, so `[[...]]` links would not resolve): what SigilKit is; v0.1.0 committed at the repository root (contracts + SDK + demo agent + CI + this vault).
- `sigilkit-whitepaper-verified` — external memory note (NOT in this vault): Aug-2026 research sweep: which whitepaper claims are fabricated/stale vs confirmed, verified 2026 build stack, competitive reality.

This vault is the working knowledge base; the memory files are the durable cross-session summaries.

---
Tags: #sigilkit #memory #index
