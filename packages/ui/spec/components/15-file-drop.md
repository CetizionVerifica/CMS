# FileDrop

Evidence upload: challans, filled forms, log sheets. Also used for the Excel file in the import wizard (single-file mode).

## Anatomy
1. **Zone** (min height 96px, 2px dashed `--line-strong`, `radius-card`, bg `--surface`): `UploadCloud` 20px · "Drag files here or **choose files**" (the "choose files" part is a real `<button>`) · hint `type-meta` `--muted`: "PDF, JPG, PNG, XLSX, DOCX up to 25 MB each".
2. **File list** below: row per file (48px): type badge (28×32, `radius-tag`, `--neutral-soft`, `type-label` "PDF") · name (`type-body`, middle-truncated "Challan_Ap…_2022.pdf") · size and state (`type-meta` `--muted`) · progress bar while uploading · trailing IconButton (Cancel / Remove / Retry).

## File states
| State | Meta text | Visual |
|---|---|---|
| Queued | Waiting | |
| Uploading | 42% · 1.2 of 2.8 MB | ProgressBar `single` |
| Scanning | Checking for viruses | spinner 16px |
| Ready | 2.8 MB · Added by Priya Rane · 12 Apr 2027 | ok `CheckCircle2` |
| Blocked | Blocked: failed virus check | crit-ink text, row bg `--crit-soft`, Remove only |
| Too large / wrong type | "Too large (31 MB). Max 25 MB." | crit-ink, file never uploads |
| Failed | Upload failed | Retry |

## Zone states
Rest · hover (border `--forest`) · focus-within (ring on zone) · drag-over (border solid `--forest`, bg `--mist`, text "Drop to upload") · disabled ("Evidence can't be changed after approval", `--muted`, no dashed border) · single-file mode filled (zone replaced by the file row + "Replace file").

## Props
```ts
type FileDropProps = {
  accept: string[]; maxBytes: number; multiple?: boolean;
  files: UploadItem[];                 // controlled; upload transport lives in the web app
  onAdd: (files: File[]) => void; onRemove: (id: string) => void; onRetry: (id: string) => void; onCancel: (id: string) => void;
  disabled?: { reason: string };
};
```
Limits (types, 25 MB) are defaults to confirm with M7; the component validates on the client for speed, the API validates again.

## Privacy (root non-negotiable 6)
Never render signed URLs in the DOM until the user clicks (fetch on click, open, discard). Never log file names or contents to the console or analytics. No thumbnails of evidence in v1.

## Keyboard and accessibility
The zone is not itself focusable; the "choose files" button is, and opens the native picker. Paste (Ctrl/Cmd+V) of files is accepted while focus is inside the component. Each state change is announced in a polite live region ("Challan_Apr.pdf uploaded, checking for viruses"; "…ready"). Remove buttons are named "Remove Challan_Apr.pdf"; removal of a Ready file goes through ConfirmDialog because it writes an audit event.
