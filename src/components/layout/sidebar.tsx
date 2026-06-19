"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect } from "react"

import { cn } from "@/lib/utils"
import { useAuth } from "@/hooks/use-auth"
import { useTotalUnread } from "@/hooks/use-total-unread"

import {
  Crown,
  GitBranch,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Mail,
  MessageSquare,
  Phone,
  Radio,
  Settings,
  Shield,
  Sparkles,
  User,
  UserCog,
  Users,
  UsersRound,
  Workflow,
  X,
  Zap,
} from "lucide-react"
import type { AccountRole } from "@/lib/auth/roles"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const ROLE_CHIP: Record<
  AccountRole,
  { icon: typeof Crown; label: string; className: string }
> = {
  owner: {
    icon: Crown,
    label: "Owner",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  },
  admin: {
    icon: Shield,
    label: "Admin",
    className: "border-primary/40 bg-primary/10 text-primary",
  },
  agent: {
    icon: UserCog,
    label: "Agent",
    className: "border-slate-700 bg-slate-800 text-slate-300",
  },
  viewer: {
    icon: User,
    label: "Viewer",
    className: "border-slate-800 bg-slate-900 text-slate-500",
  },
}

interface NavItem {
  href: string
  label: string
  icon: typeof LayoutDashboard
  beta?: boolean
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Admissions Dashboard", icon: LayoutDashboard },
  { href: "/inbox", label: "Student Inbox", icon: MessageSquare },
  { href: "/contacts", label: "Student Leads", icon: Users },
  { href: "/pipelines", label: "Admissions Pipeline", icon: GitBranch },
  { href: "/broadcasts", label: "Campaigns", icon: Radio },
  { href: "/automations", label: "Follow-up Rules", icon: Zap },
  { href: "/flows", label: "Bot Flows", icon: Workflow, beta: true },
  { href: "/bulk-whatsapp", label: "Bulk WhatsApp", icon: Radio },
  { href: "/gmail-campaign", label: "Gmail Campaign", icon: Mail },
  { href: "/call-manager", label: "Call Manager", icon: Phone },
]

const bottomNavItems = [{ href: "/settings", label: "Settings", icon: Settings }]

interface SidebarProps {
  open?: boolean
  onClose?: () => void
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname()
  const { profile, profileLoading, account, accountRole, signOut } = useAuth()
  const totalUnread = useTotalUnread()

  const showAccountStrip =
    !profileLoading &&
    !!account?.name &&
    account.name !== profile?.full_name

  useEffect(() => {
    onClose?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.()
    }

    window.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener("keydown", onKey)
    }
  }, [open, onClose])

  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-slate-950/70 backdrop-blur-sm transition-opacity lg:hidden",
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-full w-72 flex-col border-r border-emerald-500/15 bg-slate-950",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          "lg:static lg:z-0 lg:w-64 lg:translate-x-0 lg:transition-none",
        )}
        aria-label="Primary"
      >
        <div className="relative flex h-20 shrink-0 items-center justify-between gap-2 border-b border-emerald-500/15 px-4">
          <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/10 via-cyan-500/5 to-transparent" />
          <Link href="/dashboard" className="relative flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-400 text-slate-950 shadow-lg shadow-emerald-950/30">
              <GraduationCap className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold leading-tight text-white">
                KB EDU Tech
              </p>
              <p className="truncate text-xs font-medium text-emerald-200">
                Admissions CRM
              </p>
            </div>
          </Link>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="relative flex h-9 w-9 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mx-3 mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-emerald-200">
            <Sparkles className="h-3.5 w-3.5" />
            Live Admissions Workspace
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Chatbot, leads, campaigns, and follow-ups in one place.
          </p>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="flex flex-col gap-1.5">
            {navItems.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/dashboard" && pathname.startsWith(item.href))

              const showUnreadDot = item.href === "/inbox" && totalUnread > 0 && !isActive

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all lg:py-2.5",
                      isActive
                        ? "bg-gradient-to-r from-emerald-500/20 to-cyan-500/10 text-emerald-200 ring-1 ring-emerald-500/20"
                        : "text-slate-400 hover:bg-slate-900 hover:text-white",
                    )}
                  >
                    <item.icon className={cn("h-4 w-4", isActive ? "text-emerald-300" : "text-slate-500 group-hover:text-emerald-300")} />
                    <span className="flex-1">{item.label}</span>

                    {item.beta && (
                      <span
                        aria-label="Beta feature"
                        className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300"
                      >
                        Beta
                      </span>
                    )}

                    {showUnreadDot && (
                      <span
                        aria-label={`${totalUnread} unread conversation${totalUnread === 1 ? "" : "s"}`}
                        className="relative flex h-2 w-2"
                      >
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                      </span>
                    )}
                  </Link>
                </li>
              )
            })}
          </ul>

          <div className="my-4 border-t border-slate-800" />

          <ul className="flex flex-col gap-1">
            {bottomNavItems.map((item) => {
              const isActive = pathname.startsWith(item.href)
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      isActive
                        ? "bg-emerald-500/10 text-emerald-300"
                        : "text-slate-400 hover:bg-slate-900 hover:text-white",
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="shrink-0 border-t border-emerald-500/15 p-3">
          {showAccountStrip && account?.name ? (
            <div className="mb-2 flex items-center gap-2 px-3 text-xs text-slate-500">
              <UsersRound className="size-3.5 shrink-0" />
              <span className="truncate" title={account.name}>
                {account.name}
              </span>

              {accountRole
                ? (() => {
                    const meta = ROLE_CHIP[accountRole]
                    const Icon = meta.icon
                    return (
                      <span className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${meta.className}`}>
                        <Icon className="size-3" />
                        {meta.label}
                      </span>
                    )
                  })()
                : null}
            </div>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 px-3 py-3 text-left transition-colors hover:bg-slate-800/70 focus:bg-slate-800/70 focus:outline-none data-popup-open:bg-slate-800/70">
              <Avatar className="size-9 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage src={profile.avatar_url} alt={profile.full_name ?? "Avatar"} />
                ) : null}
                <AvatarFallback className="bg-emerald-500/10 text-sm font-medium text-emerald-300">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ?? profile?.email?.charAt(0)?.toUpperCase() ?? "U"}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-white">
                  {profile?.full_name ?? "User"}
                </p>
                <p className="truncate text-xs text-slate-400">
                  {profile?.email ?? ""}
                </p>
              </div>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" side="top" sideOffset={6} className="min-w-56 bg-slate-900 text-slate-100 ring-slate-700">
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    onClick={onClose}
                    className="text-slate-200 focus:bg-slate-800 focus:text-white"
                  />
                }
              >
                <User className="size-4" />
                Profile
              </DropdownMenuItem>

              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=whatsapp"
                    onClick={onClose}
                    className="text-slate-200 focus:bg-slate-800 focus:text-white"
                  />
                }
              >
                <Settings className="size-4" />
                Settings
              </DropdownMenuItem>

              <DropdownMenuSeparator className="bg-slate-800" />

              <DropdownMenuItem onClick={signOut} className="text-slate-200 focus:bg-slate-800 focus:text-white">
                <LogOut className="size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  )
}
