import type { Metadata } from 'next';
import { InboxView } from '@/views/inbox';

export const metadata: Metadata = { title: 'Needs action' };

export default function Page() {
  return <InboxView />;
}
