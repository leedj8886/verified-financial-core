# Project Agent Instructions

- All runtime and library code in this repository must use TypeScript.
- Work directly in this repository with inline execution.
- Do not create a Git worktree unless the user explicitly requests one.
- Do not invoke Superpowers skills unless the user explicitly requests them.
- Tushare must remain an optional provider; the core and default tests cannot
  require a Tushare token or interface ledger.
- Dependency installation for this repository uses the project-local official
  npm registry configured in `.npmrc`; do not change the user's global registry.
- Keep Research CI downstream of `VerifiedFactSet`; it must not implement an
  independent financial-data layer.
- Before claiming completion, run the smallest relevant tests plus typecheck
  and build for the changed packages.
