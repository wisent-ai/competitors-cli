// Coordinate verified surface research, capture and evidence-backed analysis.
import { cleanNullable, cleanObject } from '../../competition/model.js';
import { resolveCompetitorSurfaces, discoverCompetitorPages } from '../research/index.js';
import { buildEvidenceCatalog, runDeepAnalysis } from '../analysis/index.js';
import { cleanText, screenshotList } from './captures.js';

// Deep analysis: resolve a competitor's official surfaces from web-search
// evidence (research/index.js), discover the pages worth deep analysis, capture
// every verified surface and accepted page through the injected scrape
// function, build a host-side bounded evidence catalog, and run the
// eight-area deep analysis over it (analysis/index.js). All bounds are required
// caller-supplied options validated by the underlying modules.

function scrapeTargets(research, pages) {
  const targets = [];
  const seen = new Set();
  const add = (kind, url) => {
    const target = cleanText(url);
    if (!target || seen.has(target)) return;
    seen.add(target);
    targets.push({ kind, target });
  };
  for (const surface of research.surfaces) {
    if (surface.verified && surface.url) add(surface.kind, surface.url);
  }
  for (const page of pages) add(page.surfaceKind, page.url);
  return targets;
}

export async function gatherCompetitorDeepAnalysis(competitors = [], options = {}) {
  const scrapeSurface = options.scrapeSurface;
  if (typeof scrapeSurface !== 'function') throw new Error('gatherCompetitorDeepAnalysis requires a scrapeSurface(surface, competitor) function');
  const chat = options.chat;
  if (typeof chat !== 'function') throw new Error('gatherCompetitorDeepAnalysis requires a chat(messages, { purpose }) function');
  const search = options.search;
  if (typeof search !== 'function') throw new Error('gatherCompetitorDeepAnalysis requires a search(query) function');

  const results = [];
  for (const competitor of competitors) {
    const research = await resolveCompetitorSurfaces({ competitor, chat, search, options });
    let discovery = { pages: [], queries: [], errors: [], status: 'no_pages_selected' };
    if (research.status === 'resolved') {
      discovery = await discoverCompetitorPages({ competitor, surfaces: research.surfaces, chat, search, options });
    }

    const captures = [];
    const surfaceErrors = [];
    for (const target of scrapeTargets(research, discovery.pages)) {
      try {
        const capture = await scrapeSurface(target, competitor);
        if (capture) captures.push({ ...target, ...capture });
      } catch (error) {
        surfaceErrors.push({ surface: target, error: cleanText(error?.message || String(error)) });
      }
    }

    const catalog = buildEvidenceCatalog(captures, options);
    const deep = catalog.entries.length ? await runDeepAnalysis({ competitor, catalog, chat, options }) : null;

    const evidenceIndex = {};
    for (const entry of catalog.entries) {
      evidenceIndex[entry.id] = cleanObject({ surfaceKind: entry.surfaceKind, url: entry.url, type: entry.type });
    }

    results.push({
      competitor: { id: competitor.id, name: competitor.name },
      research: { surfaces: research.surfaces, queries: research.queries, errors: research.errors, status: research.status },
      pages: discovery,
      surfaces: captures.map((capture) => ({
        kind: capture.kind,
        target: capture.target,
        hasText: Boolean(cleanText(capture.text)),
        textError: cleanNullable(capture.textError),
        hasStructured: Boolean(capture.structured),
        structuredError: cleanNullable(capture.structuredError),
        screenshotCount: screenshotList(capture).length,
        report: cleanNullable(capture.report),
        artifactsDir: cleanNullable(capture.artifactsDir),
      })),
      catalog: { entryCount: catalog.entries.length, omitted: catalog.omitted, errors: catalog.errors },
      evidenceIndex,
      deep,
      surfaceErrors,
      status: deep ? deep.status : (research.status === 'resolved' ? 'no_evidence' : 'unresolved'),
    });
  }
  return results;
}

