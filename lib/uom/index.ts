/**
 * Unit-of-measure (UOM) pricing helpers.
 *
 * BigCommerce carts only accept whole-number quantities, so a UOM product is modelled as follows:
 *
 *  - The product's BigCommerce price is the price of ONE STEP (the smallest sellable increment,
 *    e.g. 0.01 sqm or 0.001 kg). The cart quantity is the number of steps.
 *  - The shopper sees (and types) amounts in the display unit, and sees the price per unit
 *    (`price / step`). The conversion to steps happens behind the scenes.
 *
 * Behaviour is driven by product custom fields. Fields in `UOM_SETTING_FIELDS` are settings and are
 * never shown on the PDP; other fields (e.g. "Box Size", "Conversion Factor") are informational and
 * stay visible.
 */

export const UOM_FLAG_FIELD = 'UOM';

export const UOM_SETTING_FIELDS = [
  'UOM',
  'UOM Unit',
  'UOM Alt Unit',
  'UOM Step',
  'UOM Rounding',
] as const;

const BOX_SIZE_FIELD = 'Box Size';
const CONVERSION_FACTOR_FIELD = 'Conversion Factor';

// Tolerance for floating point noise when rounding up (e.g. 1.44 / 0.72 = 2.0000000000000004).
const EPSILON = 1e-9;

interface CustomField {
  name: string;
  value: string;
}

export interface UomConfig {
  /** Display unit the price is quoted in, e.g. "sqm", "L", "kg". */
  unit: string;
  /** Optional second unit the shopper may type in, e.g. "sqft". */
  altUnit?: string;
  /** How many alt units fit in one display unit, e.g. 10.7639 sqft per sqm. */
  altFactor?: number;
  /** Smallest sellable increment in display units. One cart quantity = one step. */
  step: number;
  /** `exact` adds the exact amount; `box` rounds up to whole boxes. */
  rounding: 'exact' | 'box';
  /** Size of a box in display units. Required when rounding is `box`. */
  boxSize?: number;
}

export interface UomCalculation {
  /** What the shopper asked for, in display units. */
  requested: number;
  /** What will actually be bought, in display units (rounded to step or box). */
  billed: number;
  /** Whole boxes, when selling by box. */
  boxes?: number;
  /** Quantity to put in the BigCommerce cart (number of steps). */
  cartQuantity: number;
}

const findField = (fields: CustomField[], name: string) =>
  fields.find((field) => field.name.trim().toLowerCase() === name.toLowerCase())?.value.trim();

const toPositiveNumber = (value: string | undefined) => {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export function isUomSettingField(name: string) {
  return UOM_SETTING_FIELDS.some((setting) => setting.toLowerCase() === name.trim().toLowerCase());
}

// Reads the UOM configuration from a product's custom fields.
// Returns `null` when the product is not a UOM product or is misconfigured.
export function parseUomConfig(fields: CustomField[]): UomConfig | null {
  if (findField(fields, UOM_FLAG_FIELD)?.toLowerCase() !== 'yes') {
    return null;
  }

  const unit = findField(fields, 'UOM Unit');
  const step = toPositiveNumber(findField(fields, 'UOM Step'));

  if (!unit || !step) {
    return null;
  }

  const rounding = findField(fields, 'UOM Rounding')?.toLowerCase() === 'box' ? 'box' : 'exact';
  const boxSize = toPositiveNumber(findField(fields, BOX_SIZE_FIELD));

  if (rounding === 'box' && !boxSize) {
    return null;
  }

  const altUnit = findField(fields, 'UOM Alt Unit');
  const altFactor = toPositiveNumber(findField(fields, CONVERSION_FACTOR_FIELD));

  return {
    unit,
    step,
    rounding,
    ...(rounding === 'box' && boxSize ? { boxSize } : {}),
    ...(altUnit && altFactor ? { altUnit, altFactor } : {}),
  };
}

// Converts an amount typed in `inputUnit` to the display unit.
export function toDisplayUnit(amount: number, inputUnit: string, config: UomConfig) {
  if (config.altUnit && config.altFactor && inputUnit === config.altUnit) {
    return amount / config.altFactor;
  }

  return amount;
}

// Converts an amount in the display unit to `outputUnit`.
export function fromDisplayUnit(amount: number, outputUnit: string, config: UomConfig) {
  if (config.altUnit && config.altFactor && outputUnit === config.altUnit) {
    return amount * config.altFactor;
  }

  return amount;
}

const ceilTo = (value: number, increment: number) =>
  Math.ceil(value / increment - EPSILON) * increment;

// Works out how much will be bought and what cart quantity represents it.
// Returns `null` for non-positive or non-finite input.
export function calculateUom(
  amount: number,
  inputUnit: string,
  config: UomConfig,
): UomCalculation | null {
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const requested = toDisplayUnit(amount, inputUnit, config);

  if (config.rounding === 'box' && config.boxSize) {
    const boxes = Math.max(1, Math.ceil(requested / config.boxSize - EPSILON));
    const boxedAmount = boxes * config.boxSize;

    return {
      requested,
      billed: boxedAmount,
      boxes,
      cartQuantity: Math.round(boxedAmount / config.step),
    };
  }

  const billed = Math.max(config.step, ceilTo(requested, config.step));

  return { requested, billed, cartQuantity: Math.round(billed / config.step) };
}

// Price per display unit, given the BigCommerce price (which is the price of one step).
export function unitPrice(pricePerStep: number, config: UomConfig) {
  return pricePerStep / config.step;
}

// Formats an amount for display, trimming float noise and trailing zeros.
export function formatAmount(value: number, maximumFractionDigits = 4) {
  return Number(value.toFixed(maximumFractionDigits)).toLocaleString('en-US', {
    maximumFractionDigits,
  });
}

interface Money {
  inc: string;
  ex: string;
}

type PriceLike =
  | string
  | { type: 'plain'; money: Money; mode?: 'INC' | 'EX' | 'BOTH' }
  | { type: 'range'; min: Money; max: Money; mode?: 'INC' | 'EX' | 'BOTH' }
  | { type: 'sale'; previous: Money; current: Money; mode?: 'INC' | 'EX' | 'BOTH' };

const suffixMoney = (money: Money, suffix: string): Money => ({
  inc: `${money.inc}${suffix}`,
  ex: `${money.ex}${suffix}`,
});

// Appends " / unit" to a formatted price (to the current price of a sale, the top of a range).
export function suffixPrice(price: PriceLike, unit: string): PriceLike {
  const suffix = ` / ${unit}`;

  if (typeof price === 'string') {
    return `${price}${suffix}`;
  }

  switch (price.type) {
    case 'plain':
      return { ...price, money: suffixMoney(price.money, suffix) };

    case 'range':
      return { ...price, max: suffixMoney(price.max, suffix) };

    default:
      return { ...price, current: suffixMoney(price.current, suffix) };
  }
}

// Multiplies every numeric `value` in a pricing block (price, sale price, range, ...) by `factor`.
export function scalePricing<T>(pricing: T, factor: number): T {
  if (Array.isArray(pricing)) {
    // Recursive helper over plain JSON: the shape is preserved, only numbers change.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return pricing.map((item: unknown) => scalePricing(item, factor)) as T;
  }

  if (pricing && typeof pricing === 'object') {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return Object.fromEntries(
      Object.entries(pricing).map(([key, value]) => [
        key,
        key === 'value' && typeof value === 'number' ? value * factor : scalePricing(value, factor),
      ]),
    ) as T;
  }

  return pricing;
}
