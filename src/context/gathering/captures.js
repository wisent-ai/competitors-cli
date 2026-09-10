// Capture metadata and model input shared by the two gathering flows.
import { cleanNullable, cleanObject } from '../../competition/model.js';

export const CONTEXT_SURFACE_KINDS = {
  WEBSITE: 'website',
  IOS_APP: 'ios_app',
  ANDROID_APP: 'android_app',
};

export function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function screenshotList(capture) {
  return Array.isArray(capture.screenshots) ? capture.screenshots : [];
}

function modelImageUrl(value) {
  const url = cleanText(value);
  if (!url) return null;
  try {
    const protocol = new URL(url).protocol;
    return ['data:', 'http:', 'https:'].includes(protocol) ? url : null;
  } catch {
    return null;
  }
}

export function screenshotEvidence(shot) {
  if (typeof shot === 'string') {
    return cleanObject({ reference: shot, embedded: Boolean(modelImageUrl(shot)) });
  }
  return cleanObject({
    path: cleanNullable(shot?.path),
    contentType: cleanNullable(shot?.contentType),
    byteLength: shot?.byteLength,
    embedded: shot?.embedded === true,
    omittedReason: cleanNullable(shot?.omittedReason),
    error: cleanNullable(shot?.error),
  });
}

export function captureEvidence(captures) {
  const textParts = [];
  const images = [];
  for (const capture of captures) {
    const text = cleanText(capture.text);
    if (text) textParts.push(`[${capture.kind} ${capture.target}] ${text}`);
    for (const shot of screenshotList(capture)) {
      const url = modelImageUrl(typeof shot === 'string' ? shot : shot?.url || shot?.ref);
      if (url) images.push({ kind: capture.kind, url });
    }
  }
  return { textParts, images };
}

