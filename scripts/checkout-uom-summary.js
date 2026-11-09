/**
 * Checkout order summary: show unit-of-measure values instead of cart steps.
 *
 * Paste into BigCommerce Script Manager (Storefront > Script Manager > Create a script):
 *   Location: Footer   Pages: Checkout   Script type: Script   Category: Essential
 *
 * Why: UOM products are stored with price = price of one step (e.g. 0.01 sqm), so the hosted
 * checkout would show "1008 x Tile" and "Total 1,295 items". This rewrites the right-hand order
 * summary to "7 boxes (10.08 sqm / 108.5 sqft) - Tile", adds the price per unit under the name,
 * and counts each UOM line as one item.
 *
 * Where the UOM settings come from: the product custom fields (same rules as lib/uom/index.ts in
 * the storefront), read at runtime through the Storefront GraphQL API. Set STOREFRONT_TOKEN to a
 * Storefront GraphQL token for this channel whose allowed origin is the checkout origin. The
 * token is public by design (it ships to the browser) but keep the real value out of git: the
 * committed file has an empty token, put the real one in scripts/checkout-uom-summary.local.js
 * (git-ignored) and push that copy to Script Manager. Without a token, or if the lookup fails,
 * the summary is left as BigCommerce renders it.
 *
 * Products are matched to summary lines by name + quantity using the same-origin
 * /api/storefront/cart endpoint. Lines that aren't UOM products are left untouched.
 */
(function () {
  'use strict';

  var STOREFRONT_TOKEN = '';

  var QTY_PATTERN = /^\s*[\d,.\s]+\s*[x×]\s*$/i;
  var state = { items: null, currency: null, configs: {} };

  function fmt(value, digits) {
    var rounded = Number(value.toFixed(digits === undefined ? 4 : digits));

    return rounded.toLocaleString(document.documentElement.lang || undefined, {
      maximumFractionDigits: digits === undefined ? 4 : digits,
    });
  }

  function plural(count, one, many) {
    return count === 1 ? one : many;
  }

  // "1,234.50", "1.234,50", "453.60" -> number (decimal part = last separator + 1-2 digits)
  function parseMoney(text) {
    var cleaned = (text || '').replace(/[^\d.,]/g, '');
    var match = cleaned.match(/^(.*?)[.,](\d{1,2})$/);

    return match
      ? Number(match[1].replace(/[.,]/g, '') + '.' + match[2])
      : Number(cleaned.replace(/[.,]/g, ''));
  }

  function money(value, currency) {
    try {
      return new Intl.NumberFormat(document.documentElement.lang || undefined, {
        style: 'currency',
        currency: currency,
      }).format(value);
    } catch (e) {
      return value.toFixed(2);
    }
  }

  function describe(config, cartQuantity) {
    var billed = cartQuantity * config.step;
    var parts = [];
    var boxes = null;

    if (config.rounding === 'box' && config.boxSize) {
      boxes = Math.round(billed / config.boxSize);
      parts.push(boxes + ' ' + plural(boxes, 'box', 'boxes'));
    }

    var amount = fmt(billed, 3) + ' ' + config.unit;

    if (config.altUnit && config.altFactor) {
      amount += ' / ' + fmt(billed * config.altFactor, 2) + ' ' + config.altUnit;
    }

    return { billed: billed, label: parts.length ? parts[0] + ' (' + amount + ')' : amount };
  }

  // Same field names as lib/uom/index.ts. `fields` = [{ name, value }].
  function parseConfig(fields) {
    var byName = {};

    fields.forEach(function (field) {
      byName[field.name.trim().toLowerCase()] = String(field.value).trim();
    });

    if ((byName['uom'] || '').toLowerCase() !== 'yes') {
      return null;
    }

    var step = Number(byName['uom step']);
    var boxSize = Number(byName['box size']);
    var factor = Number(byName['conversion factor']);
    var rounding = (byName['uom rounding'] || '').toLowerCase() === 'box' ? 'box' : 'exact';

    if (!byName['uom unit'] || !(step > 0) || (rounding === 'box' && !(boxSize > 0))) {
      return null;
    }

    var config = { unit: byName['uom unit'], step: step, rounding: rounding };

    if (rounding === 'box') config.boxSize = boxSize;
    if (byName['uom alt unit'] && factor > 0) {
      config.altUnit = byName['uom alt unit'];
      config.altFactor = factor;
    }

    return config;
  }

  function loadCart() {
    return fetch('/api/storefront/cart?include=lineItems.physicalItems.options', {
      credentials: 'same-origin',
    })
      .then(function (response) {
        return response.json();
      })
      .then(function (carts) {
        var cart = carts && carts[0];

        if (!cart) {
          return;
        }

        state.currency = cart.currency && cart.currency.code;
        state.items = [].concat(
          cart.lineItems.physicalItems || [],
          cart.lineItems.digitalItems || [],
          cart.lineItems.customItems || [],
          cart.lineItems.giftCertificates || [],
        );
      });
  }

  function loadLiveConfigs() {
    if (!STOREFRONT_TOKEN || !state.items) {
      return Promise.resolve();
    }

    var ids = state.items
      .map(function (item) {
        return item.productId;
      })
      .filter(Boolean);

    if (!ids.length) {
      return Promise.resolve();
    }

    var query =
      'query($ids:[Int!]){site{products(entityIds:$ids){edges{node{entityId customFields(first:50){edges{node{name value}}}}}}}}';

    return fetch('/graphql', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + STOREFRONT_TOKEN },
      body: JSON.stringify({ query: query, variables: { ids: ids } }),
    })
      .then(function (response) {
        return response.json();
      })
      .then(function (json) {
        json.data.site.products.edges.forEach(function (edge) {
          var fields = edge.node.customFields.edges.map(function (e) {
            return e.node;
          });

          state.configs[edge.node.entityId] = parseConfig(fields);
        });
      })
      .catch(function () {
        /* leave the default summary in place */
      });
  }

  function configFor(productId) {
    return state.configs[productId] || null;
  }

  function findCartItem(name, quantity) {
    var byName = state.items.filter(function (item) {
      return item.name === name;
    });

    return (
      byName.filter(function (item) {
        return item.quantity === quantity;
      })[0] || byName[0]
    );
  }

  function updateLine(line) {
    var title = line.querySelector('[data-test="cart-item-product-title"]');
    var qtyNode = title && title.querySelector('span');

    // Only act while the quantity is still the raw "1008 x " text React rendered.
    if (!title || !qtyNode || !QTY_PATTERN.test(qtyNode.textContent)) {
      return;
    }

    var quantity = parseInt(qtyNode.textContent.replace(/[^\d]/g, ''), 10);
    var name = title.textContent.replace(qtyNode.textContent, '').trim();
    var item = findCartItem(name, quantity);
    var config = item && configFor(item.productId);

    if (!config) {
      return;
    }

    var info = describe(config, quantity);

    qtyNode.textContent = info.label + ' · ';

    var body = line.querySelector('.product-body');
    var priceNode = line.querySelector('[data-test="cart-item-product-price"]');
    var lineTotal = priceNode ? parseMoney(priceNode.textContent) : NaN;

    if (body && !body.querySelector('.uom-unit-price') && lineTotal > 0 && state.currency) {
      var unitPrice = document.createElement('div');

      unitPrice.className = 'uom-unit-price body-regular optimizedCheckout-contentSecondary';
      unitPrice.style.cssText = 'font-size:.85em;opacity:.75;margin-top:2px';
      unitPrice.textContent = money(lineTotal / info.billed, state.currency) + ' / ' + config.unit;
      body.appendChild(unitPrice);
    }
  }

  function updateCount() {
    var node = document.querySelector('[data-test="cart-count-total"]');

    if (!node || !state.items) {
      return;
    }

    var hasUom = false;
    var total = state.items.reduce(function (sum, item) {
      if (item.productId && configFor(item.productId)) {
        hasUom = true;

        return sum + 1;
      }

      return sum + (item.quantity || 1);
    }, 0);

    if (!hasUom) {
      return;
    }

    var next = node.textContent.replace(/[\d.,]+/, total.toLocaleString());

    if (next !== node.textContent) {
      node.textContent = next;
    }
  }

  function update() {
    if (!state.items) {
      return;
    }

    document.querySelectorAll('[data-test="cart-item"]').forEach(updateLine);
    updateCount();
  }

  var scheduled = false;

  function schedule() {
    if (scheduled) {
      return;
    }

    scheduled = true;
    window.requestAnimationFrame(function () {
      scheduled = false;
      update();
    });
  }

  // The checkout is a React app: re-apply whenever it re-renders the summary. Every update is
  // idempotent, so our own DOM changes don't loop.
  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  loadCart()
    .then(loadLiveConfigs)
    .then(update)
    .catch(function () {
      /* leave the default summary in place */
    });
})();
