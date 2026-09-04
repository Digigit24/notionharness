/**
 * A stand-in for the `server-only` package, for verification scripts.
 *
 * `server-only` is not installed here: Next.js aliases it at build time, so the
 * app compiles without it, but a plain `tsx` script resolving the same import
 * fails with ERR_MODULE_NOT_FOUND. `lib/invitations.ts` imports it deliberately
 * — the module mints invitation tokens and opens database pools, and a client
 * component importing a value from it must be a build error rather than a
 * bundle that ships `pg` to a browser — so the right fix is to let the script
 * resolve the barrier, not to remove it.
 *
 * Wired in `scripts/tsconfig.verify.json`, which is used only by the
 * verification scripts and never by the app's own build.
 */
export {}
