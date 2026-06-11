"use client";

import { Building2 } from "lucide-react";
import { isFirebaseConfigured } from "@/lib/firebase";
import { Card } from "@/components/ui/card";

/** Blocks rendering until Firebase env vars exist — components behind this
 *  gate touch `db` directly, which is undefined without a web config. */
export function ConfigGate({ children }: { children: React.ReactNode }) {
  if (!isFirebaseConfigured) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card className="max-w-md gap-3 p-6 shadow-none">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Building2 className="h-4.5 w-4.5" />
            </div>
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Pontus Capital · Internal
            </p>
          </div>
          <p className="text-sm font-medium">Firebase isn’t configured yet</p>
          <p className="text-sm text-muted-foreground">
            Copy <code className="font-mono text-xs">.env.example</code> to{" "}
            <code className="font-mono text-xs">.env.local</code>, fill in the
            Firebase web config + service account, then restart the dev
            server. Full steps are in the README.
          </p>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
