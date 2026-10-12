import { redirect } from 'next/navigation';

// /library opens the Acts view, the library's first tab.
export default function LibraryHome() {
  redirect('/library/acts');
}
