/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Next type-checks the app only (src/); `npm run typecheck` covers spike/, src/ and test/ with tsconfig.json.
  typescript: { tsconfigPath: "tsconfig.next.json" },
  reactStrictMode: true,
  serverExternalPackages: ["sharp"],
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
};
export default nextConfig;
