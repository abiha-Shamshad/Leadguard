'use client';
// Shared UI primitives. Every screen uses the same loading, empty, error, read-only and permission-denied
// states (Section 29.1).
import { useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import type { ApiError } from '@/lib/api';
import { stripControl } from '@/lib/limits';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'default'; small?: boolean; pending?: boolean };

export function Button({ variant = 'default', small, pending, children, disabled, className = '', ...rest }: BtnProps) {
  const cls = ['btn', variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : '', small ? 'btn-small' : '', className].filter(Boolean).join(' ');
  return (
    <button className={cls} disabled={disabled || pending} aria-busy={pending || undefined} {...rest}>
      {pending ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} aria-hidden /> : null}
      {children}
    </button>
  );
}

interface FieldShell { label: string; hint?: string; error?: string; children: (id: string, describedBy?: string) => ReactNode }
export function Field({ label, hint, error, children }: FieldShell) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, [hintId, errId].filter(Boolean).join(' ') || undefined)}
      {hint ? <span id={hintId} className="hint">{hint}</span> : null}
      {error ? <span id={errId} className="error" role="alert">{error}</span> : null}
    </div>
  );
}

type ConstraintProps = { label: string; hint?: string; error?: string; /** Shown by the browser when `pattern`/type validation fails. */ invalidMessage?: string };

/** Browser constraint validation with a readable message; cleared as soon as the user edits the field. */
function validityHandlers(invalidMessage?: string) {
  if (!invalidMessage) return {};
  return {
    onInvalid: (e: React.FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      if (el.validity.patternMismatch || el.validity.typeMismatch) el.setCustomValidity(invalidMessage);
    },
    onInput: (e: React.FormEvent<HTMLInputElement | HTMLTextAreaElement>) => e.currentTarget.setCustomValidity(''),
  };
}

export function TextInput({ label, hint, error, invalidMessage, onChange, ...rest }: InputHTMLAttributes<HTMLInputElement> & ConstraintProps) {
  const textual = !rest.type || ['text', 'email', 'tel', 'search', 'url'].includes(rest.type);
  return (
    <Field label={label} hint={hint} error={error}>
      {(id, d) => (
        <input
          id={id} aria-describedby={d} aria-invalid={error ? true : undefined}
          title={invalidMessage}
          {...validityHandlers(invalidMessage)}
          {...rest}
          onChange={e => {
            // Control characters are never valid in LeadGuard text; strip them as the user types or pastes.
            if (textual && e.target.value !== stripControl(e.target.value)) e.target.value = stripControl(e.target.value);
            onChange?.(e);
          }}
        />
      )}
    </Field>
  );
}

export function Select({ label, hint, error, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string; error?: string }) {
  return <Field label={label} hint={hint} error={error}>{(id, d) => <select id={id} aria-describedby={d} aria-invalid={error ? true : undefined} {...rest}>{children}</select>}</Field>;
}

export function TextArea({ label, hint, error, onChange, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string; error?: string }) {
  const len = typeof rest.value === 'string' ? rest.value.length : 0;
  const max = rest.maxLength;
  const counter = max ? `${len}/${max} characters` : undefined;
  return (
    <Field label={label} hint={[hint, counter].filter(Boolean).join(' · ') || undefined} error={error}>
      {(id, d) => (
        <textarea
          id={id} aria-describedby={d} aria-invalid={error ? true : undefined} {...rest}
          onChange={e => {
            if (e.target.value !== stripControl(e.target.value, true)) e.target.value = stripControl(e.target.value, true);
            onChange?.(e);
          }}
        />
      )}
    </Field>
  );
}

export function Card({ children, title, actions, className = '' }: { children: ReactNode; title?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? <div className="row-between" style={{ marginBottom: 12 }}>{title ? <h2 style={{ margin: 0 }}>{title}</h2> : <span />}{actions}</div> : null}
      {children}
    </section>
  );
}

export function Badge({ tone = 'muted', children }: { tone?: 'ok' | 'warn' | 'bad' | 'info' | 'muted'; children: ReactNode }) {
  return <span className={`badge ${tone === 'muted' ? '' : `badge-${tone}`}`}>{children}</span>;
}

export function Banner({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; children: ReactNode; action?: ReactNode }) {
  return <div className={`banner banner-${tone}`} role={tone === 'bad' || tone === 'warn' ? 'alert' : 'status'}><div>{children}</div>{action}</div>;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <div className="state" role="status" aria-live="polite"><span className="spinner" aria-hidden /> <span className="sr-only">{label}</span><p>{label}...</p></div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="state"><h2>{title}</h2>{children}</div>;
}

/**
 * Error state for a failed load or action. 409 VERSION_CONFLICT shows "Changed by someone else" with Reload;
 * the caller keeps the user's unsaved input. 403 shows a permission-denied state, 423 the read-only state.
 */
export function ErrorView({ error, onReload, compact }: { error: ApiError | null | undefined; onReload?: () => void; compact?: boolean }) {
  if (!error) return null;
  if (error.code === 'VERSION_CONFLICT') {
    return <Banner tone="warn" action={onReload ? <Button small onClick={onReload}>Reload</Button> : undefined}>
      <strong>Changed by someone else.</strong> <p>{error.message} Your input is kept - reload to get the latest version, then save again.</p>
    </Banner>;
  }
  if (error.status === 403 && !compact) {
    return <Empty title="You don't have access to this">{<p>{error.message}</p>}</Empty>;
  }
  if (error.status === 423) {
    return <Banner tone="warn"><strong>Read-only.</strong> <p>{error.message}</p></Banner>;
  }
  if (error.status === 404 && !compact) {
    return <Empty title="Not found"><p>{error.message}</p></Empty>;
  }
  const fields = Object.entries(error.fields);
  return (
    <Banner tone="bad" action={onReload && (error.status === 0 || error.status >= 500) ? <Button small onClick={onReload}>Try again</Button> : undefined}>
      <strong>{error.message}</strong>
      {fields.length ? <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{fields.map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul> : null}
    </Banner>
  );
}

export function Notice({ text }: { text: string | null }) {
  if (!text) return null;
  return <p role="status" aria-live="polite" className="small" style={{ color: 'var(--ok)', margin: '8px 0 0' }}>{text}</p>;
}

/** Native <dialog> as a side sheet or modal: focus trap and Escape handled by the browser. */
export function Dialog({ open, onClose, title, children, footer, variant = 'modal' }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; variant?: 'modal' | 'sheet' }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={variant} onClose={onClose} aria-labelledby={titleId}>
      {open ? (
        <div style={{ display: 'flex', flexDirection: 'column', height: variant === 'sheet' ? '100%' : undefined }}>
          <div className="dialog-head"><h2 id={titleId} style={{ margin: 0 }}>{title}</h2><button className="btn btn-small" onClick={onClose} aria-label="Close">Close</button></div>
          <div className="dialog-body" style={{ flex: 1 }}>{children}</div>
          {footer ? <div className="dialog-foot">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="copy">
        <code>{value}</code>
        <Button small onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }} aria-label={`Copy ${label}`}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return <div className="page-head"><div><h1>{title}</h1>{subtitle ? <p>{subtitle}</p> : null}</div>{actions ? <div className="row">{actions}</div> : null}</div>;
}
