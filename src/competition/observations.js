import {
  COMPETITOR_EVENTS,
  COMPETITOR_SIGNAL_TYPES,
  COMPETITOR_SOURCE_TYPES,
  VALID_SIGNAL_TYPES,
  VALID_SOURCE_TYPES,
  clean,
  cleanNullable,
  cleanObject,
  countsFrom,
  createCompetitorRegistry,
  dayKey,
  isoTime,
  normalizeCompetitor,
  normalizeCompetitorMetric,
  numberOrNull,
  numberText,
  stableHash,
  tally,
} from './model.js';

// Observation layer: normalize competitor observations, derive event
// properties, build tracking events, and summarize sets. Null fields are
// dropped centrally by cleanObject rather than defaulted per key. Options are
// read explicitly (optional chaining) instead of destructuring-default params.

function resolveRegistry(options) {
  return options && options.registry ? options.registry : createCompetitorRegistry();
}

function resolveCompetitorInput(input, registry) {
  if (typeof input.competitor === 'string') {
    const known = registry.get(input.competitor);
    return known ? known : { id: input.competitor, name: input.competitor };
  }
  if (input.competitor) return input.competitor;
  return { id: input.competitorId, name: input.competitorName || input.competitorId };
}

export function normalizeCompetitorObservation(input = {}, options) {
  const registry = resolveRegistry(options);
  const competitor = normalizeCompetitor(resolveCompetitorInput(input, registry));
  const signalType = clean(input.signalType || input.type || COMPETITOR_SIGNAL_TYPES.FEATURE);
  const sourceType = clean(input.sourceType || input.source || COMPETITOR_SOURCE_TYPES.INTERNAL_RESEARCH);

  if (!VALID_SIGNAL_TYPES.has(signalType)) {
    throw new Error(`Invalid competitor signal type: ${signalType}`);
  }
  if (!VALID_SOURCE_TYPES.has(sourceType)) {
    throw new Error(`Invalid competitor source type: ${sourceType}`);
  }

  const observedAt = isoTime(input.observedAt || input.capturedAt || input.createdAt);
  const observation = {
    observationId: cleanNullable(input.observationId || input.id),
    competitor,
    signalType,
    sourceType,
    observedAt,
    region: clean(input.region || 'global').toUpperCase(),
    language: clean(input.language || '').toLowerCase() || null,
    surface: cleanNullable(input.surface),
    productArea: cleanNullable(input.productArea || input.area),
    url: cleanNullable(input.url),
    evidenceUrl: cleanNullable(input.evidenceUrl || input.url),
    evidenceId: cleanNullable(input.evidenceId),
    title: cleanNullable(input.title),
    summary: cleanNullable(input.summary || input.note || input.description),
    metric: normalizeCompetitorMetric(input.metric),
    confidence: numberOrNull(input.confidence),
    impact: cleanNullable(input.impact),
    attributes: cleanObject(input.attributes || input.props || {}),
    capturedBy: cleanNullable(input.capturedBy || input.researcher || input.sourceOwner),
    runId: cleanNullable(input.runId),
  };

  if (!observation.observationId) {
    observation.observationId = `comp:${stableHash({
      competitorId: observation.competitor.id,
      signalType: observation.signalType,
      sourceType: observation.sourceType,
      observedDay: dayKey(observation.observedAt),
      region: observation.region,
      surface: observation.surface,
      metricKey: observation.metric?.key || null,
      title: observation.title,
      summary: observation.summary,
    })}`;
  }

  return observation;
}

export function competitorObservationProperties(observationInput) {
  const observation = normalizeCompetitorObservation(observationInput);
  return cleanObject({
    source: 'deep_analytics_competition',
    competitor_observation_id: observation.observationId,
    competitor_id: observation.competitor.id,
    competitor_name: observation.competitor.name,
    competitor_company: observation.competitor.company,
    competitor_product_category: observation.competitor.productCategory,
    competitor_domains: observation.competitor.domains.join(','),
    competitor_tags: observation.competitor.tags.join(','),
    signal_type: observation.signalType,
    source_type: observation.sourceType,
    observed_at: observation.observedAt,
    observed_day: dayKey(observation.observedAt),
    region: observation.region,
    language: observation.language,
    surface: observation.surface,
    product_area: observation.productArea,
    evidence_url: observation.evidenceUrl,
    evidence_id: observation.evidenceId,
    title: observation.title,
    summary: observation.summary,
    confidence: numberText(observation.confidence),
    impact: observation.impact,
    metric_key: observation.metric?.key,
    metric_value: numberText(observation.metric?.value),
    metric_unit: observation.metric?.unit,
    metric_period: observation.metric?.period,
    metric_currency: observation.metric?.currency,
    metric_rank: numberText(observation.metric?.rank),
    captured_by: observation.capturedBy,
    run_id: observation.runId,
    attributes: observation.attributes,
  });
}

export function buildCompetitorObservationEvent(observationInput, context = {}) {
  const observation = normalizeCompetitorObservation(observationInput, context);
  return {
    eventId: `${COMPETITOR_EVENTS.OBSERVATION_RECORDED}:${observation.observationId}`,
    eventName: COMPETITOR_EVENTS.OBSERVATION_RECORDED,
    userId: context.userId,
    anonymousId: context.anonymousId || context.userId || 'deep-analytics-competition',
    sessionId: context.sessionId || observation.runId || `competition:${dayKey(observation.observedAt)}`,
    path: context.path || '/competition',
    host: context.host || 'deep-analytics.wisent.ai',
    url: context.url || observation.url || observation.evidenceUrl,
    referrer: context.referrer,
    properties: {
      ...competitorObservationProperties(observation),
      ...(context.properties || {}),
    },
  };
}

export function createCompetitorTracker(options = {}) {
  const trackEvent = options.trackEvent;
  if (typeof trackEvent !== 'function') throw new Error('createCompetitorTracker requires trackEvent');
  const registry = options.registry ? options.registry : createCompetitorRegistry();
  const defaultContext = options.defaultContext ? options.defaultContext : {};

  async function trackCompetitorObservation(observationInput, context = {}) {
    const event = buildCompetitorObservationEvent(observationInput, {
      registry,
      ...defaultContext,
      ...context,
      properties: {
        ...(defaultContext.properties || {}),
        ...(context.properties || {}),
      },
    });
    const result = await trackEvent(event);
    return { observation: normalizeCompetitorObservation(observationInput, { registry }), event, result };
  }

  async function trackCompetitorSnapshot(snapshot = {}, context = {}) {
    const observedAt = snapshot.observedAt;
    const summary = snapshot.summary;
    const observations = snapshot.observations ? snapshot.observations : [];
    const region = snapshot.region ? snapshot.region : 'global';
    const sourceType = snapshot.sourceType ? snapshot.sourceType : COMPETITOR_SOURCE_TYPES.INTERNAL_RESEARCH;

    const normalizedObservations = observations.map((observation) => normalizeCompetitorObservation({
      sourceType,
      observedAt,
      region,
      ...observation,
    }, { registry }));
    const competitorIds = new Set(normalizedObservations.map((observation) => observation.competitor.id));
    const signalTypes = new Set(normalizedObservations.map((observation) => observation.signalType));
    const id = cleanNullable(snapshot.snapshotId) || `snapshot:${stableHash({
      observedDay: dayKey(observedAt),
      region,
      competitors: [...competitorIds].sort(),
    })}`;

    const recorded = [];
    for (const observation of normalizedObservations) {
      recorded.push(await trackCompetitorObservation(observation, {
        ...context,
        properties: {
          ...(context.properties || {}),
          snapshot_id: id,
        },
      }));
    }

    const snapshotEvent = {
      eventId: `${COMPETITOR_EVENTS.SNAPSHOT_RECORDED}:${id}`,
      eventName: COMPETITOR_EVENTS.SNAPSHOT_RECORDED,
      userId: context.userId,
      anonymousId: context.anonymousId || context.userId || 'deep-analytics-competition',
      sessionId: context.sessionId || `competition:${dayKey(observedAt)}`,
      path: context.path || '/competition',
      host: context.host || 'deep-analytics.wisent.ai',
      url: context.url,
      referrer: context.referrer,
      properties: cleanObject({
        source: 'deep_analytics_competition',
        snapshot_id: id,
        observed_at: isoTime(observedAt),
        observed_day: dayKey(observedAt),
        region: clean(region).toUpperCase(),
        source_type: sourceType,
        observation_count: String(normalizedObservations.length),
        competitor_count: String(competitorIds.size),
        signal_types: [...signalTypes].join(','),
        summary: cleanNullable(summary),
        ...(context.properties || {}),
      }),
    };
    const snapshotResult = await trackEvent(snapshotEvent);

    return {
      snapshotId: id,
      observations: recorded,
      event: snapshotEvent,
      result: snapshotResult,
    };
  }

  return {
    registry,
    trackCompetitorObservation,
    trackCompetitorSnapshot,
  };
}

export function summarizeCompetitorObservations(observations = []) {
  const normalized = observations.map((observation) => normalizeCompetitorObservation(observation));
  const times = normalized.map((observation) => observation.observedAt).sort();
  const [firstObservedAt = null] = times;
  const lastObservedAt = [...times].pop() ?? null;

  const byCompetitor = tally(normalized, (observation) => observation.competitor.id);
  const bySignalType = tally(normalized, (observation) => observation.signalType);
  const bySourceType = tally(normalized, (observation) => observation.sourceType);

  return {
    observationCount: normalized.length,
    competitorCount: byCompetitor.size,
    byCompetitor: countsFrom(byCompetitor),
    bySignalType: countsFrom(bySignalType),
    bySourceType: countsFrom(bySourceType),
    firstObservedAt,
    lastObservedAt,
  };
}
