// Construct bounded capture evidence before any model interprets it.
import { clean, cleanNullable, cleanObject } from '../../competition/model.js';
import { requirePositiveInteger, requirePositiveNumber } from './bounds.js';

// Captures arrive either with a nested surface descriptor ({ surface: { kind,
// target/url } }) or with the surface fields spread onto the capture itself
// (the gatherCompetitorContext shape). Accept both.
function surfaceOf(capture) {
  const surface = capture && typeof capture.surface === 'object' && capture.surface !== null ? capture.surface : capture;
  return {
    surfaceKind: cleanNullable(surface?.kind),
    url: cleanNullable(surface?.url) || cleanNullable(surface?.target),
  };
}

function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return { content: text, bytes: buffer.byteLength, truncated: false };
  }
  const content = buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '');
  return { content, bytes: Buffer.byteLength(content, 'utf8'), truncated: true };
}

// Only self-contained data: payloads count as embedded evidence; a plain
// http(s) reference is a pointer, not captured evidence.
function embeddedImageUrl(shot) {
  const url = cleanNullable(typeof shot === 'string' ? shot : shot?.url || shot?.ref);
  return url && url.startsWith('data:') ? url : null;
}

// Build a deterministic, bounded evidence catalog from per-surface captures.
// IDs: ev:<surfaceIndex>:text:<sliceIndex> | ev:<surfaceIndex>:meta:<n> |
// ev:<surfaceIndex>:shot:<n> — indices follow input array order, so the same
// captures always yield the same catalog.
// Returns { entries, omitted, errors }.
export function buildEvidenceCatalog(captures = [], options = {}) {
  if (!Array.isArray(captures)) throw new Error('buildEvidenceCatalog requires an array of surface captures');
  const maxTextBytesPerSurface = requirePositiveNumber(options, 'maxTextBytesPerSurface', 'buildEvidenceCatalog');
  const maxScreenshotsPerCatalog = requirePositiveInteger(options, 'maxScreenshotsPerCatalog', 'buildEvidenceCatalog');
  const maxImageBytes = requirePositiveNumber(options, 'maxImageBytes', 'buildEvidenceCatalog');

  const entries = [];
  const omitted = [];
  const errors = [];
  let screenshotCount = 0;

  captures.forEach((capture, surfaceIndex) => {
    const { surfaceKind, url } = surfaceOf(capture);
    const tie = { surfaceIndex, surfaceKind, url };

    const textError = cleanNullable(capture?.textError);
    if (textError) errors.push(cleanObject({ ...tie, source: 'text', error: textError }));
    const structuredError = cleanNullable(capture?.structuredError);
    if (structuredError) errors.push(cleanObject({ ...tie, source: 'structured', error: structuredError }));

    const text = clean(capture?.text);
    if (text) {
      const slice = truncateUtf8(text, maxTextBytesPerSurface);
      entries.push(cleanObject({
        id: `ev:${surfaceIndex}:text:0`,
        surfaceKind,
        url,
        type: 'text',
        content: slice.content,
        truncated: slice.truncated ? true : undefined,
        bytes: slice.bytes,
      }));
    }

    const structured = capture?.structured;
    if (structured !== undefined && structured !== null) {
      const items = Array.isArray(structured) ? structured : [structured];
      items.forEach((item, itemIndex) => {
        const id = `ev:${surfaceIndex}:meta:${itemIndex}`;
        let serialized;
        try {
          serialized = JSON.stringify(item);
        } catch (error) {
          errors.push(cleanObject({ ...tie, id, source: 'structured', error: `structured capture is not JSON-serializable: ${error?.message || error}` }));
          return;
        }
        if (serialized === undefined) {
          errors.push(cleanObject({ ...tie, id, source: 'structured', error: 'structured capture is not JSON-serializable' }));
          return;
        }
        const bytes = Buffer.byteLength(serialized, 'utf8');
        if (bytes > maxTextBytesPerSurface) {
          omitted.push(cleanObject({ ...tie, id, type: 'structured', reason: 'structured_size_limit', bytes }));
          return;
        }
        entries.push({ ...cleanObject({ id, surfaceKind, url, type: 'structured', bytes }), content: item });
      });
    }

    const shots = Array.isArray(capture?.screenshots) ? capture.screenshots : [];
    shots.forEach((shot, shotIndex) => {
      const id = `ev:${surfaceIndex}:shot:${shotIndex}`;
      const shotTie = { ...tie, id, type: 'screenshot' };
      const upstreamReason = typeof shot === 'object' && shot !== null ? cleanNullable(shot.omittedReason) : null;
      if (upstreamReason) {
        omitted.push(cleanObject({ ...shotTie, reason: upstreamReason, path: cleanNullable(shot?.path), error: cleanNullable(shot?.error) }));
        return;
      }
      const image = embeddedImageUrl(shot);
      if (!image) {
        omitted.push(cleanObject({ ...shotTie, reason: 'not_embedded', path: cleanNullable(shot?.path) }));
        return;
      }
      const bytes = Number.isFinite(shot?.byteLength) ? shot.byteLength : Buffer.byteLength(image, 'utf8');
      if (bytes > maxImageBytes) {
        omitted.push(cleanObject({ ...shotTie, reason: 'image_size_limit', bytes }));
        return;
      }
      if (screenshotCount >= maxScreenshotsPerCatalog) {
        omitted.push(cleanObject({ ...shotTie, reason: 'catalog_screenshot_limit', bytes }));
        return;
      }
      screenshotCount += 1;
      entries.push(cleanObject({ id, surfaceKind, url, type: 'screenshot', image, bytes }));
    });
  });

  return { entries, omitted, errors };
}

