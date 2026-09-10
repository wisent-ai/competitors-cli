import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidenceCatalog, competitorSurfaces } from '@wisent-ai/competitors-cli/context';

const limits = {
  maxTextBytesPerSurface: 2,
  maxScreenshotsPerCatalog: 1,
  maxImageBytes: 100,
};

test('catalog preserves Unicode boundaries, evidence identity and explicit omissions', () => {
  const url = 'https://example.com/product';
  const image = 'data:image/png;base64,YQ==';
  const catalog = buildEvidenceCatalog([{
    surface: { kind: 'website', url },
    text: 'ażb',
    structured: { title: 'Too large for the selected byte bound' },
    screenshots: [image, image, 'https://example.com/screenshot.png'],
  }], limits);

  assert.deepEqual(catalog.entries, [
    { id: 'ev:0:text:0', surfaceKind: 'website', url, type: 'text', content: 'a', truncated: true, bytes: 1 },
    { id: 'ev:0:shot:0', surfaceKind: 'website', url, type: 'screenshot', image, bytes: Buffer.byteLength(image) },
  ]);
  assert.deepEqual(catalog.omitted.map(({ id, reason }) => ({ id, reason })), [
    { id: 'ev:0:meta:0', reason: 'structured_size_limit' },
    { id: 'ev:0:shot:1', reason: 'catalog_screenshot_limit' },
    { id: 'ev:0:shot:2', reason: 'not_embedded' },
  ]);
  assert.deepEqual(catalog.errors, []);
  assert.throws(() => buildEvidenceCatalog([], { ...limits, maxTextBytesPerSurface: 0 }), {
    message: 'buildEvidenceCatalog requires a finite positive maxTextBytesPerSurface option',
  });
});

test('registry surfaces keep platform identities and deduplicate repeated records', () => {
  assert.deepEqual(competitorSurfaces({
    domains: ['example.com', 'example.com'],
    appStoreIds: ['1234'],
    playStorePackages: ['com.example.app'],
  }), [
    { kind: 'website', target: 'https://example.com' },
    { kind: 'ios_app', target: 'https://apps.apple.com/app/id1234' },
    { kind: 'android_app', target: 'https://play.google.com/store/apps/details?id=com.example.app' },
  ]);
});
