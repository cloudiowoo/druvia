/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Fix for Monaco Editor in Next.js
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };

      // Configure Monaco Editor workers for GraphiQL
      // This allows webpack to properly bundle worker files
      config.module.rules.push({
        test: /\.ttf$/,
        type: 'asset/resource',
      });
    }
    return config;
  },
  // Suppress specific runtime errors in development
  onDemandEntries: {
    // Keep pages in memory for longer
    maxInactiveAge: 60 * 1000,
    pagesBufferLength: 5,
  },
  // Transpile Monaco-related packages
  transpilePackages: ['monaco-editor', 'monaco-graphql'],
};

module.exports = nextConfig;
