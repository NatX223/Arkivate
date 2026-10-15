import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arkivate",
  description: "If-this-then-that for Arkiv data, run by independent workers.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
