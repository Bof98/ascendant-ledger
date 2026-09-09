import { toAnalyticDecimal, toFloatOrNull, toIntOrNull, type AnalyticDecimal } from '../domain/money.js';

/**
 * Account History `Details` JSON parsing.
 *
 * The six shapes observed in the reference export:
 *
 *   production   version, price, quality, amount, building_name
 *   sales        version, building, quality, price, unit_cogs, remaining, building_name
 *   market (buy) version, amount, price, sellers
 *   market (fill) version, resource, amount, quality, price, buyer, profit
 *   construction version, building, level, building_name
 *   game / fees  {} (empty)
 *
 * The parser is shape-driven, not category-driven: it reads whatever keys are
 * present. Category is used only to decide what the ambiguous fields MEAN.
 *
 * Two rules from spec section 7 are load-bearing here and are enforced by
 * `priceMeaning` and `quantityBasis` below:
 *
 *   `price` does not mean the same thing across categories. On a market row it
 *   is a true unit price and `amount * price == Money` exactly (verified 12/12).
 *   On a production row it values the OUTPUT and bears no relation to the cash
 *   spent (Water: Money -8,377 vs amount*price 10,190.55). On a retail sales row
 *   it is the shelf list price.
 *
 *   Retail sales quantity is NOT derivable. `Money / price` yields 97.12, 48.48,
 *   0.92 on the reference rows. Nothing here ever invents it.
 *
 * An unrecognised key never fails an import. It is recorded in `unknownKeys` and
 * the original JSON text is retained verbatim regardless.
 */

export type PriceMeaning =
  | 'market_unit_price' // exact; amount * price reconciles to Money
  | 'retail_list_price' // shelf price; does NOT reconcile to Money
  | 'production_output_valuation' // values produced goods, unrelated to cash spent
  | 'unknown';

export type QuantityBasis =
  | 'market_exact' // from `amount` on a market row, reconciles to Money
  | 'production_output' // units produced, from `amount`
  | 'unknown';

/** Keys this build understands. Anything else lands in `unknownKeys`. */
const KNOWN_KEYS = new Set([
  'version',
  'price',
  'quality',
  'amount',
  'building',
  'building_name',
  'unit_cogs',
  'remaining',
  'sellers',
  'resource',
  'buyer',
  'profit',
  'level',
]);

export interface ParsedDetails {
  /** False when JSON.parse failed. The raw text is still preserved by the caller. */
  ok: boolean;
  error: string | null;
  /** Re-serialised normalised object. Null when parsing failed. */
  json: string | null;
  /** The game's own schema version field. */
  version: number | null;

  amount: number | null;
  quantityBasis: QuantityBasis | null;

  price: AnalyticDecimal | null;
  priceMeaning: PriceMeaning | null;
  unitCogs: AnalyticDecimal | null;

  quality: number | null;
  remaining: number | null;
  profit: number | null;
  level: number | null;

  buildingCode: string | null;
  buildingName: string | null;

  resourceId: number | null;
  counterpartyName: string | null;
  counterpartyRole: 'seller' | 'buyer' | null;

  /** Keys present in the object that this build does not recognise. */
  unknownKeys: string[];
}

function emptyDetails(overrides: Partial<ParsedDetails> = {}): ParsedDetails {
  return {
    ok: true,
    error: null,
    json: '{}',
    version: null,
    amount: null,
    quantityBasis: null,
    price: null,
    priceMeaning: null,
    unitCogs: null,
    quality: null,
    remaining: null,
    profit: null,
    level: null,
    buildingCode: null,
    buildingName: null,
    resourceId: null,
    counterpartyName: null,
    counterpartyRole: null,
    unknownKeys: [],
    ...overrides,
  };
}

/**
 * Decides what `price` and `amount` mean for a given row.
 *
 * `money` disambiguates the two market shapes: a purchase is negative and names
 * `sellers`, an order fill is positive and names `buyer`.
 */
function classify(
  category: string,
  object: Record<string, unknown>,
): { price: PriceMeaning; quantity: QuantityBasis } {
  const normalised = category.trim().toLowerCase();

  switch (normalised) {
    case 'market':
      // Verified: amount * price == Money on every market row in the reference
      // export, for both purchases and order fills.
      return { price: 'market_unit_price', quantity: 'market_exact' };

    case 'sales':
      // Retail. `price` is the listed shelf price and does not reconcile to the
      // cash received; there is no quantity field at all.
      return { price: 'retail_list_price', quantity: 'unknown' };

    case 'production':
      // `amount` is genuine output quantity, but `price` values that output and
      // is unrelated to the production cash cost in `Money`.
      return { price: 'production_output_valuation', quantity: 'production_output' };

    default:
      // construction, fees, game, and any category the game adds later.
      return {
        price: 'price' in object ? 'unknown' : 'unknown',
        quantity: 'amount' in object ? 'unknown' : 'unknown',
      };
  }
}

export function parseDetails(rawDetails: string, category: string): ParsedDetails {
  const trimmed = (rawDetails ?? '').trim();

  // A blank cell and an explicit `{}` are both legitimate and common.
  if (trimmed === '' || trimmed === '{}') {
    return emptyDetails({ json: trimmed === '' ? null : '{}' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return emptyDetails({
      ok: false,
      json: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyDetails({
      ok: false,
      json: null,
      error: `Details was ${Array.isArray(parsed) ? 'an array' : typeof parsed}, expected an object.`,
    });
  }

  const object = parsed as Record<string, unknown>;
  const meaning = classify(category, object);
  const unknownKeys = Object.keys(object).filter((k) => !KNOWN_KEYS.has(k));

  const amount = toIntOrNull(object['amount']);
  const price = toAnalyticDecimal(object['price']);

  // `sellers` (purchases) and `buyer` (order fills) are the same concept from
  // opposite sides. Collapsed into one column plus a role, so supplier and buyer
  // breakdowns share a query path.
  let counterpartyName: string | null = null;
  let counterpartyRole: 'seller' | 'buyer' | null = null;
  if (typeof object['sellers'] === 'string' && object['sellers'].trim() !== '') {
    counterpartyName = object['sellers'].trim();
    counterpartyRole = 'seller';
  } else if (typeof object['buyer'] === 'string' && object['buyer'].trim() !== '') {
    counterpartyName = object['buyer'].trim();
    counterpartyRole = 'buyer';
  }

  const buildingCode =
    typeof object['building'] === 'string' && object['building'].trim() !== ''
      ? object['building'].trim()
      : null;
  const buildingName =
    typeof object['building_name'] === 'string' && object['building_name'].trim() !== ''
      ? object['building_name'].trim()
      : null;

  return {
    ok: true,
    error: null,
    json: JSON.stringify(object),
    version: toIntOrNull(object['version']),

    amount,
    quantityBasis: amount === null ? null : meaning.quantity,

    price,
    priceMeaning: price === null ? null : meaning.price,
    unitCogs: toAnalyticDecimal(object['unit_cogs']),

    quality: toFloatOrNull(object['quality']),
    remaining: toIntOrNull(object['remaining']),
    profit: toIntOrNull(object['profit']),
    level: toIntOrNull(object['level']),

    buildingCode,
    buildingName,

    resourceId: toIntOrNull(object['resource']),
    counterpartyName,
    counterpartyRole,

    unknownKeys,
  };
}

/**
 * Product name extraction from the Description column.
 *
 * Every product-bearing description in the reference export follows one of a
 * small set of templates. Matching a template is reliable; guessing beyond one
 * is not, so anything unmatched returns null and the UI shows no product rather
 * than a wrong one.
 */
const DESCRIPTION_PATTERNS: Array<{ pattern: RegExp; group: number }> = [
  { pattern: /^Production of (.+)$/i, group: 1 },
  { pattern: /^Sales of (.+)$/i, group: 1 },
  { pattern: /^Bought (.+?) on market$/i, group: 1 },
  { pattern: /^(.+?) market order filled$/i, group: 1 },
  { pattern: /^Market fees selling (.+)$/i, group: 1 },
];

export function extractProductName(description: string): string | null {
  const trimmed = (description ?? '').trim();
  if (trimmed === '') return null;

  for (const { pattern, group } of DESCRIPTION_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match?.[group]) {
      return match[group]!.trim();
    }
  }
  return null;
}

/**
 * Synthetic catalog key for a building.
 *
 * Some rows carry a code, some only a name ('Farm' in the reference export), so
 * identity has to tolerate either. The raw code and raw name are stored
 * separately regardless, per the auditing requirement.
 */
export function buildingCatalogKey(
  code: string | null,
  name: string | null,
): string | null {
  if (code) return `code:${code}`;
  if (name) return `name:${name}`;
  return null;
}
