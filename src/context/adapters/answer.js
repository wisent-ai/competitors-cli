// The schema-bound answer every model step of competitors-cli asks for: the
// injected chat is called with `{ purpose, responseFormat }`, where
// `responseFormat` is a strict JSON schema (`response_format` `json_schema`),
// and the reply must be that object. A reply that is not that object is the
// step's error, said with the reply; it is never searched for an object or an
// array inside prose, and never read as "nothing found".

/** A strict schema: the object holds exactly `properties`, every one of them. */
export function strictObject(properties) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

/** The `response_format` that binds a reply to the strict object `properties` describe, named `name`. */
export function schemaFormat(name, properties) {
  return { type: 'json_schema', json_schema: { name, strict: true, schema: strictObject(properties) } };
}

/** `raw` with its whitespace collapsed, as an error quotes a reply. */
function quoted(raw) {
  return String(raw).replace(/\s+/gu, ' ').trim();
}

/** The object a step's reply is, refused unless `holds` accepts it. */
export function replyObject(raw, stage, schemaName, holds) {
  if (typeof raw !== 'string') throw new Error(`${stage}: model reply is not text: ${JSON.stringify(raw)}`);
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (cause) {
    throw new Error(`${stage}: model reply is not parseable JSON (${cause instanceof Error ? cause.message : String(cause)}): ${quoted(raw)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !holds(parsed)) {
    throw new Error(`${stage}: model reply is not the ${schemaName} object: ${quoted(raw)}`);
  }
  return parsed;
}
