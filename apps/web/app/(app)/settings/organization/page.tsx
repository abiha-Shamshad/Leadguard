import type { Metadata } from 'next';
import { OrganizationView } from '@/views/organization';

export const metadata: Metadata = { title: 'Organization' };

export default function Page() {
  return <OrganizationView />;
}
