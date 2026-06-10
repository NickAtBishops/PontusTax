"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, LayoutDashboard, LogOut } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const NAV = [{ href: "/", label: "Dashboard", icon: LayoutDashboard }];

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
  const { user, signOut } = useAuth();

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Building2 className="h-4 w-4" />
          </div>
          <div className="leading-tight">
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Pontus Capital
            </p>
            <p className="text-sm font-semibold">Property Tax Checker</p>
          </div>
        </div>
        <Separator />
        <nav className="flex-1 space-y-0.5 p-3">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                pathname === href && "bg-accent text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>
        <Separator />
        <div className="flex items-center justify-between gap-2 p-4">
          <div className="min-w-0">
            <p className="truncate text-xs text-muted-foreground">
              {user?.email ?? "—"}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => signOut()}
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
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
