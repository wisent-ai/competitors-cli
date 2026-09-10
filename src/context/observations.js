// Project gathered context and deep findings into the competition record format.
import { COMPETITOR_SIGNAL_TYPES, COMPETITOR_SOURCE_TYPES, cleanNullable, cleanObject, cleanStringArray } from '../competition/model.js';
import { normalizeCompetitorObservation } from '../competition/observations.js';
import { DEEP_ANALYSIS_AREAS } from './analysis/index.js';
import { CONTEXT_SURFACE_KINDS, cleanText } from './gathering/captures.js';

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
