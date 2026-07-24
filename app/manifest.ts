import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Direct",
    short_name: "Direct",
    description:
      "Deterministic scenarios and verification for real application interfaces.",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f6f1",
    theme_color: "#f6f6f1",
  };
}
