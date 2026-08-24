import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Mopsfin 台股 MCP｜ChatGPT 與 Claude 設定指南",
  description:
    "把 Mopsfin 台灣公司財報與財務指標接進 ChatGPT、Claude 與其他支援遠端 MCP 的 AI。公開、唯讀、免登入。",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
