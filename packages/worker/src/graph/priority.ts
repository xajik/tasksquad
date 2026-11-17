/** Bounded heuristic, not a calibrated probability of business success. */
export function priority(input: {
  local: number | null
  goal: number | null
  visits: number
  observedAt: number | null
  now: number
  recovery: boolean
}): number {
  const quality =
    input.local === null && input.goal === null
      ? 0.5
      : input.local === null
        ? input.goal!
        : input.goal === null
          ? input.local
          : (input.local + input.goal) / 2
  const uncertainty = 1 / Math.sqrt(1 + Math.max(0, input.visits))
  const freshness =
    input.observedAt === null ? 0 : 1 / (1 + Math.max(0, input.now - input.observedAt) / 86400_000)
  return (
    Math.round(
      (0.6 * quality + 0.2 * uncertainty + 0.1 * freshness + 0.1 * (input.recovery ? 1 : 0)) * 1000
    ) / 1000
  )
}
