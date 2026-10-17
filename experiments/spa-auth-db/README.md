# spa-auth-db probe

Minimal TanStack Start app used by P0 to validate four things against a real build and a
real browser: SPA-mode deep links, a Better Auth email-password session, Drizzle SQLite
migrations plus an explicit transaction rollback, and shadcn + Base UI rendering.

```bash
npm install
npm run verify
```

`verify.sh` deletes `dev.db`, replays the migration from zero, builds for production,
starts the node server on port 3000, and runs the HTTP and Chromium checks. It prints one
`PASS`/`FAIL` line per check and exits non-zero if any fails.

Evidence, versions, and caveats are in [`docs/p0/spa-auth-db.md`](../../docs/p0/spa-auth-db.md).

Layout:

- `src/routes/index.tsx` renders the auth form, the session, and the protected server-function button.
- `src/routes/second.tsx` is the deep-link target and renders the shadcn + Base UI button and dialog.
- `src/start.tsx` sets `defaultSsr: false`, which is what makes the running server send the shell.
- `src/lib/auth.ts` wires Better Auth to the Drizzle adapter over better-sqlite3.
- `src/db/schema.ts` holds `probe_items` and re-exports the generated `src/db/auth-schema.ts`.
- `src/server/db-checks.ts` runs the unique-conflict, control, and transaction-rollback checks.
- `drizzle/` is the generated migration.
- `scripts/apply-shadcn-theme.mjs` regenerates `src/theme.css` from the shadcn `base-nova` preset.
