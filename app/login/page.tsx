"use client";

// The shared-password gate that every request hits before it can see
// anything else. Submits to /api/login; on success, the server sets the
// signed cookie and we bounce the analyst to ?next= (or "/" by default).

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Building2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        setError(detail.error ?? "Wrong password.");
        return;
      }
      // The ?next= value is set by the middleware when it redirects
      // unauthenticated requests. We only accept a same-origin path so
      // a crafted next= can't bounce the analyst to an external site.
      const rawNext = params.get("next") ?? "/";
      const next = rawNext.startsWith("/") && !rawNext.startsWith("//")
        ? rawNext
        : "/";
      router.replace(next);
      // router.refresh() forces a re-fetch of the now-authenticated
      // route so server components see the new cookie immediately.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-6">
      <Card className="w-full max-w-sm gap-4 p-6 shadow-none">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Building2 className="h-4.5 w-4.5" />
          </div>
          <p className="text-sm font-semibold">Pontus</p>
        </div>
        <h1 className="text-base font-semibold">Sign in</h1>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            disabled={busy}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={busy || !password} className="w-full">
            {busy ? "Checking..." : "Continue"}
          </Button>
        </form>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams must sit inside a Suspense boundary in Next.js
  // App Router; without it the build complains for static optimization.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
