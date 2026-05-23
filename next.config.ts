import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

const googleMapsCspSources = [
  "https://maps.googleapis.com",
  "https://maps.gstatic.com",
  "https://www.gstatic.com",
  "https://routes.googleapis.com",
  "https://*.googleapis.com",
  "https://*.gstatic.com",
  "https://*.google.com",
  "https://www.google.com",
  "https://google.com",
  "https://*.google.com",
  "https://*.google-analytics.com",
];

const joinWithSpaces = (values: string[]) => values.join(" ");

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' blob:${isProduction ? "" : " 'unsafe-eval'"} ${joinWithSpaces(googleMapsCspSources)}`,
  `worker-src 'self' blob: ${joinWithSpaces(googleMapsCspSources)}`,
  `child-src 'self' blob: ${joinWithSpaces(googleMapsCspSources)}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com",
  "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  `connect-src 'self' data: https://*.supabase.co wss://*.supabase.co ${joinWithSpaces(googleMapsCspSources)}`,
  `frame-src 'self' blob: https://maps.google.com https://www.google.com https://www.google.com/maps https://maps.google.com/maps ${joinWithSpaces(googleMapsCspSources)}`,
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(self), payment=()",
  },
  {
    key: "Cross-Origin-Opener-Policy",
    value: "same-origin",
  },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
  allowedDevOrigins: [
    "192.168.1.45",
    "imagines-sixfold-corny.ngrok-free.dev",
    "*.ngrok-free.dev",
    "*.trycloudflare.com",
  ],
  async headers() {
    return [
      {
        headers: securityHeaders,
        source: "/:path*",
      },
    ];
  },
};

export default nextConfig;
