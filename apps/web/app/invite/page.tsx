import type { Metadata } from 'next';
import { InviteView } from '@/views/invite';

export const metadata: Metadata = { title: 'Join your team' };

export default function Page() {
  return <InviteView />;
}
