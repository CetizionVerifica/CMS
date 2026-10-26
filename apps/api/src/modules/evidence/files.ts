import { Id } from '@canopy/contracts';
import { ApiError } from '../../auth/index.js';

/**
 * Allowed evidence types (api-conventions.md §6): the extension decides, and the declared MIME type must be
 * one a browser sends for it. Anything else is VALIDATION before a URL is signed.
 */
export const ALLOWED_TYPES: Readonly<Record<string, readonly string[]>> = {
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  heic: ['image/heic', 'image/heif'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  xls: ['application/vnd.ms-excel'],
  csv: ['text/csv', 'application/vnd.ms-excel'],
  txt: ['text/plain'],
  zip: ['application/zip', 'application/x-zip-compressed'],
};

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/** The MIME type without parameters, lower case ("text/plain; charset=utf-8" → "text/plain"). */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0]!.trim().toLowerCase();
}

export function isAllowedType(fileName: string, mimeType: string): boolean {
  return (ALLOWED_TYPES[extensionOf(fileName)] ?? []).includes(baseMimeType(mimeType));
}

export function requireAllowedType(fileName: string, mimeType: string): void {
  if (!isAllowedType(fileName, mimeType)) {
    throw new ApiError('VALIDATION', {
      issues: [
        {
          path: ['fileName'],
          message:
            'This file type is not accepted. Use PDF, PNG, JPG, HEIC, DOCX, XLSX, XLS, CSV, TXT or ZIP.',
        },
      ],
    });
  }
}

/**
 * The name shown and used in downloads: the last path segment only, so a name such as `../x.pdf` or
 * `C:\scans\x.pdf` is stored as `x.pdf`. A name with nothing left is a validation error.
 */
export function displayName(fileName: string): string {
  const name = fileName
    .slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1)
    .trim();
  if (name === '' || name === '.' || name === '..') {
    throw new ApiError('VALIDATION', {
      issues: [{ path: ['fileName'], message: 'Give the file a name.' }],
    });
  }
  return name;
}

/** Where an upload is stored. Derived from the upload id, so confirming needs no extra table. */
export function storageKey(input: {
  firmId: string;
  clientId: string;
  instanceId: string;
  uploadId: string;
}): string {
  return `evidence/${input.firmId}/${input.clientId}/${input.instanceId}/${input.uploadId}`;
}

/**
 * An upload id is the uuid the upload ticket gave out. It becomes the last segment of a storage key, so anything else
 * (such as `../..`) is a validation error before any key is built.
 */
export function requireUploadId(uploadId: string): void {
  if (!Id.safeParse(uploadId).success) {
    throw new ApiError('VALIDATION', {
      issues: [{ path: ['uploadId'], message: 'This is not an upload id.' }],
    });
  }
}
