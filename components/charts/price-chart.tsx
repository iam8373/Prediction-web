'use client'

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { formatTime } from '@/lib/date'
import type { PricePoint } from '@/types'

export function PriceChart({ history }: { history: PricePoint[] }) {
  const data = history.map((p) => ({ t: p.t, yes: Math.round(p.yes / 10) }))

  return (
    <div className="h-52 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="yesFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--yes)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--yes)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="t"
            tickFormatter={(t) => formatTime(t)}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            axisLine={false}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip
            formatter={((value: number) => [`${value}%`, 'Yes probability']) as never}
            labelFormatter={(t) => formatTime(Number(t))}
            contentStyle={{
              borderRadius: 12,
              border: '1px solid var(--border)',
              fontSize: 12,
              background: 'var(--card)',
            }}
          />
          <Area type="monotone" dataKey="yes" stroke="var(--yes)" strokeWidth={2} fill="url(#yesFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
