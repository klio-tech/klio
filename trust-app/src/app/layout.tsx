import type { Metadata } from "next";
import { IBM_Plex_Mono, Instrument_Serif } from "next/font/google";

import "./globals.css";

/**
 * Two fonts only — supadata-style. IBM Plex Mono carries body, lists,
 * code, button text, and labels. Instrument Serif carries display
 * headlines and italic emphasis. Hierarchy comes from size, weight,
 * and serif-vs-mono contrast — not from a sans+mono+serif zoo or
 * any colour accent.
 *
 * The font is loaded once and exposed via TWO CSS variables —
 * `--font-mono` for explicit code-block contexts and `--font-sans`
 * as the body alias — so legacy references to `--font-sans-stack`
 * keep rendering the right glyphs without a sweep through every
 * inline style.
 */
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-mono",
  display: "swap",
});

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-serif",
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
      className={`${serif.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  );
}
