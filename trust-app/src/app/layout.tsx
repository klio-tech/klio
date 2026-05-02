import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Klio — your AI agents, finally talking to each other",
  description: "See and control everything Klio remembers about you.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
