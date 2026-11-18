import type { AuthService } from '../core/auth.js';
import { StockbitMcpError } from '../core/errors.js';
import { ask, askSecret, sleep } from './prompt.js';

const say = (line: string) => process.stderr.write(`${line}\n`);

const POLL_MS = 2000;
const PROMPT_WAIT_MS = 5 * 60_000;

// Password login, then whatever Stockbit asks for a new device: an approval pushed to the phone
// app (with an OTP fallback), or the verification challenges.
export async function passwordLogin(auth: AuthService): Promise<void> {
  const user = await ask('Stockbit username or email: ');
  const password = await askSecret('Password: ');
  const step = await auth.passwordLogin(user, password);

  if (step.kind === 'done') {
    say(`Logged in${step.session.exodus?.username ? ` as ${step.session.exodus.username}` : ''}.`);
    return;
  }

  if (step.kind === 'trusted_device') {
    say(
      `Stockbit sees a new device. Approve the login in the Stockbit app${step.deviceName ? ` on ${step.deviceName}` : ''}.`,
    );
    const promptToken = await auth.sendPrompt(step.loginToken);
    const deadline = Date.now() + PROMPT_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const result = await auth.pollPrompt(promptToken);
      if (result.status === 'approved' && result.acknowledgeToken) {
        await auth.verifyPrompt(step.loginToken, result.acknowledgeToken);
        say('Approved. Logged in.');
        return;
      }
      if (result.status === 'rejected') {
        throw new StockbitMcpError('LOGIN_FAILED', 'The login was rejected in the Stockbit app.');
      }
      if (result.status === 'expired') break;
    }
    say('No approval came. Falling back to a one-time code.');
    const channel = await pickChannel(['CHANNEL_WHATSAPP', 'CHANNEL_SMS', 'CHANNEL_EMAIL']);
    await auth.requestOtp(step.loginToken, channel as 'CHANNEL_SMS' | 'CHANNEL_WHATSAPP' | 'CHANNEL_EMAIL');
    const otp = await ask('Code: ');
    await auth.verifyOtp(step.loginToken, otp);
    say('Logged in.');
    return;
  }

  let challenge = await auth.startChallenge(step.verificationToken);
  for (let i = 0; i < 8; i++) {
    switch (challenge.next) {
      case 'CHALLENGE_FINISH':
      case 'CHALLENGE_FINISHED':
        await auth.finishMultiFactor(step.loginToken);
        say('Verified. Logged in.');
        return;
      case 'CHALLENGE_OTP': {
        const channel = await pickChannel(challenge.channels.length ? challenge.channels : ['CHANNEL_SMS']);
        challenge = await auth.challengeSendOtp(step.verificationToken, channel);
        break;
      }
      case 'CHALLENGE_VERIFY_OTP':
        challenge = await auth.challengeVerify(step.verificationToken, 'otp', await ask('Code: '));
        break;
      case 'CHALLENGE_PIN':
        challenge = await auth.challengeVerify(step.verificationToken, 'pin', await askSecret('Stockbit PIN: '));
        break;
      default:
        throw new StockbitMcpError(
          'LOGIN_FAILED',
          `Stockbit asks for a ${challenge.next} verification, which only its app can do.`,
          { hint: 'Log in on stockbit.com in a browser, then run `stockbit-mcp login --token`.' },
        );
    }
  }
  throw new StockbitMcpError('LOGIN_FAILED', 'Verification did not finish.');
}

async function pickChannel(channels: string[]): Promise<string> {
  if (channels.length === 1) return channels[0]!;
  channels.forEach((c, i) => say(`  ${i + 1}. ${c.replace('CHANNEL_', '').toLowerCase()}`));
  const answer = Number(await ask(`Send the code by [1-${channels.length}]: `));
  return channels[(Number.isInteger(answer) && answer >= 1 && answer <= channels.length ? answer : 1) - 1]!;
}

export async function tokenLogin(auth: AuthService): Promise<void> {
  const access = await askSecret('Access token: ');
  if (!access) throw new StockbitMcpError('LOGIN_FAILED', 'No token given.');
  const refresh = await askSecret('Refresh token (Enter to skip): ');
  await auth.saveManualTokens(access, refresh || undefined);
  say(refresh ? 'Saved.' : 'Saved. Without a refresh token you will need to log in again when it expires.');
}

export async function tradingLogin(auth: AuthService): Promise<void> {
  const pin = await askSecret('Trading PIN: ');
  if (!/^\d{6,12}$/.test(pin)) throw new StockbitMcpError('LOGIN_FAILED', 'The PIN is 6 to 12 digits.');
  await auth.tradingLogin(pin);
  say('Trading session saved. The account_* tools can read the portfolio now.');
}
