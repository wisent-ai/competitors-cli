import type { Competitor } from '../index.js'

export const DEEP_ANALYSIS_AREAS: Readonly<Record<string, string>>
export const CONTEXT_SURFACE_KINDS: Readonly<Record<string, string>>
export function gatherCompetitorContext(competitors?: Competitor[], options?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>
export function gatherCompetitorDeepAnalysis(competitors?: Competitor[], options?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>
export function contextToObservations(result: Record<string, unknown>, options?: Record<string, unknown>): Array<Record<string, unknown>>
export function deepAnalysisToObservations(result: Record<string, unknown>, options?: Record<string, unknown>): Array<Record<string, unknown>>
export function createBramaChat(options?: Record<string, unknown>): (...args: unknown[]) => Promise<unknown>
export function createProbierzScraper(options?: Record<string, unknown>): (...args: unknown[]) => Promise<unknown>
/** A strict JSON Schema object holding exactly `properties`, every one required. */
export function strictObject(properties: Record<string, unknown>): Record<string, unknown>
/** The `response_format` that binds a reply to the strict object `properties` describe, named `name`. */
export function schemaFormat(name: string, properties: Record<string, unknown>): { type: 'json_schema'; json_schema: { name: string; strict: true; schema: Record<string, unknown> } }
/** The object a step's reply is, refused with the reply unless it parses whole as an object `holds` accepts. */
export function replyObject(raw: unknown, stage: string, schemaName: string, holds: (object: Record<string, unknown>) => boolean): Record<string, unknown>
/** The chat every model step asks: the messages, and the strict `json_schema` its answer must be. */
export type CompetitorChat = (
  messages: Array<{ role: string; content: unknown }>,
  meta: { purpose?: string; responseFormat?: { type: 'json_schema'; json_schema: { name: string; strict: true; schema: Record<string, unknown> } } },
) => Promise<string>
export interface CompetitorSurface {
  kind: string
  url: string
  domain: string
  verified: boolean
  evidence: string | null
}
/** A competitor's official website and store listings, each verified only by a search-result URL the gathered evidence holds. */
export function resolveCompetitorSurfaces(input: {
  competitor: Competitor
  chat: CompetitorChat
  search: (query: string) => Promise<string>
  options?: { maxQueries?: number; maxSearchTextBytes?: number }
}): Promise<{ surfaces: CompetitorSurface[]; queries: string[]; errors: Array<Record<string, unknown>>; status: 'resolved' | 'unresolved' }>
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
export function generateCompetitorRoadmap(input: {
  product: Competitor & { id: string }
  sourceComparisons: Array<Record<string, unknown>>
  observations: Array<Record<string, unknown>>
  chat: (...args: unknown[]) => Promise<unknown>
  options?: Record<string, unknown>
}): Promise<Record<string, unknown>>
