import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { DirectorAgentProvider } from "@/context/DirectorAgentContext";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cadence AI — Hands-Free Choreography IDE",
  description:
    "A hands-free choreography IDE driven by an Agent-Oriented Architecture, " +
    "backed by AWS and IBM Granite. Built for the IBM AI Builders Challenge.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-neutral-950 text-neutral-50">
        {/*
         * DirectorAgentProvider mounts the DirectorAgent singleton,
         * seeds the Zustand store, and forwards all STATE_UPDATED patches
         * into Zustand for fine-grained React subscriptions.
         *
         * Every page and component in the app has access to:
         *   - useDirectorAgent()   → imperative agent methods
         *   - useCadenceStore(sel) → reactive state slices
         */}
        <DirectorAgentProvider>{children}</DirectorAgentProvider>
      </body>
    </html>
  );
}
