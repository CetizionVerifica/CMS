import {
  MOCK_MFA_CODE,
  MOCK_PASSWORD,
  MOCK_TWO_FIRM_EMAIL,
  MOCK_UNENROLLED_EMAIL,
  MOCK_USERS,
} from '../api/mock';

/** Shown only while the in-process mock API is answering (no CANOPY_API_URL), so the app can be tried end to end. */
export function DemoAccounts() {
  return (
    <details className="mt-5.5 border-t border-line pt-3.5 text-meta text-muted">
      <summary className="cursor-pointer font-semibold text-ink">Demo accounts</summary>
      <p className="mt-2">
        Password for each: <code className="text-ink">{MOCK_PASSWORD}</code>. Firm users then enter
        code <code className="text-ink">{MOCK_MFA_CODE}</code>.
      </p>
      <ul className="mt-1 list-disc pl-5">
        {MOCK_USERS.map((u) => (
          <li key={u.person.id}>
            {u.person.email} (
            {u.memberships.map((m) => m.role.toLowerCase().replace('_', ' ')).join(', ')}
            {u.person.email === MOCK_TWO_FIRM_EMAIL ? ', in two firms' : ''}
            {u.person.email === MOCK_UNENROLLED_EMAIL ? ', sets up MFA at first sign-in' : ''})
          </li>
        ))}
      </ul>
    </details>
  );
}
