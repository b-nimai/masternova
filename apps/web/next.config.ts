import type { NextConfig } from 'next';

// Same-origin in dev: the browser hits localhost:3000/api/* and Next proxies it to the
// NestJS api, so the session cookie stays first-party — mirroring the prod Ingress (§2).
const apiUrl = process.env.API_URL ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@masternova/shared'],
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiUrl}/api/:path*` },
      { source: '/socket/:path*', destination: `${apiUrl}/socket/:path*` },
    ];
  },
};

export default nextConfig;
