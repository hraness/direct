import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

const description =
  "Direct runs real interfaces against deterministic product-owned ports, with explicit proof boundaries.";
const siteUrl = new URL("https://hraness.direct");

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: "Direct — deterministic interfaces",
  description,
  alternates: { canonical: "/" },
  applicationName: "Direct",
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Direct",
    title: "Direct — deterministic interfaces",
    description,
    images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Direct — deterministic interfaces",
    description,
    images: ["/opengraph-image"],
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f6f1" },
    { media: "(prefers-color-scheme: dark)", color: "#11130f" },
  ],
};

export default function RootLayout(
  { children }: Readonly<{ children: ReactNode }>,
) {
  return (
    <html lang="en-US">
      <body>{children}</body>
    </html>
  );
}
