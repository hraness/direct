import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import {
  DIRECT_DESCRIPTION,
  DIRECT_SITE_URL,
  DIRECT_TITLE,
} from "./site-shell";

const siteUrl = new URL(DIRECT_SITE_URL);

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: DIRECT_TITLE,
  description: DIRECT_DESCRIPTION,
  alternates: { canonical: "/" },
  applicationName: "Direct",
  openGraph: {
    type: "website",
    url: "/",
    siteName: "direct",
    title: DIRECT_TITLE,
    description: DIRECT_DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: DIRECT_TITLE,
    description: DIRECT_DESCRIPTION,
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
