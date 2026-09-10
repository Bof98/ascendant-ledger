import type { ReportType } from '../db/types.js';
import { normaliseHeader, type CsvDocument } from './csv.js';

/**
 * Report type detection from the header signature.
 *
 * Spec section 4 is explicit that filenames must not be trusted, so detection
 * reads the header row only. All four exports share a `Timestamp` column, so
 * each signature nominates DISCRIMINATORS — columns unique to that report —
 * alongside the full expected set.
 *
 * Scoring is deliberately tolerant. A future export that adds a column, renames
 * one, or drops an optional one should still be recognised; only a file that
 * matches nothing lands as `unknown`. That is what makes section 28's
 * "import the recognised data, keep the rest" behaviour possible.
 */

export interface ReportSignature {
  type: ReportType;
  label: string;
  /** Columns that must all be present. Absence disqualifies the signature. */
  required: string[];
  /** Columns unique to this report. Presence is strong positive evidence. */
  discriminators: string[];
  /** Full recognised column set, used for scoring and unknown-column detection. */
  known: string[];
}

const SIGNATURES: ReportSignature[] = [
  {
    type: 'account_history',
    label: 'Account History',
    required: ['id', 'timestamp', 'category', 'money'],
    discriminators: ['id', 'category', 'money', 'details'],
    known: ['id', 'timestamp', 'category', 'money', 'description', 'details'],
  },
  {
    type: 'income_statement',
    label: 'Income Statement',
    required: ['timestamp', 'sales', 'cogs', 'netincome'],
    discriminators: ['cogs', 'netincome', 'gross', 'exchange fees', 'freight out'],
    known: [
      'timestamp',
      'executive royalties', 'gain on sale',
      'sales',
      'cogs',
      'freight out',
      'construction',
      'exchange fees',
      'salaries',
      'training',
      'poaching',
      'achievements referrals pa',
      'patent conversion',
      'bond defaults',
      'bond writeoffs',
      'accounting overhead',
      'bond interest expense',
      'bond interest income',
      'donations',
      'other comprehensive income',
      'netincome',
    ],
  },
  {
    type: 'cashflow_statement',
    label: 'Cash Flow Statement',
    required: ['timestamp', 'all income', 'all expenses'],
    discriminators: ['all income', 'all expenses', 'from retail', 'to suppliers', 'game income'],
    known: [
      'timestamp',
      'from royalties', 'from employees', 'for pa quests', 'rounding adjustment',
      'all income',
      'all expenses',
      'from retail',
      'from customers',
      'from exchange',
      'from interest',
      'from poaching',
      'to suppliers',
      'to exchange',
      'to employees',
      'to executives',
      'for interest',
      'for fees',
      'for accounting',
      'investment in bonds',
      'bonds',
      'game income',
    ],
  },
  {
    type: 'balance_sheet',
    label: 'Balance Sheet',
    required: ['timestamp', 'cash', 'liabilities'],
    discriminators: [
      'accounts receivable',
      'liabilities',
      'contributed capital',
      'retained earnings',
      'inventory - materials',
    ],
    known: [
      'timestamp',
      'cash reserved for orders', 'construction in progress',
      'cash',
      'accounts receivable',
      'inventory - materials',
      'inventory - research',
      'inventory - work in process',
      'inventory - finished goods',
      'inventory - valuation allowance',
      'deposits',
      'investment in bonds',
      'buildings',
      'patents',
      'liabilities',
      'contributed capital',
      'retained earnings',
    ],
  },
];

export interface DetectionResult {
  type: ReportType | null;
  label: string;
  /** 0..1 confidence. */
  score: number;
  method: 'header_signature';
  /** Headers present in the file that this build does not recognise. */
  unknownHeaders: string[];
  /** Recognised headers this signature expected but did not find. */
  missingHeaders: string[];
  /** Every signature's score, for the "why was this detected as X" panel. */
  candidates: Array<{ type: ReportType; label: string; score: number }>;
}

export function getSignature(type: ReportType): ReportSignature {
  const found = SIGNATURES.find((s) => s.type === type);
  if (!found) throw new Error(`No signature registered for report type ${type}`);
  return found;
}

export function listSignatures(): readonly ReportSignature[] {
  return SIGNATURES;
}

/**
 * Scores one signature against a header set.
 *
 * Weighting: discriminators are worth double, because a shared column like
 * `Timestamp` carries almost no information while `Retained Earnings` is
 * decisive. Missing a required column zeroes the score outright.
 */
function scoreSignature(signature: ReportSignature, headers: Set<string>): number {
  for (const required of signature.required) {
    if (!headers.has(required)) return 0;
  }

  const knownHits = signature.known.filter((h) => headers.has(h)).length;
  const discriminatorHits = signature.discriminators.filter((h) => headers.has(h)).length;

  const knownWeight = signature.known.length;
  const discriminatorWeight = signature.discriminators.length * 2;
  const total = knownWeight + discriminatorWeight;

  return (knownHits + discriminatorHits * 2) / total;
}

/** Minimum score to accept a detection. Below this the file is `unknown`. */
export const DETECTION_THRESHOLD = 0.5;

export function detectReportType(input: CsvDocument | string[]): DetectionResult {
  const rawHeaders = Array.isArray(input) ? input : input.headers;
  const normalised = rawHeaders.map(normaliseHeader);
  const headerSet = new Set(normalised);

  const candidates = SIGNATURES.map((signature) => ({
    type: signature.type,
    label: signature.label,
    score: scoreSignature(signature, headerSet),
  })).sort((a, b) => b.score - a.score);

  const best = candidates[0]!;

  if (best.score < DETECTION_THRESHOLD) {
    return {
      type: null,
      label: 'Unrecognised',
      score: best.score,
      method: 'header_signature',
      unknownHeaders: rawHeaders,
      missingHeaders: [],
      candidates,
    };
  }

  const signature = getSignature(best.type);
  const knownSet = new Set(signature.known);

  // Index by normalised name but report the ORIGINAL spelling, so the Data
  // Quality page shows the user exactly what the file said.
  const unknownHeaders = rawHeaders.filter((_, i) => !knownSet.has(normalised[i]!));
  const missingHeaders = signature.known.filter((h) => !headerSet.has(h));

  return {
    type: best.type,
    label: signature.label,
    score: best.score,
    method: 'header_signature',
    unknownHeaders,
    missingHeaders,
    candidates,
  };
}
