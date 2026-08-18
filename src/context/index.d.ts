import type { Competitor } from '../index.js'

export const DEEP_ANALYSIS_AREAS: Readonly<Record<string, string>>
export const CONTEXT_SURFACE_KINDS: Readonly<Record<string, string>>
export function gatherCompetitorContext(competitors?: Competitor[], options?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>
export function gatherCompetitorDeepAnalysis(competitors?: Competitor[], options?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>
export function contextToObservations(result: Record<string, unknown>, options?: Record<string, unknown>): Array<Record<string, unknown>>
export function deepAnalysisToObservations(result: Record<string, unknown>, options?: Record<string, unknown>): Array<Record<string, unknown>>
export function createBramaChat(options?: Record<string, unknown>): (...args: unknown[]) => Promise<unknown>
export function createProbierzScraper(options?: Record<string, unknown>): (...args: unknown[]) => Promise<unknown>
export interface SourceFileEvidence {
  path: string
  content: string
  url?: string
}
export interface SourceRepositoryEvidence {
  repository?: string
  revision?: string
  files: SourceFileEvidence[]
}
export function buildSourceEvidenceCatalog(source?: SourceRepositoryEvidence, options?: Record<string, unknown>): Record<string, unknown>
export function analyzeSourceComparison(input: {
  product?: Competitor
  competitor?: Competitor
  productSource?: SourceRepositoryEvidence
  competitorSource?: SourceRepositoryEvidence
  chat: (...args: unknown[]) => Promise<unknown>
  options?: Record<string, unknown>
}): Promise<Record<string, unknown>>
