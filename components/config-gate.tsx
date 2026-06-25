"use client";

import { Building2 } from "lucide-react";
import { isFirebaseConfigured } from "@/lib/firebase";
import { Card } from "@/components/ui/card";

// Blocks rendering until Firebase env vars exist. Components behind
// this gate touch `db` directly; it's undefined without a web config.
export function ConfigGate({ children }: { children: React.ReactNode }) {
  if (!isFirebaseConfigured) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card className="max-w-md gap-3 p-6 shadow-none">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Building2 className="h-4.5 w-4.5" />
            </div>
            <p className="text-sm font-semibold">Pontus</p>
          </div>
          <p className="text-sm font-medium">Firebase not configured</p>
          <p className="text-sm text-muted-foreground">
            Copy <code className="font-mono text-xs">.env.example</code> to{" "}
            <code className="font-mono text-xs">.env.local</code>, fill in
            the Firebase keys, restart dev.
          </p>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
