import { TRADING_MINUTES, Universe } from '../../../src/watch/universe.js';
import { fakeHttp } from './fake-http.js';

const company = (symbol: string, valuema20: string, notations: string[] = [], status = 'STATUS_ACTIVE') => ({
  symbol, name: `${symbol} Tbk.`, valuema20, avgvolume: '1000.00', marketcap: '5000000000.00', uma: false, company_status: status,
  notations: notations.map((c) => ({ notation_code: c, notation_desc: c })),
});

function http() {
  return fakeHttp({
    '/emitten/classification/list': { data: [{ id: 1, level: 1, children: [] }, { id: 2, level: 1, children: [] }] },
    '/emitten/classification/company': {
      data: [
        { id: 1, level: 1, companies: [company('BBCA', '3200000000.00'), company('LAPD', '1000.00', ['E', 'X'])] },
        { id: 2, level: 1, companies: [company('BBCA', '3200000000.00'), company('NEWX', '0.00')] },
      ],
    },
  });
}

describe('Universe', () => {
  it('loads companies from all sectors without duplicates', async () => {
    const h = http();
    const u = await Universe.load(h);
    expect(u.size).toBe(3);
    const req = h.calls.find((c) => c.path.includes('classification/company'))!;
    expect(req.query).toEqual({ ids: [1, 2] });
    expect(u.get('BBCA')).toMatchObject({ symbol: 'BBCA', valueMa20: 3_200_000_000, notations: [], uma: false, fca: false, active: true });
  });

  it('expected value per minute is valuema20 / 320', async () => {
    const u = await Universe.load(http());
    expect(TRADING_MINUTES).toBe(320);
    expect(u.expectedPerMinute('BBCA')).toBe(10_000_000);
  });

  it('new listing gets a baseline from its first 15 minutes', async () => {
    const u = await Universe.load(http());
    expect(u.expectedPerMinute('NEWX')).toBeUndefined();
    expect(u.expectedPerMinute('ZZZZ')).toBeUndefined();
    u.learnBaseline('NEWX', 150_000_000);
    expect(u.expectedPerMinute('NEWX')).toBe(10_000_000);
    u.learnBaseline('BBCA', 1);
    expect(u.expectedPerMinute('BBCA')).toBe(10_000_000);
  });

  it('marks FCA from notation X', async () => {
    const u = await Universe.load(http());
    expect(u.get('LAPD')).toMatchObject({ notations: ['E', 'X'], fca: true });
  });
});
