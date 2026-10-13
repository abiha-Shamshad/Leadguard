import type { Metadata } from 'next';
import { BillingView } from '@/views/billing';

export const metadata: Metadata = { title: 'Subscription' };

export default function Page() {
  return <BillingView />;
}
