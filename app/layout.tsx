import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RAG Agent",
  description: "Production-ready Retrieval Augmented Generation over your documents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface-muted text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
