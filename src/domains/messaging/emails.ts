/** Email bodies for messaging events (sent through the notifications queue's `send-email` job). */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

function layout(title: string, paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p style="font-size:15px;color:#585E70;margin:0 0 12px">${escapeHtml(p)}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#0A1556;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td><h1 style="margin:0 0 16px;font-size:22px;color:#1B1D28">${escapeHtml(title)}</h1>${body}</td></tr></table></td></tr></table></body></html>`;
}

function email(subject: string, title: string, paragraphs: string[]): EmailContent {
  return { subject, text: paragraphs.join('\n\n'), html: layout(title, paragraphs) };
}

export function welcomeEmail(firstName: string | null): EmailContent {
  return email('Welcome to WishMe', `Welcome${firstName ? `, ${firstName}` : ''}!`, [
    `Hi ${firstName || 'there'}, your WishMe account is ready.`,
    'Send personalised wishes from your favourite celebrities, create greeting cards and songs, and let your assistant remember every occasion for you.',
  ]);
}

/** To the celebrity when a fan subscribes (production's send-celebrity-subscription-email sends only this one). */
export function newSubscriberEmail(celebrityFirstName: string, subscriberName: string, priceRupees: string | null, followerCount: number): EmailContent {
  return email(`New Subscriber: ${subscriberName} just followed you!`, 'New subscriber', [
    `Hi ${celebrityFirstName}, ${subscriberName} just subscribed to your profile on WishMe${priceRupees ? ` for ₹${priceRupees}` : ''}.`,
    'They can now request video wishes, book services and send you direct messages.',
    `Total followers: ${followerCount}.`,
  ]);
}