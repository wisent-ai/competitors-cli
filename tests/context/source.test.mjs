import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSourceEvidenceCatalog } from '../../src/context/index.js';

test('source catalogs preserve all supplied files and full contents without declared bounds', () => {
  const files = Array.from({ length: 41 }, (_, index) => ({ path: `source-${index}.js`, content: `export const value = '${'x'.repeat(12001)}';` }));
  const catalog = buildSourceEvidenceCatalog({ repository: 'example/product', revision: 'input-revision', files });
  assert.deepEqual(catalog.entries.map(entry => [entry.path, entry.content, entry.truncated]), files.map(file => [file.path, file.content, false]));
  assert.deepEqual(catalog.omitted, []);
  assert.deepEqual(catalog.coverage, { maxSourceFiles: null, maxSourceBytesPerFile: null, complete: true });
});

test('a declared UTF-8 byte bound never inserts replacement characters or exceeds its byte budget', () => {
  const source = { files: [{ path: 'unicode.js', content: 'A😀漢Z' }] };
  const expected = new Map([[1, 'A'], [2, 'A'], [3, 'A'], [4, 'A'], [5, 'A😀'], [6, 'A😀'], [7, 'A😀'], [8, 'A😀漢'], [9, 'A😀漢Z']]);
  for (const [maximum, content] of expected) {
    const [entry] = buildSourceEvidenceCatalog(source, { maxSourceBytesPerFile: maximum }).entries;
    assert.equal(entry.content, content);
    assert.equal(entry.truncated, content !== source.files[0].content);
    assert.ok(Buffer.byteLength(entry.content, 'utf8') <= maximum);
    assert.equal(buildSourceEvidenceCatalog(source, { maxSourceBytesPerFile: maximum }).coverage.complete, maximum === 9);
  }
  const [empty] = buildSourceEvidenceCatalog({ files: [{ path: 'start.js', content: '😀' }] }, { maxSourceBytesPerFile: 1 }).entries;
  assert.equal(empty.content, '');
  assert.equal(empty.truncated, true);
});

test('declared file limits retain identity and disclose omitted evidence', () => {
  const catalog = buildSourceEvidenceCatalog({ files: [
    { path: 'first.js', content: 'first' }, { path: 'second.js', content: 'second' },
  ] }, { maxSourceFiles: 1 });
  assert.deepEqual(catalog.entries.map(entry => [entry.id, entry.path, entry.content]), [['src:0', 'first.js', 'first']]);
  assert.deepEqual(catalog.omitted, [{ path: 'second.js', reason: 'file_limit' }]);
  assert.deepEqual(catalog.coverage, { maxSourceFiles: 1, maxSourceBytesPerFile: null, complete: false });
});

test('invalid explicit bounds are refused rather than silently changing coverage', () => {
  for (const name of ['maxSourceFiles', 'maxSourceBytesPerFile']) {
    for (const value of [0, -1, 1.5, true, '2', NaN, Infinity]) {
      assert.throws(() => buildSourceEvidenceCatalog({}, { [name]: value }), new RegExp(name));
    }
  }
});
