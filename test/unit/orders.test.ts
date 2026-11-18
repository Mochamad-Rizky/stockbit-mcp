import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { nearestTicks, onTick } from '../../src/tools/orders.js';
import { harness, type Recorded, type Responder } from './helpers.js';

const MARKET: Record<string, unknown> = {
  'exodus /emitten/BBCA/info': {
    data: {
      name: 'Bank Central Asia Tbk.',
      type_company: 'Saham',
      status: 'STATUS_ACTIVE',
      tradeable: 1,
    },
  },
  'exodus /company-price-feed/v2/orderbook/companies/BBCA': {
    data: {
      lastprice: 9475,
      bid: [{ price: '9475', volume: '120' }],
      offer: [{ price: '9500', volume: '80' }],
      ara: { value: '10,150', visible: true },
      arb: { value: '8,825', visible: true },
    },
  },
  'exodus /company-price-feed/market-time': { data: { market: { status: 'STATUS_OPEN' } } },
  'carina /stock/tradable': {
    data: [
      {
        stock_code: 'BBCA',
        is_tradable: true,
        is_sharia_tradable: true,
        board_tradable: { rg: true },
      },
    ],
  },
  'carina /balance/cash/info': { data: { trade_balance: 20_000_000, trade_limit: 0 } },
  'carina /formula/v2': { data: { fee: { buy: 0.0015, sell: 0.0025 } } },
  'carina /portfolio/v2/detail': {
    data: { result: { symbol: 'BBCA', qty: { available: { lot: 25 } } } },
  },
};

const key = (r: Recorded) => `${r.url.host.split('.')[0]} ${r.url.pathname}`;
const posts = (calls: Recorded[]) => calls.filter((c) => c.method === 'POST');

function market(
  order: (req: Recorded) => { status?: number; body: unknown } = () => ({
    body: { data: { order_id: 'ORD-1' } },
  }),
): Responder {
  return (req) => {
    if (req.method === 'POST') return order(req);
    const body = MARKET[key(req)];
    return body === undefined ? undefined : { body };
  };
}

// Answers the popups in turn: true ticks the box, false declines.
function popups(...answers: boolean[]) {
  const asked: string[] = [];
  const elicit = (message: string): ElicitResult => {
    asked.push(message);
    return answers[asked.length - 1]
      ? { action: 'accept', content: { confirm: true } }
      : { action: 'decline' };
  };
  return { asked, elicit };
}

describe('IDX ticks', () => {
  it.each([
    [199, true],
    [200, true],
    [201, false],
    [202, true],
    [500, true],
    [502, false],
    [2000, true],
    [2005, false],
    [5000, true],
    [5010, false],
    [9525, true],
  ])('%i on the grid: %s', (price, valid) => {
    expect(onTick(price)).toBe(valid);
  });

  it('suggests the neighbours of an off-grid price', () => {
    expect(nearestTicks(201)).toEqual([200, 202]);
    expect(nearestTicks(9510)).toEqual([9500, 9525]);
  });
});

describe('order_buy and order_sell', () => {
  it('sends a buy only after both popups are ticked, with shares and the limit-day body', async () => {
    const p = popups(true, true);
    const h = await harness(market(), { elicit: p.elicit });
    const res = await h.callTool('order_buy', { symbol: 'bbca', lot: 10, price: 9500 });

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      sent: true,
      order_id: 'ORD-1',
      side: 'BUY',
      symbol: 'BBCA',
      lot: 10,
      shares: 1000,
    });
    expect(p.asked).toHaveLength(2);
    expect(p.asked[0]).toContain('(1/2)');
    expect(p.asked[0]).toContain('Bank Central Asia');
    expect(p.asked[0]).toContain('10 lot (1.000 lembar)');
    expect(p.asked[0]).toContain('Rp 9.500 per lembar');
    expect(p.asked[0]).toContain('Perkiraan total dengan fee: Rp 9.514.250');
    expect(p.asked[0]).toContain('ARB 8.825 – ARA 10.150');
    expect(p.asked[1]).toContain('(2/2)');
    expect(p.asked[1]).toContain('BELI BBCA 10 lot @ Rp 9.500 = Rp 9.500.000');

    const [order] = posts(h.calls);
    expect(posts(h.calls)).toHaveLength(1);
    expect(order?.url.href).toBe('https://carina.stockbit.com/order/v2/buy');
    expect(order?.headers.Authorization).toBe('Bearer car-access');
    expect(order?.body).toEqual({
      ui_ref: expect.stringMatching(/^W\d{13}[A-Za-z]{13}$/),
      symbol: 'BBCA',
      price: 9500,
      shares: 1000,
      board_type: 'RG',
      is_gtc: false,
      time_in_force: '0',
      platform_order_type: 'PLATFORM_ORDER_TYPE_LIMIT_DAY',
    });
  });

  it('sends nothing when the first popup is declined, and does not show the second', async () => {
    const p = popups(false, true);
    const h = await harness(market(), { elicit: p.elicit });
    const res = await h.callTool('order_buy', { symbol: 'BBCA', lot: 10, price: 9500 });

    expect(res.error.code).toBe('CONFIRMATION_DECLINED');
    expect(p.asked).toHaveLength(1);
    expect(posts(h.calls)).toHaveLength(0);
  });

  it('sends nothing when only the second popup is declined', async () => {
    const p = popups(true, false);
    const h = await harness(market(), { elicit: p.elicit });
    const res = await h.callTool('order_sell', { symbol: 'BBCA', lot: 5, price: 9500 });

    expect(res.error.code).toBe('CONFIRMATION_DECLINED');
    expect(res.error.details).toMatchObject({ step: 2, steps: 2 });
    expect(p.asked).toHaveLength(2);
    expect(posts(h.calls)).toHaveLength(0);
  });

  it.each([{}, { STOCKBIT_MCP_CONFIRM: 'token' }])(
    'refuses a client without popups before any request (env %o)',
    async (env) => {
      const h = await harness(market(), { env });
      const res = await h.callTool('order_buy', { symbol: 'BBCA', lot: 1, price: 9500 });

      expect(res.error.code).toBe('CONFIRMATION_UNAVAILABLE');
      expect(JSON.stringify(res)).not.toContain('confirmation_token');
      expect(h.calls).toHaveLength(0);
    },
  );

  it('refuses a price off the tick grid with the neighbours, without a popup', async () => {
    const p = popups(true, true);
    const h = await harness(market(), { elicit: p.elicit });
    const res = await h.callTool('order_buy', { symbol: 'BBCA', lot: 1, price: 9510 });

    expect(res.error.code).toBe('INVALID_INPUT');
    expect(res.error.hint).toBe('Use 9500 or 9525.');
    expect(p.asked).toHaveLength(0);
    expect(posts(h.calls)).toHaveLength(0);
  });

  it('refuses a price above ARA', async () => {
    const p = popups(true, true);
    const h = await harness(market(), { elicit: p.elicit });
    const res = await h.callTool('order_buy', { symbol: 'BBCA', lot: 1, price: 10_200 });

    expect(res.error.code).toBe('INVALID_INPUT');
    expect(res.error.message).toContain('Rp 8.825 to Rp 10.150');
    expect(p.asked).toHaveLength(0);
  });

  it('refuses to sell more lots than are available, and sells what is', async () => {
    const p = popups(true, true);
    const h = await harness(market(), { elicit: p.elicit });

    const tooMany = await h.callTool('order_sell', { symbol: 'BBCA', lot: 30, price: 9500 });
    expect(tooMany.error.code).toBe('INVALID_INPUT');
    expect(tooMany.error.message).toContain('Only 25 lots');
    expect(p.asked).toHaveLength(0);

    const ok = await h.callTool('order_sell', { symbol: 'BBCA', lot: 25, price: 9500 });
    expect(ok.ok).toBe(true);
    expect(p.asked[0]).toContain('Lot tersedia untuk dijual: 25');
    expect(p.asked[0]).toContain('Perkiraan diterima setelah fee');
    const [order] = posts(h.calls);
    expect(order?.url.pathname).toBe('/order/v2/sell');
    expect(order?.body).toMatchObject({ symbol: 'BBCA', shares: 2500, price: 9500 });
  });

  it('refuses a stock Stockbit says is not tradable', async () => {
    const respond = market();
    const h = await harness(
      (req) =>
        key(req) === 'carina /stock/tradable'
          ? {
              body: {
                data: [{ stock_code: 'BBCA', is_tradable: false, board_tradable: { rg: false } }],
              },
            }
          : respond(req),
      { elicit: popups(true, true).elicit },
    );
    const res = await h.callTool('order_buy', { symbol: 'BBCA', lot: 1, price: 9500 });
    expect(res.error.code).toBe('INVALID_INPUT');
    expect(posts(h.calls)).toHaveLength(0);
  });

  it('reports a 5xx on the order as uncertain and does not send it twice', async () => {
    const h = await harness(
      market(() => ({ status: 502, body: { message: 'bad gateway' } })),
      {
        elicit: popups(true, true).elicit,
      },
    );
    const res = await h.callTool('order_buy', { symbol: 'BBCA', lot: 1, price: 9500 });

    expect(res.error.code).toBe('ORDER_UNCERTAIN');
    expect(res.error.hint).toContain('account_orders');
    expect(res.error.details.ui_ref).toMatch(/^W\d+/);
    expect(posts(h.calls)).toHaveLength(1);
  });

  it('reports a lost connection on the order as uncertain', async () => {
    const h = await harness(
      market(() => {
        throw new Error('socket hang up');
      }),
      { elicit: popups(true, true).elicit },
    );
    const res = await h.callTool('order_buy', { symbol: 'BBCA', lot: 1, price: 9500 });
    expect(res.error.code).toBe('ORDER_UNCERTAIN');
  });

  it('passes a 400 rejection on as Stockbit saying no', async () => {
    const h = await harness(
      market(() => ({ status: 400, body: { message: 'Saldo tidak cukup' } })),
      {
        elicit: popups(true, true).elicit,
      },
    );
    const res = await h.callTool('order_buy', { symbol: 'BBCA', lot: 1, price: 9500 });
    expect(res.error.code).toBe('INVALID_INPUT');
    expect(res.error.message).toBe('Saldo tidak cukup');
  });

  it('are not offered with STOCKBIT_MCP_ORDERS=off', async () => {
    const h = await harness(market(), { env: { STOCKBIT_MCP_ORDERS: 'off' } });
    const { tools } = await h.client.listTools();
    expect(tools.some((t) => t.name.startsWith('order_'))).toBe(false);
    expect(tools.some((t) => t.name === 'account_orders')).toBe(true);
  });
});
