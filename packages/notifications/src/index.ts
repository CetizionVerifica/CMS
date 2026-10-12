// @canopy/notifications: email templates for reminders, escalations, digests, approval requests and send-backs (MODULES.md M9).
// Pure rendering; sending, dedupe and scheduling live in apps/api/src/jobs.
export { EMAIL_COLORS, PRODUCT_NAME } from './brand.js';
export { escapeHtml, formatDate } from './format.js';
export {
  CRITICALITY_LABEL,
  renderEmail,
  type ApprovalRequestedEmail,
  type ApproverEscalationEmail,
  type ConsultantDigestEmail,
  type DigestClientSummary,
  type EmailMessage,
  type InstanceSummary,
  type OwnerReminderEmail,
  type RenderedEmail,
  type SentBackEmail,
} from './templates.js';
