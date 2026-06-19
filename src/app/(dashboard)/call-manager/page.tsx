'use client';

import { useState, useEffect } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────
interface CallLog {
  id: string;
  name: string;
  phone: string;
  disposition: 'interested' | 'not_interested' | 'callback' | 'no_answer' | 'busy' | 'wrong_number';
  notes: string;
  duration: string;
  callbackAt?: string;
  calledAt: string;
  agent: string;
}

interface CallyzerCall {
  id: string;
  caller_number: string;
  receiver_number: string;
  duration: number;
  status: string;
  start_time: string;
  recording_url?: string;
}

interface CallyzerStats {
  total: number;
  answered: number;
  missed: number;
  avg_duration: number;
}

const DISPOSITIONS = [
  { value: 'interested', label: '🔥 Interested', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  { value: 'callback', label: '📅 Callback', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  { value: 'not_interested', label: '❌ Not Interested', color: 'text-red-400 bg-red-500/10 border-red-500/20' },
  { value: 'no_answer', label: '📵 No Answer', color: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/20' },
  { value: 'busy', label: '🔴 Busy', color: 'text-orange-400 bg-orange-500/10 border-orange-500/20' },
  { value: 'wrong_number', label: '🚫 Wrong Number', color: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
];

const dispositionStyle = (d: string) => DISPOSITIONS.find((x) => x.value === d)?.color || 'text-zinc-400';
const dispositionLabel = (d: string) => DISPOSITIONS.find((x) => x.value === d)?.label || d;

// ── Main Component ─────────────────────────────────────────────────────────
export default function CallManagerPage() {
  const [activeTab, setActiveTab] = useState<'tracker' | 'callyzer'>('tracker');

  // ── Custom Tracker State ─────────────────────────────────────────────────
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newCall, setNewCall] = useState<Omit<CallLog, 'id' | 'calledAt'>>({
    name: '', phone: '', disposition: 'no_answer', notes: '', duration: '', callbackAt: '', agent: '',
  });
  const [filterDisposition, setFilterDisposition] = useState('all');
  const [filterDate, setFilterDate] = useState('');
  const [searchQ, setSearchQ] = useState('');

  // ── Callyzer State ───────────────────────────────────────────────────────
  const [callyzerKey, setCallyzerKey] = useState('');
  const [callyzerKeySaved, setCallyzerKeySaved] = useState(false);
  const [callyzerCalls, setCallyzerCalls] = useState<CallyzerCall[]>([]);
  const [callyzerStats, setCallyzerStats] = useState<CallyzerStats | null>(null);
  const [callyzerLoading, setCallyzerLoading] = useState(false);
  const [callyzerError, setCallyzerError] = useState('');
  const [callyzerDateFrom, setCallyzerDateFrom] = useState('');
  const [callyzerDateTo, setCallyzerDateTo] = useState('');

  // Load saved data
  useEffect(() => {
    const savedCalls = localStorage.getItem('call_logs');
    if (savedCalls) setCalls(JSON.parse(savedCalls));
    const savedKey = localStorage.getItem('callyzer_key');
    if (savedKey) { setCallyzerKey(savedKey); setCallyzerKeySaved(true); }
  }, []);

  const saveCalls = (updated: CallLog[]) => {
    setCalls(updated);
    localStorage.setItem('call_logs', JSON.stringify(updated));
  };

  // ── Custom Tracker ───────────────────────────────────────────────────────
  const addCall = () => {
    if (!newCall.name || !newCall.phone) { alert('Name and phone are required.'); return; }
    const entry: CallLog = { ...newCall, id: Date.now().toString(), calledAt: new Date().toISOString() };
    saveCalls([entry, ...calls]);
    setNewCall({ name: '', phone: '', disposition: 'no_answer', notes: '', duration: '', callbackAt: '', agent: '' });
    setShowAddForm(false);
  };

  const deleteCall = (id: string) => {
    if (!confirm('Delete this call log?')) return;
    saveCalls(calls.filter((c) => c.id !== id));
  };

  const filteredCalls = calls.filter((c) => {
    if (filterDisposition !== 'all' && c.disposition !== filterDisposition) return false;
    if (filterDate && !c.calledAt.startsWith(filterDate)) return false;
    if (searchQ && !c.name.toLowerCase().includes(searchQ.toLowerCase()) && !c.phone.includes(searchQ)) return false;
    return true;
  });

  const stats = {
    total: calls.length,
    interested: calls.filter((c) => c.disposition === 'interested').length,
    callback: calls.filter((c) => c.disposition === 'callback').length,
    today: calls.filter((c) => c.calledAt.startsWith(new Date().toISOString().slice(0, 10))).length,
  };

  const upcomingCallbacks = calls
    .filter((c) => c.disposition === 'callback' && c.callbackAt && new Date(c.callbackAt) > new Date())
    .sort((a, b) => new Date(a.callbackAt!).getTime() - new Date(b.callbackAt!).getTime())
    .slice(0, 5);

  const exportCSV = () => {
    const hdrs = ['Name', 'Phone', 'Disposition', 'Notes', 'Duration', 'Agent', 'Called At', 'Callback At'];
    const rows = calls.map((c) => [c.name, c.phone, c.disposition, c.notes, c.duration, c.agent, c.calledAt, c.callbackAt || '']);
    const csv = [hdrs, ...rows].map((r) => r.map((v) => `"${v}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = `call-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  // ── Callyzer Integration ─────────────────────────────────────────────────
  const saveCallyzerKey = () => {
    localStorage.setItem('callyzer_key', callyzerKey);
    setCallyzerKeySaved(true);
    alert('Callyzer API key saved!');
  };

  const fetchCallyzerData = async () => {
    if (!callyzerKey) { alert('Please enter your Callyzer API key first.'); return; }
    setCallyzerLoading(true);
    setCallyzerError('');
    try {
      // Callyzer API: https://app.callyzer.co/api/v1/calls
      const params = new URLSearchParams({ api_key: callyzerKey });
      if (callyzerDateFrom) params.append('from', callyzerDateFrom);
      if (callyzerDateTo) params.append('to', callyzerDateTo);

      const res = await fetch(`https://app.callyzer.co/api/v1/calls?${params}`);
      if (!res.ok) throw new Error(`Callyzer API error: ${res.status}`);
      const data = await res.json();

      setCallyzerCalls(data.calls || data.data || []);

      // Compute stats
      const callList: CallyzerCall[] = data.calls || data.data || [];
      const answered = callList.filter((c) => c.status === 'answered' || c.duration > 0);
      const totalDur = answered.reduce((sum, c) => sum + (c.duration || 0), 0);
      setCallyzerStats({
        total: callList.length,
        answered: answered.length,
        missed: callList.length - answered.length,
        avg_duration: answered.length ? Math.round(totalDur / answered.length) : 0,
      });
    } catch (e: any) {
      setCallyzerError(e.message || 'Failed to fetch from Callyzer. Check your API key.');
    } finally {
      setCallyzerLoading(false);
    }
  };

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-xl">📞</div>
        <div>
          <h1 className="text-xl font-bold text-white">Call Manager</h1>
          <p className="text-sm text-zinc-400">Track calls manually or sync from Callyzer</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-zinc-800 pb-0">
        {([['tracker', '📋 Call Tracker'], ['callyzer', '🔗 Callyzer Sync']] as const).map(([tab, label]) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-5 py-2.5 text-sm font-semibold rounded-t-lg transition-colors ${activeTab === tab ? 'bg-zinc-900 text-white border border-b-0 border-zinc-800' : 'text-zinc-500 hover:text-zinc-300'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── CALL TRACKER TAB ── */}
      {activeTab === 'tracker' && (
        <div className="flex flex-col gap-5">

          {/* Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Total Calls', value: stats.total, color: 'text-white', icon: '📞' },
              { label: 'Interested', value: stats.interested, color: 'text-emerald-400', icon: '🔥' },
              { label: 'Callbacks', value: stats.callback, color: 'text-amber-400', icon: '📅' },
              { label: 'Today', value: stats.today, color: 'text-blue-400', icon: '📆' },
            ].map(({ label, value, color, icon }) => (
              <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                <div className="text-2xl mb-1">{icon}</div>
                <div className={`text-2xl font-bold ${color}`}>{value}</div>
                <div className="text-xs text-zinc-500 mt-0.5 uppercase tracking-wider">{label}</div>
              </div>
            ))}
          </div>

          {/* Upcoming Callbacks */}
          {upcomingCallbacks.length > 0 && (
            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-5">
              <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-3">⏰ Upcoming Callbacks</p>
              <div className="flex flex-col gap-2">
                {upcomingCallbacks.map((c) => (
                  <div key={c.id} className="flex items-center justify-between">
                    <div>
                      <span className="text-sm font-semibold text-white">{c.name}</span>
                      <span className="text-xs text-zinc-500 ml-2">{c.phone}</span>
                    </div>
                    <span className="text-xs text-amber-400 font-semibold">{new Date(c.callbackAt!).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="flex flex-wrap gap-3 items-center justify-between">
            <div className="flex gap-2 flex-wrap">
              <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="🔍 Search name or phone..."
                className="rounded-lg border border-zinc-700 bg-zinc-900 text-white text-sm px-3 py-2 focus:outline-none focus:border-blue-500 w-52" />
              <select value={filterDisposition} onChange={(e) => setFilterDisposition(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-900 text-white text-sm px-3 py-2 focus:outline-none focus:border-blue-500">
                <option value="all">All Dispositions</option>
                {DISPOSITIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
              <input type="date" value={filterDate} onChange={(e) => setFilterDate(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-900 text-white text-sm px-3 py-2 focus:outline-none focus:border-blue-500" />
            </div>
            <div className="flex gap-2">
              <button onClick={exportCSV} className="rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-400 text-sm px-4 py-2 hover:border-zinc-500 transition-colors">
                ⬇️ Export CSV
              </button>
              <button onClick={() => setShowAddForm(true)} className="rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white text-sm font-semibold px-4 py-2 hover:opacity-90 transition-opacity">
                + Log Call
              </button>
            </div>
          </div>

          {/* Add Call Form */}
          {showAddForm && (
            <div className="rounded-2xl border border-blue-500/20 bg-zinc-900 p-5">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm font-bold text-white">Log New Call</p>
                <button onClick={() => setShowAddForm(false)} className="text-zinc-500 hover:text-zinc-300 text-lg">✕</button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
                {[
                  { key: 'name', label: 'Student Name *', placeholder: 'Rahul Sharma', type: 'text' },
                  { key: 'phone', label: 'Phone *', placeholder: '9876543210', type: 'text' },
                  { key: 'duration', label: 'Call Duration', placeholder: '3:45', type: 'text' },
                  { key: 'agent', label: 'Agent Name', placeholder: 'Your name', type: 'text' },
                  { key: 'callbackAt', label: 'Callback Date/Time', placeholder: '', type: 'datetime-local' },
                ].map(({ key, label, placeholder, type }) => (
                  <div key={key}>
                    <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">{label}</label>
                    <input type={type} placeholder={placeholder} value={(newCall as any)[key]}
                      onChange={(e) => setNewCall((p) => ({ ...p, [key]: e.target.value }))}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-3 py-2 focus:outline-none focus:border-blue-500" />
                  </div>
                ))}
                <div>
                  <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">Disposition *</label>
                  <select value={newCall.disposition} onChange={(e) => setNewCall((p) => ({ ...p, disposition: e.target.value as any }))}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-3 py-2 focus:outline-none focus:border-blue-500">
                    {DISPOSITIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="mb-4">
                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">Notes</label>
                <textarea value={newCall.notes} onChange={(e) => setNewCall((p) => ({ ...p, notes: e.target.value }))} rows={3}
                  placeholder="Student is interested in MBBS Abroad, wants to know fees..."
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-3 py-2 focus:outline-none focus:border-blue-500 resize-none" />
              </div>
              <div className="flex gap-2">
                <button onClick={addCall} className="rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold text-sm px-6 py-2.5 hover:opacity-90 transition-opacity">
                  ✅ Save Call Log
                </button>
                <button onClick={() => setShowAddForm(false)} className="rounded-lg border border-zinc-700 text-zinc-400 text-sm px-4 py-2.5 hover:border-zinc-500 transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Call Logs Table */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-950">
                    {['Student', 'Phone', 'Disposition', 'Duration', 'Agent', 'Notes', 'Called At', 'Callback', ''].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredCalls.length === 0 ? (
                    <tr><td colSpan={9} className="text-center py-12 text-zinc-600">No call logs yet. Click "+ Log Call" to start.</td></tr>
                  ) : filteredCalls.map((c) => (
                    <tr key={c.id} className="border-b border-zinc-800 hover:bg-zinc-800/50 transition-colors">
                      <td className="px-4 py-3 font-semibold text-white whitespace-nowrap">{c.name}</td>
                      <td className="px-4 py-3 text-zinc-400 whitespace-nowrap">{c.phone}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold border ${dispositionStyle(c.disposition)}`}>
                          {dispositionLabel(c.disposition)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-zinc-400 whitespace-nowrap">{c.duration || '—'}</td>
                      <td className="px-4 py-3 text-zinc-400 whitespace-nowrap">{c.agent || '—'}</td>
                      <td className="px-4 py-3 text-zinc-400 max-w-[200px] truncate">{c.notes || '—'}</td>
                      <td className="px-4 py-3 text-zinc-400 whitespace-nowrap">{new Date(c.calledAt).toLocaleString()}</td>
                      <td className="px-4 py-3 text-amber-400 whitespace-nowrap text-xs">{c.callbackAt ? new Date(c.callbackAt).toLocaleString() : '—'}</td>
                      <td className="px-4 py-3">
                        <button onClick={() => deleteCall(c.id)} className="text-zinc-600 hover:text-red-400 transition-colors text-base">🗑️</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── CALLYZER TAB ── */}
      {activeTab === 'callyzer' && (
        <div className="flex flex-col gap-5">

          {/* API Key */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 max-w-lg">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">🔑 Callyzer API Key</p>
              {callyzerKeySaved && <span className="text-xs text-emerald-400 font-semibold">✅ Saved</span>}
            </div>
            <input type="password" placeholder="Enter your Callyzer API key" value={callyzerKey}
              onChange={(e) => setCallyzerKey(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-3 py-2.5 focus:outline-none focus:border-blue-500 mb-2" />
            <p className="text-xs text-zinc-600 mb-3">
              Find in Callyzer: app.callyzer.co → Settings → API → Your API Key
            </p>
            <button onClick={saveCallyzerKey} className="rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold text-sm px-5 py-2.5 hover:opacity-90 transition-opacity">
              💾 Save Key
            </button>
          </div>

          {/* Date Filter + Fetch */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">📅 Fetch Call Data</p>
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">From Date</label>
                <input type="date" value={callyzerDateFrom} onChange={(e) => setCallyzerDateFrom(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-3 py-2 focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">To Date</label>
                <input type="date" value={callyzerDateTo} onChange={(e) => setCallyzerDateTo(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-3 py-2 focus:outline-none focus:border-blue-500" />
              </div>
              <button onClick={fetchCallyzerData} disabled={callyzerLoading}
                className="rounded-lg bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold text-sm px-6 py-2.5 hover:opacity-90 disabled:opacity-50 transition-opacity">
                {callyzerLoading ? '⏳ Fetching...' : '🔄 Sync from Callyzer'}
              </button>
            </div>
            {callyzerError && <p className="text-sm text-red-400 mt-3">⚠️ {callyzerError}</p>}
          </div>

          {/* Callyzer Stats */}
          {callyzerStats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Total Calls', value: callyzerStats.total, color: 'text-white', icon: '📞' },
                { label: 'Answered', value: callyzerStats.answered, color: 'text-emerald-400', icon: '✅' },
                { label: 'Missed', value: callyzerStats.missed, color: 'text-red-400', icon: '📵' },
                { label: 'Avg Duration', value: formatDuration(callyzerStats.avg_duration), color: 'text-blue-400', icon: '⏱️' },
              ].map(({ label, value, color, icon }) => (
                <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                  <div className="text-2xl mb-1">{icon}</div>
                  <div className={`text-2xl font-bold ${color}`}>{value}</div>
                  <div className="text-xs text-zinc-500 mt-0.5 uppercase tracking-wider">{label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Callyzer Calls Table */}
          {callyzerCalls.length > 0 && (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 overflow-hidden">
              <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
                <p className="text-sm font-bold text-white">{callyzerCalls.length} calls synced from Callyzer</p>
              </div>
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-zinc-950">
                    <tr className="border-b border-zinc-800">
                      {['Caller', 'Receiver', 'Duration', 'Status', 'Time', 'Recording'].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {callyzerCalls.map((c) => (
                      <tr key={c.id} className="border-b border-zinc-800 hover:bg-zinc-800/50 transition-colors">
                        <td className="px-4 py-3 text-white whitespace-nowrap">{c.caller_number}</td>
                        <td className="px-4 py-3 text-zinc-400 whitespace-nowrap">{c.receiver_number}</td>
                        <td className="px-4 py-3 text-zinc-400 whitespace-nowrap">{c.duration ? formatDuration(c.duration) : '—'}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold border ${c.duration > 0 ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' : 'text-red-400 bg-red-500/10 border-red-500/20'}`}>
                            {c.status || (c.duration > 0 ? 'answered' : 'missed')}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-zinc-400 whitespace-nowrap text-xs">{new Date(c.start_time).toLocaleString()}</td>
                        <td className="px-4 py-3">
                          {c.recording_url
                            ? <a href={c.recording_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-xs font-semibold">▶️ Play</a>
                            : <span className="text-zinc-600 text-xs">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {callyzerCalls.length === 0 && !callyzerLoading && (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 py-16 text-center">
              <div className="text-5xl mb-3">📞</div>
              <p className="text-zinc-500 text-sm">No calls synced yet. Enter your API key and click Sync.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
