import type { Metadata } from 'next';
import { SourcesView } from '@/views/sources';

export const metadata: Metadata = { title: 'Sources' };

export default function Page() {
  return <SourcesView />;
}
