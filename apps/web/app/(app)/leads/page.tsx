import type { Metadata } from 'next';
import { LeadsView } from '@/views/leads';

export const metadata: Metadata = { title: 'All leads' };

export default function Page() {
  return <LeadsView />;
}
