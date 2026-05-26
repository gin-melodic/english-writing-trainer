import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "中译英自适应训练系统",
  description: "面向中文母语者的英语写作训练工具"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
