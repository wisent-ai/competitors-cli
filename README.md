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
- bounded evidence catalogs for text, structured page data, and screenshots;
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
node src/cli.js registry
```

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

Generate a comparison:

```bash
node src/cli.js compare --product ours.json --competitors competitors.json --format markdown
```

## Primary interfaces

| Interface | Contract |
|---|---|
| `competitors registry` | print the maintained identity seed registry |
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
  maxQueries: 4,
  maxSearchTextBytes: 40_000,
  maxPages: 5,
  maxTextBytesPerSurface: 18_000,
  maxScreenshotsPerCatalog: 5,
  maxImageBytes: 700_000,
  maxFindingsPerArea: 8,
})
```

Every retained deep-analysis finding cites an evidence ID from the host-built catalog. Missing surfaces, omitted payloads, invalid model output, and collection failures remain explicit in the result.

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
