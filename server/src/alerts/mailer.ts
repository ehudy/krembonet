/**
 * SMTP delivery.
 *
 * The transport is built per send rather than cached, because settings can
 * change at runtime from the admin portal and a stale pooled connection would
 * keep using the old host until restart. Alert volume is a handful of mails a
 * month, so there is nothing to gain from pooling.
 */
import nodemailer from 'nodemailer';

import {
  getSettings,
  isSmtpTransportConfigured,
  type AppSettings,
} from '../settings/settings.js';

export interface MailMessage {
  subject: string;
  text: string;
  html?: string;
}

export interface SendResult {
  ok: boolean;
  recipients: string[];
  error?: string;
}

export class SmtpNotConfiguredError extends Error {
  override readonly name = 'SmtpNotConfiguredError';
}

function createTransport(current: AppSettings) {
  return nodemailer.createTransport({
    host: current.smtpHost,
    port: current.smtpPort,
    // `secure` means implicit TLS (usually 465). On 587 the connection starts
    // plaintext and upgrades via STARTTLS, which nodemailer does automatically.
    secure: current.smtpSecure,
    auth:
      current.smtpUser !== ''
        ? { user: current.smtpUser, pass: current.smtpPassword }
        : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/**
 * Sends one message.
 *
 * `recipients` defaults to the hub-wide list and is passed explicitly when a
 * device routes its alerts somewhere of its own — see alerts/routing.ts. It is
 * a parameter rather than something read back out of settings so the addresses
 * the log records are provably the addresses the transport was handed.
 */
export async function sendMail(
  message: MailMessage,
  current: AppSettings = getSettings(),
  recipients: readonly string[] = current.alertRecipients,
): Promise<SendResult> {
  if (!isSmtpTransportConfigured(current) || recipients.length === 0) {
    throw new SmtpNotConfiguredError(
      'SMTP is not configured — set host, sender, and at least one recipient in the admin portal.',
    );
  }

  const transport = createTransport(current);
  const to = [...recipients];

  try {
    await transport.sendMail({
      from: current.smtpFrom,
      to: to.join(', '),
      subject: message.subject,
      text: message.text,
      ...(message.html !== undefined ? { html: message.html } : {}),
    });
    return { ok: true, recipients: to };
  } catch (error) {
    return {
      ok: false,
      recipients: to,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    transport.close();
  }
}

export async function sendTestEmail(): Promise<SendResult> {
  const current = getSettings();

  return sendMail(
    {
      subject: `${current.hubTitle} — test email`,
      text: [
        `This is a test message from ${current.hubTitle}.`,
        '',
        'If you received it, SMTP is configured correctly and low-ink alerts',
        'will be delivered to this address.',
        '',
        `Sent ${new Date().toLocaleString()}`,
      ].join('\n'),
    },
    current,
  );
}
