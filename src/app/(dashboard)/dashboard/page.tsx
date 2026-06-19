"use client"

// KB EDU Tech Premium Dashboard v6 — TypeScript-safe Supabase queries.
// IMPORTANT: This file intentionally casts createClient() as any to avoid Hostinger build failures from Supabase nested/query-builder type inference.

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Bot,
  CalendarClock,
  CheckCircle2,
  GraduationCap,
  MessageCircle,
  PhoneCall,
  Radio,
  Sparkles,
  Target,
  TrendingUp,
  Trophy,
  Users,
  Wallet,
} from "lucide-react"

import { createClient } from "@/lib/supabase/client"

type ContactRow = {
  id: string
  name: string | null
  phone: string | null
  created_at: string | null
}

type ContactTagRawRow = {
  contact_id: string
  tag_id: string | null
}

type TagMasterRow = {
  id: string
  name: string | null
}

type ContactCustomValueRawRow = {
  contact_id: string
  custom_field_id: string | null
  value: string | null
}

type CustomFieldMasterRow = {
  id: string
  name: string | null
}

type TagRow = {
  contact_id: string
  tag_name: string | null
}

type CustomValueRow = {
  contact_id: string
  field_name: string | null
  value: string | null
}

type MessageRow = {
  id: string
  sender_type: string | null
  created_at: string | null
  status?: string | null
}

type DashboardData = {
  contacts: ContactRow[]
  tagRows: TagRow[]
  customRows: CustomValueRow[]
  messagesToday: MessageRow[]
  conversationsCount: number
  broadcastCount: number
  warnings: string[]
}

const EMPTY_DATA: DashboardData = {
  contacts: [],
  tagRows: [],
  customRows: [],
  messagesToday: [],
  conversationsCount: 0,
  broadcastCount: 0,
  warnings: [],
}

function normalize(value?: string | null) {
  return (value || "").trim().toLowerCase()
}

function startOfTodayIso() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.toISOString()
}

function asDate(value?: string | null) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function isToday(value?: string | null) {
  const d = asDate(value)
  if (!d) return false
  const today = new Date()
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  )
}

function isDueOrOverdue(value?: string | null) {
  const d = asDate(value)
  if (!d) return false
  const today = new Date()
  today.setHours(23, 59, 59, 999)
  return d.getTime() <= today.getTime()
}

function getContactTags(tagRows: TagRow[], contactId: string) {
  return tagRows
    .filter((row) => row.contact_id === contactId)
    .map((row) => row.tag_name)
    .filter(Boolean) as string[]
}

function getFieldValue(customRows: CustomValueRow[], contactId: string, fieldName: string) {
  const row = customRows.find(
    (item) =>
      item.contact_id === contactId &&
      normalize(item.field_name) === normalize(fieldName),
  )

  return row?.value || ""
}

function countContactsWithTag(tagRows: TagRow[], tagName: string) {
  return new Set(
    tagRows
      .filter((row) => normalize(row.tag_name) === normalize(tagName))
      .map((row) => row.contact_id),
  ).size
}

function countContactsWithField(customRows: CustomValueRow[], fieldName: string, matcher: (value: string) => boolean) {
  return new Set(
    customRows
      .filter((row) => normalize(row.field_name) === normalize(fieldName))
      .filter((row) => matcher(row.value || ""))
      .map((row) => row.contact_id),
  ).size
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData>(EMPTY_DATA)
  const [loading, setLoading] = useState(true)

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    const db = createClient() as any
    const todayIso = startOfTodayIso()
    const warnings: string[] = []

    try {
      const contactsQuery = await db
        .from("contacts")
        .select("id,name,phone,created_at")
        .order("created_at", { ascending: false })
        .limit(1000)

      if (contactsQuery.error) {
        console.warn("[Dashboard] contacts query failed", contactsQuery.error)
        warnings.push("contacts")
      }

      const contactTagsQuery = await db
        .from("contact_tags")
        .select("contact_id,tag_id")
        .limit(5000)

      if (contactTagsQuery.error) {
        console.warn("[Dashboard] contact_tags query failed", contactTagsQuery.error)
        warnings.push("contact_tags")
      }

      const tagMastersQuery = await db
        .from("tags")
        .select("id,name")
        .limit(5000)

      if (tagMastersQuery.error) {
        console.warn("[Dashboard] tags query failed", tagMastersQuery.error)
        warnings.push("tags")
      }

      const customValuesQuery = await db
        .from("contact_custom_values")
        .select("contact_id,custom_field_id,value")
        .limit(5000)

      if (customValuesQuery.error) {
        console.warn("[Dashboard] contact_custom_values query failed", customValuesQuery.error)
        warnings.push("contact_custom_values")
      }

      const customFieldsQuery = await db
        .from("custom_fields")
        .select("id,name")
        .limit(5000)

      if (customFieldsQuery.error) {
        console.warn("[Dashboard] custom_fields query failed", customFieldsQuery.error)
        warnings.push("custom_fields")
      }

      const messagesQuery = await db
        .from("messages")
        .select("id,sender_type,status,created_at")
        .gte("created_at", todayIso)
        .limit(2000)

      if (messagesQuery.error) {
        console.warn("[Dashboard] messages query failed", messagesQuery.error)
        warnings.push("messages")
      }

      const conversationsQuery = await db
        .from("conversations")
        .select("id", { count: "exact", head: true })

      if (conversationsQuery.error) {
        console.warn("[Dashboard] conversations query failed", conversationsQuery.error)
        warnings.push("conversations")
      }

      const broadcastsQuery = await db
        .from("broadcasts")
        .select("id", { count: "exact", head: true })

      if (broadcastsQuery.error) {
        console.warn("[Dashboard] broadcasts query failed", broadcastsQuery.error)
        warnings.push("broadcasts")
      }

      const contacts = (contactsQuery.data || []) as ContactRow[]
      const contactTags = (contactTagsQuery.data || []) as ContactTagRawRow[]
      const tagMasters = (tagMastersQuery.data || []) as TagMasterRow[]
      const customValues = (customValuesQuery.data || []) as ContactCustomValueRawRow[]
      const customFields = (customFieldsQuery.data || []) as CustomFieldMasterRow[]

      const tagNameById = new Map<string, string | null>(
        tagMasters.map((tag) => [tag.id, tag.name]),
      )

      const fieldNameById = new Map<string, string | null>(
        customFields.map((field) => [field.id, field.name]),
      )

      const tagRows: TagRow[] = contactTags.map((row) => ({
        contact_id: row.contact_id,
        tag_name: row.tag_id ? tagNameById.get(row.tag_id) || null : null,
      }))

      const customRows: CustomValueRow[] = customValues.map((row) => ({
        contact_id: row.contact_id,
        field_name: row.custom_field_id ? fieldNameById.get(row.custom_field_id) || null : null,
        value: row.value,
      }))

      setData({
        contacts,
        tagRows,
        customRows,
        messagesToday: (messagesQuery.data || []) as MessageRow[],
        conversationsCount: conversationsQuery.count || 0,
        broadcastCount: broadcastsQuery.count || 0,
        warnings,
      })
    } catch (error) {
      console.error("[Admissions dashboard] failed to load", error)
      setData({ ...EMPTY_DATA, warnings: ["dashboard"] })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDashboard()
  }, [loadDashboard])

  const stats = useMemo(() => {
    const totalLeads = data.contacts.length
    const newToday = data.contacts.filter((contact) => isToday(contact.created_at)).length
    const hotLeads = countContactsWithTag(data.tagRows, "Hot Lead")
    const feesAsked = countContactsWithTag(data.tagRows, "Fees Asked")
    const scholarshipAsked = countContactsWithTag(data.tagRows, "Scholarship Asked")
    const followUpRequired = countContactsWithTag(data.tagRows, "Follow-up Required")
    const admissionsDone = countContactsWithTag(data.tagRows, "Admission Done")
    const kalasalingam = countContactsWithTag(data.tagRows, "Kalasalingam Lead")
    const chettinad = countContactsWithTag(data.tagRows, "Chettinad Lead")
    const placementsAsked = countContactsWithTag(data.tagRows, "Placements Asked")
    const officeAsked = countContactsWithTag(data.tagRows, "Office / Contact Asked")
    const highPriority = countContactsWithField(data.customRows, "Follow-up Priority", (value) => normalize(value) === "high")
    const followUpsDue = countContactsWithField(data.customRows, "Follow-Up Date", (value) => isDueOrOverdue(value))
    const messagesSent = data.messagesToday.filter((message) => message.sender_type === "agent").length
    const incomingToday = data.messagesToday.filter((message) => message.sender_type === "customer").length

    return {
      totalLeads,
      newToday,
      hotLeads,
      feesAsked,
      scholarshipAsked,
      followUpRequired,
      admissionsDone,
      kalasalingam,
      chettinad,
      placementsAsked,
      officeAsked,
      highPriority,
      followUpsDue,
      messagesSent,
      incomingToday,
    }
  }, [data])

  const leadRows = useMemo(() => {
    return data.contacts
      .map((contact) => {
        const leadScore = Number(getFieldValue(data.customRows, contact.id, "Lead Score") || "0")
        const university = getFieldValue(data.customRows, contact.id, "Interested University")
        const askedAbout = getFieldValue(data.customRows, contact.id, "Asked About")
        const priority = getFieldValue(data.customRows, contact.id, "Follow-up Priority")
        const status = getFieldValue(data.customRows, contact.id, "Lead Status")
        return { ...contact, leadScore, university, askedAbout, priority, status }
      })
      .sort((a, b) => {
        const priorityA = normalize(a.priority) === "high" ? 100 : 0
        const priorityB = normalize(b.priority) === "high" ? 100 : 0
        return priorityB + b.leadScore - (priorityA + a.leadScore)
      })
      .slice(0, 8)
  }, [data])

  const universityTotal = Math.max(stats.kalasalingam + stats.chettinad, 1)
  const kalasalingamPct = Math.round((stats.kalasalingam / universityTotal) * 100)
  const chettinadPct = Math.round((stats.chettinad / universityTotal) * 100)

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950/70 p-6 shadow-2xl shadow-emerald-950/20">
        <div className="absolute right-0 top-0 h-48 w-48 rounded-full bg-emerald-400/20 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-32 w-32 rounded-full bg-cyan-400/10 blur-3xl" />

        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-200">
              <Sparkles className="h-3.5 w-3.5" />
              KB EDU Tech Admissions CRM
            </div>
            <h1 className="mt-4 text-3xl font-bold tracking-tight text-white">Admissions Dashboard</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-300">
              Track student leads, university interest, fees enquiries, scholarship intent, follow-ups, and admissions performance.
            </p>
            {data.warnings.length > 0 ? (
              <p className="mt-3 text-xs text-amber-300">
                Some widgets could not load: {data.warnings.join(", ")}. Core CRM still works.
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-3 gap-3 rounded-2xl border border-white/10 bg-white/5 p-3 backdrop-blur">
            <MiniStat label="Incoming Today" value={stats.incomingToday} />
            <MiniStat label="Sent Today" value={stats.messagesSent} />
            <MiniStat label="Leads" value={stats.totalLeads} />
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading ? (
          Array.from({ length: 8 }).map((_, index) => <PremiumSkeleton key={index} />)
        ) : (
          <>
            <PremiumMetric title="Total Student Leads" value={stats.totalLeads} subtitle={`${stats.newToday} new today`} icon={Users} gradient="from-emerald-500/25 to-teal-500/10" iconClass="bg-emerald-400/15 text-emerald-300" />
            <PremiumMetric title="Hot Leads" value={stats.hotLeads} subtitle={`${stats.highPriority} high priority`} icon={Target} gradient="from-rose-500/25 to-orange-500/10" iconClass="bg-rose-400/15 text-rose-300" />
            <PremiumMetric title="Fees Asked" value={stats.feesAsked} subtitle={`${stats.scholarshipAsked} scholarship enquiries`} icon={Wallet} gradient="from-amber-500/25 to-yellow-500/10" iconClass="bg-amber-400/15 text-amber-300" />
            <PremiumMetric title="Follow-ups Due" value={stats.followUpsDue || stats.followUpRequired} subtitle={`${stats.followUpRequired} require action`} icon={CalendarClock} gradient="from-cyan-500/25 to-blue-500/10" iconClass="bg-cyan-400/15 text-cyan-300" />
            <PremiumMetric title="Kalasalingam Leads" value={stats.kalasalingam} subtitle={`${kalasalingamPct}% of selected leads`} icon={GraduationCap} gradient="from-violet-500/25 to-indigo-500/10" iconClass="bg-violet-400/15 text-violet-300" />
            <PremiumMetric title="Chettinad Leads" value={stats.chettinad} subtitle={`${chettinadPct}% of selected leads`} icon={BookOpen} gradient="from-sky-500/25 to-blue-500/10" iconClass="bg-sky-400/15 text-sky-300" />
            <PremiumMetric title="Placements Asked" value={stats.placementsAsked} subtitle={`${stats.officeAsked} office/contact enquiries`} icon={Trophy} gradient="from-purple-500/25 to-fuchsia-500/10" iconClass="bg-purple-400/15 text-purple-300" />
            <PremiumMetric title="Admissions Confirmed" value={stats.admissionsDone} subtitle="Counsellor verified" icon={CheckCircle2} gradient="from-green-500/25 to-emerald-500/10" iconClass="bg-green-400/15 text-green-300" />
          </>
        )}
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="rounded-3xl border border-slate-800 bg-slate-950/80 p-5 shadow-xl xl:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-white">High Intent Follow-ups</h2>
              <p className="text-sm text-slate-400">Counsellors should call these students first.</p>
            </div>
            <Link href="/contacts" className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-400/20">
              View Leads <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <div className="mt-4 overflow-hidden rounded-2xl border border-slate-800">
            <div className="grid grid-cols-12 bg-slate-900/80 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <div className="col-span-3">Student</div>
              <div className="col-span-3">University</div>
              <div className="col-span-2">Asked</div>
              <div className="col-span-2">Score</div>
              <div className="col-span-2 text-right">Action</div>
            </div>

            {leadRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center text-slate-400">
                <Bot className="h-8 w-8 text-slate-500" />
                <p className="font-medium text-slate-300">No tracked leads yet</p>
                <p className="text-sm">Once students chat with the bot, lead scores and follow-ups will appear here.</p>
              </div>
            ) : (
              leadRows.map((lead) => (
                <div key={lead.id} className="grid grid-cols-12 items-center gap-2 border-t border-slate-800 px-4 py-3 text-sm">
                  <div className="col-span-3">
                    <p className="font-semibold text-white">{lead.name || "Student"}</p>
                    <p className="text-xs text-slate-500">{lead.phone || "No phone"}</p>
                  </div>
                  <div className="col-span-3 truncate text-slate-300">{lead.university || "Not selected"}</div>
                  <div className="col-span-2 truncate text-slate-300">{lead.askedAbout || lead.status || "New Lead"}</div>
                  <div className="col-span-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-20 overflow-hidden rounded-full bg-slate-800">
                        <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400" style={{ width: `${Math.min(Math.max(lead.leadScore || 10, 10), 100)}%` }} />
                      </div>
                      <span className="text-xs font-semibold text-emerald-200">{lead.leadScore || 10}</span>
                    </div>
                  </div>
                  <div className="col-span-2 flex justify-end gap-2">
                    {lead.phone ? (
                      <a href={`tel:+${lead.phone}`} className="rounded-full border border-slate-700 p-2 text-slate-300 hover:border-emerald-400/40 hover:text-emerald-300" title="Call student">
                        <PhoneCall className="h-4 w-4" />
                      </a>
                    ) : null}
                    <Link href="/inbox" className="rounded-full border border-slate-700 p-2 text-slate-300 hover:border-cyan-400/40 hover:text-cyan-300" title="Open inbox">
                      <MessageCircle className="h-4 w-4" />
                    </Link>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-4">
          <UniversitySplit kalasalingam={stats.kalasalingam} chettinad={stats.chettinad} kalasalingamPct={kalasalingamPct} chettinadPct={chettinadPct} />

          <div className="rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-950 to-slate-900 p-5 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-emerald-400/15 p-3 text-emerald-300">
                <Radio className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-semibold text-white">Campaign Readiness</h2>
                <p className="text-sm text-slate-400">Use Broadcasts with approved templates.</p>
              </div>
            </div>

            <div className="mt-4 space-y-3 text-sm">
              <ReadinessItem label="Contacts segmented by tags" ready={stats.totalLeads > 0} />
              <ReadinessItem label="Fees/scholarship audience available" ready={stats.feesAsked > 0 || stats.scholarshipAsked > 0} />
              <ReadinessItem label="Follow-up leads identified" ready={stats.followUpRequired > 0} />
            </div>

            <Link href="/broadcasts" className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400">
              Create Campaign <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ActionCard title="Student Inbox" description="Reply to active WhatsApp leads and review bot conversations." href="/inbox" icon={MessageCircle} accent="emerald" />
        <ActionCard title="Admissions Pipeline" description="Move students from enquiry to fees shared, application started, and admission confirmed." href="/pipelines" icon={TrendingUp} accent="cyan" />
        <ActionCard title="Follow-up Rules" description="Use later for internal reminders, tags, assignments, and counselor follow-up rules." href="/automations" icon={AlertTriangle} accent="amber" />
      </section>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-[92px] rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2 text-center">
      <p className="text-lg font-bold text-white">{value.toLocaleString()}</p>
      <p className="text-[11px] text-slate-400">{label}</p>
    </div>
  )
}

function PremiumMetric({ title, value, subtitle, icon: Icon, gradient, iconClass }: { title: string; value: number; subtitle: string; icon: typeof Users; gradient: string; iconClass: string }) {
  return (
    <div className={`relative overflow-hidden rounded-3xl border border-slate-800 bg-gradient-to-br ${gradient} p-5 shadow-xl`}>
      <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-white/10 blur-2xl" />
      <div className="relative flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-slate-300">{title}</p>
          <p className="mt-3 text-3xl font-bold text-white">{value.toLocaleString()}</p>
          <p className="mt-1 text-xs text-slate-400">{subtitle}</p>
        </div>
        <div className={`rounded-2xl p-3 ${iconClass}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  )
}

function PremiumSkeleton() {
  return <div className="h-36 animate-pulse rounded-3xl border border-slate-800 bg-slate-900/70" />
}

function UniversitySplit({ kalasalingam, chettinad, kalasalingamPct, chettinadPct }: { kalasalingam: number; chettinad: number; kalasalingamPct: number; chettinadPct: number }) {
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-950/80 p-5 shadow-xl">
      <h2 className="font-semibold text-white">University Interest Split</h2>
      <p className="mt-1 text-sm text-slate-400">Lead demand by selected university.</p>
      <div className="mt-5 space-y-5">
        <SplitBar label="Kalasalingam" value={kalasalingam} percent={kalasalingamPct} color="from-violet-400 to-fuchsia-400" />
        <SplitBar label="Chettinad" value={chettinad} percent={chettinadPct} color="from-sky-400 to-cyan-400" />
      </div>
    </div>
  )
}

function SplitBar({ label, value, percent, color }: { label: string; value: number; percent: number; color: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-medium text-slate-300">{label}</span>
        <span className="text-slate-400">{value.toLocaleString()} leads</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full bg-gradient-to-r ${color}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1 text-xs text-slate-500">{percent}% of selected leads</p>
    </div>
  )
}

function ReadinessItem({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-900/60 px-3 py-2">
      <span className="text-slate-300">{label}</span>
      {ready ? (
        <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-xs font-semibold text-emerald-300">Ready</span>
      ) : (
        <span className="rounded-full bg-slate-700/50 px-2 py-1 text-xs font-semibold text-slate-400">Pending</span>
      )}
    </div>
  )
}

function ActionCard({ title, description, href, icon: Icon, accent }: { title: string; description: string; href: string; icon: typeof Users; accent: "emerald" | "cyan" | "amber" }) {
  const styles = {
    emerald: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
    cyan: "border-cyan-400/20 bg-cyan-400/10 text-cyan-300",
    amber: "border-amber-400/20 bg-amber-400/10 text-amber-300",
  }

  return (
    <Link href={href} className="group rounded-3xl border border-slate-800 bg-slate-950/80 p-5 shadow-xl transition hover:-translate-y-0.5 hover:border-slate-700 hover:bg-slate-900/90">
      <div className={`inline-flex rounded-2xl border p-3 ${styles[accent]}`}>
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-4 font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm text-slate-400">{description}</p>
      <div className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-emerald-300">
        Open <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
      </div>
    </Link>
  )
}
