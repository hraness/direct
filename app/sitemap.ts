import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{
    url: "https://hraness.direct",
    lastModified: "2026-07-24",
    changeFrequency: "monthly",
    priority: 1,
  }];
}
