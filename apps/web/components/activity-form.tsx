'use client';
import { useState } from 'react';
import { useCommand } from '@/lib/hooks';
import { localInputValue } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button, ErrorView, Select, TextArea, TextInput } from './ui';
import { LIMITS } from '@/lib/limits';

const OUTCOMES = [
  { value: 'no_answer', label: 'No answer' },
  { value: 'voicemail', label: 'Left voicemail' },
  { value: 'reached', label: 'Reached - spoke with them' },
  { value: 'booked', label: 'Booked' },
  { value: 'wrong_number', label: 'Wrong number' },
  { value: 'not_interested', label: 'Not interested' },
];

/**
 * Log a call, text, email, visit or note (API-028). Uses the lead version the user is looking at; a 409 shows
 * "Changed by someone else" and keeps the typed input.
 */
export function ActivityForm({ leadId, version, onDone, onReload }: { leadId: string; version: number; onDone: (message?: string) => void; onReload?: () => void }) {
  const s = useSession();
  const [type, setType] = useState('call');
  const [outcome, setOutcome] = useState('no_answer');
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const cmd = useCommand<void, unknown>(() => {
    const occurred = when ? zonedToIso(when, s.timeZone) : undefined;
    return {
      path: `/leads/${leadId}/activities`,
      body: type === 'note'
        ? { type, note }
        : { expected_version: version, type, outcome, ...(note ? { note } : {}), ...(occurred ? { occurred_at: occurred } : {}) },
    };
  }, { onSuccess: (_d, _v, message) => { setNote(''); onDone(message); } });
  const f = cmd.error?.fields ?? {};
  return (
    <form onSubmit={e => { e.preventDefault(); void cmd.run(); }}>
      <Select label="What did you do?" value={type} onChange={e => setType(e.target.value)}>
        <option value="call">Call</option><option value="text">Text</option><option value="email">Email</option><option value="visit">Visit</option><option value="note">Note only</option>
      </Select>
      {type !== 'note' ? (
        <Select label="Outcome" value={outcome} onChange={e => setOutcome(e.target.value)} error={f.outcome}>
          {OUTCOMES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      ) : null}
      <TextArea label={type === 'note' ? 'Note' : 'Note (optional)'} value={note} onChange={e => setNote(e.target.value)} maxLength={LIMITS.activityNote} required={type === 'note'} />
      {type !== 'note' ? <TextInput label="When (optional)" type="datetime-local" value={when} max={localInputValue(new Date(), s.timeZone)} onChange={e => setWhen(e.target.value)} hint={`Leave empty for now. Times are in ${s.timeZone}.`} error={f.occurred_at} /> : null}
      <ErrorView error={cmd.error} compact onReload={onReload} />
      <Button variant="primary" type="submit" pending={cmd.pending} disabled={!s.writable}>Save</Button>
    </form>
  );
}

/** Convert a wall time in `timeZone` to a UTC ISO string (for occurred_at). */
export function zonedToIso(local: string, timeZone: string): string {
  const [d, t] = local.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const asZone = new Date(new Date(guess).toLocaleString('en-US', { timeZone }));
  const asUtc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess - (asZone.getTime() - asUtc.getTime())).toISOString();
}
