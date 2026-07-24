import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

const description =
  "Deterministic app states for browser agents.";
const siteUrl = new URL("https://hraness.direct");

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: "direct — deterministic app states for browser agents",
  description,
  alternates: { canonical: "/" },
  applicationName: "Direct",
  openGraph: {
    type: "website",
    url: "/",
    siteName: "direct",
    title: "direct — deterministic app states for browser agents",
    description,
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "direct — deterministic app states for browser agents",
    description,
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#151515" },
  ],
};

export default function RootLayout(
  { children }: Readonly<{ children: ReactNode }>,
) {
  return (
    <html lang="en-US">
      <body className="plain-site">{children}</body>
    </html>
  );
}
