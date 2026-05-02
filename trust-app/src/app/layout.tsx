import type { Metadata } from "next";
import { Geist, Instrument_Serif, JetBrains_Mono } from "next/font/google";

import "./globals.css";

const sans = Geist({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
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
      className={`${sans.variable} ${serif.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  );
}
