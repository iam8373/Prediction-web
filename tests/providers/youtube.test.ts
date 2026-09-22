import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { fetchVideo, fetchVideoMetadata, parseYouTubeVideoId, YouTubeError } from '@/lib/providers/youtube'

const realFetch = globalThis.fetch
const KEY = 'test-youtube-key-abcdefghijklmnop'

let requests: string[] = []

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = ((input: unknown) => {
    const url = String(input)
    requests.push(url)
    return Promise.resolve(handler(url))
  }) as typeof fetch
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function item(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    snippet: {
      title: `Video ${id}`,
      channelTitle: 'Creator',
      channelId: 'UC123',
      publishedAt: '2026-09-01T10:00:00Z',
      thumbnails: {
        default: { url: 'https://i.ytimg.com/vi/x/default.jpg', width: 120 },
        high: { url: 'https://i.ytimg.com/vi/x/high.jpg', width: 480 },
      },
    },
    statistics: { viewCount: '2184000', likeCount: '45300' },
    contentDetails: { duration: 'PT3M12S' },
    ...overrides,
  }
}

async function failureFrom(run: () => Promise<unknown>): Promise<YouTubeError> {
  try {
    await run()
  } catch (error) {
    assert.ok(error instanceof YouTubeError, `expected a YouTubeError, received ${String(error)}`)
    return error
  }
  throw new Error('expected the call to fail')
}

afterEach(() => {
  globalThis.fetch = realFetch
  requests = []
  delete process.env.YOUTUBE_API_KEY
})

describe('YouTube video reference parsing', () => {
  const id = 'dQw4w9WgXcQ'

  test('accepts the forms a person actually pastes', () => {
    const accepted = [
      id,
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&t=42s`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`,
      `https://youtu.be/${id}?si=share-token`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/live/${id}`,
      `https://www.youtube-nocookie.com/embed/${id}`,
      `  https://www.youtube.com/watch?v=${id}  `,
    ]
    for (const value of accepted) {
      assert.equal(parseYouTubeVideoId(value), id, `should accept ${value}`)
    }
  })

  test('rejects anything that is not a video reference', () => {
    const rejected = [
      '',
      '   ',
      'not a url',
      'https://vimeo.com/123456789',
      'https://www.youtube.com/@somechannel',
      'https://www.youtube.com/watch?v=tooshort',
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)',
    ]
    for (const value of rejected) {
      assert.equal(parseYouTubeVideoId(value), null, `should reject ${value}`)
    }
  })
})

describe('YouTube metadata adapter', () => {
  test('sends the credential in the query string and batches ids into one call', async () => {
    process.env.YOUTUBE_API_KEY = KEY
    stubFetch(() => jsonResponse({ items: [item('aaaaaaaaaaa'), item('bbbbbbbbbbb')] }))

    await fetchVideoMetadata(['aaaaaaaaaaa', 'bbbbbbbbbbb'])

    assert.equal(requests.length, 1, 'a batch is one request: the quota cost is per call, not per video')
    assert.match(requests[0], /youtube\/v3\/videos\?/)
    assert.match(requests[0], /part=snippet,statistics,contentDetails/)
    assert.match(requests[0], /id=aaaaaaaaaaa%2Cbbbbbbbbbbb/)
    assert.ok(requests[0].includes(encodeURIComponent(KEY)), 'the credential is sent as the key parameter')
  })

  test('more than 50 ids are split, because that is the documented maximum', async () => {
    process.env.YOUTUBE_API_KEY = KEY
    const ids = Array.from({ length: 51 }, (_, index) => `${String(index).padStart(11, 'a')}`.slice(0, 11))
    stubFetch(() => jsonResponse({ items: [] }))

    await fetchVideoMetadata(ids)

    assert.equal(requests.length, 2)
  })

  test('a second read inside the TTL is served from cache', async () => {
    process.env.YOUTUBE_API_KEY = KEY
    stubFetch(() => jsonResponse({ items: [item('ccccccccccc')] }))

    const first = await fetchVideoMetadata(['ccccccccccc'])
    const second = await fetchVideoMetadata(['ccccccccccc'])

    assert.equal(requests.length, 1, 'the provider is called once per TTL window, not per request')
    assert.deepEqual(second, first)
  })

  test('maps the metadata the market page needs, including view count as a number', async () => {
    process.env.YOUTUBE_API_KEY = KEY
    stubFetch(() => jsonResponse({ items: [item('ddddddddddd')] }))

    const [video] = await fetchVideoMetadata(['ddddddddddd'])

    assert.equal(video.id, 'ddddddddddd')
    assert.equal(video.title, 'Video ddddddddddd')
    assert.equal(video.channelTitle, 'Creator')
    assert.equal(video.viewCount, 2_184_000)
    assert.equal(video.likeCount, 45_300)
    assert.equal(video.durationIso, 'PT3M12S')
    assert.equal(video.thumbnailUrl, 'https://i.ytimg.com/vi/x/high.jpg', 'the largest thumbnail wins')
  })

  test('hidden statistics stay unknown rather than becoming zero', async () => {
    process.env.YOUTUBE_API_KEY = KEY
    stubFetch(() => jsonResponse({ items: [item('eeeeeeeeeee', { statistics: {} })] }))

    const [video] = await fetchVideoMetadata(['eeeeeeeeeee'])

    assert.equal(video.viewCount, undefined)
    assert.equal(video.likeCount, undefined)
  })

  test('a video that no longer exists is absent, not an error', async () => {
    process.env.YOUTUBE_API_KEY = KEY
    stubFetch(() => jsonResponse({ items: [] }))

    assert.deepEqual(await fetchVideoMetadata(['fffffffffff']), [])
    assert.equal(await fetchVideo('fffffffffff'), null)
  })

  test('a rejected key is an auth failure and an exhausted quota is rate limiting', async () => {
    process.env.YOUTUBE_API_KEY = KEY
    stubFetch(() => jsonResponse({ error: { code: 403, message: 'The request is missing a valid API key.', errors: [{ reason: 'keyInvalid' }] } }, 403))
    assert.equal((await failureFrom(() => fetchVideoMetadata(['ggggggggggg']))).kind, 'auth')

    stubFetch(() => jsonResponse({ error: { code: 403, message: 'Quota exceeded.', errors: [{ reason: 'quotaExceeded' }] } }, 403))
    assert.equal((await failureFrom(() => fetchVideoMetadata(['hhhhhhhhhhh']))).kind, 'rate-limit')
  })

  test('a missing key fails without making a request', async () => {
    stubFetch(() => jsonResponse({ items: [] }))

    const error = await failureFrom(() => fetchVideoMetadata(['iiiiiiiiiii']))
    assert.equal(error.kind, 'not-configured')
    assert.equal(requests.length, 0, 'no request is made without a credential')
  })

  test('the credential never reaches a message or a log line', async () => {
    process.env.YOUTUBE_API_KEY = KEY
    const logged: string[] = []
    const realError = console.error
    const realInfo = console.info
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
    console.info = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }

    try {
      stubFetch(() => {
        // The worst case: the provider echoes the submitted credential into the
        // failure it returns.
        throw Object.assign(new Error(`request failed for https://www.googleapis.com/youtube/v3/videos?key=${KEY}`), { name: 'FetchError' })
      })
      const error = await failureFrom(() => fetchVideoMetadata(['jjjjjjjjjjj']))

      for (const text of [error.message, ...logged]) {
        assert.ok(!text.includes(KEY), `the credential leaked into: ${text}`)
      }
    } finally {
      console.error = realError
      console.info = realInfo
    }
  })

  test('an invalid id never reaches the provider', async () => {
    process.env.YOUTUBE_API_KEY = KEY
    stubFetch(() => jsonResponse({ items: [] }))

    const videos = await fetchVideoMetadata(['too-short', 'has spaces', '<script>'])

    assert.deepEqual(videos, [])
    assert.equal(requests.length, 0)
  })
})
