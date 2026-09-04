import path from "path";
import { fileURLToPath } from "url";
import type { NextConfig } from "next";
import { withPayload } from "@payloadcms/next/withPayload";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Spawning child processes fails on this Windows host (Node 24 + Defender:
// `child_process.spawn` returns EPERM when trying to spawn the same
// node.exe binary). Next.js spawns a worker for type-checking during
// `next build`; running it inline avoids the spawn and unblocks the
// build. See HANDOFF.md note about the build error from 2026-09-04.
const nextConfig: NextConfig = {
  outputFileTracingRoot: dirname,
  experimental: {
    workerThreads: false,
  },
};

export default withPayload(nextConfig, { devBundleServerPackages: false });
