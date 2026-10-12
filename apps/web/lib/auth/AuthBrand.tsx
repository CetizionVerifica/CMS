import { Leaf } from 'lucide-react';

import { PRODUCT_NAME } from '../brand';

/** Logo mark and product name above the auth card. */
export function AuthBrand() {
  return (
    <div className="mb-5.5 flex items-center gap-2">
      <span className="inline-flex size-8 items-center justify-center rounded-chip bg-forest">
        <Leaf aria-hidden size={18} strokeWidth={1.75} className="text-moss" />
      </span>
      <span className="text-[17px] font-extrabold text-ink">{PRODUCT_NAME}</span>
    </div>
  );
}
