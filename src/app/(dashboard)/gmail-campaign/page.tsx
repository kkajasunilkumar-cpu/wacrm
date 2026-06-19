'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';

interface Contact { [key: string]: string; }
interface EmailSettings { from: string; appPassword: string; }
interface CampaignLog { email: string; name: string; status: 'sent' | 'failed'; reason?: string; time: string; }
interface ScheduleOption { value: string; label: string; }

const MAILER_URL = process.env.NEXT_PUBLIC_MAILER_URL || 'http://localhost:3002';

export default function GmailCampaignPage() {
  const [settings, setSettings] = useState<EmailSettings>({ from: '', appPassword: '' });
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [scheduleType, setScheduleType] = useState<'now' | 'later'>('now');
  const [scheduleTime, setScheduleTime] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [campaign, setCampaign] = useState({ running: false, total: 0, sent: 0, failed: 0, pending: 0, log: [] as CampaignLog[], scheduled: false, scheduledAt: '' });
  const [serviceError, setServiceError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Load saved settings
  useEffect(() => {
    const saved = localStorage.getItem('gmail_settings');
    if (saved) { setSettings(JSON.parse(saved)); setSettingsSaved(true); }
  }, []);

  const saveSettings = () => {
    localStorage.setItem('gmail_settings', JSON.stringify(settings));
    setSettingsSaved(true);
    alert('Gmail settings saved!');
  };

  const clearSettings = () => {
    localStorage.removeItem('gmail_settings');
    setSettings({ from: '', appPassword: '' });
    setSettingsSaved(false);
  };

  // File parsing
  const parseCSV = (text: string) => {
    const lines = text.trim().split('\n');
    const hdrs = lines[0].split(',').map((h) => h.trim().replace(/"/g, '').toLowerCase());
    const rows: Contact[] = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',').map((v) => v.trim().replace(/"/g, ''));
      if (!vals[0]) continue;
      const obj: Contact = {};
      hdrs.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
      rows.push(obj);
    }
    loadContacts(rows, hdrs);
  };

  const parseExcel = (buffer: ArrayBuffer) => {
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Contact>(ws, { defval: '' });
    const normalised = rows.map((r) => {
      const obj: Contact = {};
      Object.keys(r).forEach((k) => { obj[k.toLowerCase().trim()] = String(r[k]); });
      return obj;
    });
    const hdrs = normalised.length ? Object.keys(normalised[0]) : [];
    loadContacts(normalised, hdrs);
  };

  const loadContacts = (rows: Contact[], hdrs: string[]) => { setContacts(rows); setHeaders(hdrs); };

  const handleFile = (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'csv') { const r = new FileReader(); r.onload = (e) => parseCSV(e.target?.result as string); r.readAsText(file); }
    else if (ext === 'xlsx' || ext === 'xls') { const r = new FileReader(); r.onload = (e) => parseExcel(e.target?.result as ArrayBuffer); r.readAsArrayBuffer(file); }
  };

  const personalize = (template: string, contact: Contact) => {
    let t = template;
    Object.keys(contact).forEach((k) => { t = t.replace(new RegExp(`\\{${k}\\}`, 'gi'), contact[k]); });
    return t;
  };

  const insertVar = (v: string) => {
    const ta = bodyRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const newVal = body.slice(0, start) + v + body.slice(ta.selectionEnd);
    setBody(newVal);
    setTimeout(() => { ta.selectionStart = ta.selectionEnd = start + v.length; ta.focus(); }, 0);
  };

  const showPreview = () => {
    const sample = contacts.length ? contacts[0] : { name: 'Rahul', course: 'MBBS Abroad', email: 'rahul@example.com' };
    setPreview({ subject: personalize(subject, sample), body: personalize(body, sample) });
  };

  const startCampaign = async () => {
    if (!settings.from || !settings.appPassword) { alert('Please save Gmail settings first.'); return; }
    if (!subject.trim() || !body.trim()) { alert('Subject and body are required.'); return; }
    if (!contacts.length) { alert('Please import contacts.'); return; }

    const emailContacts = contacts.filter((c) => c.email || c.Email);
    if (!emailContacts.length) { alert('No email column found in contacts. Make sure column is named "email".'); return; }

    if (!confirm(`Send to ${emailContacts.length} contacts${scheduleType === 'later' ? ` at ${scheduleTime}` : ' now'}?`)) return;

    try {
      const res = await fetch(`${MAILER_URL}/send-campaign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gmail: settings,
          contacts: emailContacts,
          subject,
          body,
          scheduleAt: scheduleType === 'later' ? scheduleTime : null,
        }),
      });
      const data = await res.json();
      if (data.error) { alert(data.error); return; }
      setServiceError(false);
      if (scheduleType === 'later') {
        setCampaign((p) => ({ ...p, scheduled: true, scheduledAt: scheduleTime }));
        alert(`Campaign scheduled for ${new Date(scheduleTime).toLocaleString()}`);
      } else {
        startPolling();
      }
    } catch {
      setServiceError(true);
      alert('Cannot reach mailer service. Make sure it is running on port 3002.');
    }
  };

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${MAILER_URL}/campaign-status`);
        const data = await res.json();
        setCampaign((p) => ({ ...p, ...data }));
        if (!data.running && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      } catch {}
    }, 2000);
  };

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const pct = campaign.total > 0 ? Math.round(((campaign.sent + campaign.failed) / campaign.total) * 100) : 0;
  const defaultVars = ['name', 'email', 'course', 'city', 'phone'];
  const extraVars = headers.filter((h) => !defaultVars.includes(h));
  const allVars = [...defaultVars, ...extraVars];

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-orange-500 flex items-center justify-center text-xl">📧</div>
        <div>
          <h1 className="text-xl font-bold text-white">Gmail Campaign</h1>
          <p className="text-sm text-zinc-400">Send personalized bulk emails via Gmail App Password</p>
        </div>
      </div>

      {serviceError && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
          ⚠️ Mailer service not reachable. Run <code className="bg-zinc-800 px-2 py-0.5 rounded text-xs">pm2 start mailer-service</code> on your server.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6 items-start">

        {/* LEFT */}
        <div className="flex flex-col gap-5">

          {/* Gmail Settings */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">⚙️ Gmail Settings</p>
              {settingsSaved && <span className="text-xs text-emerald-400 font-semibold">✅ Saved</span>}
            </div>

            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">Gmail Address</label>
            <input type="email" placeholder="youremail@gmail.com" value={settings.from}
              onChange={(e) => setSettings((p) => ({ ...p, from: e.target.value }))}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-3 py-2.5 focus:outline-none focus:border-red-500 mb-3" />

            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">App Password</label>
            <input type="password" placeholder="xxxx xxxx xxxx xxxx" value={settings.appPassword}
              onChange={(e) => setSettings((p) => ({ ...p, appPassword: e.target.value }))}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-3 py-2.5 focus:outline-none focus:border-red-500 mb-1" />
            <p className="text-xs text-zinc-600 mb-4">
              Gmail → My Account → Security → 2FA → App Passwords → Generate
            </p>

            <button onClick={saveSettings} className="w-full rounded-lg bg-gradient-to-r from-red-500 to-orange-500 text-white font-semibold text-sm py-2.5 hover:opacity-90 transition-opacity mb-2">
              💾 Save Settings
            </button>
            {settingsSaved && (
              <button onClick={clearSettings} className="w-full rounded-lg border border-zinc-700 text-zinc-400 text-sm py-2 hover:border-zinc-500 transition-colors">
                🗑️ Clear Saved Settings
              </button>
            )}
          </div>

          {/* Contacts */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">👥 Import Contacts</p>

            <div
              className={`relative border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors mb-4 ${isDragging ? 'border-red-500 bg-red-500/10' : 'border-zinc-700 hover:border-zinc-500'}`}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
              onClick={() => fileInputRef.current?.click()}
            >
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
              <div className="text-3xl mb-2">📂</div>
              <p className="text-sm font-semibold text-white mb-1">Drop CSV or Excel here</p>
              <p className="text-xs text-zinc-500">Required column: <span className="text-red-400">email</span></p>
            </div>

            {contacts.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-white">{contacts.length} contacts · {contacts.filter(c => c.email || c.Email).length} with email</span>
                  <button onClick={() => { setContacts([]); setHeaders([]); }} className="text-xs text-zinc-500 hover:text-red-400 transition-colors">✕ Clear</button>
                </div>
                <div className="rounded-lg border border-zinc-800 overflow-hidden max-h-44 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="bg-zinc-800">{headers.slice(0, 3).map((h) => <th key={h} className="px-3 py-2 text-left text-zinc-400 font-semibold uppercase">{h}</th>)}</tr></thead>
                    <tbody>
                      {contacts.slice(0, 20).map((c, i) => (
                        <tr key={i} className="border-t border-zinc-800">
                          {headers.slice(0, 3).map((h) => <td key={h} className="px-3 py-2 text-zinc-300">{c[h]}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Schedule */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">🕐 Schedule</p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {(['now', 'later'] as const).map((t) => (
                <button key={t} onClick={() => setScheduleType(t)}
                  className={`rounded-lg py-2.5 text-sm font-semibold transition-colors ${scheduleType === t ? 'bg-red-500/20 border border-red-500/40 text-red-400' : 'bg-zinc-800 border border-zinc-700 text-zinc-400 hover:border-zinc-600'}`}>
                  {t === 'now' ? '🚀 Send Now' : '⏰ Schedule'}
                </button>
              ))}
            </div>
            {scheduleType === 'later' && (
              <input type="datetime-local" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-3 py-2.5 focus:outline-none focus:border-red-500" />
            )}
          </div>
        </div>

        {/* RIGHT */}
        <div className="flex flex-col gap-5">

          {/* Email Composer */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">✍️ Email Composer</p>

            <div className="flex flex-wrap gap-2 mb-4">
              {allVars.map((v) => (
                <button key={v} onClick={() => insertVar(`{${v}}`)}
                  className="px-3 py-1 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-semibold hover:bg-red-500/20 transition-colors">
                  {`{${v}}`}
                </button>
              ))}
            </div>

            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">Subject Line</label>
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
              placeholder="Special Admission Offer for {name} — KBEduTech 2024"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-3 py-2.5 focus:outline-none focus:border-red-500 mb-4" />

            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">Email Body</label>
            <textarea ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)} rows={10}
              placeholder={`Dear {name},\n\nThank you for your interest in {course} at KBEduTech.\n\nWe are pleased to inform you about our special admissions for the 2024-25 batch:\n\n✅ World-class faculty\n✅ 100% placement support\n✅ Scholarship opportunities\n\nTo know more, reply to this email or call us at +91 XXXXXXXXXX.\n\nBest regards,\nKBEduTech Admissions Team`}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 text-white text-sm px-4 py-3 focus:outline-none focus:border-red-500 resize-none mb-3" />

            <div className="flex items-center justify-between mb-5">
              <span className="text-xs text-zinc-500">{body.length} characters</span>
              <button onClick={showPreview} className="text-xs text-red-400 hover:text-red-300 font-semibold transition-colors">👁️ Preview</button>
            </div>

            {preview && (
              <div className="rounded-xl border border-zinc-700 bg-zinc-950 p-4 mb-4">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-xs text-zinc-500 font-semibold uppercase">Email Preview</span>
                  <button onClick={() => setPreview(null)} className="text-zinc-600 hover:text-zinc-400 text-xs">✕</button>
                </div>
                <div className="text-xs text-zinc-400 mb-1">Subject:</div>
                <div className="text-sm font-semibold text-white mb-3">{preview.subject}</div>
                <div className="text-xs text-zinc-400 mb-1">Body:</div>
                <div className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{preview.body}</div>
              </div>
            )}

            <button onClick={startCampaign} disabled={campaign.running}
              className="w-full rounded-xl bg-gradient-to-r from-red-500 to-orange-500 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 text-sm transition-opacity">
              {scheduleType === 'later' ? '⏰ Schedule Campaign' : '🚀 Send Campaign Now'}
            </button>
          </div>

          {/* Progress */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">📊 Campaign Progress</p>

            {campaign.scheduled && !campaign.running && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400 mb-4">
                ⏰ Campaign scheduled for {new Date(campaign.scheduledAt).toLocaleString()}
              </div>
            )}

            <div className="grid grid-cols-3 gap-3 mb-4">
              {[{ label: 'Sent', value: campaign.sent, color: 'text-emerald-400' }, { label: 'Failed', value: campaign.failed, color: 'text-red-400' }, { label: 'Pending', value: campaign.pending, color: 'text-amber-400' }].map(({ label, value, color }) => (
                <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-center">
                  <div className={`text-3xl font-bold ${color}`}>{value}</div>
                  <div className="text-xs text-zinc-500 mt-1 uppercase tracking-wider">{label}</div>
                </div>
              ))}
            </div>

            <div className="h-2 rounded-full bg-zinc-800 overflow-hidden mb-2">
              <div className="h-full rounded-full bg-gradient-to-r from-red-500 to-orange-500 transition-all duration-500" style={{ width: `${pct}%` }} />
            </div>
            <div className="flex justify-between text-xs text-zinc-500 mb-4">
              <span>{campaign.running ? `Sending... (${campaign.sent + campaign.failed}/${campaign.total})` : campaign.total > 0 ? 'Campaign complete' : 'No campaign running'}</span>
              <span>{pct}%</span>
            </div>

            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">📋 Send Log</p>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 max-h-64 overflow-y-auto">
              {campaign.log.length === 0 ? (
                <div className="text-center py-8 text-zinc-600 text-sm">No emails sent yet</div>
              ) : (
                [...campaign.log].reverse().map((entry, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 last:border-0">
                    <span>{entry.status === 'sent' ? '✅' : '❌'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-white truncate">{entry.name}</div>
                      <div className="text-xs text-zinc-500 truncate">{entry.email}{entry.reason ? ` · ${entry.reason}` : ''}</div>
                    </div>
                    <span className="text-xs text-zinc-600 flex-shrink-0">{new Date(entry.time).toLocaleTimeString()}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
