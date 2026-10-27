import type { CompetitorChat } from '../context/index.js'

/** One candidate a discovery round judged, with the model's decision and the query that found it. */
export interface DiscoveredCandidate {
  name: string
  url?: string
  snippet?: string
  decision: string
  reason?: string
  discoveredByQuery: string
}

/** Model-native discovery: seed, search, extract, classify and expand until the frontier drains or `maxRounds` rounds ran. */
export function discoverCompetitors(
  input: { brand: string; product?: string | null; market?: string | null; marketDefinition?: string | null },
  options: {
    search: (query: string) => Promise<string>
    chat: CompetitorChat
    maxRounds: number
    fetchPage?: (url: string) => Promise<string>
    gatherEvidence?: boolean
  },
): Promise<{
  ok: boolean
  status: 'saturated' | 'incomplete'
  brand: string
  marketDefinition: string
  competitors: DiscoveredCandidate[]
  excluded: DiscoveredCandidate[]
  ambiguous: DiscoveredCandidate[]
  rounds: Array<{ queries: string[]; added: string[]; newQueries: string[] }>
  coverage: { roundsRun: number; roundBudgetExhausted: boolean; frontierRemaining: number; competitorsFound: number }
  sourceErrors: Array<Record<string, unknown>>
}>

/** The model seam discovery asks each step through. */
export function createCompetitorModel(input: { chat: CompetitorChat }): Record<string, (...args: unknown[]) => Promise<unknown>>
