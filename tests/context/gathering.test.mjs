import assert from 'node:assert/strict';
import { STATUS_CODES, createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createBramaChat, gatherCompetitorContext } from '../../src/context/index.js';

// Node's own table of statuses, read by the status's phrase.
function statusNamed(phrase) {
  const [code] = Object.entries(STATUS_CODES).find(([, text]) => text === phrase);
  return Number(code);
}
const OK = statusNamed('OK');
const SERVICE_UNAVAILABLE = statusNamed('Service Unavailable');

// A gateway on this machine that answers `/v1/chat/completions` with whatever
// body the test queued next, so the real adapter and the real gathering run
// over a real HTTP exchange. The gateway records every request body it read.
async function gateway() {
  const answers = [];
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, body });
      const answer = answers.shift();
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  server.listen({ host: 'localhost' });
  await once(server, 'listening');
  const { port } = server.address();
  const chat = createBramaChat({ routerUrl: `http://localhost:${port}/`, signRequest: () => ({ 'x-test-signature': 'local' }) });
  const queued = [];
  const answer = (body, status = OK) => { answers.push({ status, body }); queued.push(body); };
  return { answer, queued, requests, chat, close: () => new Promise((resolve) => server.close(resolve)) };
}

const competitor = { id: 'acme', name: 'Acme', domains: ['acme.example'] };
const scrapeSurface = async (surface) => ({ text: `Captured text of ${surface.target}` });
const hello = [{ role: 'user', content: 'hello' }];

test('a Brama answer without message content is the adapter\'s error naming the answer', async () => {
  const brama = await gateway();
  try {
    for (const body of [{ choices: [{ message: {} }] }, { choices: [] }, { choices: [{ message: { content: null } }] }, {}]) {
      brama.answer(body);
      await assert.rejects(brama.chat(hello, { purpose: 'test' }), { message: `brama chat answered without message content: ${JSON.stringify(body)}` });
    }
    brama.answer({ choices: [{ message: { content: 'first choice' } }] });
    assert.equal(await brama.chat(hello, { purpose: 'test' }), 'first choice');
    brama.answer({ content: 'flat content' });
    assert.equal(await brama.chat(hello, { purpose: 'test' }), 'flat content');
    brama.answer({ error: 'no model' }, SERVICE_UNAVAILABLE);
    await assert.rejects(brama.chat(hello, { purpose: 'test' }), { message: `brama chat failed: ${SERVICE_UNAVAILABLE} {"error":"no model"}` });
    assert.equal(brama.requests.length, brama.queued.length);
    assert.ok(brama.requests.every((request) => request.url === '/v1/chat/completions'));
  } finally {
    await brama.close();
  }
});

// A context step is asked for as one required call of the schema's function,
// so the gateway answers it with that call, its arguments the reply text.
const CONTEXT_FUNCTION = 'competitor_context';
const called = (reply) => ({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: CONTEXT_FUNCTION, arguments: reply } }] } }] });

test('a context reply that is not one JSON object is a context error carrying the reply and the cause', async () => {
  const brama = await gateway();
  try {
    const replies = [
      ['Sorry, I cannot read these captures.', /^model context reply is not parseable JSON \(.+\): Sorry, I cannot read these captures\.$/u],
      ['{"positioning": "unterminated', /^model context reply is not parseable JSON \(.+\): \{"positioning": "unterminated$/u],
      ['Here it is: {"positioning": "fine"}', /^model context reply is not parseable JSON \(.+\): Here it is: \{"positioning": "fine"\}$/u],
      ['["positioning"]', /^model context reply JSON is not an object: \["positioning"\]$/u],
    ];
    for (const [reply] of replies) brama.answer(called(reply));
    brama.answer({ choices: [{ message: {} }] });
    const competitors = brama.queued.map((_, index) => ({ ...competitor, id: `acme-${index}` }));
    const results = await gatherCompetitorContext(competitors, { scrapeSurface, chat: brama.chat });
    assert.equal(results.length, competitors.length);
    for (const [index, [, pattern]] of replies.entries()) {
      assert.equal(results[index].context, null);
      assert.match(results[index].contextError, pattern);
    }
    const [last] = [...results].reverse();
    assert.equal(last.context, null);
    assert.equal(last.contextError, `brama chat did not answer by exactly one call of ${CONTEXT_FUNCTION}: {"choices":[{"message":{}}]}`);
    assert.equal(brama.requests.length, competitors.length);
    const capturedText = (request) => JSON.parse(request.body).messages
      .find((message) => message.role === 'user').content
      .find((part) => part.type === 'text').text;
    assert.ok(brama.requests.every((request) => capturedText(request).includes('Captured text of https://acme.example')));
  } finally {
    await brama.close();
  }
});

test('a context reply that is the schema-bound object is the competitor\'s context and no context error', async () => {
  const brama = await gateway();
  try {
    brama.answer(called('{"positioning":"Budget CRM","keyFeatures":["pipelines"," "],"pricing":"","targetAudience":"SMBs","differentiation":null,"notes":"n/a"}'));
    const [result] = await gatherCompetitorContext([competitor], { scrapeSurface, chat: brama.chat });
    assert.equal(result.contextError, null);
    assert.deepEqual(result.context, { positioning: 'Budget CRM', keyFeatures: ['pipelines'], targetAudience: 'SMBs', notes: 'n/a' });
    assert.deepEqual(result.surfaceErrors, []);
    const [request] = brama.requests;
    const { tools: [tool], tool_choice: choice } = JSON.parse(request.body);
    assert.equal(tool.function.name, CONTEXT_FUNCTION);
    assert.equal(tool.function.strict, true);
    assert.deepEqual(choice, { type: 'function', function: { name: CONTEXT_FUNCTION } });
    assert.deepEqual(tool.function.parameters.required.toSorted(), ['differentiation', 'keyFeatures', 'notes', 'pricing', 'positioning', 'targetAudience']);
  } finally {
    await brama.close();
  }
});

test('a competitor nothing was captured for has neither context nor a context error', async () => {
  const brama = await gateway();
  try {
    const [result] = await gatherCompetitorContext([competitor], { scrapeSurface: async () => { throw new Error('site unreachable'); }, chat: brama.chat });
    assert.equal(result.context, null);
    assert.equal(result.contextError, null);
    assert.deepEqual(result.surfaceErrors.map((entry) => entry.error), ['site unreachable']);
    assert.deepEqual(brama.requests, []);
  } finally {
    await brama.close();
  }
});
