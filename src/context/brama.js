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
  const routerUrl = String(options.routerUrl || '').replace(/\/+$/u, '');
  if (!routerUrl) throw new Error('createBramaChat requires routerUrl');
  const signRequest = options.signRequest;
  if (typeof signRequest !== 'function') throw new Error('createBramaChat requires a signRequest(body) => headers function');
  const fetchImpl = options.fetchImpl ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('createBramaChat requires fetch');
  const modelForPurpose = typeof options.modelForPurpose === 'function' ? options.modelForPurpose : defaultModelForPurpose;

  return async function chat(messages, meta = {}) {
    const vision = messagesHaveImages(messages);
    const model = modelForPurpose(meta.purpose, vision);
    const body = JSON.stringify({ model, messages });
    const signed = await signRequest(body);
    const headers = { 'content-type': 'application/json', ...signed };
    const response = await fetchImpl(`${routerUrl}/v1/chat/completions`, { method: 'POST', headers, body });
    if (!response.ok) throw new Error(`brama chat failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    const choices = Array.isArray(data?.choices) ? data.choices : [];
    const [first] = choices;
    return first?.message?.content || data?.content || '';
  };
}
