import { createServer } from 'node:http'
import { addCompetitor, editCompetitor, editCompetitors, importCompetitors, readRegistry, removeCompetitor, showCompetitor } from '../competition/registry-file.js'
import { boardApp, boardRows } from './board.js'
import { importMappings, setMapping, removeMapping, showMapping } from './mapping.js'
import { addObservation, importList, removeObservation, selectObservations, showObservation } from './observations.js'
import { rankOpportunities } from './opportunity.js'
import { writeProposals } from './proposal.js'
import { measureCompetitors } from './signals.js'

// The board served on this machine's loopback: the page shows the board and
// carries a form for every operation the CLI has; each form calls the API
// below, which runs the same library functions the CLI runs. Every request
// reads the registry again, so the page always shows the file as it is.

class Refusal extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function body(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function object(request) {
  const text = await body(request)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Refusal(400, `the request body is not JSON: ${error.message}`)
  }
}

function routes(registry, catalog) {
  const id = (match) => decodeURIComponent(match[1])
  return [
    ['GET', /^\/$/u, async () => ({ html: boardApp(boardRows(await readRegistry(registry)), registry) })],
    ['GET', /^\/v1\/board$/u, async () => boardRows(await readRegistry(registry))],
    ['GET', /^\/v1\/opportunities$/u, async () => rankOpportunities(await readRegistry(registry))],
    ['GET', /^\/v1\/competitors$/u, async () => (await readRegistry(registry)).competitors],
    ['GET', /^\/v1\/competitors\/([^/]+)$/u, async (request, match) => showCompetitor(registry, id(match))],
    ['POST', /^\/v1\/competitors\/import$/u, async (request) => {
      const input = await object(request)
      return { added: await importCompetitors(registry, Array.isArray(input) ? input : input.competitors) }
    }],
    ['POST', /^\/v1\/competitors$/u, async (request) => ({ added: await addCompetitor(registry, await object(request)) })],
    ['PATCH', /^\/v1\/competitors$/u, async (request) => {
      const input = await object(request)
      return { changed: await editCompetitors(registry, Array.isArray(input) ? input : input.competitors) }
    }],
    ['PATCH', /^\/v1\/competitors\/([^/]+)$/u, async (request, match) => ({ changed: await editCompetitor(registry, id(match), await object(request)) })],
    ['DELETE', /^\/v1\/competitors\/([^/]+)$/u, async (request, match) => ({ removed: await removeCompetitor(registry, id(match)) })],
    ['POST', /^\/v1\/observations\/import$/u, async (request) => importList(registry, await body(request), 'the pasted list')],
    ['POST', /^\/v1\/observations\/measure$/u, async (request) => measureCompetitors(registry, { competitors: (await object(request)).competitors || [] })],
    ['GET', /^\/v1\/observations$/u, async (request) => {
      const query = new URL(request.url, 'http://loopback').searchParams
      return selectObservations((await readRegistry(registry)).observations, { competitor: query.get('competitor'), metric: query.get('metric') })
    }],
    ['POST', /^\/v1\/observations$/u, async (request) => ({ added: await addObservation(registry, await object(request)) })],
    ['GET', /^\/v1\/observations\/([^/]+)$/u, async (request, match) => showObservation(registry, id(match))],
    ['DELETE', /^\/v1\/observations\/([^/]+)$/u, async (request, match) => ({ removed: await removeObservation(registry, id(match)) })],
    ['GET', /^\/v1\/mappings$/u, async () => (await readRegistry(registry)).mappings],
    ['GET', /^\/v1\/mappings\/([^/]+)$/u, async (request, match) => showMapping(registry, id(match))],
    ['POST', /^\/v1\/mappings\/import$/u, async (request) => importMappings(registry, await object(request), catalog)],
    ['PUT', /^\/v1\/mappings\/([^/]+)$/u, async (request, match) => setMapping(registry, id(match), await object(request), catalog)],
    ['DELETE', /^\/v1\/mappings\/([^/]+)$/u, async (request, match) => ({ removed: await removeMapping(registry, id(match)) })],
    ['POST', /^\/v1\/proposals$/u, async (request) => {
      const input = await object(request)
      const oko = input.okoRoot || input.okoProduct ? { root: input.okoRoot, product: input.okoProduct } : null
      return writeProposals(registry, { out: input.out, limit: input.limit, owner: input.owner, family: input.family, evidence: input.evidence || [], catalog, oko })
    }],
  ]
}

/**
 * Serve the board on 127.0.0.1 at `port`, or at a port the operating system
 * assigns when it is 0; resolves with the address once it listens.
 */
export function serveBoard({ registry, catalog, port }) {
  const table = routes(registry, catalog)
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://loopback').pathname
    const route = table.find(([method, pattern]) => method === request.method && pattern.test(path))
    try {
      if (!route) {
        const methods = table.filter(([, pattern]) => pattern.test(path)).map(([method]) => method)
        throw methods.length
          ? new Refusal(405, `${request.method} ${path} is not served; ${path} takes ${methods.join(', ')}`)
          : new Refusal(404, `${path} is not served; the board is at / and its API under /v1`)
      }
      const answer = await route[2](request, route[1].exec(path))
      if (answer && typeof answer.html === 'string') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(answer.html)
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answer, null, 2))
    } catch (error) {
      response.writeHead(error instanceof Refusal ? error.status : 422, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error.message }))
    }
  })
  return new Promise((accept, refuse) => {
    server.once('error', (error) => refuse(new Error(`serving the board on 127.0.0.1:${port} failed: ${error.message}`)))
    server.listen(port, '127.0.0.1', () => accept({ server, url: `http://127.0.0.1:${server.address().port}/` }))
  })
}
