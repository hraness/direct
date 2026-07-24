import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Direct",
    short_name: "Direct",
    description:
      "Named, repeatable app states for browser agents working on real interfaces.",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f6f1",
    theme_color: "#f6f6f1",
  };
}
