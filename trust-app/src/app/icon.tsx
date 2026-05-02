import { ImageResponse } from "next/og";

/**
 * Favicon — generated at build time from the same geometry as the
 * KlioMark component. Three horizontal bars on warm paper, middle
 * one indented. Stays legible at 16×16 because the bars are 2px
 * tall on a 24×24 grid (~1.3px at favicon size).
 */
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#fafaf7",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect x="3" y="6" width="18" height="2" fill="#0a0a0a" />
          <rect x="8" y="11" width="13" height="2" fill="#0a0a0a" />
          <rect x="3" y="16" width="18" height="2" fill="#0a0a0a" />
        </svg>
      </div>
    ),
    size,
  );
}
