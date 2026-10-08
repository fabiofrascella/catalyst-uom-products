import { removeEdgesAndNodes } from '@bigcommerce/catalyst-client';

import { getSessionCustomerAccessToken } from '~/auth';
import { client } from '~/client';
import { graphql, VariablesOf } from '~/client/graphql';
import { revalidate } from '~/client/revalidate-target';
import { getPreferredCurrencyCode } from '~/lib/currency';

const CreateCartMutation = graphql(`
  mutation CreateCartMutation($createCartInput: CreateCartInput!) {
    cart {
      createCart(input: $createCartInput) {
        cart {
          entityId
        }
      }
    }
  }
`);

const ChannelCurrenciesQuery = graphql(`
  query CreateCartChannelCurrenciesQuery {
    site {
      currencies(first: 25) {
        edges {
          node {
            code
            isActive
            isTransactional
            isDefault
          }
        }
      }
    }
  }
`);

// Without a currency, BigCommerce creates the cart in the store-wide default currency. If that
// currency isn't enabled on the channel, cart creation fails with "Currency not found", so fall
// back to one of the channel's own transactional currencies.
const getChannelCurrencyCode = async () => {
  const { data } = await client.fetch({
    document: ChannelCurrenciesQuery,
    fetchOptions: { next: { revalidate } },
  });

  const usableCurrencies = removeEdgesAndNodes(data.site.currencies).filter(
    (currency) => currency.isActive && currency.isTransactional,
  );

  return (usableCurrencies.find((currency) => currency.isDefault) ?? usableCurrencies[0])?.code;
};

type Variables = VariablesOf<typeof CreateCartMutation>;
export type CreateCartInput = Variables['createCartInput'];

export const createCart = async (data: CreateCartInput) => {
  const customerAccessToken = await getSessionCustomerAccessToken();
  const currencyCode = (await getPreferredCurrencyCode()) ?? (await getChannelCurrencyCode());

  return await client.fetch({
    document: CreateCartMutation,
    variables: {
      createCartInput: {
        ...data,
        currencyCode,
      },
    },
    customerAccessToken,
    fetchOptions: { cache: 'no-store' },
  });
};
