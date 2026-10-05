"use client";

import { useCallback, useRef, useState } from "react";

const ACCEPT = ".pdf,.txt,.md,.markdown,.docx";

/**
 * Presentational drag-and-drop + click-to-browse file picker.
 * It knows NOTHING about the network — it just hands selected File[] to onFiles.
 * This keeps it reusable and trivially testable.
 */
export function FileDropzone({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length) onFiles(files);
    },
    [onFiles, disabled],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      className={[
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition",
        isDragging ? "border-neutral-800 bg-surface-muted" : "border-surface-border bg-surface",
        disabled ? "cursor-not-allowed opacity-50" : "hover:bg-surface-muted",
      ].join(" ")}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = ""; // allow re-selecting the same file
        }}
      />
      <div className="text-sm font-medium">
        Drag &amp; drop files here, or click to browse
      </div>
      <div className="text-xs text-neutral-500">
        PDF, TXT, Markdown, DOCX · multiple files supported
      </div>
    </div>
  );
}
