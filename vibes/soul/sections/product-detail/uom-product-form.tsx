'use client';

import { useActionState, useMemo, useState } from 'react';

import { Button } from '@/vibes/soul/primitives/button';
import { calculateUom, formatAmount, fromDisplayUnit, unitPrice, type UomConfig } from '~/lib/uom';

export interface UomFormState {
  status: 'idle' | 'success' | 'error';
  message?: string;
}

export interface UomProductFormProps {
  productId: number;
  config: UomConfig;
  /** BigCommerce price of ONE step, in `currencyCode`. */
  pricePerStep: number;
  currencyCode: string;
  action: (state: UomFormState, payload: FormData) => Promise<UomFormState>;
  ctaLabel?: string;
  ctaDisabled?: boolean;
  amountLabel?: string;
  unitLabel?: string;
}

// Amount-based add-to-cart form for products sold by unit of measure. The price is shown per
// display unit (e.g. per sqm); the conversion to whole-number cart quantity happens in
// `calculateUom` and is re-checked on the server.
export function UomProductForm({
  productId,
  config,
  pricePerStep,
  currencyCode,
  action,
  ctaLabel = 'Add to cart',
  ctaDisabled = false,
  amountLabel = 'Amount needed',
  unitLabel = 'Unit',
}: UomProductFormProps) {
  const [state, formAction, pending] = useActionState(action, { status: 'idle' });
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState(config.unit);

  const units = config.altUnit ? [config.unit, config.altUnit] : [config.unit];
  const money = (value: number) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(value);

  const calculation = useMemo(
    () => (amount === '' ? null : calculateUom(Number(amount), unit, config)),
    [amount, unit, config],
  );

  const step = unit === config.unit ? config.step : config.step * (config.altFactor ?? 1);
  const total = calculation ? calculation.cartQuantity * pricePerStep : 0;
  const rounded = calculation ? calculation.billed !== calculation.requested : false;

  return (
    <form action={formAction} className="flex flex-col gap-5 py-6">
      <input name="productId" type="hidden" value={productId} />
      <input name="unit" type="hidden" value={unit} />

      <p className="text-sm text-[var(--product-detail-secondary-text,hsl(var(--contrast-500)))]">
        Price per {config.unit}:{' '}
        <strong className="text-[var(--product-detail-primary-text,hsl(var(--foreground)))]">
          {money(unitPrice(pricePerStep, config))}
        </strong>
        {config.rounding === 'box' && config.boxSize
          ? ` · sold in boxes of ${formatAmount(config.boxSize)} ${config.unit}`
          : ''}
      </p>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium">
          {amountLabel}
          <input
            className="h-12 rounded-lg border border-[hsl(var(--contrast-200))] bg-transparent px-4 text-base font-normal focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
            inputMode="decimal"
            min={0}
            name="amount"
            onChange={(e) => setAmount(e.currentTarget.value)}
            placeholder="0"
            required
            step={step}
            type="number"
            value={amount}
          />
        </label>
        {units.length > 1 && (
          <label className="flex w-28 flex-col gap-1.5 text-sm font-medium">
            {unitLabel}
            <select
              className="h-12 rounded-lg border border-[hsl(var(--contrast-200))] bg-transparent px-3 text-base font-normal"
              onChange={(e) => setUnit(e.currentTarget.value)}
              value={unit}
            >
              {units.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {calculation && (
        <div
          aria-live="polite"
          className="rounded-lg bg-[hsl(var(--contrast-100))] p-4 text-sm leading-relaxed"
        >
          {calculation.boxes !== undefined && (
            <p>
              <strong>
                {calculation.boxes} {calculation.boxes === 1 ? 'box' : 'boxes'}
              </strong>{' '}
              to cover at least {formatAmount(Number(amount))} {unit}
            </p>
          )}
          <p>
            You will receive {formatAmount(calculation.billed)} {config.unit}
            {config.altUnit && config.altFactor
              ? ` (${formatAmount(fromDisplayUnit(calculation.billed, config.altUnit, config))} ${config.altUnit})`
              : ''}
            {rounded && calculation.boxes === undefined ? ' (rounded up to the nearest step)' : ''}
          </p>
          <p className="mt-1 text-base font-medium">Total: {money(total)}</p>
        </div>
      )}

      <Button
        disabled={ctaDisabled || !calculation}
        loading={pending}
        shape="pill"
        size="large"
        type="submit"
      >
        {ctaLabel}
      </Button>

      {state.status !== 'idle' && Boolean(state.message) && (
        <p
          className={
            state.status === 'error'
              ? 'text-sm text-[hsl(var(--error))]'
              : 'text-sm text-[hsl(var(--success))]'
          }
          role="status"
        >
          {state.message}
        </p>
      )}
    </form>
  );
}
