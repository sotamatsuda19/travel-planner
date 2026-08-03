import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 親ディレクトリの lockfile を拾わないよう、このプロジェクトをルートとして固定する
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
