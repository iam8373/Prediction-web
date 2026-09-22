import 'server-only'

import { createTtlCache } from '@/lib/providers/cache'
import { getJson, ProviderRequestError, scrubSecrets, type ProviderFailureKind } from '@/lib/providers/http'

/**
 * YouTube Data API v3 — metadata for a video attached to a market page.
 *
 * Used for display only: a market that references a video shows its title,
 * channel, thumbnail and view count, so a visitor can see the thing the market
 * is about. Nothing here creates or resolves markets, and nothing here runs in
 * the browser.
 *
 * Confirmed from Google's own reference:
 *  - `GET https://www.googleapis.com/youtube/v3/videos`
 *  - `part=snippet,statistics,contentDetails`; `id` takes a comma-separated list
 *    of up to 50 video ids
 *  - the credential is the `key` **query parameter**
 *  - **`videos.list` costs 1 quota unit per call**
 *
 * Not re-read here (their quota page was unreachable from this workspace): the
 * default project quota is 10,000 units per day, so one call per cache window is
 * nowhere near it. The TTL below is set for freshness rather than for quota.
 *
 * Quota policy: 1 unit per call regardless of how many ids are in it, so ids are
 * batched into one request per refresh instead of one request per video.
 *
 * TTL: 6 hours. View counts drift slowly and a stale count on a market page is
 * harmless, while a short TTL would multiply calls for no benefit. An in-process
 * cache is the right size for this; before running more than one instance this
 * should move to a shared cache (see `lib/providers/cache.ts`).
 */

const BASE_URL = 'https://www.googleapis.com/youtube/v3/videos'
const TIMEOUT_MS = 5_000
const TTL_MS = 6 * 60 * 60_000
/** Google's documented maximum for the `id` parameter. */
const MAX_IDS_PER_REQUEST = 50

export type YouTubeFailureKind = 'not-configured' | 'auth' | 'rate-limit' | 'timeout' | 'network' | 'malformed' | 'unavailable'

export class YouTubeError extends Error {
  readonly kind: YouTubeFailureKind
  readonly status?: number

  constructor(kind: YouTubeFailureKind, detail: string, status?: number) {
    super(`youtube ${kind}: ${detail}`)
    this.name = 'YouTubeError'
    this.kind = kind
    this.status = status
  }
}

export interface YouTubeVideo {
  id: string
  title: string
  channelTitle: string
  channelId?: string
  publishedAt?: string
  thumbnailUrl?: string
  /** Null when the uploader hides their statistics. */
  viewCount?: number
  likeCount?: number
  /** ISO 8601 duration, e.g. `PT1M30S`. */
  durationIso?: string
}

interface YouTubeListResponse {
  items?: Array<{
    id?: string
    snippet?: {
      title?: string
      channelTitle?: string
      channelId?: string
      publishedAt?: string
      thumbnails?: Record<string, { url?: string; width?: number; height?: number }>
    }
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }
    contentDetails?: { duration?: string }
  }>
}

const videosCache = createTtlCache<YouTubeVideo[]>({ name: 'youtube', ttlMs: TTL_MS })

export function youtubeProviderConfigured(): boolean {
  return Boolean(process.env.YOUTUBE_API_KEY?.trim())
}

/**
 * Accepts anything a person might paste — a watch URL, a share URL, a Shorts or
 * embed link, or a bare id — and returns the 11-character video id, or null.
 *
 * Kept strict about the id shape: it is the only value this module will send to
 * the API, and accepting arbitrary text here would let a caller put whatever
 * they like into the request.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value

  let parsed: URL
  try {
    parsed = new URL(value.includes('://') ? value : `https://${value}`)
  } catch {
    return null
  }

  const host = parsed.hostname.replace(/^www\.|^m\./, '').toLowerCase()
  const fromPath = (prefix: string) => {
    const match = new RegExp(`^/${prefix}/([A-Za-z0-9_-]{11})(?:$|[/?])`).exec(parsed.pathname)
    return match?.[1] ?? null
  }

  if (host === 'youtu.be') {
    const id = parsed.pathname.slice(1).split('/')[0]
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null

  const queryId = parsed.searchParams.get('v')
  if (queryId && /^[A-Za-z0-9_-]{11}$/.test(queryId)) return queryId

  return fromPath('embed') ?? fromPath('shorts') ?? fromPath('live') ?? fromPath('v')
}

/**
 * Metadata for the given ids. Returns only the videos that exist and are
 * public; an id that has been deleted or made private is simply absent, which
 * is why the caller must treat "not found" as normal rather than as an error.
 */
export async function fetchVideoMetadata(videoIds: string[]): Promise<YouTubeVideo[]> {
  const key = process.env.YOUTUBE_API_KEY?.trim()
  if (!key) throw new YouTubeError('not-configured', 'YOUTUBE_API_KEY is not set')

  const wanted = [...new Set(videoIds.map((id) => id.trim()).filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)))]
  if (wanted.length === 0) return []

  const batches: string[][] = []
  for (let index = 0; index < wanted.length; index += MAX_IDS_PER_REQUEST) {
    batches.push(wanted.slice(index, index + MAX_IDS_PER_REQUEST))
  }

  const collected: YouTubeVideo[] = []
  for (const batch of batches) {
    // Sorted so the cache key is the same however the ids were ordered.
    const cacheKey = [...batch].sort().join(',')
    const videos = await videosCache.getOrLoad(cacheKey, () => requestBatch(batch, key))
    collected.push(...videos)
  }
  return collected
}

/** One video, or null when it is missing, private or deleted. */
export async function fetchVideo(videoId: string): Promise<YouTubeVideo | null> {
  const videos = await fetchVideoMetadata([videoId])
  return videos.find((video) => video.id === videoId) ?? null
}

async function requestBatch(videoIds: string[], key: string): Promise<YouTubeVideo[]> {
  const url = `${BASE_URL}?part=snippet,statistics,contentDetails&id=${encodeURIComponent(videoIds.join(','))}&key=${encodeURIComponent(key)}`

  let payload: YouTubeListResponse
  try {
    payload = await getJson<YouTubeListResponse>({
      provider: 'youtube',
      url,
      timeoutMs: TIMEOUT_MS,
      classifyErrorBody: classifyGoogleError,
    })
  } catch (error) {
    throw toYouTubeError(error, key)
  }

  const videos = (payload.items ?? []).map(normaliseVideo).filter((video): video is YouTubeVideo => video !== null)
  if (videos.length !== videoIds.length) {
    // Normal, not an error: a video may have been removed or made private.
    console.info(`[providers] youtube ${videos.length}/${videoIds.length} video(s) resolved; the rest are unavailable`)
  }
  return videos
}

function normaliseVideo(item: NonNullable<YouTubeListResponse['items']>[number]): YouTubeVideo | null {
  const id = item.id?.trim()
  const title = item.snippet?.title?.trim()
  if (!id || !title) return null

  // Google returns the largest sensible thumbnail first in practice, but the
  // order of these keys is not guaranteed, so pick by width.
  const thumbnails = Object.values(item.snippet?.thumbnails ?? {})
    .filter((thumbnail): thumbnail is { url?: string; width?: number } => Boolean(thumbnail?.url))
    .sort((left, right) => (right.width ?? 0) - (left.width ?? 0))

  return {
    id,
    title,
    channelTitle: item.snippet?.channelTitle?.trim() || 'YouTube',
    channelId: item.snippet?.channelId?.trim() || undefined,
    publishedAt: item.snippet?.publishedAt?.trim() || undefined,
    thumbnailUrl: thumbnails[0]?.url,
    viewCount: toCount(item.statistics?.viewCount),
    likeCount: toCount(item.statistics?.likeCount),
    durationIso: item.contentDetails?.duration?.trim() || undefined,
  }
}

/** Statistics arrive as strings; a hidden count must stay `undefined`, not become 0. */
function toCount(value?: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Google reports a rejected key and an exhausted quota as the same status, so
 * the `reason` field is what distinguishes them.
 */
function classifyGoogleError(body: unknown): { kind: ProviderFailureKind; detail: string } | null {
  const error = (body as { error?: { errors?: Array<{ reason?: string; message?: string }>; message?: string } } | null)?.error
  if (!error) return null

  const reasons = (error.errors ?? []).map((entry) => entry.reason ?? '').filter(Boolean)
  const detail = reasons.length > 0 ? reasons.join(', ') : (error.message ?? 'unclassified google error')

  if (reasons.some((reason) => /quota|rateLimit|dailyLimit/i.test(reason))) {
    return { kind: 'rate-limit', detail }
  }
  if (reasons.some((reason) => /keyInvalid|keyExpired|ipRefererBlocked|forbidden|accessNotConfigured/i.test(reason))) {
    return { kind: 'auth', detail }
  }
  return null
}

function toYouTubeError(error: unknown, key: string): YouTubeError {
  if (error instanceof YouTubeError) return error
  if (error instanceof ProviderRequestError) {
    const kind: YouTubeFailureKind =
      error.kind === 'auth' ? 'auth'
        : error.kind === 'rate-limit' ? 'rate-limit'
          : error.kind === 'timeout' ? 'timeout'
            : error.kind === 'malformed' ? 'malformed'
              : 'network'
    // The key is scrubbed out of the message as well: this provider takes it in
    // the query string, so an unredacted URL would be a credential leak.
    return new YouTubeError(kind, scrubSecrets(error.message, [key]), error.status)
  }
  return new YouTubeError('unavailable', scrubSecrets(error instanceof Error ? error.message : 'unknown failure', [key]))
}
