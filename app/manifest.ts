import type { MetadataRoute } from "next";
import { DIRECT_DESCRIPTION } from "./site-shell";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Direct",
    short_name: "Direct",
    description: DIRECT_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: "#f6f6f1",
    theme_color: "#f6f6f1",
  };
}
