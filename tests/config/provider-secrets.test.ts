import 'server-only'

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

/**
 * Static audit of the external provider credentials.
 *
 * Four credentials now exist — CricketData, API-Football, YouTube and AuthKey —
 * and the rules that keep them out of a browser bundle and out of a log line are
 * easy to break later by accident: one `process.env` read in a client component,
 * one URL printed on a failure path, one paste into a fixture. Each rule below
 * is asserted against the shipped source, so breaking it fails this suite rather
 * than leaking quietly in production.
 *
 * Runtime behaviour (a real call to each provider) is NOT proven here; it
 * requires credentials that are not present in this test environment and is
 * reported as such in the verification notes.
 */

const root = path.resolve(import.meta.dirname, '..', '..')

function filesUnder(relative: string): string[] {
  const absolute = path.join(root, relative)
  try {
    return readdirSync(absolute, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath ?? absolute, entry.name))
      .map((file) => path.relative(root, file))
      .sort()
  } catch {
    return []
  }
}

const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

/** Every credential this application reads from its environment. */
const PROVIDER_SECRETS = [
  'CRICKETDATA_API_KEY',
  'API_FOOTBALL_KEY',
  'YOUTUBE_API_KEY',
  'AUTHKEY_API_KEY',
] as const

const SOURCE_FILES = [
  ...filesUnder('app'),
  ...filesUnder('components'),
  ...filesUnder('lib'),
  ...filesUnder('scripts'),
].filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))

const PROVIDER_MODULES = filesUnder('lib/providers').filter((file) => file.endsWith('.ts'))

/**
 * Files that may legitimately read a provider credential.
 *
 * The adapters themselves, plus the launch-gate script, which reports whether
 * sign-in can deliver a code — it reads the two AuthKey variables to answer
 * "configured or not" and never prints a value. Listed by name rather than by
 * pattern so a new reader has to be added here deliberately.
 */
const ALLOWED_SECRET_READERS = new Set([
  ...PROVIDER_MODULES.filter((file) => !file.endsWith('/drafts.ts')),
  'scripts/preflight.ts',
])

/** Client code: anything that runs in the browser. */
const CLIENT_FILES = SOURCE_FILES.filter((file) => {
  const source = read(file)
  return file.startsWith('components/') || source.includes("'use client'") || source.includes('"use client"')
})

describe('provider credentials never reach the client', () => {
  test('no component or client module names a provider credential', () => {
    const offenders: string[] = []
    for (const file of CLIENT_FILES) {
      const source = read(file)
      for (const secret of PROVIDER_SECRETS) {
        if (source.includes(secret)) offenders.push(`${file} mentions ${secret}`)
      }
    }
    assert.deepEqual(offenders, [], 'provider credentials must be read server-side only')
  })

  test('only the provider adapters read a provider credential', () => {
    const offenders: string[] = []
    for (const file of SOURCE_FILES) {
      if (ALLOWED_SECRET_READERS.has(file)) continue
      const source = read(file)
      for (const secret of PROVIDER_SECRETS) {
        if (source.includes(`process.env.${secret}`)) offenders.push(`${file} reads ${secret}`)
      }
    }
    assert.deepEqual(offenders, [])
  })

  test('every provider module is server-only', () => {
    assert.ok(PROVIDER_MODULES.length >= 5, 'the provider adapters exist')
    for (const file of PROVIDER_MODULES) {
      const source = read(file)
      assert.ok(
        /^import 'server-only'/.test(source),
        `${file} must start with \`import 'server-only'\` so it can never be bundled for the browser`,
      )
    }
  })

  test('no route in the public API surface returns a credential', () => {
    // The health route is unauthenticated and was already trimmed of the payment
    // block for the same reason: anything truly public must describe state, not
    // configuration.
    const offenders = filesUnder('app/api')
      .filter((file) => file.endsWith('route.ts'))
      .filter((file) => PROVIDER_SECRETS.some((secret) => read(file).includes(secret)))
    assert.deepEqual(offenders, [], 'a route handler must not name a provider credential')
  })
})

describe('no credential-shaped literal exists in the repository', () => {
  /**
   * The shapes that would be mistaken for a real credential. A literal that
   * looks like a key is treated as a leak even if it is a placeholder, because
   * nobody can tell the difference when reading a diff.
   */
  const KEY_SHAPES: Array<{ name: string; pattern: RegExp }> = [
    { name: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{30,}/ },
    // API-Football and AuthKey issue 32-character hexadecimal keys.
    { name: '32-character hex key', pattern: /\b[0-9a-f]{32}\b/ },
    // CricketData issues a UUID, the same shape as this application's own ids,
    // so it is checked against the provider name rather than in isolation.
    { name: 'UUID next to a provider key name', pattern: /(?:CRICKETDATA_API_KEY|apikey)\s*[:=]\s*['"]?[0-9a-f]{8}-/i },
  ]

  const AUDITED_FILES = [
    ...SOURCE_FILES,
    ...filesUnder('tests').filter((file) => file.endsWith('.ts')),
    ...filesUnder('docs').filter((file) => file.endsWith('.md')),
    'README.md',
    '.env.example',
  ]

  for (const shape of KEY_SHAPES) {
    test(`no ${shape.name} appears in source, tests or docs`, () => {
      const offenders = AUDITED_FILES.filter((file) => {
        try {
          return shape.pattern.test(read(file))
        } catch {
          return false
        }
      })
      assert.deepEqual(offenders, [], `${shape.name} shape found in the repository`)
    })
  }

  test('every provider credential is documented, with no value anywhere', () => {
    const readme = read('README.md')
    for (const secret of PROVIDER_SECRETS) {
      assert.ok(readme.includes(secret), `README documents ${secret}`)
    }

    // A documented name followed by a value is a leaked credential, whichever
    // shipped file it is in — the template included. `tests/` is excluded on
    // purpose: the adapter suites assign throwaway values at runtime to prove
    // the request shape, and a real-looking literal is caught by the key-shape
    // checks above rather than by this one.
    const documented = [
      ...SOURCE_FILES,
      ...filesUnder('docs').filter((file) => file.endsWith('.md')),
      'README.md',
      '.env.example',
    ]
    for (const file of documented) {
      let source = ''
      try {
        source = read(file)
      } catch {
        continue
      }
      for (const secret of PROVIDER_SECRETS) {
        // Markup is not a value: `` `NAME=` `` in a README table and `| NAME= |`
        // are documentation, whereas `NAME=abc123` is a credential.
        const assigned = new RegExp(secret + '\\s*=\\s*[^`|\\s]')
        assert.ok(!assigned.test(source), `${secret} is given a value in ${file}`)
      }
    }
  })

  test('environment files cannot be committed', () => {
    const ignore = read('.gitignore')
    assert.match(ignore, /^\.env$/m)
    assert.match(ignore, /^\.env\.\*$/m)
    assert.match(ignore, /^!\.env\.example$/m, 'the template itself stays tracked')
  })
})
