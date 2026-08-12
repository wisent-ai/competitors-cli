export type Competitor = {
  id?: string
  name: string
  company?: string | null
  productCategory?: string | null
  domains?: string[]
  appStoreIds?: string[]
  playStorePackages?: string[]
  tags?: string[]
}

export type ProductComparisonInput = {
  id?: string
  name: string
  url?: string
  positioning?: string
  targetAudience?: string
  features?: string[] | Record<string, unknown>
  pricing?: Record<string, unknown>
}

export const DEFAULT_COMPETITORS: Competitor[]
export function compareProducts(product: ProductComparisonInput, competitors?: ProductComparisonInput[]): Record<string, unknown>
export function comparisonMarkdown(comparison: Record<string, unknown>): string
export function discoverCompetitorCandidates(records?: unknown[], options?: Record<string, unknown>): unknown[]
export function summarizeDiscoveryCandidates(candidates?: unknown[]): Record<string, unknown>
export function createCompetitorRegistry(seed?: Competitor[]): unknown
export function normalizeCompetitorObservation(input?: Record<string, unknown>, options?: Record<string, unknown>): Record<string, unknown>
export * from './context/index.js'
