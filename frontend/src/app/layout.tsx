import type { Metadata } from "next";
import { Instrument_Serif, JetBrains_Mono, Mulish } from "next/font/google";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { Providers } from "@/components/Providers";
import "./globals.css";

const serif = Instrument_Serif({ weight: "400", style: ["normal", "italic"], subsets: ["latin"], variable: "--font-instrument" });
const sans = Mulish({ weight: ["400", "500", "600", "700", "800"], subsets: ["latin"], variable: "--font-mulish" });
const mono = JetBrains_Mono({ weight: ["400", "500"], subsets: ["latin"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: { default: "Arkivate", template: "%s · Arkivate" },
  description: "Arkiv data expires. Arkivate reacts. Open-source triggers for Arkiv, run by independent workers, with a public receipt for every reaction.",
};

// Applied before paint so a saved light theme doesn't flash dark first.
const themeScript = `try{var t=localStorage.getItem("arkivate.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen overflow-x-hidden">
        <Providers>
          <Header />
          {/* Decorative arcs bleed off the edges by design; clip them so the page never scrolls sideways. */}
          <div className="relative overflow-x-clip">{children}</div>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
