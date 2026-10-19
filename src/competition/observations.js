import {
  COMPETITOR_EVENTS,
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
import { eventIdentity } from '../events/identity.js';

// Observation layer: normalize competitor observations, derive event
// properties, build tracking events, and summarize sets. Each field is read
// under its one name; a field the caller does not state stays absent (null
// fields are dropped centrally by cleanObject), and the signal and source
// types an observation cannot be classified without are refused by name.

function resolveRegistry(options) {
  return options && options.registry ? options.registry : createCompetitorRegistry([]);
}

function resolveCompetitorInput(input, registry) {
  if (typeof input.competitor === 'string') {
    const known = registry.get(input.competitor);
    return known ? known : { id: input.competitor, name: input.competitor };
  }
  if (input.competitor) return input.competitor;
  return { id: input.competitorId, name: input.competitorName };
}

/** A stated region as an upper-case code, or null when none is stated. */
function regionCode(value) {
  const region = cleanNullable(value);
  return region && region.toUpperCase();
}

/** The stated type under `name`, refused by name when missing or unknown. */
function statedType(value, name, valid) {
  const type = clean(value);
  if (!type) throw new Error(`a competitor observation needs ${name}, one of ${[...valid].join(', ')}`);
  if (!valid.has(type)) throw new Error(`Invalid competitor ${name}: ${type}`);
  return type;
}

export function normalizeCompetitorObservation(input = {}, options) {
  const registry = resolveRegistry(options);
  const competitor = normalizeCompetitor(resolveCompetitorInput(input, registry));
  const signalType = statedType(input.signalType, 'signalType', VALID_SIGNAL_TYPES);
  const sourceType = statedType(input.sourceType, 'sourceType', VALID_SOURCE_TYPES);
  const language = cleanNullable(input.language);
  const metric = normalizeCompetitorMetric(input.metric);

  const observation = {
    observationId: cleanNullable(input.observationId),
    competitor,
    signalType,
    sourceType,
    observedAt: isoTime(input.observedAt),
    region: regionCode(input.region),
    language: language && language.toLowerCase(),
    surface: cleanNullable(input.surface),
    productArea: cleanNullable(input.productArea),
    url: cleanNullable(input.url),
    evidenceUrl: cleanNullable(input.evidenceUrl),
    evidenceId: cleanNullable(input.evidenceId),
    title: cleanNullable(input.title),
    summary: cleanNullable(input.summary),
    metric,
    confidence: numberOrNull(input.confidence),
    impact: cleanNullable(input.impact),
    attributes: cleanObject(input.attributes),
    capturedBy: cleanNullable(input.capturedBy),
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
      metricKey: cleanNullable(metric && metric.key),
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

/** The session an event belongs to: the caller's stated session, else the
 * run that produced it, else the day it was observed on. */
function eventSession(context, runId, observedAt) {
  if (context.sessionId) return context.sessionId;
  if (runId) return runId;
  return `competition:${dayKey(observedAt)}`;
}

/** The page an observation event points at: the caller's url, else the
 * observed page, else the evidence url. */
function eventUrl(context, observation) {
  if (context.url) return context.url;
  if (observation.url) return observation.url;
  return observation.evidenceUrl;
}

export function buildCompetitorObservationEvent(observationInput, context = {}) {
  const observation = normalizeCompetitorObservation(observationInput, context);
  return {
    eventId: `${COMPETITOR_EVENTS.OBSERVATION_RECORDED}:${observation.observationId}`,
    eventName: COMPETITOR_EVENTS.OBSERVATION_RECORDED,
    ...eventIdentity(context, 'a competitor observation event'),
    sessionId: eventSession(context, observation.runId, observation.observedAt),
    url: eventUrl(context, observation),
    properties: {
      ...competitorObservationProperties(observation),
      ...context.properties,
    },
  };
}

/** The snapshot's stated id, or the digest of its day, region and competitors. */
function snapshotIdentity(snapshot, region, competitorIds) {
  const stated = cleanNullable(snapshot.snapshotId);
  if (stated) return stated;
  return `snapshot:${stableHash({
    observedDay: dayKey(snapshot.observedAt),
    region,
    competitors: [...competitorIds].sort(),
  })}`;
}

export function createCompetitorTracker(options = {}) {
  const trackEvent = options.trackEvent;
  if (typeof trackEvent !== 'function') throw new Error('createCompetitorTracker requires trackEvent');
  const registry = resolveRegistry(options);
  const defaultContext = options.defaultContext;

  async function trackCompetitorObservation(observationInput, context = {}) {
    const event = buildCompetitorObservationEvent(observationInput, {
      registry,
      ...defaultContext,
      ...context,
      properties: {
        ...defaultContext?.properties,
        ...context.properties,
      },
    });
    const result = await trackEvent(event);
    return { observation: normalizeCompetitorObservation(observationInput, { registry }), event, result };
  }

  async function trackCompetitorSnapshot(snapshot = {}, context = {}) {
    if (!Array.isArray(snapshot.observations)) {
      throw new Error('a competitor snapshot needs observations, the list of observations it records');
    }
    const { observedAt, sourceType } = snapshot;
    const region = regionCode(snapshot.region);

    const normalizedObservations = snapshot.observations.map((observation) => normalizeCompetitorObservation({
      sourceType,
      observedAt,
      region,
      ...observation,
    }, { registry }));
    const competitorIds = new Set(normalizedObservations.map((observation) => observation.competitor.id));
    const signalTypes = new Set(normalizedObservations.map((observation) => observation.signalType));
    const id = snapshotIdentity(snapshot, region, competitorIds);

    const recorded = [];
    for (const observation of normalizedObservations) {
      recorded.push(await trackCompetitorObservation(observation, {
        ...context,
        properties: {
          ...context.properties,
          snapshot_id: id,
        },
      }));
    }

    const snapshotEvent = {
      eventId: `${COMPETITOR_EVENTS.SNAPSHOT_RECORDED}:${id}`,
      eventName: COMPETITOR_EVENTS.SNAPSHOT_RECORDED,
      ...eventIdentity(context, 'a competitor snapshot event'),
      sessionId: eventSession(context, null, observedAt),
      properties: cleanObject({
        source: 'deep_analytics_competition',
        snapshot_id: id,
        observed_at: isoTime(observedAt),
        observed_day: dayKey(observedAt),
        region,
        source_type: sourceType,
        observation_count: String(normalizedObservations.length),
        competitor_count: String(competitorIds.size),
        signal_types: [...signalTypes].join(','),
        summary: cleanNullable(snapshot.summary),
        ...context.properties,
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
  const [lastObservedAt = null] = [...times].reverse();

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
