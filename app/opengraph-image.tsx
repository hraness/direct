import { ImageResponse } from "next/og";

export const alt = "Direct makes interface state deterministic";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#f6f6f1",
          color: "#171914",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          justifyContent: "space-between",
          padding: "72px",
          width: "100%",
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 18 }}>
          <div
            style={{
              alignItems: "center",
              background: "#9bd43f",
              borderRadius: 10,
              color: "#24300e",
              display: "flex",
              fontFamily: "monospace",
              fontSize: 34,
              fontWeight: 800,
              height: 64,
              justifyContent: "center",
              letterSpacing: "-0.12em",
              width: 64,
            }}
          >
            D/
          </div>
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "0.03em" }}>
            Direct
          </div>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 72,
            fontWeight: 600,
            letterSpacing: "-0.055em",
            lineHeight: 1,
            maxWidth: 980,
          }}
        >
          Make interface state deterministic without copying the frontend.
        </div>
        <div style={{ color: "#62675d", display: "flex", fontSize: 25 }}>
          Product-owned ports · named worlds · explicit proof boundaries
        </div>
      </div>
    ),
    size,
  );
}
