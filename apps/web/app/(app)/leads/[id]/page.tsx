import type { Metadata } from 'next';
import { LeadDetailView } from '@/views/lead-detail';

export const metadata: Metadata = { title: 'Lead' };

export default function Page() {
  return <LeadDetailView />;
}
