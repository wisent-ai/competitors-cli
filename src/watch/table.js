import { COMPETITOR_SIGNAL_TYPES, COMPETITOR_SOURCE_TYPES, slugify, stableHash } from '../competition/model.js'

// A published list of companies, as a spreadsheet pastes it: tab-separated
// text whose first line names the columns. Each row is one company at one
// snapshot time from one source; each stated figure becomes one dated
// observation of that company, so a later list of the same companies adds
// readings to the same time series instead of replacing them.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const SCALE = { k: 1e3, m: 1e6, b: 1e9 }

// Every column a list may carry, by the header it is pasted under. A figure
// column names the metric it records, its unit and its signal type.
const FIGURES = {
  'Annual Revenue': { key: 'annual_revenue', unit: 'USD', period: 'year', signalType: COMPETITOR_SIGNAL_TYPES.FINANCIAL, read: amount },
  '# of Employees': { key: 'employees', unit: 'people', signalType: COMPETITOR_SIGNAL_TYPES.TEAM, read: count },
  'Revenue/Employee': { key: 'revenue_per_employee', unit: 'USD per person', period: 'year', signalType: COMPETITOR_SIGNAL_TYPES.FINANCIAL, read: amount },
  'Profitable?': { key: 'profitable', unit: 'yes=1 no=0', signalType: COMPETITOR_SIGNAL_TYPES.FINANCIAL, read: answer },
  'Total Funding': { key: 'total_funding', unit: 'USD', signalType: COMPETITOR_SIGNAL_TYPES.FINANCIAL, read: amount },
  Valuation: { key: 'valuation', unit: 'USD', signalType: COMPETITOR_SIGNAL_TYPES.FINANCIAL, read: amount },
  'Valuation/Employee': { key: 'valuation_per_employee', unit: 'USD per person', signalType: COMPETITOR_SIGNAL_TYPES.FINANCIAL, read: amount },
}
const DESCRIPTIVE = ['Rank', 'Company', 'Description', 'Location', 'Founded', 'Snapshot Time', 'Source']
const REQUIRED = ['Company', 'Snapshot Time', 'Source']
export const LIST_COLUMNS = [...DESCRIPTIVE, ...Object.keys(FIGURES)]

/** `text` as {value, bound}: "$1,800,000,000", "$1.8B", "≥$10,000,000". */
function amount(text) {
  const match = /^(≥|>=)?\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([kmb])?$/iu.exec(text)
  if (!match) return null
  const [, atLeast, digits, suffix] = match
  const value = Number(digits.replaceAll(',', '')) * (suffix ? SCALE[suffix.toLowerCase()] : 1)
  return { value, bound: atLeast ? 'at_least' : null }
}

function count(text) {
  const match = /^(≥|>=)?\s*(\d[\d,]*)$/u.exec(text)
  if (!match) return null
  return { value: Number(match[2].replaceAll(',', '')), bound: match[1] ? 'at_least' : null }
}

function answer(text) {
  const word = text.toLowerCase()
  if (word === 'yes') return { value: 1, bound: null }
  if (word === 'no') return { value: 0, bound: null }
  return null
}

/** The first day of the stated month, in UTC: "Apr 2026", "April 2026", "2026-04". */
function snapshotMonth(text) {
  const named = /^([a-z]+)\.?\s+(\d{4})$/iu.exec(text)
  if (named) {
    const month = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase())
    if (month >= 0) return { observedAt: new Date(Date.UTC(Number(named[2]), month, 1)).toISOString(), month: `${named[2]}-${String(month + 1).padStart(2, '0')}` }
  }
  const numeric = /^(\d{4})-(\d{2})$/u.exec(text)
  if (numeric && Number(numeric[2]) >= 1 && Number(numeric[2]) <= 12) {
    return { observedAt: new Date(Date.UTC(Number(numeric[1]), Number(numeric[2]) - 1, 1)).toISOString(), month: text }
  }
  return null
}

function isUrl(text) {
  return /^https?:\/\//iu.test(text) && URL.canParse(text)
}

/**
 * The companies and observations a tab-separated list states. Every refusal
 * names the line, the company and the column, and what the column accepts.
 */
export function parseListTable(text, origin) {
  const lines = String(text).split(/\r?\n/u).filter((line) => line.trim())
  if (lines.length < 2) throw new Error(`${origin} holds no list: a header line naming the columns and one line per company are required`)
  const header = lines[0].split('\t').map((name) => name.trim())
  const unknown = header.filter((name) => !LIST_COLUMNS.includes(name))
  if (unknown.length) {
    throw new Error(`${origin}: column ${unknown.map((name) => JSON.stringify(name)).join(', ')} is not a list column; the columns are ${LIST_COLUMNS.join(', ')} (tab-separated)`)
  }
  const missing = REQUIRED.filter((name) => !header.includes(name))
  if (missing.length) throw new Error(`${origin}: the header names no ${missing.join(', ')} column; every list states them`)
  const competitors = []
  const observations = []
  const seen = new Set()
  lines.slice(1).forEach((line, index) => {
    const lineNumber = index + 2
    const cells = line.split('\t').map((cell) => cell.trim())
    if (cells.length > header.length) throw new Error(`${origin} line ${lineNumber}: ${cells.length} cells under ${header.length} columns`)
    const row = Object.fromEntries(header.map((name, at) => [name, cells[at] || '']))
    const name = row.Company
    const where = `${origin} line ${lineNumber} (${name || 'no company'})`
    if (!name) throw new Error(`${where}: Company is empty`)
    const id = slugify(name)
    if (seen.has(id)) throw new Error(`${where}: ${name} is listed twice`)
    seen.add(id)
    const snapshot = snapshotMonth(row['Snapshot Time'])
    if (!snapshot) throw new Error(`${where}: Snapshot Time ${JSON.stringify(row['Snapshot Time'])} is not a month such as "Apr 2026" or "2026-04"`)
    const source = row.Source
    if (!source) throw new Error(`${where}: Source is empty; every figure names where it was read`)
    let founded = null
    if (row.Founded) {
      if (!/^\d{4}$/u.test(row.Founded)) throw new Error(`${where}: Founded ${JSON.stringify(row.Founded)} is not a year`)
      founded = Number(row.Founded)
    }
    competitors.push({
      id,
      name,
      description: row.Description || null,
      productCategory: row.Description ? slugify(row.Description) : null,
      location: row.Location || null,
      founded,
    })
    for (const [column, figure] of Object.entries(FIGURES)) {
      const raw = row[column]
      if (!raw) continue
      const read = figure.read(raw)
      if (!read) throw new Error(`${where}: ${column} ${JSON.stringify(raw)} is not ${figure.read === answer ? 'Yes or No' : 'a figure such as $1,800,000 or 1.8M'}`)
      observations.push({
        observationId: `list:${stableHash({ id, key: figure.key, month: snapshot.month, value: read.value, bound: read.bound, source })}`,
        competitor: id,
        signalType: figure.signalType,
        sourceType: COMPETITOR_SOURCE_TYPES.PUBLISHED_LIST,
        observedAt: snapshot.observedAt,
        url: isUrl(source) ? source : null,
        evidenceUrl: isUrl(source) ? source : null,
        metric: { key: figure.key, value: read.value, unit: figure.unit, period: figure.period || null, currency: figure.unit.startsWith('USD') ? 'USD' : null, rawValue: raw },
        attributes: { snapshot: snapshot.month, source, ...(read.bound ? { bound: read.bound } : {}), ...(row.Rank ? { rank: row.Rank } : {}) },
        capturedBy: 'competitors observation import',
      })
    }
  })
  return { competitors, observations }
}
