import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import {
  PRODUCT_DESCRIPTION,
  PRODUCT_DESCRIPTOR,
  PRODUCT_NAME,
} from "@/lib/product-identity";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  applicationName: PRODUCT_NAME,
  title: {
    default: `${PRODUCT_NAME} · ${PRODUCT_DESCRIPTOR}`,
    template: `%s · ${PRODUCT_NAME}`,
  },
  description: PRODUCT_DESCRIPTION,
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: PRODUCT_NAME,
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Nonce-based CSP requires request-time rendering so Next can attach the
  // request nonce to its framework and bootstrap scripts on every page.
  await connection();
  return (
    <html
      lang="en"
      data-font-size="default"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
