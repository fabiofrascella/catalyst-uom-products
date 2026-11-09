import { removeEdgesAndNodes } from '@bigcommerce/catalyst-client';
import { notFound } from 'next/navigation';

import { Accordion, AccordionItem } from '@/vibes/soul/primitives/accordion';
import { ProductGallery } from '@/vibes/soul/sections/product-detail/product-gallery';
import { UomProductForm } from '@/vibes/soul/sections/product-detail/uom-product-form';
import { rewriteWysiwygContentUrls } from '~/data-transformers/html-content-transformer';
import { getPreferredCurrencyCode } from '~/lib/currency';
import { isUomSettingField, type UomConfig } from '~/lib/uom';

import { addUomToCart } from '../_actions/add-uom-to-cart';
import {
  getProductPricingAndRelatedProducts,
  getStreamableProduct,
  getStreamableProductInventory,
} from '../page-data';

interface Props {
  productId: number;
  config: UomConfig;
  name: string;
  brandName?: string;
  description: string;
  taxDisplay?: 'INC' | 'EX' | 'BOTH' | null;
  customerAccessToken?: string;
}

// PDP template for products sold by unit of measure (custom field UOM = Yes). Separate from the
// default Catalyst PDP so the default stays untouched and easy to upgrade.
export async function UomProductDetail({
  productId,
  config,
  name,
  brandName,
  description,
  taxDisplay,
  customerAccessToken,
}: Props) {
  const currencyCode = await getPreferredCurrencyCode();
  const variables = { entityId: productId, optionValueIds: [], useDefaultOptionSelections: true };

  const pricingVariables = { ...variables, currencyCode };

  const [product, inventory, pricing] = await Promise.all([
    getStreamableProduct(variables, customerAccessToken),
    getStreamableProductInventory(variables, customerAccessToken),
    getProductPricingAndRelatedProducts(pricingVariables, customerAccessToken),
  ]);

  if (!product || !pricing) {
    return notFound();
  }

  const prices = taxDisplay === 'INC' ? pricing.pricesIncludingTax : pricing.pricesExcludingTax;
  const price = prices?.price;

  const images = removeEdgesAndNodes(product.images).map((image) => ({
    src: image.url,
    alt: image.altText,
  }));

  const galleryImages = product.defaultImage
    ? [
        { src: product.defaultImage.url, alt: product.defaultImage.altText },
        ...images.filter((image) => image.src !== product.defaultImage?.url),
      ]
    : images;

  // Settings are hidden; informational fields (box size, conversion factor, ...) stay visible.
  const specifications = [
    { name: 'SKU', value: product.sku },
    ...removeEdgesAndNodes(product.customFields)
      .filter((field) => !isUomSettingField(field.name))
      .map((field) => ({ name: field.name, value: field.value })),
  ];

  const unavailable =
    inventory?.availabilityV2.status === 'Unavailable' || inventory?.inventory.isInStock === false;

  return (
    <section className="@container">
      <div className="mx-auto w-full max-w-screen-2xl px-4 py-10 @xl:px-6 @xl:py-14 @4xl:px-8 @4xl:py-20">
        <div className="grid grid-cols-1 items-start gap-x-8 gap-y-8 @2xl:grid-cols-2 @5xl:gap-x-12">
          <ProductGallery images={galleryImages} productId={productId} />
          <div>
            {brandName ? <p className="font-mono text-sm uppercase">{brandName}</p> : null}
            <h1 className="mb-3 mt-2 font-[family-name:var(--product-detail-title-font-family,var(--font-family-heading))] text-2xl font-medium leading-none @xl:text-3xl @4xl:text-4xl">
              {name}
            </h1>

            {price ? (
              <UomProductForm
                action={addUomToCart}
                config={config}
                ctaDisabled={unavailable}
                ctaLabel={unavailable ? 'Out of stock' : 'Add to cart'}
                currencyCode={price.currencyCode}
                pricePerStep={price.value}
                productId={productId}
              />
            ) : null}

            <div
              className="prose prose-sm max-w-none border-t border-[hsl(var(--contrast-100))] py-8"
              dangerouslySetInnerHTML={{ __html: rewriteWysiwygContentUrls(description) }}
            />

            <Accordion className="border-t border-[hsl(var(--contrast-100))] pt-4" type="multiple">
              <AccordionItem title="Specifications" value="specifications">
                <dl className="flex flex-col gap-4">
                  {specifications.map((field) => (
                    <div className="grid grid-cols-1 gap-2 @lg:grid-cols-2" key={field.name}>
                      <dt>
                        <strong>{field.name}</strong>
                      </dt>
                      <dd>{field.value}</dd>
                    </div>
                  ))}
                </dl>
              </AccordionItem>
            </Accordion>
          </div>
        </div>
      </div>
    </section>
  );
}
