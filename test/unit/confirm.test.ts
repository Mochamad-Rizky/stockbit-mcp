import { Confirmer, type ElicitationPort } from '../../src/core/confirm.js';
import { createLogger } from '../../src/core/logger.js';

const req = {
  action: 'order_buy',
  title: 'Beli BBCA',
  lines: ['Harga 9.000', '10 lot'],
  payload: { symbol: 'BBCA', price: 9000, lot: 10 },
};

function port(supported: boolean, answer?: Awaited<ReturnType<ElicitationPort['elicit']>>) {
  const asked: string[] = [];
  return {
    asked,
    supported: () => supported,
    async elicit(params: Parameters<ElicitationPort['elicit']>[0]) {
      asked.push(params.message);
      if (!answer) {
        throw new Error('client cannot elicit');
      }
      return answer;
    },
  };
}

const logger = createLogger('silent');

describe('Confirmer', () => {
  it('confirms through elicitation when the user ticks the box', async () => {
    const p = port(true, { action: 'accept', content: { confirm: true } });
    const c = new Confirmer({ confirm: 'auto' }, p, logger);
    await expect(c.confirm(req, undefined)).resolves.toEqual({ status: 'confirmed', via: 'elicitation' });
    expect(p.asked[0]).toContain('Beli BBCA');
    expect(p.asked[0]).toContain('10 lot');
  });

  it.each([
    { action: 'decline' as const },
    { action: 'cancel' as const },
    { action: 'accept' as const, content: { confirm: false } },
  ])('refuses on %o', async (answer) => {
    const c = new Confirmer({ confirm: 'auto' }, port(true, answer), logger);
    await expect(c.confirm(req, undefined)).rejects.toMatchObject({ code: 'CONFIRMATION_DECLINED' });
  });

  it('issues a token when the client has no elicitation, and redeems it once', async () => {
    const c = new Confirmer({ confirm: 'auto' }, port(false), logger);
    const first = await c.confirm(req, undefined);
    expect(first.status).toBe('pending');
    if (first.status !== 'pending') throw new Error('unreachable');

    await expect(c.confirm(req, first.confirmation_token)).resolves.toEqual({
      status: 'confirmed',
      via: 'token',
    });
    await expect(c.confirm(req, first.confirmation_token)).rejects.toMatchObject({
      code: 'CONFIRMATION_EXPIRED',
    });
  });

  it('rejects a token used for different arguments', async () => {
    const c = new Confirmer({ confirm: 'token' }, port(true), logger);
    const first = await c.confirm(req, undefined);
    if (first.status !== 'pending') throw new Error('expected pending');
    const changed = { ...req, payload: { ...req.payload, lot: 100 } };
    await expect(c.confirm(changed, first.confirmation_token)).rejects.toMatchObject({
      code: 'CONFIRMATION_EXPIRED',
    });
  });

  it('expires tokens', async () => {
    let now = 1_000;
    const c = new Confirmer({ confirm: 'token' }, port(false), logger, () => now);
    const first = await c.confirm(req, undefined);
    if (first.status !== 'pending') throw new Error('expected pending');
    now += 121_000;
    await expect(c.confirm(req, first.confirmation_token)).rejects.toMatchObject({
      code: 'CONFIRMATION_EXPIRED',
    });
  });

  it('falls back to a token when elicitation errors in auto mode, but not in elicit mode', async () => {
    const auto = new Confirmer({ confirm: 'auto' }, port(true), logger);
    await expect(auto.confirm(req, undefined)).resolves.toMatchObject({ status: 'pending' });

    const strict = new Confirmer({ confirm: 'elicit' }, port(true), logger);
    await expect(strict.confirm(req, undefined)).rejects.toThrow('client cannot elicit');
  });

  describe('confirmByPopups (orders)', () => {
    const steps = [
      { title: 'Order 1/2', lines: ['BBCA 10 lot'], check: 'Benar' },
      { title: 'Order 2/2', lines: ['Kirim?'], check: 'Kirim' },
    ];

    function sequence(answers: Awaited<ReturnType<ElicitationPort['elicit']>>[]) {
      const asked: string[] = [];
      return {
        asked,
        supported: () => true,
        async elicit(params: Parameters<ElicitationPort['elicit']>[0]) {
          asked.push(params.message);
          const answer = answers[asked.length - 1];
          if (!answer) throw new Error('timed out');
          return answer;
        },
      };
    }
    const yes = { action: 'accept' as const, content: { confirm: true } };

    it('asks every step in order and resolves when all are ticked', async () => {
      const p = sequence([yes, yes]);
      await expect(new Confirmer({ confirm: 'auto' }, p, logger).confirmByPopups(steps)).resolves.toBeUndefined();
      expect(p.asked).toEqual([expect.stringContaining('Order 1/2'), expect.stringContaining('Order 2/2')]);
    });

    it('stops at the first refusal', async () => {
      const p = sequence([{ action: 'accept', content: { confirm: false } }, yes]);
      await expect(new Confirmer({ confirm: 'auto' }, p, logger).confirmByPopups(steps)).rejects.toMatchObject({
        code: 'CONFIRMATION_DECLINED',
        details: { step: 1 },
      });
      expect(p.asked).toHaveLength(1);
    });

    it('never falls back to a token: no popups, or a popup that fails, is a refusal', async () => {
      for (const mode of ['auto', 'token'] as const) {
        await expect(
          new Confirmer({ confirm: mode }, port(false), logger).confirmByPopups(steps),
        ).rejects.toMatchObject({ code: 'CONFIRMATION_UNAVAILABLE' });
      }
      await expect(
        new Confirmer({ confirm: 'auto' }, sequence([yes]), logger).confirmByPopups(steps),
      ).rejects.toMatchObject({ code: 'CONFIRMATION_UNAVAILABLE', message: expect.stringContaining('popup 2 of 2') });
    });
  });
});
