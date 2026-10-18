// Gather a competitor overview from the caller's captures and model.
import { cleanNullable, cleanObject, cleanStringArray } from '../../competition/model.js';
import { CONTEXT_SURFACE_KINDS, captureEvidence, cleanText, screenshotEvidence, screenshotList } from './captures.js';

// Per-competitor context gathering. For each competitor, derive the surfaces to
// inspect from its registry data (website, mobile apps), capture each through
// the injected scrape function (probierz), then ask the injected model (brama)
// to extract a structured competitor context from the captured evidence.
// No hardcoded market vocabulary and no scoring: judgment is the model's.

const PURPOSE_CONTEXT = 'competitor-context';

// The context the model answers, bound as a strict JSON schema
// (`response_format` `json_schema`), so the reply is that object and is never
// searched for one inside prose. Strict schemas require every property.
const CONTEXT_PROPERTIES = {
  positioning: { type: 'string' },
  keyFeatures: { type: 'array', items: { type: 'string' } },
  pricing: { type: 'string' },
  targetAudience: { type: 'string' },
  differentiation: { type: 'string' },
  notes: { type: 'string' },
};
const CONTEXT_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'competitor_context',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(CONTEXT_PROPERTIES),
      properties: CONTEXT_PROPERTIES,
    },
  },
};

// The JSON object the model's context reply is; a reply that is not one is
// the gathering's failure, said with the reply, never an absent context.
function contextReplyObject(raw) {
  if (typeof raw !== 'string') throw new Error(`model context reply is not text: ${JSON.stringify(raw)}`);
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (cause) {
    throw new Error(`model context reply is not parseable JSON (${cause instanceof Error ? cause.message : String(cause)}): ${cleanText(raw)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`model context reply JSON is not an object: ${cleanText(raw)}`);
  return parsed;
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
      content: 'You analyze a competitor from captured web and app evidence (page text and screenshots) and answer the competitor_context object: its positioning, key features, pricing, target audience, differentiation and notes. Use an empty string or empty array when the evidence does not support a field.',
    },
    { role: 'user', content },
  ];
}

function normalizeContext(parsed) {
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
        const reply = await chat(contextMessages(competitor, captureEvidence(captures)), { purpose: PURPOSE_CONTEXT, responseFormat: CONTEXT_RESPONSE_FORMAT });
        context = normalizeContext(contextReplyObject(reply));
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

