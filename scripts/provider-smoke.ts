/**
 * Provider reachability check.
 *
 * Runs each data adapter against the live service and prints what an operator
 * needs to know: whether the credential is configured, whether the call
 * succeeded, which failure kind came back if it did not, how long it took, and a
 * sample of what was mapped.
 *
 * It prints **no credential and no response body** — the response bodies of at
 * least one of these providers echo the submitted key, and this script's output
 * ends up in terminals and CI logs. Only counts, providers' own rate-limit
 * headers, durations and mapped values are shown.
 *
 *   pnpm providers:smoke
 *   pnpm providers:smoke --refresh     # ignore any cached response
 *   pnpm providers:smoke --send-otp 9876543210   # actually spends an SMS credit
 *
 * Exit code is 1 only when a provider that *is* configured failed, so a
 * deployment with no provider keys is not reported as broken.
 */
import { cricketFixturesToDrafts, fetchCricketFixtures, cricketProviderConfigured } from '@/lib/providers/cricket'
import { fetchFootballFixtures, footballFixturesToDrafts, footballProviderConfigured } from '@/lib/providers/football'

const refresh = process.argv.includes('--refresh')

interface Line {
  provider: string
  configured: boolean
  outcome: 'ok' | 'failed' | 'skipped'
  detail: string
}

const lines: Line[] = []

function fail(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

async function checkCricket() {
  const configured = cricketProviderConfigured()
  if (!configured) {
    lines.push({ provider: 'cricketdata', configured, outcome: 'skipped', detail: 'CRICKETDATA_API_KEY is not set' })
    return
  }
  const started = Date.now()
  try {
    const fixtures = await fetchCricketFixtures({ refresh })
    const drafts = cricketFixturesToDrafts(fixtures)
    const elapsed = Date.now() - started
    const sample = drafts[0]
    lines.push({
      provider: 'cricketdata',
      configured,
      outcome: 'ok',
      detail: `${fixtures.length} fixture(s), ${drafts.length} market draft(s) in ${elapsed}ms${sample ? ` · e.g. ${sample.id} "${sample.question}"` : ''}`,
    })
  } catch (error) {
    lines.push({ provider: 'cricketdata', configured, outcome: 'failed', detail: fail(error) })
  }
}

async function checkFootball() {
  const configured = footballProviderConfigured()
  if (!configured) {
    lines.push({ provider: 'api-football', configured, outcome: 'skipped', detail: 'API_FOOTBALL_KEY is not set' })
    return
  }
  const started = Date.now()
  try {
    const fixtures = await fetchFootballFixtures({ refresh })
    const drafts = footballFixturesToDrafts(fixtures)
    const elapsed = Date.now() - started
    const sample = drafts[0]
    lines.push({
      provider: 'api-football',
      configured,
      outcome: 'ok',
      detail: `${fixtures.length} fixture(s), ${drafts.length} market draft(s) in ${elapsed}ms${sample ? ` · e.g. ${sample.id} "${sample.question}"` : ''}`,
    })
  } catch (error) {
    lines.push({ provider: 'api-football', configured, outcome: 'failed', detail: fail(error) })
  }
}

async function main() {
  await checkCricket()
  await checkFootball()

  console.info('')
  console.info('provider smoke test')
  console.info('-------------------')
  for (const line of lines) {
    const state = line.outcome === 'ok' ? 'OK     ' : line.outcome === 'failed' ? 'FAILED ' : 'SKIPPED'
    console.info(`${line.provider.padEnd(14)} ${state} ${line.detail}`)
  }
  console.info('')

  const hardFailure = lines.some((line) => line.configured && line.outcome === 'failed')
  const anyRan = lines.some((line) => line.outcome === 'ok')
  if (!anyRan && !hardFailure) {
    console.info('No provider credentials are configured here, so nothing was called.')
    console.info('The application falls back to the demo catalogue in that case, which is the intended behaviour.')
  }
  process.exit(hardFailure ? 1 : 0)
}

main().catch((error) => {
  console.error('provider smoke test crashed:', fail(error))
  process.exit(1)
})
