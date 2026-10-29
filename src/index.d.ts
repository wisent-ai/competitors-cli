export type Competitor = {
  id?: string
  name: string
  company?: string | null
  productCategory?: string | null
  description?: string | null
  location?: string | null
  founded?: number | null
  domains?: string[]
  repositories?: string[]
  mentionQuery?: string | null
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

export function registryPath(explicit?: string | null, env?: Record<string, string | undefined>): string
export type Registry = {
  competitors: Competitor[]
  observations: Record<string, unknown>[]
  mappings: Record<string, unknown>[]
}

export function readRegistry(path: string): Promise<Registry>
export function mutateRegistry<T>(path: string, change: (registry: Registry) => T): Promise<T>
export function showCompetitor(path: string, id: string): Promise<Competitor>
export function addCompetitor(path: string, input: Competitor): Promise<Competitor>
export function editCompetitor(path: string, id: string, changes: Partial<Competitor>): Promise<Competitor>
export function removeCompetitor(path: string, id: string): Promise<{ competitor: Competitor; observations: number; mapping: boolean }>
export function compareProducts(product: ProductComparisonInput, competitors?: ProductComparisonInput[]): Record<string, unknown>
export function comparisonMarkdown(comparison: Record<string, unknown>): string
export function discoverCompetitorCandidates(records?: unknown[], options?: Record<string, unknown>): unknown[]
export function summarizeDiscoveryCandidates(candidates?: unknown[]): Record<string, unknown>
export function createCompetitorRegistry(competitors: Competitor[]): unknown
export function normalizeCompetitorObservation(input?: Record<string, unknown>, options?: Record<string, unknown>): Record<string, unknown>
export * from './context/index.js'
