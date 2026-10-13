import type { Metadata } from 'next';
import { SignInView } from '@/views/sign-in';

export const metadata: Metadata = { title: 'Sign in' };

export default function Page() {
  return <SignInView />;
}
