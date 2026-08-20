'use client';

import { useCallback, useRef, useState, type DragEvent } from 'react';
import { cn } from '@/lib/cn';
import { ACCEPTED_LEAD_TYPES } from '@/lib/leads';

interface FileDropzoneProps {
  onFile: (file: File, text: string) => void;
  fileName: string | null;
  detectedCount: number | null;
  error?: string | null;
  onClear: () => void;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Drag-and-drop (or click) upload for the CSV/TXT lead list. */
export function FileDropzone({ onFile, fileName, detectedCount, error, onClear }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;

      if (file.size > MAX_FILE_BYTES) {
        setReadError('That file is larger than 10 MB. Split the list and try again.');
        return;
      }

      try {
        setReadError(null);
        onFile(file, await file.text());
      } catch {
        setReadError('Could not read that file.');
      }
    },
    [onFile],
  );

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void handleFile(event.dataTransfer.files?.[0]);
  };

  const message = error ?? readError;

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Lead list</p>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
        }}
        className={cn(
          'cursor-pointer rounded-xl border border-dashed px-4 py-6 text-center transition-colors',
          isDragging ? 'border-brand-500 bg-brand-500/5' : 'border-surface-border hover:border-slate-600',
          message && 'border-rose-500/60',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_LEAD_TYPES}
          className="hidden"
          onChange={(event) => void handleFile(event.target.files?.[0] ?? undefined)}
        />

        {fileName ? (
          <div className="space-y-1">
            <p className="text-sm font-medium text-slate-200">{fileName}</p>
            <p className="text-sm text-brand-300">
              {detectedCount === 1 ? '1 email address detected' : `${detectedCount ?? 0} email addresses detected`}
            </p>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setReadError(null);
                onClear();
                if (inputRef.current) inputRef.current.value = '';
              }}
              className="text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
            >
              Choose a different file
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-sm text-slate-300">
              Drop a CSV or TXT file here, or <span className="text-brand-300">browse</span>
            </p>
            <p className="text-xs text-slate-500">One address per row, or any CSV with an email column</p>
          </div>
        )}
      </div>

      {message && <p className="text-xs text-rose-400">{message}</p>}
    </div>
  );
}
