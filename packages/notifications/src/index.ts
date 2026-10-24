// @canopy/notifications: email templates for reminders, escalations, digests, approval requests, send-backs, sign-in links, invitations, trial endings, renewals and MFA setup notices (MODULES.md M9).
// Pure rendering; sending, dedupe and scheduling live in apps/api/src/jobs.
export { EMAIL_COLORS, PRODUCT_NAME } from './brand.js';
export { escapeHtml, formatDate } from './format.js';
export {
  CRITICALITY_LABEL,
  ROLE_LABEL,
  renderEmail,
  type ApprovalRequestedEmail,
  type ApproverEscalationEmail,
  type ConsultantDigestEmail,
  type DigestClientSummary,
  type EmailMessage,
  type InstanceSummary,
  type InviteEmail,
  type MagicLinkEmail,
  type MfaEnrolledEmail,
  type OwnerReminderEmail,
  type RenderedEmail,
  type RenewalDueEmail,
  type SentBackEmail,
  type TrialEndingEmail,
} from './templates.js';
