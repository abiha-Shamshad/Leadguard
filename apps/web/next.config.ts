import type { NextConfig } from 'next';

// The browser calls /api/v1 on the app origin; Next proxies to the API service, so no contact data or tokens
// ever appear in cross-origin URLs and CORS is not needed in development. Set NEXT_PUBLIC_API_URL to call the
// API origin directly instead (the API allows APP_URL as a CORS origin).
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const PUBLIC_API = process.env.NEXT_PUBLIC_API_URL ?? '';
const CLERK = process.env.NEXT_PUBLIC_AUTH_MODE === 'clerk';
const DEV = process.env.NODE_ENV !== 'production';

// Content-Security-Policy. Next.js App Router emits inline bootstrap scripts, so script-src needs
// 'unsafe-inline' unless a nonce-based proxy is added; everything else is locked to this origin (and Clerk's
// hosted domains when Clerk is enabled). No third-party analytics or scripts are loaded.
const clerkHosts = CLERK ? ' https://*.clerk.accounts.dev https://*.clerk.com https://clerk.leadguard.io https://challenges.cloudflare.com' : '';
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEV ? " 'unsafe-eval'" : ''}${clerkHosts}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob:${CLERK ? ' https://img.clerk.com' : ''}`,
  "font-src 'self' data:",
  `connect-src 'self'${PUBLIC_API ? ` ${new URL(PUBLIC_API).origin}` : ''}${clerkHosts}${DEV ? ' ws: http://localhost:*' : ''}`,
  `frame-src ${CLERK ? clerkHosts.trim() : "'none'"}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(DEV ? [] : ['upgrade-insecure-requests']),
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_URL}/api/v1/:path*` }];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
        ...(DEV ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]),
      ],
    }];
  },
};

export default nextConfig;
