"use client";

import { Building2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, configured, signIn } = useAuth();
  const [busy, setBusy] = useState(false);

  if (!configured) {
    return (
      <Centered>
        <Card className="max-w-md gap-3 p-6 shadow-none">
          <Brand />
          <p className="text-sm font-medium">Firebase isn’t configured yet</p>
          <p className="text-sm text-muted-foreground">
            Copy <code className="font-mono text-xs">.env.example</code> to{" "}
            <code className="font-mono text-xs">.env.local</code>, fill in the
            Firebase web config + service account, then restart the dev
            server. Full steps are in the README.
          </p>
        </Card>
      </Centered>
    );
  }

  if (loading) {
    return (
      <Centered>
        <div className="w-72 space-y-3">
          <Skeleton className="h-10 w-10 rounded-md" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-36" />
        </div>
      </Centered>
    );
  }

  if (!user) {
    return (
      <Centered>
        <Card className="w-full max-w-sm gap-5 p-8 shadow-none">
          <Brand />
          <div className="space-y-1">
            <p className="text-base font-semibold">Property Tax Checker</p>
            <p className="text-sm text-muted-foreground">
              Upload a tracker, check every county portal, download the
              updated workbook.
            </p>
          </div>
          <Button
            className="w-full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await signIn();
              } catch (e) {
                toast.error(
                  e instanceof Error ? e.message : "Sign-in failed",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Signing in…" : "Continue with Google"}
          </Button>
        </Card>
      </Centered>
    );
  }

  return <>{children}</>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      {children}
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Building2 className="h-4.5 w-4.5" />
      </div>
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Pontus Capital · Internal
      </p>
    </div>
  );
}
