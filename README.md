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

Requires Node.js 20 or newer. Registry mutations also use the `fs-ext` native
advisory-lock binding; installation requires the platform's Node native-addon
toolchain. A missing or unsupported binding is a named refusal, not unlocked
execution.

```bash
git clone https://github.com/wisent-ai/competitors-cli.git
cd competitors-cli
npm install
export COMPETITORS_REGISTRY="$PWD/competitors.registry.json"
node src/cli.js registry add --competitor alternative.json
node src/cli.js registry list
```

`alternative.json` is one competitor record, `{"name": "Alternative", "domains": ["alternative.example"]}`. The registry file starts empty and changes only through `registry add`, `registry import --competitors <competitors.json>`, `registry edit <id> --competitor <changes.json>` and `registry remove <id>`; `registry show <id>` reads one record. A missing registry name is refused with `no competitor registry is named: pass --registry <file> or set COMPETITORS_REGISTRY`, an unknown id names the ids the file holds, and adding an id twice is refused.

`registry import` takes an array or `{"competitors": [...]}` and adds every record in one locked write, or none: when the file names an id twice or an id the registry already holds, it exits 1 with `import refused, nothing was added: <ids> already in <registry> or named twice in the file; change held ones with competitors registry edit`, and the registry is unchanged. Its answer is `{"registry", "added": [...]}`.

`registry list` and `compare --registry` narrow the competitors with `--tag <tag>` and `--region <region>` (both repeat; a competitor carrying any one of them stays), `--category <productCategory>`, and `--active` or `--inactive`; matching ignores case. A filtered list answers `{"registry", "filter", "held", "competitors"}`, where `filter` describes the criteria and `held` counts the registry. `--active` with `--inactive` is a usage error (exit 2); `compare` refuses filters with `--competitors <file>` (exit 2) and, when no registry competitor matches, exits 1 naming the filter and how many the registry holds.

Registry add, edit and remove hold one nonblocking OS lock across the complete
read-modify-write operation. Symlink aliases resolve to the same target and
lock. A competing mutation refuses with the registry path, lock path and OS
cause; it does not wait, retry or overwrite another accepted change. Reads see
the complete old or new JSON through atomic replacement.

The stable `<registry>.lock` carrier remains beside the registry. Ownership is
held by the open descriptor and released when it closes or the process exits;
the file's presence does not mean a mutation is active. Do not unlink the
carrier while clients can use it: separate inodes would permit separate locks.
Use a local filesystem with working advisory locks; this is not distributed
coordination over NFS. Each write owns a unique pending file, syncs its bytes
and renames it over the target. Failures retain the actual cause and whether
the mutation was committed, including a later lock-close failure.

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

`discover` keeps a stated zero: a record whose ad, install or review count is
zero has that count, not an unknown one. A record naming no `sourceType` is
internal research and one naming no region is `GLOBAL`; a `sourceType` the
competition model does not know is refused with the known types, never filed as
internal research.

Unknown flags, missing option values (including another flag in place of the
value), and duplicate singleton options are usage errors with exit status 2.
`--own-domain`, `--tag` and `--region` may repeat. `--help` and `-h`
work at every command depth.

## Primary interfaces

| Interface | Contract |
|---|---|
| `competitors registry list\|show\|add\|import\|edit\|remove` | the registry file the CLI owns; `list` filters by tag, region, category and state |
| `competitors discover` | normalize and deduplicate caller-supplied discovery records |
| `competitors compare` | generate a feature and pricing matrix from explicit product records |
| `@wisent-ai/competitors-cli` | identities, observations, discovery, context, and comparison APIs |
| `@wisent-ai/competitors-cli/context` | evidence capture orchestration and deep analysis |
| `@wisent-ai/competitors-cli/crawl` | model-native search expansion with injected I/O; the injected `chat(messages, { purpose, responseFormat })` is asked for a strict `json_schema` object at every step (`competitor_queries`, `competitor_entities`, `competitor_decision`). A reply that is not that object is an error naming the step and the reply, never an empty or `ambiguous` answer: `discoverCompetitors` records it in `sourceErrors` for extract, classify and expand and throws it from the seed step, and `classifyDiscoveredCandidates` throws it. Missing inputs throw before anything is searched or asked: `brand is required`, `product, market, or marketDefinition is required`, `discoverCompetitors requires a search(query) function`, `discoverCompetitors requires an integer maxRounds option`, and for a missing `chat`, from `discoverCompetitors` or `createCompetitorModel` alike, `createCompetitorModel requires a chat(messages, { purpose, responseFormat }) function` |

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

The Probierz adapter's `scrapeSurface` throws, and the gathering flow records
as a surface error, a surface of a kind Probierz does not capture, a run
Probierz returned empty or skipped, a run with no report path, and a
screenshot named relative to a run that reported no artifacts directory. An
unreadable screenshot stays in the capture with `omittedReason:
"image_read_error"` and the read error's message.

`analyzeSourceComparison` asks the injected `chat` for a strict `json_schema`
named `source_findings`: `findings`, each a `capability`, an `assessment`
(`ours_better`, `theirs_better`, `different`, `equivalent` or `unknown`), a
`summary`, the `oursEvidenceIds` and `theirsEvidenceIds` it cites, which the
schema admits only from each catalog, and its `limitations`. A reply that is
not that object answers `status: "failed"` with the reply and the parser's
cause in `errors`. A finding without a capability, summary or citation, an
assessment outside the list, or a directional assessment without evidence
from both sides is said in `errors` (the last two kept as `unknown`), so the
comparison is `partial`. A source whose `files` is not a list, or a file
without path or content text, is refused by name; an empty file is left out.

Every retained deep-analysis finding cites an evidence ID from the host-built catalog. Missing surfaces, omitted payloads, invalid model output, and collection failures remain explicit in the result. `runDeepAnalysis` asks each area for a strict `json_schema` named `area_findings`: `findings`, each a `summary`, a `detail` and a `confidence` (null when the model has none) and the `evidenceIds` it cites, which the schema admits only from the catalog. A reply that is not that object is the area's `invalid_response` error with the reply and the parser's cause; a model call that fails is its `chat_error`. A catalog with no entries is refused, since no finding could cite one.

Surface resolution and page discovery ask the injected
`chat(messages, { purpose, responseFormat })` for a strict `json_schema` object
at every step: `research_queries` (`queries`, a list of search strings),
`competitor_surfaces` (`surfaces`, each a `kind` of `website`, `ios_app` or
`android_app`, its `url` and the search-result URL cited as `evidence`) and
`competitor_pages` (`pages`, each a `url`, the `reason` it merits analysis and
its `role`). A reply that is not that object is recorded in `errors` as
`<stage>: model reply is not parseable JSON (<cause>): <reply>` or
`<stage>: model reply is not the <schema> object: <reply>`, and the step ends
with no surfaces or pages; it is never searched for an object inside prose.
A search answer that is not text is recorded as an error for its query.
`discoverCompetitorPages` refuses `surfaces` that are not a list.

`gatherCompetitorContext` answers one result per competitor. It asks the
injected `chat` with `{ purpose, responseFormat }`, where `responseFormat` is a
strict `json_schema` named `competitor_context` (`positioning`, `keyFeatures`,
`pricing`, `targetAudience`, `differentiation`, `notes`); the Brama adapter
asks for it as one required call of the function that schema names, whose
parameters are the schema, and the call's arguments are the reply. `context` holds the reply when the
whole reply is that JSON object, with `contextError` null. A reply that does
not parse as JSON, prose around an object included, or that is not an object,
is said in `contextError` with the reply and the parser's cause
(`model context reply is not parseable JSON (<cause>): <reply>`), and
`context` is null; the reply is never searched for an object inside it. The
Brama adapter rejects an answer without exactly that one call
(`brama chat did not answer by exactly one call of competitor_context: <answer>`), which lands in
`contextError` the same way. Only a competitor nothing was captured for has
`context` and `contextError` both null; its `surfaceErrors` name every capture
that failed.

`generateCompetitorRoadmap({ product, sourceComparisons, observations, chat, options })`
turns the comparison findings and market observations into a review. Every
input but `options` is required: a product without an `id`, or
`sourceComparisons` or `observations` that are not lists (empty when there are
none), or a comparison without a `findings` list, is refused by name. It asks
the injected `chat` with a strict `json_schema` named `competitor_roadmap`: an
object whose `items` each give a `disposition` (`roadmap` or `no_action`), a
`priority` (`critical`, `high`, `medium` or `low`), the title, rationale,
impact, proposed change, code areas, acceptance criteria, competitors and the
`evidenceIds` it cites, which the schema admits only from the catalog it was
shown. A reply that is not that object answers `status: "failed"` with the
reply and the parser's cause in `errors`; it is never searched for JSON inside
it. An item without a title, rationale or citation is left out and said in
`errors`; a `roadmap` item without a proposed change and acceptance criteria,
or citing only source findings that show no competitor advantage or
difference, is kept as `no_action` with the reason in `errors`. Each item's
`id` is `roadmap:` and the SHA-256 of the product, disposition, title and
cited ids, so the same item keeps its id across runs.

A caller that asks its own injected `chat` for an object uses the same
helpers every step here uses, exported from `@wisent-ai/competitors-cli/context`:
`schemaFormat(name, properties)` builds the strict `json_schema`
`response_format` to pass as `responseFormat`, `strictObject(properties)` a
nested strict object, and `replyObject(reply, stage, name, holds)` reads the
reply whole, refusing one that does not parse (`<stage>: model reply is not
parseable JSON (<cause>): <reply>`) or is not the object `holds` accepts
(`<stage>: model reply is not the <name> object: <reply>`).

The public exports stay at `src/context/index.js`. Internally, `adapters/`
owns transport adapters, `research/` separates verified surfaces from page
selection, `analysis/` separates evidence construction from model analysis,
and `gathering/` owns capture orchestration. Observation conversion stays
separate from those collection steps.

Run `npm test` for the public source catalog's full-input, Unicode byte-boundary,
file-omission and invalid-bound behavior, and for context gathering over the
real Brama adapter against an HTTP gateway on this machine: content-less
answers, replies without a usable JSON object, a usable reply and a competitor
with no capture. Declare `COMPETITORS_TEST_SUCCESS_EXIT` and
`COMPETITORS_TEST_FAILURE_EXIT` as below. Reports under `.build/source-evidence`
retain the source revision and patches, commands, exits and TAP output; a source
change during execution refuses qualification. These tests do not claim a live
model, search, browser or application GUI run.

Run `npm run test:registry` for the registry's lifecycle through the CLI: it adds,
shows, edits, compares against and removes a competitor in a fresh registry file,
reads the file after each step and checks every refusal. Its report,
`.build/real-tests/registry/<stamp>/report.txt`, names the revision and each check.

`npm run test:registry:concurrency` holds a real OS lock while the actual CLI
attempts a mutation through a symlink alias, verifies refusal and unchanged
state, releases ownership, and verifies add/remove recovery and duplicate
refusal. A pre-existing pending-file sentinel must remain unchanged. Declare
`COMPETITORS_TEST_SOURCE_REVISION`, `COMPETITORS_TEST_SUCCESS_EXIT` and
`COMPETITORS_TEST_FAILURE_EXIT`; the existing CLI contract uses success `0`
and operational failure `1`. Reports under `.build/registry-concurrency/`
retain the source revision, entry digest, commands, exits and complete output.
Only the run-owned workspace is removed; no registry or process belonging to
the operator is touched.

`node --test tests/usage/exit-status.test.mjs` runs the CLI with an unknown
command, a flag the command does not take, and a correct invocation that fails:
the first two must exit with the usage status, name what was wrong and print the
usage, and the last must exit with the failure status and its own cause without
the usage. Declare the contract's statuses as `COMPETITORS_TEST_USAGE_EXIT` and
`COMPETITORS_TEST_FAILURE_EXIT` (usage `2`, operational failure `1`); a missing
one is refused by name.

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
