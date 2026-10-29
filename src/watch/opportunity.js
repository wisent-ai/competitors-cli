import { selectObservations } from './observations.js'

// How strong an opportunity a tracked competitor is for us, from its
// observations and its mapping. The score multiplies three things the
// registry states: the revenue the competitor makes per employee (how much a
// small team earns in that market: the figure the published lists rank
// companies by), how much its revenue grew between its first and its latest
// reading (1 while it has one reading), and how many of our advantages over
// it its mapping names (0 when we would do nothing better, which leaves no
// opportunity). Every factor is reported beside the score, so the ranking can
// be read and disputed figure by figure.

function latest(observations, key) {
  const series = observations.filter((observation) => observation.metric?.key === key && observation.metric.value !== null)
  return series.length ? series[series.length - 1] : null
}

function earliest(observations, key) {
  return observations.find((observation) => observation.metric?.key === key && observation.metric.value !== null) || null
}

function money(value) {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(value % 1e9 ? 2 : 0)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(value % 1e6 ? 1 : 0)}M`
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`
  return `$${value}`
}

function month(observation) {
  return observation.attributes?.snapshot || observation.observedAt.slice(0, 10)
}

function source(observation) {
  return observation.attributes?.source || observation.evidenceUrl || observation.sourceType
}

/** The change of one counted signal between its first and latest reading, or null. */
function movement(observations, key) {
  const first = earliest(observations, key)
  const last = latest(observations, key)
  if (!first || !last || first === last) return null
  return { from: first.metric.value, to: last.metric.value, since: first.observedAt.slice(0, 10), at: last.observedAt.slice(0, 10) }
}

/** One competitor's opportunity: the score, each factor and the reasons in words. */
export function assessOpportunity(competitor, observations, mapping) {
  const own = selectObservations(observations, { competitor: competitor.id })
  const revenue = latest(own, 'annual_revenue')
  const firstRevenue = earliest(own, 'annual_revenue')
  const employees = latest(own, 'employees')
  const stated = latest(own, 'revenue_per_employee')
  let revenuePerEmployee = stated ? stated.metric.value : null
  if (revenuePerEmployee === null && revenue && employees && employees.metric.value > 0) revenuePerEmployee = revenue.metric.value / employees.metric.value
  const growth = revenue && firstRevenue && firstRevenue !== revenue && firstRevenue.metric.value > 0
    ? revenue.metric.value / firstRevenue.metric.value
    : null
  const reasons = []
  if (revenue) reasons.push(`${money(revenue.metric.value)} annual revenue${employees ? ` with ${employees.metric.value} ${employees.metric.value === 1 ? 'person' : 'people'}` : ''} (${month(revenue)}, ${source(revenue)})`)
  if (revenuePerEmployee !== null) reasons.push(`${money(Math.round(revenuePerEmployee))} revenue per employee`)
  if (growth !== null) reasons.push(`revenue ×${growth.toFixed(2)} from ${month(firstRevenue)} to ${month(revenue)}`)
  const stories = movement(own, 'hn_stories')
  if (stories) reasons.push(`Hacker News stories ${stories.from} → ${stories.to} (${stories.since} → ${stories.at})`)
  const starCount = movement(own, 'github_stars')
  if (starCount) reasons.push(`GitHub stars ${starCount.from} → ${starCount.to} (${starCount.since} → ${starCount.at})`)
  if (!mapping) {
    return { competitor: competitor.id, name: competitor.name, kind: 'unmapped', score: null, revenuePerEmployee, growth, advantages: null, ours: [], reasons: [...reasons, 'not mapped to our products: competitors mapping set'] }
  }
  const advantages = mapping.better.length
  const gap = mapping.ours.length === 0
  let kind = 'covered'
  if (gap) kind = mapping.better.length ? 'new-product' : 'not-pursued'
  else if (mapping.missing.length) kind = 'improve'
  if (kind === 'new-product') reasons.push(`no product of ours meets "${mapping.need}"; we would build: ${mapping.offer}`)
  else if (kind === 'not-pursued') reasons.push(`no product of ours meets "${mapping.need}", and the mapping names nothing we would do better`)
  else reasons.push(`${mapping.ours.join(', ')} ${mapping.relation === 'competes' ? 'competes' : 'is adjacent'}${mapping.missing.length ? `; missing: ${mapping.missing.join('; ')}` : ''}`)
  for (const item of mapping.better) reasons.push(`better on ${item.advantage}: ${item.reason}`)
  const score = revenuePerEmployee === null ? null : revenuePerEmployee * (growth === null ? 1 : growth) * advantages
  if (revenuePerEmployee === null) reasons.push('no revenue per employee is observed, so it is not ranked')
  return { competitor: competitor.id, name: competitor.name, kind, score, revenuePerEmployee, growth, advantages, ours: mapping.ours, purpose: mapping.purpose, reasons }
}

/** Every tracked competitor's opportunity, the strongest first; unranked ones last. */
export function rankOpportunities(registry) {
  const mappings = new Map(registry.mappings.map((mapping) => [mapping.competitor, mapping]))
  const assessed = registry.competitors
    .filter((competitor) => competitor.active)
    .map((competitor) => assessOpportunity(competitor, registry.observations, mappings.get(competitor.id) || null))
  return assessed.sort((left, right) => {
    if (left.score === null && right.score === null) return left.competitor.localeCompare(right.competitor)
    if (left.score === null) return 1
    if (right.score === null) return -1
    return right.score - left.score
  })
}
