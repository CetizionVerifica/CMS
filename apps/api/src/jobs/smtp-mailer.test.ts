import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderEmail } from '@canopy/notifications';
import type { LocalDate } from '@canopy/contracts';
import { mailConfigFromEnv, smtpMailer } from './smtp-mailer.js';
import { startFakeSmtp, type FakeSmtp } from './testing/fake-smtp.js';

const BASE = {
  MAIL_FROM: 'PlanetPulse Compliance <no-reply@planetpulse.example>',
  APP_URL: 'https://app.planetpulse.example',
};

describe('mail settings from the environment', () => {
  it('is null, so the jobs stay unmounted, when no SMTP server is set', () => {
    expect(mailConfigFromEnv({})).toBeNull();
    expect(mailConfigFromEnv({ ...BASE })).toBeNull();
  });

  it('takes SMTP_URL as it is', () => {
    expect(mailConfigFromEnv({ ...BASE, SMTP_URL: 'smtps://u:p@smtp.example.com:465' })).toEqual({
      smtpUrl: 'smtps://u:p@smtp.example.com:465',
      from: BASE.MAIL_FROM,
      appUrl: BASE.APP_URL,
    });
  });

  it('builds the URL from host, port and credentials, STARTTLS on 587 and implicit TLS on 465', () => {
    expect(mailConfigFromEnv({ ...BASE, SMTP_HOST: 'smtp.example.com' })!.smtpUrl).toBe(
      'smtp://smtp.example.com:587',
    );
    expect(
      mailConfigFromEnv({
        ...BASE,
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '465',
        SMTP_USER: 'apikey',
        SMTP_PASS: 'p@ss:word/1',
      })!.smtpUrl,
    ).toBe('smtps://apikey:p%40ss%3Aword%2F1@smtp.example.com:465');
    expect(
      mailConfigFromEnv({
        ...BASE,
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        SMTP_SECURE: 'true',
      })!.smtpUrl,
    ).toBe('smtps://localhost:1025');
    expect(
      mailConfigFromEnv({ ...BASE, SMTP_HOST: 'h', SMTP_PORT: '465', SMTP_SECURE: 'false' })!
        .smtpUrl,
    ).toBe('smtp://h:465');
  });

  it('throws at boot on half-set settings, naming the variables and never their values', () => {
    const fail = (env: Record<string, string>) => () => mailConfigFromEnv(env);
    expect(fail({ SMTP_HOST: 'h', APP_URL: BASE.APP_URL })).toThrow('MAIL_FROM');
    expect(fail({ SMTP_HOST: 'h', MAIL_FROM: BASE.MAIL_FROM })).toThrow('APP_URL');
    expect(fail({ ...BASE, SMTP_HOST: 'h', APP_URL: 'javascript:alert(1)' })).toThrow('APP_URL');
    expect(fail({ ...BASE, SMTP_URL: 'http://h', SMTP_HOST: 'h' })).toThrow('SMTP_URL');
    expect(fail({ ...BASE, SMTP_URL: 'smtp://h', SMTP_HOST: 'h' })).toThrow(
      'set SMTP_URL or SMTP_HOST, not both',
    );
    expect(fail({ ...BASE, SMTP_HOST: 'h', SMTP_USER: 'u' })).toThrow(
      'set SMTP_USER and SMTP_PASS together',
    );
    expect(fail({ ...BASE, SMTP_HOST: 'h', SMTP_PORT: '99999' })).toThrow('SMTP_PORT');
    try {
      mailConfigFromEnv({ ...BASE, SMTP_HOST: 'h', SMTP_USER: 'secret-user' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-user');
    }
  });
});

describe('SMTP mailer', () => {
  let smtp: FakeSmtp;
  beforeEach(async () => {
    smtp = await startFakeSmtp();
  });
  afterEach(async () => {
    await smtp.close();
  });

  const email = () => ({
    ...renderEmail({
      kind: 'OWNER_REMINDER',
      recipientName: 'Asha Rao',
      clientName: 'Kestrel Metals Group',
      offsetDays: 1,
      sentBack: true,
      instance: {
        title: 'Deposit TDS for the month',
        actName: 'Income Tax Act, 1961',
        unitName: 'Plant',
        departmentName: 'Finance',
        criticality: 'CRITICAL',
        dueDate: '2026-10-11' as LocalDate,
        url: 'https://app.planetpulse.example/c/1/register?instance=2',
      },
    }),
    to: { name: 'Asha Rao', email: 'asha@example.com' },
    idempotencyKey: 'event:e1:p1',
  });

  it('sends a multipart message with the From, To, a stable Message-ID and Auto-Submitted', async () => {
    const config = mailConfigFromEnv({
      ...BASE,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_USER: 'apikey',
      SMTP_PASS: 'secret',
    })!;
    const mailer = smtpMailer(config);
    await mailer.send(email());
    await mailer.send(email());
    mailer.close();

    expect(smtp.received).toHaveLength(2);
    const [first, second] = smtp.received;
    expect(first!.auth).toBe('\0apikey\0secret');
    expect(first!.from).toBe('no-reply@planetpulse.example');
    expect(first!.to).toEqual(['asha@example.com']);
    expect(first!.data).toMatch(/^From: PlanetPulse Compliance <no-reply@planetpulse\.example>$/m);
    expect(first!.data).toMatch(/^To: Asha Rao <asha@example\.com>$/m);
    expect(first!.data).toMatch(/^Subject: Overdue 1 day: Deposit TDS for the month$/m);
    expect(first!.data).toMatch(/^Auto-Submitted: auto-generated$/m);
    expect(first!.data).toContain('multipart/alternative');
    expect(first!.data).toContain('text/plain');
    expect(first!.data).toContain('text/html');
    const messageId = /^Message-ID: (<[0-9a-f]{32}@planetpulse\.example>)$/m.exec(first!.data)?.[1];
    expect(messageId).toBeDefined();
    // The same send-log key gives the same Message-ID, so a provider can drop a re-sent copy.
    expect(second!.data).toContain(`Message-ID: ${messageId}`);
  });

  it('throws a transient failure with codes only, so the job retries without logging the address', async () => {
    const mailer = smtpMailer({
      smtpUrl: `smtp://127.0.0.1:${smtp.port}`,
      from: 'no-reply@planetpulse.example',
    });
    smtp.failNextRecipients(1);
    const error = await mailer.send(email()).then(
      () => null,
      (e: unknown) => e as Error,
    );
    mailer.close();
    expect(error?.message).toMatch(/^SMTP send failed: \w+ 451$/);
    expect(error?.message).not.toContain('asha');
    expect(error?.message).not.toContain('Deposit');
  });

  it('reports a connection failure by code', async () => {
    await smtp.close();
    const mailer = smtpMailer({
      smtpUrl: `smtp://127.0.0.1:${smtp.port}`,
      from: 'bare-address',
    });
    await expect(mailer.send(email())).rejects.toThrow(/^SMTP send failed: \w+$/);
    mailer.close();
    smtp = await startFakeSmtp();
  });
});
