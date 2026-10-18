// Brama gateway chat adapter. Posts OpenAI-style chat completions to the brama
// model gateway and returns the assistant reply text. Signing is injected as
// signRequest(bodyString) => headers, so this module holds no agent secret and
// no timestamp math; the caller wires brama's signer. A vision-capable model is
// chosen automatically when the messages carry image references.

function messagesHaveImages(messages) {
  return messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part && part.type === 'image_url'));
}

function defaultModelForPurpose(purpose, vision) {
  if (vision) return 'any-vision-capable';
  return purpose ? `task:${purpose}` : 'any';
}

export function createBramaChat(options = {}) {
  if (typeof options.routerUrl !== 'string' || !options.routerUrl.trim()) {
    throw new Error(`createBramaChat requires routerUrl, the Brama origin; got ${JSON.stringify(options.routerUrl)}`);
  }
  const routerUrl = options.routerUrl.trim().replace(/\/+$/u, '');
  const signRequest = options.signRequest;
  if (typeof signRequest !== 'function') throw new Error('createBramaChat requires a signRequest(body) => headers function');
  const fetchImpl = options.fetchImpl ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('createBramaChat requires fetch');
  const modelForPurpose = typeof options.modelForPurpose === 'function' ? options.modelForPurpose : defaultModelForPurpose;

  // `meta.responseFormat`, when a caller binds its answer to a strict
  // `json_schema`, is asked for as one required call of the function that
  // schema names, whose parameters are the schema, and the call's arguments
  // are the reply text: the form Brama answers. An answer without exactly
  // that call is Brama's failure, said with what it sent. Without one the
  // answer is free text.
  return async function chat(messages, meta = {}) {
    const vision = messagesHaveImages(messages);
    const model = modelForPurpose(meta.purpose, vision);
    const format = meta.responseFormat;
    const body = JSON.stringify(format === undefined
      ? { model, messages }
      : {
        model,
        messages,
        tools: [{ type: 'function', function: { name: format.json_schema.name, description: `The ${format.json_schema.name} answer, as its parameters describe it.`, strict: true, parameters: format.json_schema.schema } }],
        tool_choice: { type: 'function', function: { name: format.json_schema.name } },
      });
    const signed = await signRequest(body);
    const headers = { 'content-type': 'application/json', ...signed };
    const response = await fetchImpl(`${routerUrl}/v1/chat/completions`, { method: 'POST', headers, body });
    if (!response.ok) throw new Error(`brama chat failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    const message = Array.isArray(data?.choices) ? data.choices.find(Boolean)?.message : undefined;
    if (format !== undefined) {
      const calls = message?.tool_calls;
      const [call, ...others] = Array.isArray(calls) ? calls : [];
      if (!call || others.length || call.function?.name !== format.json_schema.name || typeof call.function.arguments !== 'string') {
        throw new Error(`brama chat did not answer by exactly one call of ${format.json_schema.name}: ${JSON.stringify(data)}`);
      }
      return call.function.arguments;
    }
    // An answer without message text is Brama's failure, not an empty reply.
    const content = Array.isArray(data?.choices) ? message?.content : data?.content;
    if (typeof content !== 'string') throw new Error(`brama chat answered without message content: ${JSON.stringify(data)}`);
    return content;
  };
}
