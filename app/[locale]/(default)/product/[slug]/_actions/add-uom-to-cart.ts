'use server';

import { BigCommerceGQLError, removeEdgesAndNodes } from '@bigcommerce/catalyst-client';

import { getSessionCustomerAccessToken } from '~/auth';
import { addToOrCreateCart } from '~/lib/cart';
import { MissingCartError } from '~/lib/cart/error';
import { calculateUom, formatAmount, parseUomConfig } from '~/lib/uom';

import { getProduct } from '../page-data';

export interface AddUomToCartState {
  status: 'idle' | 'success' | 'error';
  message?: string;
}

// Adds a UOM product to the cart. The amount is re-validated and converted to cart quantity on
// the server from the product's custom fields, so the client can't dictate quantity.
export const addUomToCart = async (
  _prevState: AddUomToCartState,
  payload: FormData,
): Promise<AddUomToCartState> => {
  const productEntityId = Number(payload.get('productId'));
  const amount = Number(payload.get('amount'));
  const unitValue = payload.get('unit');
  const unit = typeof unitValue === 'string' ? unitValue : '';

  if (!Number.isInteger(productEntityId)) {
    return { status: 'error', message: 'Invalid product.' };
  }

  const customerAccessToken = await getSessionCustomerAccessToken();
  const { product } = await getProduct(productEntityId, customerAccessToken);

  const config = product ? parseUomConfig(removeEdgesAndNodes(product.customFields)) : null;

  if (!config) {
    return { status: 'error', message: 'This product cannot be sold by unit of measure.' };
  }

  const result = calculateUom(amount, unit, config);

  if (!result) {
    return { status: 'error', message: 'Enter an amount greater than zero.' };
  }

  try {
    await addToOrCreateCart({
      lineItems: [{ productEntityId, quantity: result.cartQuantity }],
    });

    return {
      status: 'success',
      message:
        result.boxes !== undefined
          ? `${result.boxes} ${result.boxes === 1 ? 'box' : 'boxes'} (${formatAmount(result.billed)} ${config.unit}) added to your cart.`
          : `${formatAmount(result.billed)} ${config.unit} added to your cart.`,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error);

    if (error instanceof BigCommerceGQLError) {
      return { status: 'error', message: error.errors.map(({ message }) => message).join(' ') };
    }

    if (error instanceof MissingCartError) {
      return { status: 'error', message: 'Your cart could not be found. Please try again.' };
    }

    return { status: 'error', message: 'Something went wrong. Please try again.' };
  }
};
