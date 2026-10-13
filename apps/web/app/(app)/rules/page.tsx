import type { Metadata } from 'next';
import { RulesView } from '@/views/rules';

export const metadata: Metadata = { title: 'Follow-up rules' };

export default function Page() {
  return <RulesView />;
}
