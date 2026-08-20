'use client';

import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { InputField, TextareaField } from '@/components/ui/Field';
import { FileDropzone } from '@/components/ui/FileDropzone';
import { Modal } from '@/components/ui/Modal';
import { ApiError, api } from '@/lib/api';
import { parseLeads, type Lead } from '@/lib/leads';
import { formatDateTime, formatDuration, toDateTimeLocalValue } from '@/lib/format';
import { estimateLastSendAt } from './schedulePreview';

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  onScheduled: () => void;
  /** Defaults pulled from the API so the form matches the server's config. */
  defaults: { delayMs: number; hourlyLimit: number; windowMs: number };
}

interface FormErrors {
  subject?: string;
  body?: string;
  leads?: string;
  startAt?: string;
}

const DEFAULT_LEAD_TIME_MS = 5 * 60 * 1000;

export function ComposeModal({ open, onClose, onScheduled, defaults }: ComposeModalProps) {
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [startAt, setStartAt] = useState(() => toDateTimeLocalValue(new Date(Date.now() + DEFAULT_LEAD_TIME_MS)));
  const [delaySeconds, setDelaySeconds] = useState(String(Math.round(defaults.delayMs / 1000)));
  const [hourlyLimit, setHourlyLimit] = useState(String(defaults.hourlyLimit));
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
  const limit = Math.max(0, Number(hourlyLimit) || 0);

  const finishesAt = useMemo(() => {
    const start = new Date(startAt);
    if (Number.isNaN(start.getTime())) return null;
    return estimateLastSendAt({
      count: leads.length,
      startAt: start,
      delayMs,
      hourlyLimit: limit,
      windowMs: defaults.windowMs,
    });
  }, [startAt, leads.length, delayMs, limit, defaults.windowMs]);

  const reset = () => {
    setName('');
    setSubject('');
    setBody('');
    setFileName(null);
    setLeads([]);
    setStartAt(toDateTimeLocalValue(new Date(Date.now() + DEFAULT_LEAD_TIME_MS)));
    setErrors({});
  };

  const close = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const validate = (): boolean => {
    const next: FormErrors = {};
    if (!subject.trim()) next.subject = 'Give the email a subject.';
    if (!body.trim()) next.body = 'Write something for your leads to read.';
    if (leads.length === 0) next.leads = 'Upload a CSV or TXT file with at least one email address.';
    if (Number.isNaN(new Date(startAt).getTime())) next.startAt = 'Pick a valid start time.';

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;

    setSubmitting(true);
    try {
      const result = await api.schedule({
        name: name.trim() || fileName || null,
        subject: subject.trim(),
        body: body.trim(),
        startAt: new Date(startAt).toISOString(),
        delayBetweenEmailsMs: delayMs,
        hourlyLimit: limit,
        recipients: leads,
        // Guards against a double-click or a retried request creating the
        // campaign twice.
        idempotencyKey: crypto.randomUUID(),
      });

      const notes: string[] = [];
      if (result.skipped.duplicates > 0) notes.push(`${result.skipped.duplicates} duplicate(s) removed`);
      if (result.startAtAdjusted) notes.push('start time moved to now');

      toast.success(
        `Scheduled ${result.scheduledCount} email${result.scheduledCount === 1 ? '' : 's'}` +
          (notes.length > 0 ? ` — ${notes.join(', ')}` : ''),
      );

      reset();
      onScheduled();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not schedule this campaign.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Compose new email"
      description="Upload your leads, set the pace, and the scheduler takes it from there."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={submitting}>
            {leads.length > 0 ? `Schedule ${leads.length} email${leads.length === 1 ? '' : 's'}` : 'Schedule'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
        <div className="space-y-4">
          <InputField
            label="Subject"
            value={subject}
            error={errors.subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Quick question about your outbound"
            maxLength={500}
          />

          <TextareaField
            label="Body"
            value={body}
            error={errors.body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={'Hi there,\n\nI noticed...'}
            rows={9}
            hint={`${body.length} characters`}
          />

          <InputField
            label="Campaign name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Optional - defaults to the file name"
            maxLength={200}
          />
        </div>

        <div className="space-y-4">
          <FileDropzone
            fileName={fileName}
            detectedCount={leads.length}
            error={errors.leads}
            onClear={() => {
              setFileName(null);
              setLeads([]);
            }}
            onFile={(file, text) => {
              const parsed = parseLeads(text);
              setFileName(file.name);
              setLeads(parsed.leads);
              setErrors((current) => ({ ...current, leads: undefined }));

              if (parsed.leads.length === 0) {
                toast.error('No email addresses found in that file.');
              } else if (parsed.duplicates > 0) {
                toast(`${parsed.duplicates} duplicate address(es) will be skipped.`, { icon: '!' });
              }
            }}
          />

          <InputField
            label="Start time"
            type="datetime-local"
            value={startAt}
            error={errors.startAt}
            onChange={(event) => setStartAt(event.target.value)}
          />

          <div className="grid grid-cols-2 gap-3">
            <InputField
              label="Delay"
              type="number"
              min={0}
              max={3600}
              value={delaySeconds}
              hint="seconds"
              onChange={(event) => setDelaySeconds(event.target.value)}
            />
            <InputField
              label="Hourly limit"
              type="number"
              min={0}
              max={100000}
              value={hourlyLimit}
              hint="0 = off"
              onChange={(event) => setHourlyLimit(event.target.value)}
            />
          </div>

          <dl className="space-y-1.5 rounded-xl border border-surface-border bg-surface-base/40 p-3.5 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Recipients</dt>
              <dd className="tabular-nums text-slate-300">{leads.length}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Spacing</dt>
              <dd className="tabular-nums text-slate-300">{formatDuration(delayMs)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Last send (est.)</dt>
              <dd className="tabular-nums text-slate-300">
                {finishesAt ? formatDateTime(finishesAt.toISOString()) : '-'}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </Modal>
  );
}
