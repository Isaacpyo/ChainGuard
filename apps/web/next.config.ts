import type { NextConfig } from 'next';

// Static export: Netlify serves plain files and the browser talks to the API directly.
const config: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@chainguard/shared'],
  poweredByHeader: false,
};

export default config;
