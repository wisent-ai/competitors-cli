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
// DOM outline, journey hints — whatever object the extractor returns). A
// caller may bound it with maxStructuredBytes; without a bound it is kept
// whole. Without that module, structured capture is skipped entirely and the
// capture shape is unchanged.
//
// A surface probierz cannot capture is thrown with its cause, so the gathering
// flow records it among the surface errors instead of losing it unseen.

const TARGET_FOR_KIND = {
  website: 'web',
  ios_app: 'web',
  android_app: 'web',
};

// The words a thrown value carries: an Error's message, anything else as text.
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function envForSurface(surface) {
  return { BASE_URL: surface.target };
}

function toDataUrl(image, contentType) {
  const encoded = image.toString('base64');
  const mime = contentType ? contentType : 'image/png';
  return `data:${mime};base64,${encoded}`;
}

// A screenshot the report names relative to the run's artifacts directory; a
// relative name with no artifacts directory is refused, never resolved against
// whatever directory this process happens to run in.
function artifactPath(file, artifactsDir) {
  if (isAbsolute(file)) return file;
  if (typeof artifactsDir !== 'string' || artifactsDir === '') {
    throw new Error(`probierz named screenshot ${file} relative to a run that reported no artifacts directory`);
  }
  return resolve(artifactsDir, file);
}

function unreadImage(evidence, error) {
  return { ...evidence, embedded: false, omittedReason: 'image_read_error', error: errorText(error) };
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
      return unreadImage(evidence, error);
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

function structuredRefused(reason) {
  return { structured: null, structuredError: reason };
}

function boundedStructured(value, maxStructuredBytes) {
  if (!value || typeof value !== 'object') {
    return structuredRefused('structured extractor must return a JSON-serializable object');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    return structuredRefused(errorText(error));
  }
  if (typeof serialized !== 'string') {
    return structuredRefused('structured extractor returned an object that does not serialize to JSON');
  }
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > maxStructuredBytes) {
    return structuredRefused(`structured payload of ${byteLength} bytes exceeds the ${maxStructuredBytes} byte bound`);
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
  const bound = (name) => {
    const given = options[name];
    if (given === undefined || given === null) return Infinity;
    const value = Number(given);
    if (Number.isNaN(value) || value < Number.EPSILON) {
      throw new Error(`createProbierzScraper: ${name} must be a positive number, got ${given}`);
    }
    return value;
  };
  const screenshotLimit = bound('screenshotLimit');
  const maxImageBytes = bound('maxImageBytes');
  const maxStructuredBytes = bound('maxStructuredBytes');

  return async function scrapeSurface(surface, competitor) {
    const target = TARGET_FOR_KIND[surface.kind];
    if (!target) {
      throw new Error(`probierz captures no surface of kind ${surface.kind} (${surface.target})`);
    }
    const run = await runSurface(target, { env: envForSurface(surface), record: true, ...runOptions });
    if (!run) throw new Error(`probierz returned no run for ${surface.target}`);
    if (run.skipped) throw new Error(`probierz skipped the ${target} run for ${surface.target}`);
    if (!run.reportPath) throw new Error(`probierz ran ${surface.target} but reported no report path`);
    const analysis = analyzeRun({ reportPath: run.reportPath, artifactsDir: run.artifactsDir, tool: run.tool });
    let text = '';
    let textError = null;
    if (extractText) {
      try {
        text = await extractText(analysis, run, surface, competitor);
      } catch (error) {
        textError = errorText(error);
      }
    }
    let structured = null;
    let structuredError = null;
    if (extractStructured) {
      try {
        const value = await extractStructured(analysis, run, surface, competitor);
        ({ structured, structuredError } = boundedStructured(value, maxStructuredBytes));
      } catch (error) {
        structuredError = errorText(error);
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
