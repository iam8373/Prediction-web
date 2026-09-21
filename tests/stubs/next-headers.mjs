/**
 * Test stub for `next/headers`.
 *
 * Next resolves this module through its own exports map and provides the
 * request-scoped cookie store. The Node test runner cannot.
 *
 * `cookies()` throws by default so that any test which depends on a request
 * scope fails loudly instead of silently reading a fake cookie jar. A test that
 * genuinely needs a request scope (the authorization suite, which must prove
 * that a session cookie — and only a session cookie — grants admin access)
 * opts in explicitly with `__setRequestCookies`.
 */

let requestCookies = null

/** Opts this process into a fake cookie jar for the given cookies. */
export function __setRequestCookies(values) {
  requestCookies = values ?? {}
}

/** Removes the fake cookie jar, restoring the loud failure. */
export function __resetRequestCookies() {
  requestCookies = null
}

export async function cookies() {
  if (!requestCookies) {
    throw new Error('cookies() is only available inside a Next.js request scope (or after __setRequestCookies)')
  }
  const jar = requestCookies
  return {
    get(name) {
      const value = jar[name]
      return value === undefined ? undefined : { name, value }
    },
    getAll() {
      return Object.entries(jar).map(([name, value]) => ({ name, value }))
    },
    has(name) {
      return jar[name] !== undefined
    },
    set() {
      throw new Error('The test cookie jar is read-only')
    },
    delete() {
      throw new Error('The test cookie jar is read-only')
    },
  }
}

export async function headers() {
  throw new Error('headers() is only available inside a Next.js request scope')
}
