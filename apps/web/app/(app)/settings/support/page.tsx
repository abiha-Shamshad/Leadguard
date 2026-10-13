import type { Metadata } from 'next';
import { SupportView } from '@/views/support';

export const metadata: Metadata = { title: 'Support access' };

export default function Page() {
  return <SupportView />;
}
