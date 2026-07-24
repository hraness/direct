import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://hraness.direct",
      lastModified: "2026-07-24",
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: "https://hraness.direct/docs/overview",
      lastModified: "2026-07-24",
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
}
