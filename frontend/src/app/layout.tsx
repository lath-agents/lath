import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ReactNode } from "react";
import { Providers } from "./providers";
import { Nav } from "@/components/Nav";
import { SetupBanner } from "@/components/SetupBanner";
import { WalletGate } from "@/components/WalletGate";
import "./globals.css";

// Self-hosted at build time by `next/font`, so the identity's two faces (Inter, and JetBrains
// Mono for the wordmark and every number and hash) render on any machine, not only one that has
// them installed. The variables are what `tailwind.config.ts`'s families read first.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

const DESCRIPTION =
  "Agent loops that pay for their own AI on Tempo, with a record of every payment anyone can replay on Solana.";

/**
 * The base `og:image` resolves against. Crawlers need an absolute URL, and with no base Next
 * resolves `opengraph-image.jpg` against `http://localhost:3000`, so a shared link's card is blank
 * everywhere but the machine that built it. The console's public origin is already
 * `LATH_CONSOLE_ORIGIN`; a value that does not parse leaves the base unset rather than
 * failing the build, the same answer as leaving it out.
 */
function siteBase(): URL | undefined {
  const origin = process.env.LATH_CONSOLE_ORIGIN?.trim();
  if (!origin) return undefined;
  try {
    return new URL(origin);
  } catch {
    return undefined;
  }
}

export const metadata: Metadata = {
  metadataBase: siteBase(),
  title: { default: "Lath", template: "%s · Lath" },
  description: DESCRIPTION,
  // The image is the file convention's (`opengraph-image.jpg`, with its alt beside it). X reads
  // `og:image` when there is no `twitter:image`, so one file serves both; the card type is the
  // only X tag it needs.
  openGraph: { type: "website", siteName: "Lath", title: "Lath", description: DESCRIPTION },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="flex min-h-screen flex-col">
        <Providers>
          <Nav />
          <div className="mx-auto flex w-full max-w-[83rem] flex-1 flex-col px-4 sm:px-6">
            <SetupBanner />
            <main className="flex-1 py-8 sm:py-10">
              <WalletGate>{children}</WalletGate>
            </main>
            {/* No footer: each page says who signed what where it happens, and docs and explorer links
              would be one more thing on every screen. */}
          </div>
        </Providers>
      </body>
    </html>
  );
}
