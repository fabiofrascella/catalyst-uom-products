# UOM (unit of measure) products on Catalyst: developer cheat sheet

How to sell products by amount (sqm/sqft, L/gal, kg/lb, boxes) on a Catalyst storefront, using
product custom fields as the only configuration. Everything below is implemented in this repo; use
the file list as a map.

## 1. The core idea

BigCommerce cart quantities are **whole numbers** (`CartLineItemInput.quantity: Int!`), so you cannot
add 1.37 sqm directly. Instead:

- The BigCommerce **price is the price of one step**, the smallest sellable increment
  (e.g. `0.01` sqm). **Cart quantity = number of steps.**
- The storefront shows and accepts the **display unit** (sqm) and shows **price per unit**
  (`price / step`). The conversion happens in code, never in the shopper's head.
- Box products (tiles, rugs) round the requested amount **up to whole boxes**.

Example, tile at £45/sqm, step 0.01, box 1.44 sqm: BigCommerce price = £0.45. Shopper needs 10 sqm
-> 7 boxes = 10.08 sqm = **1008** in the cart, total £453.60.

Pick a step so the per-step price has **at most 2 decimals** (£45/sqm / 100 = £0.45). Prices that
need 3+ decimals round badly at checkout.

## 2. Product setup (custom fields)

A product uses the UOM template when custom field `UOM` = `Yes` **and** it is configured validly
(otherwise it silently falls back to the default PDP).

| Custom field | Required | Visible on PDP | Meaning |
|---|---|---|---|
| `UOM` | yes | no | `Yes` turns the feature on |
| `UOM Unit` | yes | no | Display unit the price is quoted in: `sqm`, `L`, `kg` |
| `UOM Step` | yes | no | Smallest increment in `UOM Unit` (e.g. `0.01`) |
| `UOM Rounding` | no | no | `exact` (default) or `box` |
| `UOM Alt Unit` | no | no | Second input unit, e.g. `sqft` |
| `Conversion Factor` | with alt unit | yes | Alt units per display unit (`10.7639` sqft per sqm) |
| `Box Size` | if `box` | yes | Display units per box (`1.44`) |

Rule: names in `UOM_SETTING_FIELDS` are settings and hidden; anything else (Box Size, Conversion
Factor, your own fields) shows in Specifications.

Also set on the product: price = price **per step**, weight = weight per step, inventory as needed.
Assign it to the channel(s) and category tree(s) like any product.

Four demo products exist in the store (IDs 1447-1450): liquid, powder, textile (exact) and tile (box).

## 3. Where the code is

| Layer | File | What it does |
|---|---|---|
| Logic | `lib/uom/index.ts` (+ `index.spec.ts`) | `parseUomConfig`, `calculateUom`, `unitPrice`, `scalePricing`, `suffixPrice`. Pure, unit-tested |
| PDP routing | `app/[locale]/(default)/product/[slug]/page.tsx` | If `parseUomConfig(customFields)` is non-null, render the UOM template and return early |
| PDP data | `.../product/[slug]/page-data.ts` | `customFields` added to `ProductQuery` |
| PDP template | `.../_components/uom-product-detail.tsx` | Server component: gallery, price per unit, form, specs (settings hidden) |
| PDP form | `vibes/soul/sections/product-detail/uom-product-form.tsx` | Client form: amount + unit, live "N boxes / amount / total" |
| Add to cart | `.../_actions/add-uom-to-cart.ts` | Server action: **re-reads custom fields and recomputes quantity server-side** |
| PLP cards | `components/product-card/fragment.ts`, `data-transformers/product-card-transformer.ts` | Fetch custom fields; scale price by `1/step`, append `/ unit` |
| Cart | `app/[locale]/(default)/cart/page.tsx`, `page-data.ts`, `vibes/soul/sections/cart/client.tsx` | Per-unit price, amount input, +/- by box or unit, line summary |
| Header | `components/header/index.tsx` | Cart badge counts a UOM line as 1 |
| Checkout | `scripts/checkout-uom-summary.js` | Script Manager script for the hosted checkout summary |

Keep the template separate from the default PDP (not an `if` inside it): the default PDP stays
untouched, so Catalyst upgrades merge cleanly.

## 4. Build steps (to replicate)

1. **Logic first.** Write `lib/uom` with tests. Parse fields case-insensitively; return `null` for
   misconfiguration. Round up with a small epsilon (`1.44 / 0.72` is `2.0000000000000004` in JS).
2. **Query custom fields** where you need them: product page, product card fragment, cart line item
   (`catalogProductWithOptionSelections { customFields(first: 50) ... }`), header cart count.
3. **PDP:** branch in `page.tsx`; build the template with a client form. The form is UX only.
4. **Add to cart server action:** accept `productId`, `amount`, `unit` only. Look the product up
   again, run `calculateUom`, send `quantity = cartQuantity`. Never trust a quantity from the client.
5. **PLP:** in the card transformer, if the product has a valid config, run `pricesTransformer` on
   a copy whose prices are multiplied by `1/step`, then append `/ unit`.
6. **Cart:** pass a serializable `uom` object on the line item. Show amount (`quantity * step`),
   step the +/- by one box (box) or one unit (exact), convert typed amounts with `calculateUom`.
   Count a UOM line as one item in totals.
7. **Checkout:** a Script Manager script (section 6).
8. **Gate:** `npx tsc --noEmit`, `npx vitest run`, `npx eslint` on touched files.

## 5. Gotchas we hit

- **Min/max purchase quantity** (BigCommerce product settings) are in steps, not display units.
- **Box size must be a multiple of the step**, or `billed / step` will not be a whole number.
- **A typo in a setting silently falls back to the default PDP**, which then shows every custom
  field, settings included. Check the page after editing fields.
- **Other card types** (wishlist, compare) don't load custom fields, so they still show the per-step
  price. Add `customFields` to their fragments to fix.
- **Analytics** events still report steps as quantity.

## 6. Checkout (hosted, Script Manager)

The hosted checkout can't be themed by Catalyst code, so a script rewrites the order summary:

- Reads `/api/storefront/cart` (same origin) for line items, matches summary lines by **name +
  quantity** (the summary DOM has no product id), looks up UOM settings from custom fields through
  the **Storefront GraphQL API**, and rewrites the line, the per-unit price and the item count.
- A `MutationObserver` re-applies it when the React checkout re-renders; every edit is idempotent.

Setup:

1. Create a Storefront GraphQL token: `POST /v3/storefront/api-token` with
   `{"channel_ids":[<channel>], "expires_at": <unix>, "allowed_cors_origins":["https://<checkout origin>"]}`.
   The origin must match the checkout page origin **exactly** (scheme + host, no trailing slash).
2. Copy `scripts/checkout-uom-summary.js` to `scripts/checkout-uom-summary.local.js` (git-ignored)
   and set `STOREFRONT_TOKEN`. The committed file keeps it empty.
3. Create the script: `POST /v3/content/scripts` with `kind: "script_tag"`, `location: "footer"`,
   `visibility: "checkout"`, `consent_category: "essential"`, `channel_id`, `html: "<script>...</script>"`.
   Update later with `PUT /v3/content/scripts/{uuid}`.

Security: the token ships to every shopper's browser by design. It is read-only catalog access
(plus anonymous storefront actions). The origin lock is not strong protection, because non-browser
clients can fake `Origin`. Use a dedicated, expiring token and never put the admin token near it.
Not covered: the order confirmation page.

## 7. Testing checklist

- [ ] `calculateUom`: exact amount, round up to step, box rounding, exact multiple of a box, alt unit
- [ ] PDP shows price per unit, hides settings, shows Box Size / Conversion Factor
- [ ] Add to cart with an alt unit (sqft) gives the same quantity as the equivalent sqm
- [ ] Tampering with the form amount can't change the quantity (server recomputes)
- [ ] PLP/search/related show `£x / unit`
- [ ] Cart: edit amount, +/- by box, summary and header count
- [ ] Checkout summary shows amounts and unit prices; non-UOM lines untouched
