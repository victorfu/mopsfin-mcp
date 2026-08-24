"use client";

import { useState } from "react";

type CopyButtonProps = {
  value: string;
  label: string;
};

export function CopyButton({ value, label }: CopyButtonProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
      window.setTimeout(() => setStatus("idle"), 1800);
    } catch {
      setStatus("error");
    }
  }

  const buttonLabel = status === "copied" ? "已複製" : status === "error" ? "請手動複製" : label;

  return (
    <button className="copyButton" type="button" onClick={copy} aria-live="polite">
      <span aria-hidden="true">{status === "copied" ? "✓" : "□"}</span>
      {buttonLabel}
    </button>
  );
}
