import { cleanNullable, dayKey, stableHash } from '../competition/model.js';

/**
 * Where an event happened and whom it belongs to, as the caller stated it.
 * The actor is the anonymous id, or the user id of a signed-in caller; each
 * missing part is refused by name, so no event is recorded against a host,
 * page or person that did not produce it. `subject` names the event kind in
 * the refusal, as in "a competitor discovery event".
 */
export function eventIdentity(context, subject) {
  const actor = context.anonymousId || context.userId;
  if (!actor) throw new Error(`${subject} needs context.anonymousId or context.userId, the actor it is recorded for`);
  if (!context.host) throw new Error(`${subject} needs context.host, the host it was recorded on`);
  if (!context.path) throw new Error(`${subject} needs context.path, the path it was recorded on`);
  return { userId: context.userId, anonymousId: actor, host: context.host, path: context.path, url: context.url, referrer: context.referrer };
}

/**
 * A run's stated id, or one derived from `kind`, the run's day and its sorted
 * members under `membersName`, so the same run on the same day is identified
 * the same way it always was.
 */
export function runIdentity(statedRunId, kind, observedAt, membersName, members) {
  const stated = cleanNullable(statedRunId);
  if (stated) return stated;
  return `${kind}:${stableHash({ day: dayKey(observedAt), [membersName]: [...members].sort() })}`;
}
