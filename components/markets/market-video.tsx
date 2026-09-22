import { Card, SectionHeading } from '@/components/ui/primitives'
import type { YouTubeVideo } from '@/lib/providers/youtube'

/**
 * The video a market is about, with the metadata the YouTube adapter fetched on
 * the server.
 *
 * Rendered only when the fetch succeeded: a missing key, a deleted video or a
 * provider outage means the caller passes nothing and this card is simply
 * absent, which is why it takes an already-resolved value rather than doing any
 * fetching itself. It never renders on the client, so the metadata arrives with
 * the page.
 */

function formatCount(value?: number): string | null {
  if (value === undefined) return null
  if (value >= 10_000_000) return `${(value / 10_000_000).toFixed(1)}Cr`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function formatPublished(value?: string): string | null {
  if (!value) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function MarketVideo({ video }: { video: YouTubeVideo }) {
  const views = formatCount(video.viewCount)
  const published = formatPublished(video.publishedAt)
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`

  return (
    <section>
      <SectionHeading title="The video this market tracks" />
      <Card className="overflow-hidden">
        <a href={watchUrl} target="_blank" rel="noreferrer noopener" className="block">
          {video.thumbnailUrl ? (
            // A plain <img>: these thumbnails come from a third-party host that
            // is only known per video, and nothing here needs optimisation.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={video.thumbnailUrl}
              alt=""
              width={640}
              height={360}
              className="aspect-video w-full object-cover"
              loading="lazy"
            />
          ) : null}
          <div className="space-y-1 p-4">
            <p className="text-sm font-semibold text-foreground">{video.title}</p>
            <p className="text-xs text-muted-foreground">{video.channelTitle}</p>
            <p className="text-xs text-muted-foreground">
              {[views ? `${views} views` : null, published].filter(Boolean).join(' · ')}
            </p>
          </div>
        </a>
      </Card>
      <p className="mt-1 text-xs text-muted-foreground">
        Video metadata is shown for context and is not the settlement source.
      </p>
    </section>
  )
}
