import type { Metadata } from "next";
import "./styles.css";
export const metadata: Metadata = { title: "DevHub — Contribution Inbox", description: "AI-native contribution processing for developers and agents." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
