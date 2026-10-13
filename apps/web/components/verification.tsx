'use client';
import type { VerificationStep } from '@/lib/types';

const LABEL: Record<string, string> = {
  endpoint_reachable: 'Endpoint reachable',
  signature_valid: 'Signature valid',
  authentication_valid: 'Authentication valid',
  fields_mapped: 'Fields mapped (email or phone found)',
  lead_created: 'Lead created',
};

/** Live checklist; names the exact failed step and how to fix it (setup honesty rule). */
export function VerificationChecklist({ steps }: { steps: VerificationStep[] }) {
  return (
    <ol className="steps" aria-label="Verification steps">
      {steps.map(s => (
        <li key={s.step} className={`step-${s.state}`}>
          <span className="step-icon" aria-hidden>{s.state === 'passed' ? '✓' : s.state === 'failed' ? '!' : '·'}</span>
          <div>
            <div><strong>{LABEL[s.step] ?? s.step}</strong> <span className="sr-only">{s.state.replace('_', ' ')}</span><span className="muted small"> - {s.state === 'passed' ? 'passed' : s.state === 'failed' ? 'failed' : 'not reached yet'}</span></div>
            {s.detail ? <div className="small" style={{ color: s.state === 'failed' ? 'var(--bad)' : undefined }}>{s.detail}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
