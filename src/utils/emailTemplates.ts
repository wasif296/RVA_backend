import { env } from '../config/env.js';

export type EmailContent = {
  subject: string;
  html: string;
  text: string;
};

/*
  Email HTML is not web HTML. These values are the RVA design-token navy and
  cyan written as hex because clients cannot read CSS variables — this is the
  one place raw hex is correct.

  Constraints this module is built around:
  - Table layout only (no flex/grid — Outlook)
  - Inline styles only (no <style> blocks, no external CSS, no web fonts)
  - 600px max width, readable at 320px
  - Do not rely on a white background for legibility (dark-mode inversion)
  - No tracking pixels, no images required for the email to make sense
*/
const NAVY = '#021F4B';
const CYAN = '#03A3BB';
const SURFACE = '#EEF3F1';
const INK = '#1E2322';
const MUTED = '#515D5B';
const WHITE = '#FFFFFF';
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function logoUrl(): string {
  return `${env.APP_URL.replace(/\/$/, '')}/email-logo.png`;
}

function hiddenPreheader(text: string): string {
  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(text)}</div>`;
}

function renderCtaButton(label: string, href: string): string {
  const safeHref = escapeHtml(href);
  const safeLabel = escapeHtml(label);
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;width:100%;margin:8px 0 16px 0;">
      <tr>
        <td align="center" bgcolor="${NAVY}" style="background-color:${NAVY};border-radius:6px;">
          <a href="${safeHref}" target="_blank" style="display:block;padding:14px 24px;font-family:${FONT};font-size:16px;line-height:22px;font-weight:700;color:${WHITE};text-decoration:none;text-align:center;">${safeLabel}</a>
        </td>
      </tr>
    </table>
  `.trim();
}

function renderBrandedEmail(params: {
  preheader: string;
  heading: string;
  paragraphs: string[];
  ctaLabel: string;
  ctaUrl: string;
  urlHint: string;
  expiryNote: string;
  ignoreNote: string;
}): string {
  const safeHeading = escapeHtml(params.heading);
  const safeUrl = escapeHtml(params.ctaUrl);
  const paragraphHtml = params.paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${INK};">${paragraph}</p>`,
    )
    .join('\n              ');

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${safeHeading}</title>
</head>
<body style="margin:0;padding:0;background-color:${NAVY};color:${SURFACE};">
  ${hiddenPreheader(params.preheader)}
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" bgcolor="${NAVY}" style="border-collapse:collapse;background-color:${NAVY};width:100%;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="border-collapse:collapse;width:100%;max-width:600px;">
          <tr>
            <td align="left" style="padding:8px 24px 20px 24px;">
              <img src="${escapeHtml(logoUrl())}" alt="RVA — Remote VA's Academy" width="59" height="48" style="display:block;border:0;outline:none;text-decoration:none;width:59px;height:auto;max-width:100%;" />
              <p style="margin:12px 0 0 0;font-family:${FONT};font-size:18px;line-height:24px;font-weight:700;color:${WHITE};">RVA Academy</p>
              <p style="margin:4px 0 0 0;font-family:${FONT};font-size:13px;line-height:18px;color:${CYAN};">Remote VA&apos;s Academy</p>
            </td>
          </tr>
          <tr>
            <td bgcolor="${CYAN}" style="background-color:${CYAN};height:4px;line-height:4px;font-size:0;">&nbsp;</td>
          </tr>
          <tr>
            <td bgcolor="${SURFACE}" style="background-color:${SURFACE};color:${INK};padding:28px 24px;">
              <h1 style="margin:0 0 16px 0;font-family:${FONT};font-size:22px;line-height:28px;font-weight:700;color:${NAVY};">${safeHeading}</h1>
              ${paragraphHtml}
              ${renderCtaButton(params.ctaLabel, params.ctaUrl)}
              <p style="margin:0 0 8px 0;font-family:${FONT};font-size:13px;line-height:18px;color:${MUTED};">${escapeHtml(params.urlHint)}</p>
              <p style="margin:0 0 20px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${NAVY};word-break:break-all;overflow-wrap:anywhere;">
                <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:${NAVY};text-decoration:underline;word-break:break-all;">${safeUrl}</a>
              </p>
              <p style="margin:0 0 12px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${escapeHtml(params.expiryNote)}</p>
              <p style="margin:0;font-family:${FONT};font-size:14px;line-height:21px;color:${MUTED};">${escapeHtml(params.ignoreNote)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px 8px 24px;font-family:${FONT};font-size:12px;line-height:18px;color:${CYAN};">
              RVA Academy
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildInviteEmailContent(params: {
  name: string;
  invitedByName: string;
  inviteUrl: string;
}): EmailContent {
  const subject = "You're invited to RVA Academy";
  const text = [
    `Hi ${params.name},`,
    '',
    `${params.invitedByName} invited you to RVA Academy, a learning platform for remote VA skills.`,
    '',
    `Set your password to get started: ${params.inviteUrl}`,
    '',
    'This link expires in 48 hours. If it has expired, contact your administrator for a new invite.',
    '',
    'If you were not expecting this invite, you can safely ignore this email.',
  ].join('\n');

  const html = renderBrandedEmail({
    preheader: `${params.invitedByName} invited you to RVA Academy. This link expires in 48 hours.`,
    heading: `Hi ${params.name}`,
    paragraphs: [
      `${escapeHtml(params.invitedByName)} invited you to RVA Academy, a learning platform for remote VA skills.`,
      'Set your password with the button below to get started.',
    ],
    ctaLabel: 'Set your password',
    ctaUrl: params.inviteUrl,
    urlHint: 'If the button does not work, copy and paste this link into your browser:',
    expiryNote:
      'This link expires in 48 hours. If it has expired, contact your administrator for a new invite.',
    ignoreNote: 'If you were not expecting this invite, you can safely ignore this email.',
  });

  return { subject, html, text };
}

export function buildPasswordResetEmailContent(params: {
  name: string;
  invitedByName: string;
  resetUrl: string;
}): EmailContent {
  const subject = 'Reset your RVA Academy password';
  const text = [
    `Hi ${params.name},`,
    '',
    `${params.invitedByName} requested a password reset for your RVA Academy account, a learning platform for remote VA skills.`,
    '',
    `Set a new password: ${params.resetUrl}`,
    '',
    'This link expires in 48 hours. If it has expired, contact your administrator for a new reset link.',
    '',
    'If you were not expecting this, you can safely ignore this email — your password will not change.',
  ].join('\n');

  const html = renderBrandedEmail({
    preheader: `${params.invitedByName} requested a password reset. This link expires in 48 hours.`,
    heading: `Hi ${params.name}`,
    paragraphs: [
      `${escapeHtml(params.invitedByName)} requested a password reset for your RVA Academy account, a learning platform for remote VA skills.`,
      'Set a new password with the button below.',
    ],
    ctaLabel: 'Set a new password',
    ctaUrl: params.resetUrl,
    urlHint: 'If the button does not work, copy and paste this link into your browser:',
    expiryNote:
      'This link expires in 48 hours. If it has expired, contact your administrator for a new reset link.',
    ignoreNote:
      'If you were not expecting this, you can safely ignore this email — your password will not change.',
  });

  return { subject, html, text };
}
