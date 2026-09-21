/**
 * Minimal Node ESM resolve hook so the built-in test runner understands the
 * project's `@/*` path alias (which tsconfig/Next resolve at build time) and the
 * extensionless relative imports TypeScript source files use.
 *
 * Only used by `pnpm test`; the application bundle never loads this.
 */

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')

function fromPath(base) {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts')]
  for (const candidate of candidates) {
    if (path.extname(candidate) && existsSync(candidate) && statSync(candidate).isFile()) {
      return { url: pathToFileURL(candidate).href, shortCircuit: true }
    }
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') {
    // Next.js resolves the `react-server` condition to an empty module. The
    // Node test runner needs the same for the server modules under test.
    return { url: pathToFileURL(path.join(root, 'tests/stubs/server-only.mjs')).href, shortCircuit: true }
  }
  if (specifier === 'next/headers') {
    // Next resolves this through its own exports map; Node cannot. The stub
    // throws from `cookies()` unless a test opts into a cookie jar.
    return { url: pathToFileURL(path.join(root, 'tests/stubs/next-headers.mjs')).href, shortCircuit: true }
  }
  if (specifier === 'next/server') {
    // Same story: `next/server` is only resolvable inside Next's bundler. The
    // stub provides just the response shape the security units build.
    return { url: pathToFileURL(path.join(root, 'tests/stubs/next-server.mjs')).href, shortCircuit: true }
  }
  if (specifier.startsWith('@/')) {
    const resolved = fromPath(path.join(root, specifier.slice(2)))
    if (resolved) return resolved
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    // TypeScript source omits the extension; Node needs it.
    if (!path.extname(specifier)) {
      const parent = context.parentURL ? path.dirname(new URL(context.parentURL).pathname) : root
      const resolved = fromPath(path.resolve(parent, specifier))
      if (resolved) return resolved
    }
  }
  return nextResolve(specifier, context)
}
