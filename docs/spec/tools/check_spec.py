#!/usr/bin/env python3
"""Static consistency checks for the LeadGuard v1.1 specification sources. Usage: python3 check_spec.py"""
import json, re, sys, glob
import os
BASE = os.path.dirname(os.path.abspath(__file__))
# Paths adapted to the repository layout (the delivered pack had tools/, spec/, contracts/ and db/ side by side).
REPO = os.path.join(BASE, '..', '..', '..')
PARTS = os.path.join(BASE, '..', 'parts')
md = {f: open(os.path.join(PARTS, f)).read() for f in ['01.md', '02.md', '03.md', '04.md', '05.md']}
allmd = "\n".join(md.values())
ex = json.load(open(os.path.join(REPO, 'packages', 'contracts', 'api-examples.json')))
sql = open(os.path.join(REPO, 'packages', 'db', 'migrations', '001_core_schema.sql')).read()
R = []
def rec(i, name, ok, detail=''):
    R.append((i, name, 'PASS' if ok else 'FAIL', detail))

# CHK-01 every JSON-looking code block parses
bad = []
for f, text in md.items():
    blocks = re.findall(r'(?:^    .*\n?)+', text, re.M)
    for b in blocks:
        body = "\n".join(l[4:] for l in b.splitlines())
        if body.lstrip().startswith('{'):
            try: json.loads(body)
            except Exception as e: bad.append((f, body[:60], str(e)))
rec('CHK-01', 'Every JSON code block in the specification parses', not bad, str(bad[:3]))

# CHK-02 API references exist
n = len(ex)
refs = set(int(x) for x in re.findall(r'API-(\d{3})', allmd))
rec('CHK-02', 'Every API-### reference points to a registered operation', all(1 <= r <= n for r in refs), str(sorted(r for r in refs if r > n)))

# CHK-11 task references exist
tasks = set(re.findall(r'^### (TASK-\d{3})', md.get('05.md',''), re.M))
trefs = set(re.findall(r'TASK-\d{3}', allmd))
rec('CHK-11', 'Every TASK reference points to a task card', trefs <= tasks and len(tasks) > 0, str(sorted(trefs - tasks)))
oids = set(re.findall(r'\b(OD-\d\d|INT-\d{3}|DEC-\d{3})\b', allmd))
defined = set(re.findall(r'^\| (OD-\d\d|INT-\d{3}|DEC-\d{3}) \|', md.get('05.md',''), re.M))
rec('CHK-12', 'Every OD, INT and DEC reference is defined in Appendix D or E', oids <= defined, str(sorted(oids - defined)))

# CHK-03 counts
contracts = len(re.findall(r'^## API-\d{3} ', md['03.md'], re.M))
regrows = len(re.findall(r'^\| API-\d{3} \|', md['03.md'], re.M))
appA = re.search(r'Appendix A.*?\*\*TOTAL\*\* \| \*\*(\d+)\*\*', md['04.md'], re.S)
domrows = re.search(r'Appendix A.*?\n\|---\|---\|\n(.*?)\n\| \*\*TOTAL', md['04.md'], re.S).group(1)
dsum = sum(int(x) for x in re.findall(r'\| (\d+) \|$', domrows, re.M))
title_n = int(re.search(r'Endpoint Registry - (\d+) HTTP', md['03.md']).group(1))
words = set(int(x) for x in re.findall(r'\b(\d{2}) (?:HTTP )?operations', allmd))
ok = len({n, contracts, regrows, int(appA.group(1)), dsum, title_n}) == 1 and words <= {n}
rec('CHK-03', 'Registry rows, contract sections, title, Appendix A total and domain sum agree', ok, f'n={n} contracts={contracts} rows={regrows} appA={appA.group(1)} sum={dsum} title={title_n} prose={sorted(words)}')

# CHK-04 meta.timestamp not earlier than past-event timestamps in the same body
PAST = {'created_at', 'received_at', 'occurred_at', 'acknowledged_at', 'closed_at', 'revoked_at', 'started_at', 'at', 'since',
        'last_event_at', 'verified_at', 'disabled_at', 'updated_at', 'first_action_at', 'effective_at', 'active_from', 'submitted_at'}
viol = []
def walk(o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in PAST and isinstance(v, str) and re.match(r'\d{4}-\d\d-\d\dT', v): out.append((k, v))
            walk(v, out)
    elif isinstance(o, list):
        for v in o: walk(v, out)
for e in ex:
    for label, body in [('success', e['success']['body'])] + [(x['label'], x['body']) for x in e['extra']]:
        if isinstance(body, dict) and 'meta' in body and 'timestamp' in body['meta']:
            ts = body['meta']['timestamp']; found = []; walk(body.get('data'), found)
            for k, v in found:
                if v > ts: viol.append((e['id'], k, v, ts))
rec('CHK-04', 'No example reports a past event later than its response timestamp', not viol, str(viol[:5]))

# CHK-05 enums in examples are allowed by the canonical schema
def checkvals(sqlcol):
    m = re.search(sqlcol + r".*?CHECK \(\w+ IN \(([^)]*)\)\)", sql, re.S)
    return set(x.strip().strip("'") for x in m.group(1).split(','))
lead_st = checkvals(r"\n  status           text NOT NULL DEFAULT 'new'\n")
src_st = checkvals(r"status           text NOT NULL DEFAULT 'draft'")
del_st = checkvals(r"state                text NOT NULL DEFAULT 'pending'\n")
sub_st = checkvals(r"state                 text NOT NULL")
found = {'lead': set(), 'src': set(), 'del': set(), 'sub': set()}
def walk2(o, ctx=None):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ('status', 'to_status', 'previous_status', 'merged_lead_status', 'allowed_statuses') and ctx == 'lead':
                for x in (v if isinstance(v, list) else [v]):
                    if isinstance(x, str): found['lead'].add(x)
            if k == 'state' and ctx == 'delivery' and isinstance(v, str): found['del'].add(v)
            if k in ('state', 'subscription_state', 'org_state') and ctx == 'sub' and isinstance(v, str): found['sub'].add(v)
            walk2(v, ctx)
    elif isinstance(o, list):
        for v in o: walk2(v, ctx)
for e in ex:
    bodies = [e['success']['body']] + [x['body'] for x in e['extra']] + ([e['request']] if e['request'] else [])
    ctx = 'lead' if '/leads' in e['path'] or e['path'].endswith('/inbox') else 'delivery' if 'alerts' in e['path'] or 'timeline' in e['path'] or 'notifications' in e['path'] else 'sub' if 'billing' in e['path'] else None
    for b in bodies: walk2(b, ctx)
    if '/sources' in e['path']:
        for b in bodies:
            for m in re.finditer(r'"status": "(\w+)"', json.dumps(b)): found['src'].add(m.group(1))
found['lead'] -= {'merged'} if False else set()
probs = {k: sorted(v - allowed) for k, v, allowed in [('lead', found['lead'], lead_st), ('src', found['src'], src_st), ('del', found['del'], del_st), ('sub', found['sub'], sub_st)] if v - allowed}
rec('CHK-05', 'Lead, source, delivery and subscription states in examples exist in the schema', not probs, str(probs))

# CHK-06 error codes used are in the catalogue
cat = set(re.findall(r'^\| ([A-Z_]+) \| \d{3}', md['04.md'], re.M))
used = set(re.findall(r'"code": "([A-Z_]+)"', json.dumps(ex)))
used |= set(re.findall(r'\b([A-Z][A-Z_]{6,})\b', " ".join(m for e in ex for m in map(str, e['statuses'])))) if False else set()
used |= set(c for c in re.findall(r'\b([A-Z]+(?:_[A-Z]+)+)\b', md['03.md']) if c.endswith(('_REQUIRED', '_FAILED', '_INVALID', '_DENIED', '_FOUND', '_CONFLICT', '_REUSED', '_PROGRESS', '_CLAIMED', '_DISABLED', '_VERIFIED', '_EXPIRED', '_TRANSITION', '_REACHED', '_OWNER', '_ALLOWED', '_APPLICABLE', '_ENABLED', '_AVAILABLE', '_INACTIVE', '_LIMITED', '_UNAVAILABLE', '_CONFIGURED', '_UNMAPPABLE', '_GAP', '_AMBIGUOUS')))
missing = sorted(used - cat)
rec('CHK-06', 'Every error code used in contracts is in the error catalogue', not missing, str(missing))

# CHK-07 documented statuses include the example statuses
bad7 = [e['id'] for e in ex if e['success']['status'] not in e['statuses'] or e['error']['status'] not in e['statuses'] or any(x['status'] not in e['statuses'] for x in e['extra'])]
rec('CHK-07', 'Each example status code is listed in its HTTP table', not bad7, str(bad7))

# CHK-08 identifiers
blob = json.dumps(ex)
left = re.findall(r'\b(?:org|usr|lead|src|sev|inv|act|alr|ver|chk|exp|sag)_[0-9A-Z]{10}\b', blob + allmd)
uuids = re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', blob)
rec('CHK-08', 'All example IDs are UUIDv7-format strings; no legacy prefixed IDs remain', not left and len(uuids) > 50, f'leftover={left[:3]} uuids={len(uuids)}')

# CHK-09 envelopes
bad9 = []
for e in ex:
    if e['path'].startswith('/api/v1'):
        b = e['success']['body']; eb = e['error']['body']
        if not (b.get('success') is True and 'request_id' in b.get('meta', {})): bad9.append((e['id'], 'success'))
        if not (eb.get('success') is False and 'code' in eb.get('error', {})): bad9.append((e['id'], 'error'))
rec('CHK-09', 'Product API examples use the standard success and error envelopes', not bad9, str(bad9))

# CHK-10 entitlement class present for every operation and known
classes = {'none', 'read', 'bootstrap', 'setup', 'business_write', 'ingest', 'control', 'provider'}
rec('CHK-10', 'Every operation has a known entitlement class', all(e['entitlement'] in classes for e in ex), '')

w = "\n".join(f"| {a} | {b} | {c} | {d.replace('|','/')} |" for a, b, c, d in R)
print("| Check | Behavior | Status | Detail |\n|---|---|---|---|\n" + w)
sys.exit(1 if any(r[2] == 'FAIL' for r in R) else 0)
