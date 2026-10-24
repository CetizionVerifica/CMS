import { once } from 'node:events';
import { Readable } from 'node:stream';
import archiver from 'archiver';
import type { ArchiveEvidence } from '../dashboard/ports.js';
import { slug } from './service.js';

/** What one evidence file sits under in the archive: its instance's due date, obligation and unit. */
export interface ArchiveInstance {
  dueDate: string;
  title: string;
  unitName: string;
}

export interface ClientArchiveInput {
  clientName: string;
  /** The client's whole register, as the REGISTER_XLSX export builds it. */
  register: Uint8Array;
  evidence: readonly ArchiveEvidence[];
  /** Evidence the archive leaves out because its scan is not CLEAN. */
  withheld: number;
  instances: ReadonlyMap<string, ArchiveInstance>;
  /** Opens one stored file; null when it is missing from storage. */
  open(storageKey: string): Promise<AsyncIterable<Uint8Array> | null>;
  generatedAt: string;
}

/** A file name safe inside a zip on any system: no folders, no `..`, no control characters, at most 150 characters. */
export function safeFileName(name: string): string {
  const cleaned = [...name]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? '_' : ch))
    .join('')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  if (cleaned === '') return 'file';
  if (cleaned.length <= 150) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 150 - ext.length) + ext;
}

function csvCell(value: string | number): string {
  const text = String(value);
  // A leading =, +, - or @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function readme(input: ClientArchiveInput, files: number, missing: number): string {
  const lines = [
    `PlanetPulse Compliance: archive of ${input.clientName}`,
    `Generated ${input.generatedAt} (UTC).`,
    '',
    'register.xlsx        Every compliance item of the client, all dates, in the register layout. It can be',
    '                     imported again.',
    'evidence/            The evidence files, one folder per item: due date, obligation and unit.',
    'evidence/index.csv   Each file with its item, unit, due date, upload time and SHA-256 checksum.',
    '',
    `Evidence files included: ${files}.`,
  ];
  if (input.withheld > 0) {
    lines.push(
      `Left out: ${input.withheld} file(s) whose virus scan is pending or did not pass. They stay in the account.`,
    );
  }
  if (missing > 0) {
    lines.push(`Not found in storage: ${missing} file(s). PlanetPulse support can look into it.`);
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * The client archive as a zip stream: the register, then each clean evidence file read from storage one at a time
 * (so only one is open at once), then the index and a README. Errors end the stream with that error. Nothing here
 * logs file names or contents (root CLAUDE.md non-negotiable 6).
 */
export function clientArchive(input: ClientArchiveInput): Readable {
  const zip = archiver('zip', { zlib: { level: 6 } });
  const add = async (source: Buffer | Readable, name: string, date?: Date) => {
    const added = once(zip, 'entry');
    zip.append(source, { name, ...(date && { date }) });
    await added;
  };
  void (async () => {
    await add(Buffer.from(input.register), 'register.xlsx');
    const index = [
      ['File', 'Obligation', 'Unit', 'Due date', 'Uploaded at', 'Size (bytes)', 'SHA-256'].join(
        ',',
      ),
    ];
    const used = new Set<string>();
    let files = 0;
    let missing = 0;
    for (const file of input.evidence) {
      const body = await input.open(file.storageKey);
      if (body === null) {
        missing += 1;
        continue;
      }
      const instance = input.instances.get(file.instanceId);
      const folder = instance
        ? `${instance.dueDate} ${slug(instance.title)} ${slug(instance.unitName)}`.slice(0, 120)
        : 'other';
      let path = `evidence/${folder}/${safeFileName(file.fileName)}`;
      for (let n = 2; used.has(path); n++) {
        path = `evidence/${folder}/${n} ${safeFileName(file.fileName)}`;
      }
      used.add(path);
      await add(Readable.from(body), path, new Date(file.uploadedAt));
      files += 1;
      index.push(
        [
          path.slice('evidence/'.length),
          instance?.title ?? '',
          instance?.unitName ?? '',
          instance?.dueDate ?? '',
          file.uploadedAt,
          file.sizeBytes,
          file.sha256,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    await add(Buffer.from(index.join('\r\n') + '\r\n'), 'evidence/index.csv');
    await add(Buffer.from(readme(input, files, missing)), 'README.txt');
    await zip.finalize();
  })().catch((error: unknown) =>
    zip.destroy(error instanceof Error ? error : new Error('archive')),
  );
  return zip;
}
