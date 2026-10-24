// How evidence files read and open, wherever they are listed (the instance drawer, the evidence vault).
import type { EvidenceView } from '@canopy/contracts';

import type { Outcome } from './instance-api';

const MB = 1024 * 1024;

/** "2 MB", "340 KB": never "0 KB". */
export const fileSize = (bytes: number) =>
  bytes >= MB
    ? `${Math.round((bytes / MB) * 10) / 10} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The virus check's result in words. */
export const SCAN_TEXT: Record<EvidenceView['scanStatus'], string> = {
  PENDING: 'Checking for viruses',
  CLEAN: 'Ready',
  INFECTED: 'Blocked: failed virus check',
  FAILED: 'Virus check failed',
};

/**
 * Opens a file in a new tab through a 5-minute signed URL fetched on the click. The tab opens first, so the browser
 * treats it as the click's own window; the URL is never stored or logged (root rule 6). Answers an error message, or
 * null once the file is opening.
 */
export async function openEvidence(
  evidenceId: string,
  link: (id: string) => Promise<Outcome<string>>,
): Promise<string | null> {
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  const result = await link(evidenceId).catch(() => null);
  if (result?.ok && tab) {
    tab.location.href = result.data;
    return null;
  }
  tab?.close();
  return result?.ok
    ? 'Allow pop-ups for this site to open evidence.'
    : (result?.message ?? 'The file didn’t open. Try again.');
}
