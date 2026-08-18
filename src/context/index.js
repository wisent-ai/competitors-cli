export * from './headers.js';
export * from './brama.js';
export * from './probierz.js';
export * from './research.js';
export * from './analysis.js';
export * from './source.js';

import { COMPETITOR_SIGNAL_TYPES, COMPETITOR_SOURCE_TYPES, cleanNullable, cleanObject, cleanStringArray } from '../competition/model.js';
import { normalizeCompetitorObservation } from '../competition/observations.js';
import { resolveCompetitorSurfaces, discoverCompetitorPages } from './research.js';
import { buildEvidenceCatalog, runDeepAnalysis, DEEP_ANALYSIS_AREAS } from './analysis.js';

// Per-competitor context gathering. For each competitor, derive the surfaces to
// inspect from its registry data (website, mobile apps), capture each through
// the injected scrape function (probierz), then ask the injected model (brama)
// to extract a structured competitor context from the captured evidence.
// No hardcoded market vocabulary and no scoring: judgment is the model's.

export const CONTEXT_SURFACE_KINDS = {
  WEBSITE: 'website',
  IOS_APP: 'ios_app',
  ANDROID_APP: 'android_app',
};

const PURPOSE_CONTEXT = 'competitor-context';

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseJsonObject(raw) {
  const match = String(raw || '').match(/\{[\s\S]*\}/u);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match.join(''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function competitorSurfaces(competitor) {
  const surfaces = [];
  for (const domain of cleanStringArray(competitor.domains)) {
    surfaces.push({ kind: CONTEXT_SURFACE_KINDS.WEBSITE, target: `https://${domain}` });
  }
  for (const appId of cleanStringArray(competitor.appStoreIds)) {
    surfaces.push({ kind: CONTEXT_SURFACE_KINDS.IOS_APP, target: `https://apps.apple.com/app/id${appId}` });
  }
  for (const pkg of cleanStringArray(competitor.playStorePackages)) {
    surfaces.push({ kind: CONTEXT_SURFACE_KINDS.ANDROID_APP, target: `https://play.google.com/store/apps/details?id=${pkg}` });
  }
  return surfaces;
}

function screenshotList(capture) {
  return Array.isArray(capture.screenshots) ? capture.screenshots : [];
}

function modelImageUrl(value) {
  const url = cleanText(value);
  if (!url) return null;
  try {
    const protocol = new URL(url).protocol;
    return ['data:', 'http:', 'https:'].includes(protocol) ? url : null;
  } catch {
    return null;
  }
}

function screenshotEvidence(shot) {
  if (typeof shot === 'string') {
    return cleanObject({ reference: shot, embedded: Boolean(modelImageUrl(shot)) });
  }
  return cleanObject({
    path: cleanNullable(shot?.path),
    contentType: cleanNullable(shot?.contentType),
    byteLength: shot?.byteLength,
    embedded: shot?.embedded === true,
    omittedReason: cleanNullable(shot?.omittedReason),
    error: cleanNullable(shot?.error),
  });
}

function captureEvidence(captures) {
  const textParts = [];
  const images = [];
  for (const capture of captures) {
    const text = cleanText(capture.text);
    if (text) textParts.push(`[${capture.kind} ${capture.target}] ${text}`);
    for (const shot of screenshotList(capture)) {
      const url = modelImageUrl(typeof shot === 'string' ? shot : shot?.url || shot?.ref);
      if (url) images.push({ kind: capture.kind, url });
    }
  }
  return { textParts, images };
}

function contextMessages(competitor, evidence) {
  const headerLines = [`Competitor: ${cleanText(competitor.name)}`];
  const domains = cleanStringArray(competitor.domains);
  if (domains.length) headerLines.push(`Domains: ${domains.join(', ')}`);
  headerLines.push('Extract a structured competitor context from the captured web and app evidence below.');
  const content = [{ type: 'text', text: `${headerLines.join('\n')}\n\n${evidence.textParts.join('\n\n')}` }];
  for (const image of evidence.images) {
    content.push({ type: 'image_url', image_url: { url: image.url } });
  }
  return [
    {
      role: 'system',
      content: 'You analyze a competitor from captured web and app evidence (page text and screenshots). Return ONLY a JSON object with these fields: {"positioning":"...","keyFeatures":["..."],"pricing":"...","targetAudience":"...","differentiation":"...","notes":"..."}. Use an empty string or empty array when the evidence does not support a field. No prose, no markdown.',
    },
    { role: 'user', content },
  ];
}

function normalizeContext(parsed) {
  if (!parsed) return null;
  return cleanObject({
    positioning: cleanNullable(parsed.positioning),
    keyFeatures: cleanStringArray(parsed.keyFeatures),
    pricing: cleanNullable(parsed.pricing),
    targetAudience: cleanNullable(parsed.targetAudience),
    differentiation: cleanNullable(parsed.differentiation),
    notes: cleanNullable(parsed.notes),
  });
}

export async function gatherCompetitorContext(competitors = [], options = {}) {
  const scrapeSurface = options.scrapeSurface;
  if (typeof scrapeSurface !== 'function') throw new Error('gatherCompetitorContext requires a scrapeSurface(surface, competitor) function');
  const chat = options.chat;
  if (typeof chat !== 'function') throw new Error('gatherCompetitorContext requires a chat(messages, { purpose }) function');
  const requestedKinds = Array.isArray(options.surfaceKinds) ? new Set(options.surfaceKinds) : null;

  const results = [];
  for (const competitor of competitors) {
    const surfaces = competitorSurfaces(competitor).filter((surface) => !requestedKinds || requestedKinds.has(surface.kind));
    const captures = [];
    const surfaceErrors = [];
    for (const surface of surfaces) {
      try {
        const capture = await scrapeSurface(surface, competitor);
        if (capture) captures.push({ ...surface, ...capture });
      } catch (error) {
        surfaceErrors.push({ surface, error: cleanText(error?.message || String(error)) });
      }
    }

    let context = null;
    let contextError = null;
    if (captures.length) {
      try {
        const reply = await chat(contextMessages(competitor, captureEvidence(captures)), { purpose: PURPOSE_CONTEXT });
        context = normalizeContext(parseJsonObject(reply));
      } catch (error) {
        contextError = cleanText(error?.message || String(error));
      }
    }

    results.push({
      competitor: { id: competitor.id, name: competitor.name },
      surfaces: captures.map((capture) => ({
        kind: capture.kind,
        target: capture.target,
        hasText: Boolean(cleanText(capture.text)),
        textError: cleanNullable(capture.textError),
        screenshotCount: screenshotList(capture).length,
        screenshots: screenshotList(capture).map(screenshotEvidence),
        report: cleanNullable(capture.report),
        artifactsDir: cleanNullable(capture.artifactsDir),
      })),
      context,
      surfaceErrors,
      contextError,
    });
  }
  return results;
}

// Map a gathered context result into competition observations so it flows into
// the existing competition tracker and summaries. Positioning, differentiation
// and target audience become positioning signals; pricing a pricing signal;
// each key feature a feature signal.
export function contextToObservations(contextResult, options = {}) {
  const context = contextResult?.context;
  if (!context) return [];
  const base = {
    competitor: contextResult.competitor,
    sourceType: options.sourceType ? options.sourceType : COMPETITOR_SOURCE_TYPES.WEBSITE,
    observedAt: options.observedAt,
    region: options.region,
  };
  const observations = [];
  const add = (signalType, summary) => {
    const text = cleanText(summary);
    if (text) observations.push(normalizeCompetitorObservation({ ...base, signalType, summary: text }));
  };
  add(COMPETITOR_SIGNAL_TYPES.POSITIONING, context.positioning);
  add(COMPETITOR_SIGNAL_TYPES.POSITIONING, context.differentiation);
  add(COMPETITOR_SIGNAL_TYPES.POSITIONING, context.targetAudience);
  add(COMPETITOR_SIGNAL_TYPES.PRICING, context.pricing);
  for (const feature of cleanStringArray(context.keyFeatures)) add(COMPETITOR_SIGNAL_TYPES.FEATURE, feature);
  return observations;
}

// Deep analysis: resolve a competitor's official surfaces from web-search
// evidence (research.js), discover the pages worth deep analysis, capture
// every verified surface and accepted page through the injected scrape
// function, build a host-side bounded evidence catalog, and run the
// eight-area deep analysis over it (analysis.js). All bounds are required
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

// Map one gathered deep-analysis result into competition observations. Areas
// map onto the closest signal types (funnel onboarding, seo seo, pricing and
// offers pricing, promotions ads, page structure feature, style and design
// system positioning); the source type follows the surface kind of the first
// valid evidence reference (website, app_store, play_store).
const DEEP_SIGNAL_FOR_AREA = {
  [DEEP_ANALYSIS_AREAS.STYLE]: COMPETITOR_SIGNAL_TYPES.POSITIONING,
  [DEEP_ANALYSIS_AREAS.DESIGN_SYSTEM]: COMPETITOR_SIGNAL_TYPES.POSITIONING,
  [DEEP_ANALYSIS_AREAS.PAGE_STRUCTURE]: COMPETITOR_SIGNAL_TYPES.FEATURE,
  [DEEP_ANALYSIS_AREAS.FUNNEL]: COMPETITOR_SIGNAL_TYPES.ONBOARDING,
  [DEEP_ANALYSIS_AREAS.SEO]: COMPETITOR_SIGNAL_TYPES.SEO,
  [DEEP_ANALYSIS_AREAS.PRICING]: COMPETITOR_SIGNAL_TYPES.PRICING,
  [DEEP_ANALYSIS_AREAS.OFFERS]: COMPETITOR_SIGNAL_TYPES.PRICING,
  [DEEP_ANALYSIS_AREAS.PROMOTIONS]: COMPETITOR_SIGNAL_TYPES.ADS,
};

const DEEP_SOURCE_FOR_SURFACE = {
  [CONTEXT_SURFACE_KINDS.WEBSITE]: COMPETITOR_SOURCE_TYPES.WEBSITE,
  [CONTEXT_SURFACE_KINDS.IOS_APP]: COMPETITOR_SOURCE_TYPES.APP_STORE,
  [CONTEXT_SURFACE_KINDS.ANDROID_APP]: COMPETITOR_SOURCE_TYPES.PLAY_STORE,
};

export function deepAnalysisToObservations(deepResult, options = {}) {
  const areas = deepResult?.deep?.areas;
  if (!areas) return [];
  const evidenceIndex = deepResult.evidenceIndex && typeof deepResult.evidenceIndex === 'object' ? deepResult.evidenceIndex : {};
  const observations = [];
  for (const [area, areaResult] of Object.entries(areas)) {
    const signalType = DEEP_SIGNAL_FOR_AREA[area];
    if (!signalType) continue;
    const findings = Array.isArray(areaResult?.findings) ? areaResult.findings : [];
    for (const finding of findings) {
      const summary = cleanText(finding?.summary);
      if (!summary) continue;
      const evidenceIds = cleanStringArray(finding?.evidenceIds);
      const firstEvidenceId = evidenceIds.find((id) => evidenceIndex[id]) || null;
      const evidence = firstEvidenceId ? evidenceIndex[firstEvidenceId] : null;
      observations.push(normalizeCompetitorObservation({
        competitor: deepResult.competitor,
        signalType,
        sourceType: (evidence && DEEP_SOURCE_FOR_SURFACE[evidence.surfaceKind]) || options.sourceType || COMPETITOR_SOURCE_TYPES.WEBSITE,
        observedAt: options.observedAt,
        region: options.region,
        surface: evidence ? evidence.surfaceKind : null,
        productArea: area,
        url: evidence ? evidence.url : null,
        evidenceUrl: evidence ? evidence.url : null,
        evidenceId: firstEvidenceId,
        summary,
        confidence: finding?.confidence,
        attributes: cleanObject({
          detail: cleanNullable(finding?.detail),
          evidenceIds: evidenceIds.join(','),
        }),
        capturedBy: options.capturedBy,
        runId: options.runId,
      }));
    }
  }
  return observations;
}
