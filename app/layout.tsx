import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "ROD — Repo Onboarding Doctor",
  description: "Fresh-environment onboarding checks for GitHub repositories.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "ui-sans-serif, system-ui, sans-serif", background: "#0b0d10", color: "#f4f7fb" }}>
        {children}
      </body>
    </html>
  );
}
