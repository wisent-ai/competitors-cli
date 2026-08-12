function clean(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

function slug(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '')
}

function featureMap(product) {
  if (Array.isArray(product?.features)) {
    return new Map(product.features.map((feature) => [slug(feature), true]).filter(([key]) => key))
  }
  if (!product?.features || typeof product.features !== 'object') return new Map()
  return new Map(Object.entries(product.features).map(([key, value]) => [slug(key), value]).filter(([key]) => key))
}

function displayValue(value) {
  if (value === true) return 'Yes'
  if (value === false || value == null || value === '') return 'No'
  if (Array.isArray(value)) return value.map(clean).filter(Boolean).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return clean(value)
}

function normalizeProduct(product, index) {
  const name = clean(product?.name)
  if (!name) throw new Error(`Product at index ${index} requires a name`)
  return {
    id: clean(product.id) || slug(name),
    name,
    url: clean(product.url) || null,
    positioning: clean(product.positioning) || null,
    targetAudience: clean(product.targetAudience) || null,
    features: featureMap(product),
    pricing: product.pricing && typeof product.pricing === 'object' ? product.pricing : {},
  }
}

export function compareProducts(product, competitors = []) {
  const products = [product, ...competitors].map(normalizeProduct)
  const featureKeys = [...new Set(products.flatMap((entry) => [...entry.features.keys()]))].sort()
  const pricingKeys = [...new Set(products.flatMap((entry) => Object.keys(entry.pricing).map(slug).filter(Boolean)))].sort()
  return {
    product: products[0],
    competitors: products.slice(1),
    featureRows: featureKeys.map((feature) => ({
      key: feature,
      values: Object.fromEntries(products.map((entry) => [entry.id, displayValue(entry.features.get(feature))])),
    })),
    pricingRows: pricingKeys.map((price) => ({
      key: price,
      values: Object.fromEntries(products.map((entry) => {
        const match = Object.entries(entry.pricing).find(([key]) => slug(key) === price)
        return [entry.id, displayValue(match?.[1])]
      })),
    })),
  }
}

function escapeCell(value) {
  return clean(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function comparisonMarkdown(comparison) {
  const products = [comparison.product, ...comparison.competitors]
  const header = `| Attribute | ${products.map((entry) => escapeCell(entry.name)).join(' | ')} |`
  const divider = `|---|${products.map(() => '---').join('|')}|`
  const rows = []
  for (const row of comparison.featureRows) {
    rows.push(`| Feature: ${escapeCell(row.key.replaceAll('_', ' '))} | ${products.map((entry) => escapeCell(row.values[entry.id])).join(' | ')} |`)
  }
  for (const row of comparison.pricingRows) {
    rows.push(`| Price: ${escapeCell(row.key.replaceAll('_', ' '))} | ${products.map((entry) => escapeCell(row.values[entry.id])).join(' | ')} |`)
  }
  return [header, divider, ...rows].join('\n')
}
