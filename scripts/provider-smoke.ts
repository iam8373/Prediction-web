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
 *   pnpm providers:smoke --refresh                # ignore any cached response
 *   pnpm providers:smoke --video <id|url>         # look up one video (1 quota unit)
 *   pnpm providers:smoke --send-otp 9876543210    # actually sends an SMS and spends a credit
 *
 * YouTube and AuthKey are checked for configuration only unless asked otherwise:
 * the first costs quota, and the second costs money and sends a message to a
 * real phone.
 *
 * Exit code is 1 only when a provider that *is* configured failed, so a
 * deployment with no provider keys is not reported as broken.
 */
import { authKeyConfigured, authKeyMissingConfig, sendSignInCode } from '@/lib/providers/authkey-otp'
import { cricketFixturesToDrafts, fetchCricketFixtures, cricketProviderConfigured } from '@/lib/providers/cricket'
import { fetchFootballFixtures, footballFixturesToDrafts, footballProviderConfigured } from '@/lib/providers/football'
import { fetchVideoMetadata, parseYouTubeVideoId, youtubeProviderConfigured } from '@/lib/providers/youtube'

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

async function checkYouTube() {
  const configured = youtubeProviderConfigured()
  if (!configured) {
    lines.push({ provider: 'youtube', configured, outcome: 'skipped', detail: 'YOUTUBE_API_KEY is not set' })
    return
  }

  const flag = process.argv.indexOf('--video')
  const argument = flag === -1 ? undefined : process.argv[flag + 1]
  if (!argument) {
    lines.push({
      provider: 'youtube',
      configured, outcome: 'skipped',
      detail: 'configured; pass --video <id|url> to spend a quota unit on a real lookup',
    })
    return
  }

  const videoId = parseYouTubeVideoId(argument)
  if (!videoId) {
    lines.push({ provider: 'youtube', configured, outcome: 'failed', detail: 'that is not a YouTube video reference' })
    return
  }

  const started = Date.now()
  try {
    const [video] = await fetchVideoMetadata([videoId])
    const elapsed = Date.now() - started
    lines.push({
      provider: 'youtube',
      configured,
      outcome: 'ok',
      detail: video
        ? `${video.id} "${video.title}" by ${video.channelTitle} in ${elapsed}ms`
        : `${videoId} resolved to nothing (deleted, private, or unknown) in ${elapsed}ms`,
    })
  } catch (error) {
    lines.push({ provider: 'youtube', configured, outcome: 'failed', detail: fail(error) })
  }
}

async function checkAuthKey() {
  const configured = authKeyConfigured()
  if (!configured) {
    lines.push({
      provider: 'authkey',
      configured,
      outcome: 'skipped',
      detail: `missing ${authKeyMissingConfig().join(', ') || 'configuration'}`,
    })
    return
  }

  const flag = process.argv.indexOf('--send-otp')
  const phone = flag === -1 ? undefined : process.argv[flag + 1]
  if (!phone) {
    lines.push({
      provider: 'authkey',
      configured, outcome: 'skipped',
      detail: 'configured; pass --send-otp <number> to send a real code (costs a credit)',
    })
    return
  }

  const started = Date.now()
  try {
    // A code that can never be used, so a diagnostic run cannot sign anybody in.
    const result = await sendSignInCode({ phone: phone.replace(/\D/g, '').slice(-10), code: '000000' })
    lines.push({ provider: 'authkey', configured, outcome: 'ok', detail: `${result.message} in ${Date.now() - started}ms` })
  } catch (error) {
    lines.push({ provider: 'authkey', configured, outcome: 'failed', detail: fail(error) })
  }
}

async function main() {
  await checkCricket()
  await checkFootball()
  await checkYouTube()
  await checkAuthKey()

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
