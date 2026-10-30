import { Resend } from 'resend';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export type SendEmailParams = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type SendEmailResult = { sent: boolean; reason?: string };

let resendClient: Resend | null = null;

function getResendClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!resendClient) {
    resendClient = new Resend(env.RESEND_API_KEY);
  }
  return resendClient;
}

/**
 * Without RESEND_API_KEY — always true in development unless it's explicitly
 * configured — the email is logged in full (including any links) at info
 * level instead of sent, so the invite/reset flow works with no network and
 * no Resend account. This never silently drops an email: every path here
 * ends in an explicit sent true/false result the caller can act on.
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const client = getResendClient();

  if (!client) {
    logger.info(
      {
        to: params.to,
        from: env.EMAIL_FROM,
        subject: params.subject,
        text: params.text,
        html: params.html,
      },
      'RESEND_API_KEY not set — logging email instead of sending',
    );
    return { sent: true };
  }

  try {
    const result = await client.emails.send({
      from: env.EMAIL_FROM ?? 'RVA Academy <no-reply@rva.academy>',
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });

    if (result.error) {
      logger.error({ err: result.error, to: params.to }, 'Resend send failed');
      return { sent: false, reason: result.error.message };
    }

    return { sent: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown email error';
    logger.error({ err: error, to: params.to }, 'Resend send threw');
    return { sent: false, reason };
  }
}
