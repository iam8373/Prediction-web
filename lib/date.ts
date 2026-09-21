import { DEMO_NOW } from '@/lib/data/demo-config'

/**
 * All timestamps render against the demo clock so server and client output
 * matches exactly. Swapping `DEMO_NOW` for `Date.now()` is the only change
 * needed once markets come from the database.
 */

const dateTime = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
})

const dateOnly = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
})

const timeOnly = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
})

export function formatDateTime(ts: number) {
  return `${dateTime.format(ts)} IST`
}

export function formatDate(ts: number) {
  return dateOnly.format(ts)
}

export function formatTime(ts: number) {
  return timeOnly.format(ts)
}

/** "4h left" / "3d left" / "Closed" */
export function timeToClose(closesAt: number, now: number = DEMO_NOW) {
  const diff = closesAt - now
  if (diff <= 0) return 'Closed'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m left`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h left`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d left`
  return `${Math.floor(days / 30)}mo left`
}

/** "2 days ago" */
export function timeAgo(ts: number, now: number = DEMO_NOW) {
  const diff = Math.max(0, now - ts)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatDate(ts)
}

export function isClosingSoon(closesAt: number, now: number = DEMO_NOW) {
  const diff = closesAt - now
  return diff > 0 && diff < 12 * 3_600_000
}

/** `datetime-local` value for form defaults. */
export function toLocalInputValue(ts: number) {
  const d = new Date(ts + 5.5 * 3_600_000)
  return d.toISOString().slice(0, 16)
}
