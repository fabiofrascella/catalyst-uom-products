import { BigCommerceAuthError, createClient } from '@bigcommerce/catalyst-client';

import { getCurrentChannelId } from '../lib/channel';
import { backendUserAgent } from '../user-agent';

// next/headers, next/navigation, and next-intl/server are imported dynamically
// (via `import()`) rather than statically. Static imports cause these modules to
// be evaluated during module graph resolution when next.config.ts imports this
// file, which poisons the process-wide AsyncLocalStorage context (pnpm symlinks
// create two separate singleton instances of next/headers). Dynamic imports
// defer module loading to call time, after Next.js has fully initialized.
//
// During config resolution, the dynamic import of next-intl/server succeeds but
// getLocale() throws ("not supported in Client Components") — the try/catch
// below absorbs this gracefully. The channel itself is resolved by
// getCurrentChannelId(), which falls back to the default channel.

const getLocale = async () => {
  try {
    const { getLocale: getServerLocale } = await import('next-intl/server');

    return await getServerLocale();
  } catch {
    /**
     * Next-intl `getLocale` only works on the server, and when the proxy has run.
     *
     * Instances when `getLocale` will not work:
     * - Requests during next.config.ts resolution
     * - Requests in proxies
     * - Requests in `generateStaticParams`
     * - Request in api routes
     * - Requests in static sites without `setRequestLocale`
     */
  }
};

const baseClient = createClient({
  storefrontToken: process.env.BIGCOMMERCE_STOREFRONT_TOKEN ?? '',
  storeHash: process.env.BIGCOMMERCE_STORE_HASH ?? '',
  channelId: process.env.BIGCOMMERCE_CHANNEL_ID,
  backendUserAgentExtensions: backendUserAgent,
  logger:
    (process.env.NODE_ENV !== 'production' && process.env.CLIENT_LOGGER !== 'false') ||
    process.env.CLIENT_LOGGER === 'true',
  getChannelId: (defaultChannelId: string) => getCurrentChannelId(defaultChannelId),
  beforeRequest: async (fetchOptions) => {
    // We can't serialize a `Headers` object within this method so we have to opt into using a plain object
    const requestHeaders: Record<string, string> = {};
    const locale = await getLocale();

    if (fetchOptions?.cache && ['no-store', 'no-cache'].includes(fetchOptions.cache)) {
      const { headers } = await import('next/headers');
      const ipAddress = (await headers()).get('X-Forwarded-For');

      if (ipAddress) {
        requestHeaders['X-Forwarded-For'] = ipAddress;
        requestHeaders['True-Client-IP'] = ipAddress;
      }

      // Only sent on uncacheable requests. The correlation ID is unique per request, and Next.js
      // includes request headers in the Data Cache key, so sending it alongside
      // `next: { revalidate }` makes every lookup miss and write a fresh entry.
      const { getCorrelationId } = await import('./correlation-id');

      requestHeaders['X-Correlation-ID'] = getCorrelationId();
    }

    if (locale) {
      requestHeaders['Accept-Language'] = locale;
    }

    return {
      headers: requestHeaders,
    };
  },
  onError: async (error, queryType) => {
    if (error instanceof BigCommerceAuthError && queryType === 'query') {
      const { redirect } = await import('next/navigation');

      redirect('/api/auth/signout');
    }
  },
});

type FetchConfig = Parameters<typeof baseClient.fetch>[0];

interface OperationNode {
  kind: string;
  operation?: string;
  directives?: ReadonlyArray<{ name: { value: string } }>;
}

interface DocumentLike {
  kind: 'Document';
  definitions: readonly OperationNode[];
}

const isDocumentLike = (document: unknown): document is DocumentLike =>
  typeof document === 'object' &&
  document !== null &&
  'kind' in document &&
  document.kind === 'Document' &&
  'definitions' in document &&
  Array.isArray(document.definitions);

// The default locale as resolved by the proxy. Header-only (no I/O), so it can't recurse into
// `client.fetch`. Returns `undefined` outside a request or when the proxy didn't set it.
const getForwardedDefaultLocale = async () => {
  try {
    const { getForwardedLocaleRouting } = await import('~/i18n/locale-config');

    return (await getForwardedLocaleRouting())?.defaultLocale;
  } catch {
    return undefined;
  }
};

// The BigCommerce Storefront API ignores the `Accept-Language` header on some channels and keeps
// resolving the default locale, so translated content never comes back. The
// `@shopperPreferences(locale: "...")` directive is honoured, so for non-default locales we add it
// to query operations. Default-locale requests are left untouched.
const withShopperLocale = async <T>(document: T): Promise<T> => {
  if (!isDocumentLike(document)) {
    return document;
  }

  const locale = await getLocale();

  if (!locale || locale === (await getForwardedDefaultLocale())) {
    return document;
  }

  return {
    ...document,
    definitions: document.definitions.map((definition) => {
      if (
        definition.kind !== 'OperationDefinition' ||
        definition.operation !== 'query' ||
        definition.directives?.some(({ name }) => name.value === 'shopperPreferences')
      ) {
        return definition;
      }

      return {
        ...definition,
        directives: [
          ...(definition.directives ?? []),
          {
            kind: 'Directive',
            name: { kind: 'Name', value: 'shopperPreferences' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'locale' },
                value: { kind: 'StringValue', value: locale },
              },
            ],
          },
        ],
      };
    }),
  };
};

export const client = new Proxy(baseClient, {
  get(target, prop) {
    if (prop === 'fetch') {
      return async (config: FetchConfig) =>
        target.fetch({ ...config, document: await withShopperLocale(config.document) });
    }

    const value: unknown = Reflect.get(target, prop, target);

    if (typeof value === 'function') {
      const bound: unknown = value.bind(target);

      return bound;
    }

    return value;
  },
});
