import { describe, expect, test } from 'vitest';

import {
  calculateUom,
  isUomSettingField,
  parseUomConfig,
  scalePricing,
  suffixPrice,
  unitPrice,
} from './index';

const fields = (entries: Record<string, string>) =>
  Object.entries(entries).map(([name, value]) => ({ name, value }));

const tile = parseUomConfig(
  fields({
    UOM: 'Yes',
    'UOM Unit': 'sqm',
    'UOM Alt Unit': 'sqft',
    'UOM Step': '0.01',
    'UOM Rounding': 'box',
    'Box Size': '1.44',
    'Conversion Factor': '10.7639',
  }),
);

const powder = parseUomConfig(
  fields({ UOM: 'Yes', 'UOM Unit': 'kg', 'UOM Step': '0.001', 'UOM Rounding': 'exact' }),
);

describe('parseUomConfig', () => {
  test('returns null unless UOM is Yes', () => {
    expect(parseUomConfig(fields({ UOM: 'No', 'UOM Unit': 'kg', 'UOM Step': '1' }))).toBeNull();
    expect(parseUomConfig([])).toBeNull();
  });

  test('returns null when misconfigured', () => {
    expect(parseUomConfig(fields({ UOM: 'Yes', 'UOM Unit': 'kg' }))).toBeNull();
    expect(
      parseUomConfig(
        fields({ UOM: 'Yes', 'UOM Unit': 'sqm', 'UOM Step': '0.01', 'UOM Rounding': 'box' }),
      ),
    ).toBeNull();
  });

  test('parses a box config with alt unit', () => {
    expect(tile).toMatchObject({
      unit: 'sqm',
      altUnit: 'sqft',
      altFactor: 10.7639,
      step: 0.01,
      rounding: 'box',
      boxSize: 1.44,
    });
  });
});

describe('isUomSettingField', () => {
  test('hides settings but not informational fields', () => {
    expect(isUomSettingField('uom')).toBe(true);
    expect(isUomSettingField('UOM Step')).toBe(true);
    expect(isUomSettingField('Box Size')).toBe(false);
    expect(isUomSettingField('Conversion Factor')).toBe(false);
  });
});

describe('calculateUom', () => {
  test('exact weight adds the exact amount in steps', () => {
    expect(powder && calculateUom(2.5, 'kg', powder)).toMatchObject({
      billed: 2.5,
      cartQuantity: 2500,
    });
  });

  test('exact amounts round up to the next step', () => {
    expect(powder && calculateUom(0.0005, 'kg', powder)?.cartQuantity).toBe(1);
  });

  test('box products round up to whole boxes', () => {
    // 10 sqm / 1.44 = 6.94 -> 7 boxes = 10.08 sqm = 1008 steps
    expect(tile && calculateUom(10, 'sqm', tile)).toMatchObject({ boxes: 7, cartQuantity: 1008 });
  });

  test('an exact multiple of the box size does not add an extra box', () => {
    expect(tile && calculateUom(2.88, 'sqm', tile)?.boxes).toBe(2);
  });

  test('converts alt units before rounding', () => {
    // 100 sqft = 9.29 sqm -> 7 boxes
    expect(tile && calculateUom(100, 'sqft', tile)?.boxes).toBe(7);
  });

  test('rejects invalid amounts', () => {
    expect(powder && calculateUom(0, 'kg', powder)).toBeNull();
    expect(powder && calculateUom(Number.NaN, 'kg', powder)).toBeNull();
  });
});

describe('unitPrice', () => {
  test('scales the per-step price up to the display unit', () => {
    expect(tile && unitPrice(0.45, tile)).toBeCloseTo(45);
  });
});

describe('scalePricing', () => {
  test('scales every numeric value, including ranges, and leaves other fields', () => {
    const scaled = scalePricing(
      {
        price: { value: 0.45, currencyCode: 'GBP' },
        salePrice: null,
        priceRange: {
          min: { value: 0.4, currencyCode: 'GBP' },
          max: { value: 0.5, currencyCode: 'GBP' },
        },
      },
      100,
    );

    expect(scaled.price).toEqual({ value: 45, currencyCode: 'GBP' });
    expect(scaled.salePrice).toBeNull();
    expect(scaled.priceRange.max.value).toBeCloseTo(50);
  });
});

describe('suffixPrice', () => {
  const money = { inc: '£45.00', ex: '£37.50' };

  test('adds the unit to plain, sale and range prices', () => {
    expect(suffixPrice('£45.00', 'sqm')).toBe('£45.00 / sqm');
    expect(suffixPrice({ type: 'plain', money }, 'sqm')).toMatchObject({
      money: { inc: '£45.00 / sqm', ex: '£37.50 / sqm' },
    });
    expect(suffixPrice({ type: 'sale', previous: money, current: money }, 'kg')).toMatchObject({
      previous: money,
      current: { inc: '£45.00 / kg' },
    });
    expect(suffixPrice({ type: 'range', min: money, max: money }, 'L')).toMatchObject({
      min: money,
      max: { ex: '£37.50 / L' },
    });
  });
});
