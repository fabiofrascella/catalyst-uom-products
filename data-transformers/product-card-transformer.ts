import { removeEdgesAndNodes } from '@bigcommerce/catalyst-client';
import { ResultOf } from 'gql.tada';
import { getFormatter } from 'next-intl/server';

import { Product } from '@/vibes/soul/primitives/product-card';
import { ExistingResultType } from '~/client/util';
import { ProductCardFragment } from '~/components/product-card/fragment';
import { WishlistItemProductFragment } from '~/components/wishlist/fragment';
import { parseUomConfig, scalePricing, suffixPrice } from '~/lib/uom';

import { pricesTransformer, TaxDisplay } from './prices-transformer';

const getInventoryMessage = (
  product: ResultOf<typeof ProductCardFragment>,
  outOfStockMessage?: string,
  showBackorderMessage?: boolean,
) => {
  if (!product.inventory.isInStock) {
    return outOfStockMessage;
  }

  if (!showBackorderMessage || product.inventory.hasVariantInventory) {
    return undefined;
  }

  const { availableForBackorder, unlimitedBackorder, availableOnHand } =
    product.inventory.aggregated ?? {};

  if (availableOnHand) {
    return undefined;
  }

  const hasBackorderAvailablity = !!availableForBackorder || unlimitedBackorder;

  if (!hasBackorderAvailablity) {
    return undefined;
  }

  const baseVariant = removeEdgesAndNodes(product.variants).at(0);

  if (!baseVariant?.inventory?.byLocation) {
    return undefined;
  }

  const inventoryByLocation = removeEdgesAndNodes(baseVariant.inventory.byLocation).at(0);

  return inventoryByLocation?.backorderMessage ?? undefined;
};

// Products sold by unit of measure (custom field UOM = Yes) are priced per display unit
// (e.g. per sqm) rather than per cart step, which is what BigCommerce stores as the price.
const getPrice = (
  product: ResultOf<typeof ProductCardFragment | typeof WishlistItemProductFragment>,
  format: ExistingResultType<typeof getFormatter>,
  taxDisplay?: TaxDisplay | null,
) => {
  const config =
    'customFields' in product ? parseUomConfig(removeEdgesAndNodes(product.customFields)) : null;

  if (!config) {
    return pricesTransformer(product, format, taxDisplay);
  }

  const factor = 1 / config.step;
  const price = pricesTransformer(
    {
      ...product,
      pricesIncludingTax: scalePricing(product.pricesIncludingTax, factor),
      pricesExcludingTax: scalePricing(product.pricesExcludingTax, factor),
    },
    format,
    taxDisplay,
  );

  return price && suffixPrice(price, config.unit);
};

export const singleProductCardTransformer = (
  product: ResultOf<typeof ProductCardFragment | typeof WishlistItemProductFragment>,
  format: ExistingResultType<typeof getFormatter>,
  outOfStockMessage?: string,
  showBackorderMessage?: boolean,
  taxDisplay?: TaxDisplay | null,
): Product => {
  return {
    id: product.entityId.toString(),
    title: product.name,
    href: product.path,
    image: product.defaultImage
      ? { src: product.defaultImage.url, alt: product.defaultImage.altText }
      : undefined,
    price: getPrice(product, format, taxDisplay),
    subtitle: product.brand?.name ?? undefined,
    rating: product.reviewSummary.averageRating,
    numberOfReviews: product.reviewSummary.numberOfReviews,
    inventoryMessage:
      'variants' in product
        ? getInventoryMessage(product, outOfStockMessage, showBackorderMessage)
        : undefined,
    promotions:
      'featuredPromotions' in product
        ? removeEdgesAndNodes(product.featuredPromotions).map((p) => ({
            id: p.entityId.toString(),
            text: p.text,
          }))
        : undefined,
  };
};

export const productCardTransformer = (
  products: Array<ResultOf<typeof ProductCardFragment | typeof WishlistItemProductFragment>>,
  format: ExistingResultType<typeof getFormatter>,
  outOfStockMessage?: string,
  showBackorderMessage?: boolean,
  taxDisplay?: TaxDisplay | null,
): Product[] => {
  return products.map((product) =>
    singleProductCardTransformer(
      product,
      format,
      outOfStockMessage,
      showBackorderMessage,
      taxDisplay,
    ),
  );
};
