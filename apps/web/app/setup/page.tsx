import type { Metadata } from 'next';
import { SetupView } from '@/views/setup';

export const metadata: Metadata = { title: 'Set up' };

export default function Page() {
  return <SetupView />;
}
