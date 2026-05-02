import type { Metadata } from "next";
import { IBM_Plex_Mono } from "next/font/google";

import "./globals.css";

/**
 * One font — supadata's actual recipe. IBM Plex Mono carries
 * everything (display, body, code, labels). Hierarchy comes from
 * weight and size only. No serif, no sans, no third typeface.
 *
 * Weights loaded:
 *   300 — light, used for caption-tier annotations
 *   400 — body
 *   500 — medium, used for emphasis within body
 *   600 — semibold, used for h3 + button text
 *   700 — bold, used for display headlines
 */
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://klio.tech"),
  title: {
    default: "Klio — persistent memory for AI agents",
    template: "%s · Klio",
  },
  description:
    "Local-first, encrypted, MCP-native memory for Claude Code, Cursor, and any AI coding agent. Open source.",
  authors: [{ name: "Abhishek Singh", url: "https://klio.tech" }],
  openGraph: {
    title: "Klio — persistent memory for AI agents",
    description:
      "Local-first, encrypted, MCP-native memory for Claude Code, Cursor, and any AI coding agent. Open source.",
    url: "https://klio.tech",
    siteName: "Klio",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Klio — persistent memory for AI agents",
    description:
      "Local-first, encrypted, MCP-native memory for Claude Code, Cursor, and any AI coding agent. Open source.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={mono.variable}
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  );
}
