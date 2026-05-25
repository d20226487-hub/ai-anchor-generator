import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin libsql as external so Next doesn't try to bundle its native binding — required
  // for the data.db SQLite layer to load correctly under server runtime.
  serverExternalPackages: ["@libsql/client", "libsql"],
  // Emit a self-contained runtime under `.next/standalone/` during `next build`. The
  // Dockerfile only copies that folder + `.next/static` + `public`, so the production
  // image stays ~150 MB instead of carrying full node_modules. No effect on `npm run dev`.
  output: "standalone",
};

export default nextConfig;
