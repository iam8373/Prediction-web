/**
 * Test stub for the `server-only` marker package.
 *
 * `server-only` throws on import unless the bundler resolves the
 * `react-server` condition — exactly what Next.js does at build time. The Node
 * test runner has no such condition, so the alias loader in
 * `tests/alias-resolver.mjs` maps `server-only` to this empty module. Nothing
 * else about the server modules changes: they still run against a real
 * PostgreSQL connection in the DB E2E suite.
 */

export {}
