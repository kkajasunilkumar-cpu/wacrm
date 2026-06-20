'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import * as XLSX from 'xlsx';

interface Contact { [key: string]: string; }
interface CampaignStatus { running: boolean; total: number; sent: number; failed: number; pending: number; log: LogEntry[]; startedAt: string | null; aborted: boolean; }
interface LogEntry { number: string; name: string; status: 'sent' | 'failed'; reason?: string; time: string; }
interface ConnectionStatus { status: 'connected' | 'connecting' | 'disconnected'; hasQR: boolean; phone?: { name: string; id: string }; }
interface TotalStats { totalSent: number; totalFailed: number; totalMessages: number; campaigns: number; lastUpdated: string; }

const NGROK_HEADERS = { 'ngrok-skip-browser-warning': 'true' };
const URL_STORAGE_KEY = 'baileys_service_url';
const PREV_CAMPAIGN_KEY = 'prev_campaign_result';
const TOTAL_STATS_KEY = 'total_campaign_stats';

const DEFAULT_TOTAL: TotalStats = { totalSent: 0, totalFailed: 0, totalMessages: 0, campaigns: 0, lastUpdated: '' };

export default function BulkWhatsAppPage() {
  const [serviceUrl, setServiceUrl] = useState('');
  const [serviceUrlInput, setServiceUrlInput] = useState('');
  const [urlSaved, setUrlSaved] = useState(false);
  const [showUrlSettings, setShowUrlSettings] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus>({ status: 'disconnected', hasQR: false });
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [delayMin, setDelayMin] = useState(5);
  const [delayMax, setDelayMax] = useState(15);
  const [campaign, setCampaign] = useState<CampaignStatus>({ running: false, total: 0, sent: 0, failed: 0, pending: 0, log: [], startedAt: null, aborted: false });
  const [prevCampaign, setPrevCampaign] = useState<CampaignStatus | null>(null);
  const [totalStats, setTotalStats] = useState<TotalStats>(DEFAULT_TOTAL);
  const [isStarting, setIsStarting] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [serviceError, setServiceError] = useState(false);
  const [campaignCompleted, setCampaignCompleted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastSavedCampaignRef = useRef<string | null>(null);

  // Load saved data on mount
  useEffect(() => {
    const savedUrl = localStorage.getItem(URL_STORAGE_KEY);
    if (savedUrl) { setServiceUrl(savedUrl); setServiceUrlInput(savedUrl); setUrlSaved(true); }
    else { setShowUrlSettings(true); }
    const prev = localStorage.getItem(PREV_CAMPAIGN_KEY);
    if (prev) setPrevCampaign(JSON.parse(prev));
    const total = localStorage.getItem(TOTAL_STATS_KEY);
    if (total) setTotalStats(JSON.parse(total));
  }, []);

  const saveServiceUrl = () => {
    const url = serviceUrlInput.trim().replace(/\/$/, '');
    if (!url) { alert('Please enter the ngrok URL.'); return; }
    if (!url.startsWith('http')) { alert('URL must start with http:// or https://'); return; }
    localStorage.setItem(URL_STORAGE_KEY, url);
    setServiceUrl(url); setUrlSaved(true); setShowUrlSettings(false);
    alert('URL saved! Click Refresh Status to connect.');
  };

  const clearServiceUrl = () => {
    localStorage.removeItem(URL_STORAGE_KEY);
    setServiceUrl(''); setServiceUrlInput(''); setUrlSaved(false); setShowUrlSettings(true);
    setConnection({ status: 'disconnected', hasQR: false }); setQrImage(null);
  };

  const resetTotalStats = () => {
    if (!confirm('Reset all total statistics? This cannot be undone.')) return;
    localStorage.removeItem(TOTAL_STATS_KEY);
    localStorage.removeItem(PREV_CAMPAIGN_KEY);
    setTotalStats(DEFAULT_TOTAL);
    setPrevCampaign(null);
  };

  // Update total stats when campaign completes
  const updateTotalStats = (completedCampaign: CampaignStatus) => {
    const key = completedCampaign.startedAt || '';
    if (lastSavedCampaignRef.current === key) return; // Avoid double counting
    lastSavedCampaignRef.current = key;

    const current = localStorage.getItem(TOTAL_STATS_KEY);
    const existing: TotalStats = current ? JSON.parse(current) : DEFAULT_TOTAL;
    const updated: TotalStats = {
      totalSent: existing.totalSent + completedCampaign.sent,
      totalFailed: existing.totalFailed + completedCampaign.failed,
      totalMessages: existing.totalMessages + completedCampaign.total,
      campaigns: existing.campaigns + 1,
      lastUpdated: new Date().toISOString(),
    };
    localStorage.setItem(TOTAL_STATS_KEY, JSON.stringify(updated));
    setTotalStats(updated);
    // Save as previous campaign
    localStorage.setItem(PREV_CAMPAIGN_KEY, JSON.stringify(completedCampaign));
    setPrevCampaign(completedCampaign);
  };

  // Polling
  const startPolling = (url: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${url}/campaign-status`, { headers: NGROK_HEADERS });
        const data: CampaignStatus = await res.json();
        setCampaign(data);
        setIsStarting(false);
        if (!data.running && data.total > 0) {
          updateTotalStats(data);
          setCampaignCompleted(true);
          clearInterval(pollRef.current!);
          pollRef.current = null;
        }
      } catch {}
    }, 2000);
  };

  // Connection check
  const checkStatus = useCallback(async (url: string) => {
    if (!url) return;
    try {
      const res = await fetch(`${url}/status`, { headers: NGROK_HEADERS });
      const data: ConnectionStatus = await res.json();
      setConnection(data);
      setServiceError(false);
      if (data.status === 'connecting' && data.hasQR) {
        const qrRes = await fetch(`${url}/qr`, { headers: NGROK_HEADERS });
        const qrData = await qrRes.json();
        if (qrData.qr) setQrImage(qrData.qr);
      }
      if (data.status === 'connected') setQrImage(null);
    } catch {
      setServiceError(true);
      setConnection({ status: 'disconnected', hasQR: false });
    }
  }, []);

  useEffect(() => {
    if (!serviceUrl) return;
    const loadCampaign = async () => {
      try {
        const res = await fetch(`${serviceUrl}/campaign-status`, { headers: NGROK_HEADERS });
        const data: CampaignStatus = await res.json();
        setCampaign(data);
        if (data.running) startPolling(serviceUrl);
      } catch {}
    };
    loadCampaign();
    checkStatus(serviceUrl);
    const interval = setInterval(() => checkStatus(serviceUrl), 5000);
    return () => { clearInterval(interval); if (pollRef.current) clearInterval(pollRef.current); };
  }, [serviceUrl, checkStatus]);

  // File import
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
    setContacts(rows); setHeaders(hdrs);
  };

  const parseExcel = (buffer: ArrayBuffer) => {
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Contact>(ws, { defval: '' });
    const normalised = rows.map((r) => { const obj: Contact = {}; Object.keys(r).forEach((k) => { obj[k.toLowerCase().trim()] = String(r[k]); }); return obj; });
    const hdrs = normalised.length ? Object.keys(normalised[0]) : [];
    setContacts(normalised); setHeaders(hdrs);
  };

  const handleFile = (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'csv') { const r = new FileReader(); r.onload = (e) => parseCSV(e.target?.result as string); r.readAsText(file); }
    else if (ext === 'xlsx' || ext === 'xls') { const r = new FileReader(); r.onload = (e) => parseExcel(e.target?.result as ArrayBuffer); r.readAsArrayBuffer(file); }
  };

  const insertVar = (v: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    setMessage(message.slice(0, start) + v + message.slice(ta.selectionEnd));
    setTimeout(() => { ta.selectionStart = ta.selectionEnd = start + v.length; ta.focus(); }, 0);
  };

  const showPreviewFn = () => {
    const sample = contacts.length ? contacts[0] : { name: 'Rahul', course: 'MBBS Abroad', city: 'Hyderabad', phone: '9876543210' };
    let p = message;
    Object.keys(sample).forEach((k) => { p = p.replace(new RegExp(`\\{${k}\\}`, 'gi'), sample[k]); });
    setPreview(p);
  };

  const startCampaign = async () => {
    if (!serviceUrl) { alert('Please save the service URL first.'); return; }
    if (!message.trim()) { alert('Please write a message.'); return; }
    if (!contacts.length) { alert('Please import contacts.'); return; }
    if (connection.status !== 'connected') { alert('WhatsApp not connected. Scan QR first.'); return; }
    if (!confirm(`Start sending to ${contacts.length} contacts?`)) return;
    setIsStarting(true);
    setCampaignCompleted(false);
    try {
      const res = await fetch(`${serviceUrl}/bulk-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...NGROK_HEADERS },
        body: JSON.stringify({ contacts, message, delayMin: delayMin * 1000, delayMax: delayMax * 1000 }),
      });
      const data = await res.json();
      if (data.error) { alert(data.error); setIsStarting(false); return; }
      startPolling(serviceUrl);
    } catch { alert('Cannot reach service. Check ngrok URL.'); setIsStarting(false); }
  };

  const abortCampaign = async () => {
    if (!confirm('Abort campaign?')) return;
    await fetch(`${serviceUrl}/abort`, { method: 'POST', headers: NGROK_HEADERS });
  };

  const isRunning = campaign.running || isStarting;
  const pct = campaign.total > 0 ? Math.round(((campaign.sent + campaign.failed) / campaign.total) * 100) : 0;
  const statusColor = connection.status === 'connected' ? 'bg-emerald-500' : connection.status === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-red-500';
  const defaultVars = ['name', 'mobile', 'phone', 'course', 'city', 'email'];
  const allVars = headers.length ? [...new Set([...headers.filter(h => defaultVars.includes(h)), ...headers.filter(h => !defaultVars.includes(h))])] : defaultVars;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-xl">📢</div>
          <div>
            <h1 className="text-xl font-bold text-white">Bulk WhatsApp</h1>
            <p className="text-sm text-zinc-400">Send messages via temporary number — separate from your official Meta number</p>
          </div>
        </div>
        <button onClick={() => setShowUrlSettings(!showUrlSettings)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-400 text-sm hover:border-emerald-500 hover:text-emerald-400 transition-colors">
          ⚙️ {urlSaved ? 'Change URL' : 'Set URL'}
        </button>
      </div>

      {/* URL Settings */}
      {showUrlSettings && (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5">
          <p className="text-sm font-bold text-white mb-1">🔗 WhatsApp Service URL</p>
          <p className="text-xs text-zinc-400 mb-4">Paste the ngrok URL from your laptop. No GitHub update needed!</p>
          <div className="flex gap-3">
            <input type="text" value={serviceUrlInput} onChange={(e) => setServiceUrlInput(e.target.value)}
              placeholder="https://xxxx.ngrok-free.app"
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-4 py-2.5 focus:outline-none focus:border-emerald-500 font-mono" />
            <button onClick={saveServiceUrl} className="px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-bold transition-colors whitespace-nowrap">💾 Save URL</button>
            {urlSaved && <button onClick={clearServiceUrl} className="px-4 py-2.5 rounded-lg border border-zinc-700 text-zinc-400 text-sm hover:border-red-500 hover:text-red-400 transition-colors">✕</button>}
          </div>
          {urlSaved && <div className="mt-3 flex items-center gap-2 text-xs text-emerald-400"><span className="w-2 h-2 rounded-full bg-emerald-400"></span>Current: <span className="font-mono">{serviceUrl}</span></div>}
        </div>
      )}

      {!serviceUrl && !showUrlSettings && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400 flex items-center justify-between">
          <span>⚠️ No service URL set.</span>
          <button onClick={() => setShowUrlSettings(true)} className="text-xs font-bold underline">Set Now</button>
        </div>
      )}

      {serviceError && serviceUrl && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400 flex items-center justify-between">
          <span>❌ Cannot reach service. Check node index.js and ngrok are running.</span>
          <button onClick={() => setShowUrlSettings(true)} className="text-xs font-bold underline ml-4 whitespace-nowrap">Update URL</button>
        </div>
      )}

      {/* ── TOTAL STATS BAR ── */}
      {totalStats.campaigns > 0 && (
        <div className="rounded-2xl border border-zinc-700 bg-gradient-to-r from-zinc-900 to-zinc-800 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-bold text-white">📈 Total Campaign Stats</p>
              <p className="text-xs text-zinc-500 mt-0.5">{totalStats.campaigns} campaign{totalStats.campaigns > 1 ? 's' : ''} sent so far{totalStats.lastUpdated ? ` · Last: ${new Date(totalStats.lastUpdated).toLocaleDateString()}` : ''}</p>
            </div>
            <button onClick={resetTotalStats} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">🗑️ Reset</button>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Total Sent', value: totalStats.totalSent, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', icon: '✅' },
              { label: 'Total Failed', value: totalStats.totalFailed, color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20', icon: '❌' },
              { label: 'Total Messages', value: totalStats.totalMessages, color: 'text-white', bg: 'bg-zinc-800 border-zinc-700', icon: '📨' },
              { label: 'Campaigns', value: totalStats.campaigns, color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20', icon: '🚀' },
            ].map(({ label, value, color, bg, icon }) => (
              <div key={label} className={`rounded-xl border ${bg} p-4 text-center`}>
                <div className="text-lg mb-1">{icon}</div>
                <div className={`text-2xl font-bold ${color}`}>{value}</div>
                <div className="text-xs text-zinc-500 mt-1 leading-tight">{label}</div>
              </div>
            ))}
          </div>
          {/* Success rate bar */}
          {totalStats.totalMessages > 0 && (
            <div className="mt-4">
              <div className="flex justify-between text-xs text-zinc-500 mb-1.5">
                <span>Success Rate</span>
                <span className="text-emerald-400 font-semibold">{Math.round((totalStats.totalSent / totalStats.totalMessages) * 100)}%</span>
              </div>
              <div className="h-2 rounded-full bg-zinc-700 overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-500"
                  style={{ width: `${Math.round((totalStats.totalSent / totalStats.totalMessages) * 100)}%` }} />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6 items-start">

        {/* LEFT */}
        <div className="flex flex-col gap-5">

          {/* Connection */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">📱 Temporary Number</p>
            <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 mb-4">
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusColor}`} />
              <div>
                <p className="text-sm font-semibold text-white">
                  {connection.status === 'connected' ? '✅ Connected' : connection.status === 'connecting' ? '🔄 Scan QR Code' : '🔴 Disconnected'}
                </p>
                <p className="text-xs text-zinc-500">
                  {connection.status === 'connected' ? 'Ready to send bulk messages'
                    : connection.status === 'connecting' ? 'Open WhatsApp → Linked Devices → Scan'
                    : serviceUrl ? 'Start node index.js and ngrok on laptop' : 'Set ngrok URL above first'}
                </p>
              </div>
            </div>
            <div className="rounded-xl bg-white flex items-center justify-center min-h-[200px] mb-4 p-4">
              {qrImage ? <img src={qrImage} alt="WhatsApp QR" className="w-44 h-44" />
                : connection.status === 'connected' ? (
                  <div className="text-center text-zinc-400 text-sm"><div className="text-4xl mb-2">✅</div><div className="text-emerald-600 font-semibold">Connected!</div></div>
                ) : (
                  <div className="text-center text-zinc-400 text-sm"><div className="text-4xl mb-2">📷</div><div>QR will appear here</div></div>
                )}
            </div>
            <button onClick={() => checkStatus(serviceUrl)} disabled={!serviceUrl}
              className="w-full rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-white text-sm font-semibold py-2.5 transition-colors mb-2">
              🔄 Refresh Status
            </button>
            {connection.status === 'connected' && (
              <button onClick={async () => { if (!confirm('Log out temporary number?')) return; await fetch(`${serviceUrl}/disconnect`, { method: 'POST', headers: NGROK_HEADERS }); setQrImage(null); setTimeout(() => checkStatus(serviceUrl), 2000); }}
                className="w-full rounded-lg border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-sm font-semibold py-2.5 transition-colors">
                🔌 Disconnect & Clear Session
              </button>
            )}
          </div>

          {/* Contacts */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">👥 Import Contacts</p>
            <div className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors mb-4 ${isDragging ? 'border-emerald-500 bg-emerald-500/10' : 'border-zinc-700 hover:border-zinc-500'}`}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
              onClick={() => fileInputRef.current?.click()}>
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
              <div className="text-3xl mb-2">📂</div>
              <p className="text-sm font-semibold text-white mb-1">Drop CSV or Excel here</p>
              <p className="text-xs text-zinc-500">Required: <span className="text-emerald-400">phone</span> or <span className="text-emerald-400">mobile</span> column</p>
            </div>
            {contacts.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-white">{contacts.length} contacts loaded</span>
                  <button onClick={() => { setContacts([]); setHeaders([]); }} className="text-xs text-zinc-500 hover:text-red-400">✕ Clear</button>
                </div>
                <div className="rounded-lg border border-zinc-800 overflow-hidden max-h-48 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="bg-zinc-800">{headers.slice(0, 3).map((h) => <th key={h} className="px-3 py-2 text-left text-zinc-400 font-semibold uppercase">{h}</th>)}</tr></thead>
                    <tbody>{contacts.slice(0, 30).map((c, i) => <tr key={i} className="border-t border-zinc-800">{headers.slice(0, 3).map((h) => <td key={h} className="px-3 py-2 text-zinc-300">{c[h]}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 mt-4">
              <div>
                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">Min Delay (sec)</label>
                <input type="number" value={delayMin} min={3} max={60} onChange={(e) => setDelayMin(Number(e.target.value))}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-3 py-2 focus:outline-none focus:border-emerald-500" />
              </div>
              <div>
                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">Max Delay (sec)</label>
                <input type="number" value={delayMax} min={5} max={120} onChange={(e) => setDelayMax(Number(e.target.value))}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 text-white text-sm px-3 py-2 focus:outline-none focus:border-emerald-500" />
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT */}
        <div className="flex flex-col gap-5">

          {/* Composer */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">✍️ Message Composer</p>
            <p className="text-xs text-zinc-500 mb-2">Click to insert variable:</p>
            <div className="flex flex-wrap gap-2 mb-4">
              {allVars.map((v) => (
                <button key={v} onClick={() => insertVar(`{${v}}`)}
                  className="px-3 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold hover:bg-emerald-500/20 transition-colors">
                  {`{${v}}`}
                </button>
              ))}
            </div>
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">Message Template</label>
            <textarea ref={textareaRef} value={message} onChange={(e) => setMessage(e.target.value)} rows={7}
              placeholder={`Hi {name} 👋\n\nWe noticed your interest in {course}.\n\nKBEduTech special admissions 2024-25!\n✅ Expert faculty\n✅ Proven track record\n\nReply to know more!\n\n— KBEduTech Team`}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 text-white text-sm px-4 py-3 focus:outline-none focus:border-emerald-500 resize-none mb-3" />
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs text-zinc-500">{message.length} characters</span>
              <button onClick={showPreviewFn} className="text-xs text-emerald-400 hover:text-emerald-300 font-semibold">👁️ Preview</button>
            </div>
            {preview && (
              <div className="rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-white whitespace-pre-wrap mb-4 leading-relaxed">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs text-zinc-500 font-semibold uppercase">Preview</span>
                  <button onClick={() => setPreview(null)} className="text-zinc-600 hover:text-zinc-400 text-xs">✕</button>
                </div>
                {preview}
              </div>
            )}
            <button onClick={startCampaign} disabled={isRunning || !serviceUrl}
              className="w-full rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 text-sm transition-opacity">
              🚀 {isStarting ? 'Starting...' : campaign.running ? 'Campaign Running...' : 'Start Bulk Campaign'}
            </button>
          </div>

          {/* Previous Campaign */}
          {prevCampaign && !isRunning && (
            <div className="rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">📋 Previous Campaign</p>
              <div className="grid grid-cols-3 gap-3 mb-2">
                {[{ label: 'Sent', value: prevCampaign.sent, color: 'text-emerald-400' }, { label: 'Failed', value: prevCampaign.failed, color: 'text-red-400' }, { label: 'Total', value: prevCampaign.total, color: 'text-zinc-300' }].map(({ label, value, color }) => (
                  <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-center">
                    <div className={`text-2xl font-bold ${color}`}>{value}</div>
                    <div className="text-xs text-zinc-500 mt-0.5 uppercase tracking-wider">{label}</div>
                  </div>
                ))}
              </div>
              {prevCampaign.startedAt && <p className="text-xs text-zinc-600">Sent on: {new Date(prevCampaign.startedAt).toLocaleString()}</p>}
            </div>
          )}

          {/* Current Campaign Progress */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">📊 Current Campaign</p>
              {isStarting && <span className="text-xs text-amber-400 animate-pulse font-semibold">⏳ Starting...</span>}
              {campaign.running && <span className="text-xs text-emerald-400 animate-pulse font-semibold">🔴 Live</span>}
              {campaignCompleted && !campaign.running && !isStarting && <span className="text-xs text-emerald-500 font-semibold">✅ Complete</span>}
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              {[{ label: 'Sent', value: campaign.sent, color: 'text-emerald-400' }, { label: 'Failed', value: campaign.failed, color: 'text-red-400' }, { label: 'Pending', value: campaign.pending, color: 'text-amber-400' }].map(({ label, value, color }) => (
                <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-center">
                  <div className={`text-3xl font-bold ${color}`}>{value}</div>
                  <div className="text-xs text-zinc-500 mt-1 uppercase tracking-wider">{label}</div>
                </div>
              ))}
            </div>
            <div className="h-2 rounded-full bg-zinc-800 overflow-hidden mb-2">
              <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-500" style={{ width: `${isStarting ? 2 : pct}%` }} />
            </div>
            <div className="flex justify-between text-xs text-zinc-500 mb-4">
              <span>
                {isStarting ? '⏳ Preparing to send...'
                  : campaign.running ? `🔴 Sending... (${campaign.sent + campaign.failed}/${campaign.total})`
                  : campaign.total > 0 ? `✅ ${campaign.sent} sent, ${campaign.failed} failed out of ${campaign.total}`
                  : 'No campaign running yet'}
              </span>
              <span>{isStarting ? '' : `${pct}%`}</span>
            </div>
            {campaign.running && (
              <button onClick={abortCampaign} className="w-full rounded-xl border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-400 font-semibold py-2.5 text-sm transition-colors mb-4">
                ⛔ Abort Campaign
              </button>
            )}
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">📋 Send Log</p>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 max-h-64 overflow-y-auto">
              {campaign.log.length === 0 ? (
                <div className="text-center py-8 text-zinc-600 text-sm">{isStarting ? '⏳ Waiting for first message...' : 'No messages sent yet'}</div>
              ) : (
                [...campaign.log].reverse().map((entry, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 last:border-0">
                    <span className="text-base">{entry.status === 'sent' ? '✅' : '❌'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-white truncate">{entry.name}</div>
                      <div className="text-xs text-zinc-500 truncate">{entry.number}{entry.reason ? ` · ${entry.reason}` : ''}</div>
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
