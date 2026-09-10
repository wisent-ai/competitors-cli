import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// Probierz scraper adapter. Builds a scrapeSurface(surface, competitor) that
// drives the probierz automation toolkit to capture a competitor surface with
// recording on, then reads the run's report/artifacts for screenshots and any
// page text. Probierz's run and analyze functions are injected, so this module
// hardcodes no cross-repo path and stays testable.
//
// Every surface is a URL (site or app-store listing) captured through the web
// target, so no competitor app binary is needed; probierz's web project also
// covers mobile-emulated browsers. The surface kind stays as an evidence label.
//
// When the operator injects an extractStructuredModule, each capture also
// records the structured page evidence that module extracts (page metadata,
// DOM outline, journey hints — whatever object the extractor returns), bounded
// by a caller-supplied maxStructuredBytes. Without that module, structured
// capture is skipped entirely and the capture shape is unchanged.

const TARGET_FOR_KIND = {
  website: 'web',
  ios_app: 'web',
  android_app: 'web',
};

function envForSurface(surface) {
  return { BASE_URL: surface.target };
}

function toDataUrl(image, contentType) {
  const encoded = image.toString('base64');
  const mime = contentType ? contentType : 'image/png';
  return `data:${mime};base64,${encoded}`;
}

function artifactPath(file, artifactsDir) {
  return isAbsolute(file) ? file : resolve(artifactsDir || '.', file);
}

function screenshotsFromAnalysis(analysis, options) {
  const media = Array.isArray(analysis?.media) ? analysis.media : [];
  const shots = media.filter((item) => item && item.kind === 'screenshot' && item.file && !item.missing);
  return shots.map((item, index) => {
    const path = artifactPath(item.file, options.artifactsDir);
    const evidence = { path, contentType: item.contentType };
    if (!options.inlineImages) {
      return { ...evidence, embedded: false, omittedReason: 'embedding_disabled' };
    }
    if (index >= options.screenshotLimit) {
      return { ...evidence, embedded: false, omittedReason: 'screenshot_limit' };
    }
    let image;
    try {
      image = readFileSync(path);
    } catch (error) {
      return {
        ...evidence,
        embedded: false,
        omittedReason: 'image_read_error',
        error: String(error?.message || error),
      };
    }
    if (image.byteLength > options.maxImageBytes) {
      return { ...evidence, embedded: false, byteLength: image.byteLength, omittedReason: 'image_size_limit' };
    }
    return {
      ...evidence,
      embedded: true,
      byteLength: image.byteLength,
      url: toDataUrl(image, item.contentType),
    };
  });
}

function resolveExtractStructured(extractStructuredModule, config) {
  if (!extractStructuredModule) return null;
  if (typeof extractStructuredModule.createExtractStructured === 'function') {
    const extractStructured = extractStructuredModule.createExtractStructured(config);
    if (typeof extractStructured !== 'function') {
      throw new Error('extractStructuredModule.createExtractStructured(config) must return a function');
    }
    return extractStructured;
  }
  if (typeof extractStructuredModule.extractStructured === 'function') return extractStructuredModule.extractStructured;
  throw new Error('extractStructuredModule must export createExtractStructured(config) or extractStructured(analysis, run, surface, competitor)');
}

function boundedStructured(value, maxStructuredBytes) {
  if (!value || typeof value !== 'object') {
    return { structured: null, structuredError: 'structured extractor must return a JSON-serializable object' };
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    return { structured: null, structuredError: String(error?.message || error) };
  }
  if (typeof serialized !== 'string') {
    return { structured: null, structuredError: 'structured extractor returned an object that does not serialize to JSON' };
  }
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > maxStructuredBytes) {
    return {
      structured: null,
      structuredError: `structured payload of ${byteLength} bytes exceeds the ${maxStructuredBytes} byte bound`,
    };
  }
  return { structured: value, structuredError: null };
}

export function createProbierzScraper(options = {}) {
  const runSurface = options.runSurface;
  if (typeof runSurface !== 'function') throw new Error('createProbierzScraper requires the probierz runSurface function');
  const analyzeRun = options.analyzeRun;
  if (typeof analyzeRun !== 'function') throw new Error('createProbierzScraper requires the probierz analyzeRun function');
  const extractText = typeof options.extractText === 'function' ? options.extractText : null;
  const extractStructured = resolveExtractStructured(options.extractStructuredModule, options);
  const runOptions = options.runOptions ? options.runOptions : {};
  const inlineImages = options.inlineImages === true;
  const screenshotLimit = Number(options.screenshotLimit);
  const maxImageBytes = Number(options.maxImageBytes);
  const maxStructuredBytes = Number(options.maxStructuredBytes);
  if (inlineImages && (!Number.isInteger(screenshotLimit) || screenshotLimit < Number.EPSILON)) {
    throw new Error('createProbierzScraper requires a positive integer screenshotLimit when inlineImages is enabled');
  }
  if (inlineImages && (!Number.isFinite(maxImageBytes) || maxImageBytes < Number.EPSILON)) {
    throw new Error('createProbierzScraper requires a positive maxImageBytes when inlineImages is enabled');
  }
  if (extractStructured && (!Number.isFinite(maxStructuredBytes) || maxStructuredBytes < Number.EPSILON)) {
    throw new Error('createProbierzScraper requires a positive maxStructuredBytes when structured extraction is enabled');
  }

  return async function scrapeSurface(surface, competitor) {
    const target = TARGET_FOR_KIND[surface.kind];
    if (!target) return null;
    const run = await runSurface(target, { env: envForSurface(surface), record: true, ...runOptions });
    if (!run || run.skipped || !run.reportPath) return null;
    const analysis = analyzeRun({ reportPath: run.reportPath, artifactsDir: run.artifactsDir, tool: run.tool });
    let text = '';
    let textError = null;
    if (extractText) {
      try {
        text = await extractText(analysis, run, surface, competitor);
      } catch (error) {
        textError = String(error?.message || error);
      }
    }
    let structured = null;
    let structuredError = null;
    if (extractStructured) {
      try {
        const value = await extractStructured(analysis, run, surface, competitor);
        ({ structured, structuredError } = boundedStructured(value, maxStructuredBytes));
      } catch (error) {
        structuredError = String(error?.message || error);
      }
    }
    const capture = {
      text,
      textError,
      screenshots: screenshotsFromAnalysis(analysis, {
        artifactsDir: run.artifactsDir,
        inlineImages,
        screenshotLimit,
        maxImageBytes,
      }),
      report: run.reportPath,
      artifactsDir: run.artifactsDir,
    };
    if (!extractStructured) return capture;
    return { ...capture, structured, structuredError };
  };
}
