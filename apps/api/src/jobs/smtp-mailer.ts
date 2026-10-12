import { createHash } from 'node:crypto';
import { createTransport } from 'nodemailer';
import { z } from 'zod';
import type { Mailer, OutgoingEmail } from './ports.js';

/** Where the jobs send mail from and link to. Built from the environment by `mailConfigFromEnv`. */
export interface MailConfig {
  /** `smtp://` or `smtps://` URL, credentials included when the server needs them. */
  smtpUrl: string;
  /** The From header, e.g. `PlanetPulse Compliance <no-reply@planetpulse.life>`. */
  from: string;
  /** Public web origin for links in emails, e.g. `https://app.planetpulse.life`. */
  appUrl: string;
}

const httpUrl = z.url({ protocol: /^https?$/ });

const MailEnv = z
  .object({
    SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    /** "true" for implicit TLS (smtps, usually port 465). Default: true on port 465, else STARTTLS when offered. */
    SMTP_SECURE: z.enum(['true', 'false']).optional(),
    MAIL_FROM: z.string().min(3),
    APP_URL: httpUrl,
  })
  .refine((e) => !(e.SMTP_URL && e.SMTP_HOST), {
    message: 'set SMTP_URL or SMTP_HOST, not both',
  })
  .refine((e) => !e.SMTP_USER === !e.SMTP_PASS, {
    message: 'set SMTP_USER and SMTP_PASS together',
  });

const MAIL_KEYS = ['SMTP_URL', 'SMTP_HOST'] as const;

/**
 * The jobs' mail settings, or null when the environment configures no SMTP server: the jobs then stay unmounted.
 * A server without `MAIL_FROM` or `APP_URL`, or with a malformed value, throws at boot instead of sending broken mail.
 * Error messages name the variables, never their values.
 */
export function mailConfigFromEnv(env: Record<string, string | undefined>): MailConfig | null {
  if (MAIL_KEYS.every((key) => !env[key])) return null;
  const parsed = MailEnv.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => (i.path.length ? i.path.join('.') : i.message));
    throw new Error(`Mail settings invalid: ${[...new Set(problems)].join(', ')}`);
  }
  const e = parsed.data;
  let smtpUrl: string;
  if (e.SMTP_URL) {
    smtpUrl = e.SMTP_URL;
  } else {
    const port = e.SMTP_PORT ?? 587;
    const secure = e.SMTP_SECURE ? e.SMTP_SECURE === 'true' : port === 465;
    const url = new URL(`${secure ? 'smtps' : 'smtp'}://${e.SMTP_HOST}:${port}`);
    if (e.SMTP_USER) {
      url.username = e.SMTP_USER;
      url.password = e.SMTP_PASS!;
    }
    smtpUrl = url.toString();
  }
  return { smtpUrl, from: e.MAIL_FROM, appUrl: e.APP_URL };
}

/** The address part of a From header, for the Message-ID domain. */
function fromDomain(from: string): string {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  return address.split('@')[1]?.trim() || 'localhost';
}

/** SMTP failure details that carry no address or message content: the error code and the server's reply code. */
function sendFailure(error: unknown): Error {
  const e = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof e.code === 'string' ? e.code : 'UNKNOWN';
  const reply = typeof e.responseCode === 'number' ? ` ${e.responseCode}` : '';
  return new Error(`SMTP send failed: ${code}${reply}`);
}

/**
 * A `Mailer` over any SMTP server (provider relay, Mailpit locally). The Message-ID is derived from the send-log key,
 * so a re-sent PENDING row carries the same id and a provider that dedupes on it drops the copy. A failure throws
 * with codes only (no address, subject or body), so the job leaves the row pending and retries.
 */
export function smtpMailer(config: Pick<MailConfig, 'smtpUrl' | 'from'>): Mailer & {
  close(): void;
} {
  const transport = createTransport(config.smtpUrl);
  const domain = fromDomain(config.from);
  return {
    async send(email: OutgoingEmail) {
      const id = createHash('sha256').update(email.idempotencyKey).digest('hex').slice(0, 32);
      try {
        await transport.sendMail({
          from: config.from,
          to: { name: email.to.name, address: email.to.email },
          subject: email.subject,
          html: email.html,
          text: email.text,
          messageId: `<${id}@${domain}>`,
          headers: { 'Auto-Submitted': 'auto-generated' },
        });
      } catch (error) {
        throw sendFailure(error);
      }
    },
    close: () => transport.close(),
  };
}
