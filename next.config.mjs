/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Produce a minimal standalone server bundle for Docker/self-host deploys.
  // (Vercel ignores this and uses its own build output.)
  output: "standalone",

  // Node-only libraries that must run on the Node.js runtime (not Edge) and must
  // never be bundled into client code. `serverExternalPackages` leaves them as
  // real Node `require`s on the server.
  //
  // pdf-parse / mammoth: document parsing (Phase 2).
  // pdfkit: PDF export (Phase 17). It loads its built-in font metrics (.afm) from
  // disk at runtime, which a bundler would otherwise rewrite and break.
  serverExternalPackages: ["pdf-parse", "mammoth", "pdfkit"],
};

export default nextConfig;
