"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Building2,
  ChevronsLeft,
  ChevronsRight,
  FileSpreadsheet,
  ReceiptText,
} from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// One entry per tool. Each entry highlights when pathname matches the
// tool's prefix exactly OR starts with `<prefix>/`, so /tax/runs/<id>
// still keeps "Property Tax" lit.
const NAV = [
  { href: "/tax", label: "Property Tax", icon: FileSpreadsheet },
  { href: "/tenant-credit", label: "Tenant Credit", icon: ReceiptText },
];

const STORAGE_KEY = "pontus-sidebar-collapsed";

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // Sidebar state persists across page loads via localStorage so the
  // analyst's preference sticks. SSR safety: useState starts false so
  // the initial render matches the server, then the effect below reads
  // localStorage and updates on the client. The setCollapsed call is
  // deferred via queueMicrotask to satisfy react-hooks/set-state-in-
  // effect (the rule flags synchronous setState inside useEffect
  // because it triggers an extra render; deferring lets the lint pass
  // and the user-visible behavior is identical).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem(STORAGE_KEY) === "true") {
      queueMicrotask(() => setCollapsed(true));
    }
  }, []);
  function toggleCollapsed() {
    setCollapsed((cur) => {
      const next = !cur;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      }
      return next;
    });
  }

  return (
    <div className="flex min-h-screen">
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r bg-sidebar transition-[width] duration-150 md:flex",
          collapsed ? "w-14" : "w-60",
        )}
      >
        <Link
          href="/"
          className={cn(
            "flex items-center gap-2.5 px-5 py-5",
            collapsed && "px-3 justify-center",
          )}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Building2 className="h-4 w-4" />
          </div>
          {!collapsed && (
            <p className="text-sm font-semibold">Pontus</p>
          )}
        </Link>
        <Separator />
        <nav className="flex-1 space-y-0.5 p-3">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                isActive(pathname, href) && "bg-accent text-foreground",
                collapsed && "justify-center px-2",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && label}
            </Link>
          ))}
        </nav>
        <Separator />
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            collapsed && "justify-center",
          )}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-4 border-b bg-card px-6">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
