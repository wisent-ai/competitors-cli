<!-- wisent-banner:start -->
<p align="center">
  <img src="assets/readme-banner.webp" alt="competitors-cli by Wisent" width="100%">
</p>
<!-- wisent-banner:end -->

<!-- wisent-readme-signals:start -->
[![Source](https://img.shields.io/badge/GitHub-Source-181717?logo=github)](https://github.com/wisent-ai/competitors-cli) [![Issues](https://img.shields.io/badge/GitHub-Issues-181717?logo=github)](https://github.com/wisent-ai/competitors-cli/issues) [![Wisent](https://img.shields.io/badge/Wisent-Website-0B0B0B)](https://wisent.com) [![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/qRjpkthq54) [![LinkedIn](https://img.shields.io/badge/LinkedIn-Follow-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/company/wisent-ai/) [![X](https://img.shields.io/badge/X-Follow-000000?logo=x&logoColor=white)](https://x.com/wisentai) [![Enterprise](https://img.shields.io/badge/Enterprise-Book%20a%20call-0B0B0B?logo=calendly)](https://calendly.com/lbartoszcze)
<!-- wisent-readme-signals:end -->

# Competitors CLI

[![Release](https://img.shields.io/github/v/release/wisent-ai/competitors-cli?display_name=tag&sort=semver)](https://github.com/wisent-ai/competitors-cli/releases)
[![Downloads](https://img.shields.io/github/downloads/wisent-ai/competitors-cli/total)](https://github.com/wisent-ai/competitors-cli/releases)
[![License](https://img.shields.io/github/license/wisent-ai/competitors-cli)](https://github.com/wisent-ai/competitors-cli)
[![Discord](https://img.shields.io/badge/Discord-Join%20Wisent-5865F2?logo=discord&logoColor=white)](https://discord.gg/qRjpkthq54)

**Competitors CLI is an evidence-first toolkit for competitor identity, discovery, rendered-surface research, comparison matrices, and normalized market observations.**

It provides a portable command line and JavaScript API. Search, browser capture, and model inference are injected boundaries: the package does not hide credentials, providers, or collection policy inside the library.

## Product boundaries

### Included

- canonical competitor identities, domains, categories, and aliases;
- deterministic discovery-record normalization and deduplication;
- model-directed discovery with caller-supplied search and page retrieval;
- official-surface resolution backed by cited search evidence;
- evidence catalogs for text, structured page data, and screenshots;
- evidence-referenced analysis of style, design system, page structure, funnel, SEO, pricing, offers, and promotions;
- normalized observations and Markdown or JSON product-comparison matrices.

### Explicit non-goals

- The CLI does not bypass authentication, robots controls, rate limits, platform policy, or access restrictions.
- A discovered candidate is not a verified competitor until supporting evidence establishes the relationship.
- Market observations are dated evidence, not permanent facts.
- Model output without a retained evidence reference is discarded by the deep-analysis pipeline.
- The repository contains no private customer data, credentials, campaign strategy, or unpublished competitive research.

## Quick start

Requires Node.js 20 or newer.

```bash
git clone https://github.com/wisent-ai/competitors-cli.git
cd competitors-cli
export COMPETITORS_REGISTRY="$PWD/competitors.registry.json"
node src/cli.js registry add --competitor alternative.json
node src/cli.js registry list
```

`alternative.json` is one competitor record, `{"name": "Alternative", "domains": ["alternative.example"]}`. The registry file starts empty and changes only through `registry add`, `registry edit <id> --competitor <changes.json>` and `registry remove <id>`; `registry show <id>` reads one record. A missing registry name is refused with `no competitor registry is named: pass --registry <file> or set COMPETITORS_REGISTRY`, an unknown id names the ids the file holds, and adding an id twice is refused.

Create `ours.json`:

```json
{
  "name": "Example",
  "features": { "Local mode": true, "Voice": true },
  "pricing": { "Monthly": "$10" }
}
```

Create `competitors.json`:

```json
[
  {
    "name": "Alternative",
    "features": { "Local mode": false, "Voice": true },
    "pricing": { "Monthly": "$15" }
  }
]
```

Generate a comparison from that file, or from the registry:

```bash
node src/cli.js compare --product ours.json --competitors competitors.json --format markdown
node src/cli.js compare --product ours.json --registry "$COMPETITORS_REGISTRY" --format markdown
```

`compare` takes exactly one of the two, and refuses an empty registry. `discover --registry <file>` deduplicates against the registered competitors; without it nothing is assumed to be known.

## Primary interfaces

| Interface | Contract |
|---|---|
| `competitors registry list\|show\|add\|edit\|remove` | the registry file the CLI owns |
| `competitors discover` | normalize and deduplicate caller-supplied discovery records |
| `competitors compare` | generate a feature and pricing matrix from explicit product records |
| `@wisent-ai/competitors-cli` | identities, observations, discovery, context, and comparison APIs |
| `@wisent-ai/competitors-cli/context` | evidence capture orchestration and deep analysis |
| `@wisent-ai/competitors-cli/crawl` | model-native search expansion with injected I/O |

## Integration model

The package owns competitor-domain contracts. Applications own transport and credentials:

```js
import { gatherCompetitorDeepAnalysis } from '@wisent-ai/competitors-cli/context'

const results = await gatherCompetitorDeepAnalysis(competitors, {
  search,
  scrapeSurface,
  chat,
})
```

Every bound (`maxQueries`, `maxSearchTextBytes`, `maxPages`,
`maxTextBytesPerSurface`, `maxScreenshotsPerCatalog`, `maxImageBytes`,
`maxFindingsPerArea`, `maxSourceFiles`, `maxSourceBytesPerFile`,
`maxSourceFindings`, `maxRoadmapItems`, and the Probierz adapter's
`screenshotLimit`, `maxImageBytes`, `maxStructuredBytes`) is the caller's. A
bound left out means the whole input is used; a bound given as anything other
than a positive number is refused with its name and value. The model and
search providers' own limits still apply and surface as their errors.
Source-file byte bounds retain only complete UTF-8 characters. A cut before a
multibyte character can use fewer bytes than the declared maximum; it never
inserts replacement text or exceeds that maximum. `entries[].truncated` and
`omitted` expose the evidence lost to explicitly declared bounds.
Catalog `coverage` retains the declared limits and whether all supplied evidence
survived. Source comparisons return `partial` when those catalogs lost evidence
or `maxSourceFindings` left model items unprocessed; `coverage.unprocessedFindings`
counts the unexamined items, not a claimed number of valid omitted findings.

Every retained deep-analysis finding cites an evidence ID from the host-built catalog. Missing surfaces, omitted payloads, invalid model output, and collection failures remain explicit in the result.

The public exports stay at `src/context/index.js`. Internally, `adapters/`
owns transport adapters, `research/` separates verified surfaces from page
selection, `analysis/` separates evidence construction from model analysis,
and `gathering/` owns capture orchestration. Observation conversion stays
separate from those collection steps.

Run `npm test` for the public source catalog's full-input, Unicode byte-boundary,
file-omission and invalid-bound behavior. Reports under `.build/source-evidence`
retain the source revision and patches, commands, exits and TAP output; a source
change during execution refuses qualification. These tests do not claim a live
model, search, browser or application GUI run.

Run `npm run test:registry` for the registry's lifecycle through the CLI: it adds,
shows, edits, compares against and removes a competitor in a fresh registry file,
reads the file after each step and checks every refusal. Its report,
`.build/real-tests/registry/<stamp>/report.txt`, names the revision and each check.

## Operational model

- **Input:** explicit JSON records or injected search, capture, and model functions.
- **Output:** JSON, Markdown, normalized observations, and evidence references.
- **State:** none by default; the caller chooses where dated reports and artifacts are retained.
- **Credentials:** owned by the calling application and never accepted as CLI flags.
- **Cost:** local comparison is unmetered; external search, capture, and inference costs belong to configured providers.

## Project status and support

- **Maturity:** public development source, version `0.1.0`.
- **Issues:** [wisent-ai/competitors-cli](https://github.com/wisent-ai/competitors-cli/issues).
- **Security:** use private GitHub Security Advisories for vulnerabilities; never attach credentials or unpublished research to a public issue.
- **License:** Apache License 2.0; see [LICENSE](LICENSE).
