// Which registry competitors a list or a comparison is about. Every criterion
// narrows: a competitor stays only when it carries one of the requested tags,
// one of the requested regions, the requested product category and the
// requested active state. No criterion keeps every competitor.

function lowered(values) {
  return new Set(values.map((value) => String(value).trim().toLowerCase()))
}

function sharesOne(values, wanted) {
  return values.some((value) => wanted.has(String(value).toLowerCase()))
}

export function filterCompetitors(competitors, criteria) {
  const tags = lowered(criteria.tags)
  const regions = lowered(criteria.regions)
  const category = criteria.category === null ? null : criteria.category.trim().toLowerCase()
  return competitors.filter((competitor) => {
    if (tags.size && !sharesOne(competitor.tags, tags)) return false
    if (regions.size && !sharesOne(competitor.regions, regions)) return false
    if (category !== null && competitor.productCategory.toLowerCase() !== category) return false
    if (criteria.active !== null && competitor.active !== criteria.active) return false
    return true
  })
}

// The criteria a parsed command line names: --tag and --region repeat,
// --category is one value, --active and --inactive pick one state and refuse
// each other.
export function criteriaFromValues(values, refuse) {
  if (values.active && values.inactive) refuse('--active and --inactive refuse each other; name one state or neither')
  let active = null
  if (values.active) active = true
  if (values.inactive) active = false
  let category = null
  if (typeof values.category === 'string') category = values.category
  return { tags: values.tag, regions: values.region, category, active }
}

export function describeCriteria(criteria) {
  const parts = []
  if (criteria.tags.length) parts.push(`tag ${criteria.tags.join(' or ')}`)
  if (criteria.regions.length) parts.push(`region ${criteria.regions.join(' or ')}`)
  if (criteria.category !== null) parts.push(`category ${criteria.category}`)
  if (criteria.active === true) parts.push('active')
  if (criteria.active === false) parts.push('inactive')
  return parts.join(', ')
}
