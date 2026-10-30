import { comparableFigures, selectObservations, signalSeries } from './observations.js'
import { rankOpportunities } from './opportunity.js'

// The board: every tracked competitor beside our products, one row each in
// opportunity order: its latest figures and public signals, which product of
// ours meets it and how, and its opportunity. It is one read of the registry;
// the CLI prints it and the served board shows the same rows.

function last(series) {
  return series.length ? series[series.length - 1] : null
}

function reading(own, key) {
  const series = own.filter((observation) => observation.metric?.key === key && observation.metric.value !== null)
  const latest = last(series)
  if (!latest) return null
  return {
    value: latest.metric.value,
    at: latest.attributes?.snapshot || latest.observedAt.slice(0, 10),
    previous: series.length > 1 ? series[series.length - 2].metric.value : null,
    readings: series.length,
  }
}

/**
 * A counted public signal as the board shows it: the latest day's figure,
 * the one before it that sums the same sources, and how many such days.
 */
function counted(own, key) {
  const figures = comparableFigures(signalSeries(own, key))
  const latest = last(figures)
  if (!latest) return null
  return {
    value: latest.value,
    at: latest.at,
    previous: figures.length > 1 ? figures[figures.length - 2].value : null,
    readings: figures.length,
    sources: latest.sources,
  }
}

function positioning(own) {
  const pages = own.filter((observation) => observation.sourceType === 'website')
  const latest = last(pages)
  if (!latest) return null
  const changes = pages.filter((page, index) => index > 0 && page.attributes?.positioningHash !== pages[index - 1].attributes?.positioningHash)
  return { title: latest.title, url: latest.url, at: latest.observedAt.slice(0, 10), changedAt: changes.length ? last(changes).observedAt.slice(0, 10) : null }
}

export function boardRows(registry) {
  const competitors = new Map(registry.competitors.map((competitor) => [competitor.id, competitor]))
  const mappings = new Map(registry.mappings.map((mapping) => [mapping.competitor, mapping]))
  return rankOpportunities(registry).map((opportunity, index) => {
    const competitor = competitors.get(opportunity.competitor)
    const own = selectObservations(registry.observations, { competitor: competitor.id })
    const mapping = mappings.get(competitor.id) || null
    const measured = own.filter((observation) => observation.capturedBy === 'competitors observation measure')
    return {
      rank: opportunity.score === null ? null : index + 1,
      id: competitor.id,
      name: competitor.name,
      description: competitor.description,
      location: competitor.location,
      annualRevenue: reading(own, 'annual_revenue'),
      employees: reading(own, 'employees'),
      revenuePerEmployee: opportunity.revenuePerEmployee,
      growth: opportunity.growth,
      profitable: reading(own, 'profitable'),
      hackerNewsStories: counted(own, 'hn_stories'),
      githubStars: counted(own, 'github_stars'),
      website: positioning(own),
      lastMeasuredAt: measured.length ? measured.map((observation) => observation.recordedAt).sort().pop() : null,
      ours: mapping ? mapping.ours : [],
      relation: mapping ? mapping.relation : null,
      missing: mapping ? mapping.missing : [],
      better: mapping ? mapping.better.map((item) => item.advantage) : [],
      kind: opportunity.kind,
      score: opportunity.score,
      reasons: opportunity.reasons,
    }
  })
}

function figure(value) {
  if (value === null || value === undefined) return '-'
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`
  return String(Math.round(value * 100) / 100)
}

function signal(read) {
  if (!read) return '-'
  return read.previous === null ? figure(read.value) : `${figure(read.value)} (was ${figure(read.previous)})`
}

/** The columns every rendering shows, as text cells. */
function cells(row) {
  return [
    row.rank === null ? '-' : String(row.rank),
    row.name,
    row.description || '-',
    row.annualRevenue ? `$${figure(row.annualRevenue.value)} (${row.annualRevenue.at})` : '-',
    row.employees ? String(row.employees.value) : '-',
    row.revenuePerEmployee === null ? '-' : `$${figure(row.revenuePerEmployee)}`,
    row.growth === null ? '-' : `×${row.growth.toFixed(2)}`,
    signal(row.hackerNewsStories),
    signal(row.githubStars),
    row.ours.length ? `${row.ours.join(', ')} (${row.relation})` : (row.kind === 'unmapped' ? 'not mapped' : 'none'),
    row.missing.join('; ') || '-',
    row.better.join(', ') || '-',
    row.kind,
    row.score === null ? '-' : figure(row.score),
  ]
}

export const BOARD_COLUMNS = ['#', 'company', 'what it sells', 'revenue', 'people', 'revenue/person', 'growth', 'HN stories', 'GitHub stars', 'ours', 'ours lacks', 'we are better on', 'gap', 'score']

export function boardMarkdown(rows) {
  const escape = (text) => text.replaceAll('|', '\\|')
  return [
    `| ${BOARD_COLUMNS.join(' | ')} |`,
    `|${BOARD_COLUMNS.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${cells(row).map(escape).join(' | ')} |`),
  ].join('\n')
}

function html(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

const STYLE = `body{font:14px -apple-system,system-ui,sans-serif;margin:24px;color:#111}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
th{position:sticky;top:0;background:#f6f6f6}tr.gap td{background:#fffbea}td.reasons{font-size:12px;color:#444}
section{margin:16px 0;padding:12px;border:1px solid #ddd;border-radius:6px}textarea{width:100%;font:12px ui-monospace,monospace}
#answer{white-space:pre-wrap;font:12px ui-monospace,monospace;background:#f6f6f6;padding:8px}`

function table(rows) {
  const body = rows.map((row) => {
    const reasons = `<details><summary>why</summary><ul>${row.reasons.map((reason) => `<li>${html(reason)}</li>`).join('')}</ul></details>`
    return `<tr class="${row.kind === 'new-product' ? 'gap' : ''}" data-id="${html(row.id)}">${cells(row).map((cell) => `<td>${html(cell)}</td>`).join('')}<td class="reasons">${reasons}</td></tr>`
  }).join('\n')
  return `<table><thead><tr>${[...BOARD_COLUMNS, 'reasons'].map((column) => `<th>${html(column)}</th>`).join('')}</tr></thead><tbody>\n${body}\n</tbody></table>`
}

/** The board as one HTML page, as `competitors board --format html` writes it. */
export function boardHtml(rows, registry) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Competitors board</title><style>${STYLE}</style></head><body>
<h1>Tracked companies and our products</h1><p>${rows.length} companies from ${html(registry)}; highlighted rows are gaps no product of ours meets.</p>
${table(rows)}</body></html>`
}

/**
 * The served board: the same table, and a form for every operation the CLI
 * has, each one a request to the served API (`competitors board serve`).
 */
export function boardApp(rows, registry) {
  const forms = `
<section><h2>Import a list</h2><p>Paste the tab-separated list, header line first.</p>
<textarea id="list" rows="6"></textarea><button data-call="import">Import</button></section>
<section><h2>Measure</h2><p>Read every competitor's declared signals now, or only those named (comma-separated ids).</p>
<input id="measure-ids" size="60"><button data-call="measure">Measure</button></section>
<section><h2>Competitor</h2><p>Add a competitor (JSON record) or import a JSON list of them; edit one by id, or with no id edit a JSON list of changes, each naming its id; remove one by id.</p>
<input id="competitor-id" placeholder="id" size="30"><textarea id="competitor" rows="4"></textarea>
<button data-call="competitor-list">List</button><button data-call="competitor-show">Show</button><button data-call="competitor-add">Add</button><button data-call="competitor-import">Import list</button><button data-call="competitor-edit">Edit</button><button data-call="competitor-remove">Remove</button></section>
<section><h2>Mapping</h2><p>Write the mapping of a competitor to our products (JSON), show it or remove it; or import a JSON list of mappings, each naming its competitor.</p>
<input id="mapping-id" placeholder="competitor id" size="30"><textarea id="mapping" rows="8"></textarea>
<button data-call="mapping-list">List</button><button data-call="mapping-show">Show</button><button data-call="mapping-set">Set</button><button data-call="mapping-import">Import list</button><button data-call="mapping-remove">Remove</button></section>
<section><h2>Observation</h2><p>Add one observation (JSON), or show or remove one by its id.</p>
<input id="observation-id" placeholder="observation id" size="40"><textarea id="observation" rows="4"></textarea>
<button data-call="observation-list">List (of the competitor id below)</button><input id="observation-of" placeholder="competitor id" size="20"><button data-call="observation-add">Add</button><button data-call="observation-show">Show</button><button data-call="observation-remove">Remove</button></section>
<section><h2>Opportunities</h2><button data-call="opportunities">List</button></section>
<section><h2>Proposals</h2><p>Write product plans for the strongest gaps.</p>
<input id="proposal-out" placeholder="out directory" size="50"> limit <input id="proposal-limit" size="3">
owner <input id="proposal-owner" size="12"> family <select id="proposal-family"><option>wisent</option><option>standalone</option></select>
evidence <input id="proposal-evidence" placeholder="comma-separated references" size="40">
oko root <input id="proposal-oko-root" size="38"> oko product <input id="proposal-oko-product" size="10">
<button data-call="proposals">Write</button></section>
<div id="answer"></div>`
  const script = `<script>
const value = (id) => document.getElementById(id).value.trim()
const list = (id) => value(id) ? value(id).split(',').map((item) => item.trim()).filter(Boolean) : []
const calls = {
  import: () => ['POST', '/v1/observations/import', value('list'), 'text/tab-separated-values'],
  measure: () => ['POST', '/v1/observations/measure', JSON.stringify({ competitors: list('measure-ids') })],
  'competitor-add': () => ['POST', '/v1/competitors', value('competitor')],
  'competitor-edit': () => ['PATCH', value('competitor-id') ? '/v1/competitors/' + encodeURIComponent(value('competitor-id')) : '/v1/competitors', value('competitor')],
  'competitor-remove': () => ['DELETE', '/v1/competitors/' + encodeURIComponent(value('competitor-id'))],
  'mapping-show': () => ['GET', '/v1/mappings/' + encodeURIComponent(value('mapping-id'))],
  'mapping-set': () => ['PUT', '/v1/mappings/' + encodeURIComponent(value('mapping-id')), value('mapping')],
  'mapping-remove': () => ['DELETE', '/v1/mappings/' + encodeURIComponent(value('mapping-id'))],
  'mapping-import': () => ['POST', '/v1/mappings/import', value('mapping')],
  'mapping-list': () => ['GET', '/v1/mappings'],
  'competitor-list': () => ['GET', '/v1/competitors'],
  'competitor-show': () => ['GET', '/v1/competitors/' + encodeURIComponent(value('competitor-id'))],
  'competitor-import': () => ['POST', '/v1/competitors/import', value('competitor')],
  'observation-list': () => ['GET', '/v1/observations?' + new URLSearchParams(value('observation-of') ? { competitor: value('observation-of') } : {})],
  opportunities: () => ['GET', '/v1/opportunities'],
  'observation-add': () => ['POST', '/v1/observations', value('observation')],
  'observation-show': () => ['GET', '/v1/observations/' + encodeURIComponent(value('observation-id'))],
  'observation-remove': () => ['DELETE', '/v1/observations/' + encodeURIComponent(value('observation-id'))],
  proposals: () => ['POST', '/v1/proposals', JSON.stringify({ out: value('proposal-out'), limit: Number(value('proposal-limit')), owner: value('proposal-owner'), family: value('proposal-family'), evidence: list('proposal-evidence'), okoRoot: value('proposal-oko-root') || null, okoProduct: value('proposal-oko-product') || null })],
}
for (const button of document.querySelectorAll('button[data-call]')) {
  button.addEventListener('click', async () => {
    const [method, path, body, type] = calls[button.dataset.call]()
    const response = await fetch(path, { method, body: method === 'GET' || method === 'DELETE' ? undefined : body, headers: { 'content-type': type || 'application/json' } })
    const text = await response.text()
    document.getElementById('answer').textContent = response.status + ' ' + text
    if (response.ok && method !== 'GET') {
      const page = await (await fetch('/')).text()
      document.querySelector('table').replaceWith(new DOMParser().parseFromString(page, 'text/html').querySelector('table'))
    }
  })
}
</script>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>Competitors board</title><style>${STYLE}</style></head><body>
<h1>Tracked companies and our products</h1><p>${rows.length} companies from ${html(registry)}; highlighted rows are gaps no product of ours meets.</p>
${table(rows)}${forms}${script}</body></html>`
}
