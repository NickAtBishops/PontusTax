import Link from "next/link";
import { Building2, FileSpreadsheet, ReceiptText } from "lucide-react";

import { Card } from "@/components/ui/card";

export const metadata = {
  title: "Pontus Capital — Internal Tools",
};

// Root landing page. The two tools (Property Tax Checker and Tenant
// Credit Tracker) used to live in separate repos and on separate Vercel
// projects. They are now folded into one app behind this picker so the
// analyst lands on a tools list and clicks through, instead of bouncing
// between domains.
export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-6 py-12">
      <header className="mb-8 flex flex-col items-center gap-2 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Building2 className="h-5 w-5" />
        </div>
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Pontus Capital · Internal
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Pick a tool</h1>
      </header>

      <div className="grid w-full max-w-3xl grid-cols-1 gap-4 md:grid-cols-2">
        <ToolCard
          href="/tax"
          title="Property Tax Checker"
          description="Upload a property-tax Excel tracker. Each row is looked up on its county portal and a checked copy is produced for download."
          Icon={FileSpreadsheet}
        />
        <ToolCard
          href="/tenant-credit"
          title="Tenant Credit Tracker"
          description="Upload a tenant's quarterly income statement PDF. Computes Sales and EBITDA and writes them into the corporate tracker."
          Icon={ReceiptText}
        />
      </div>
    </div>
  );
}

function ToolCard({
  href,
  title,
  description,
  Icon,
}: {
  href: string;
  title: string;
  description: string;
  Icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Link href={href} className="group">
      <Card className="h-full gap-3 p-6 shadow-none transition-colors group-hover:border-primary group-hover:bg-accent/40">
        <div className="flex h-9 w-9 items-center justify-center rounded-md border bg-card">
          <Icon className="h-4.5 w-4.5 text-foreground" />
        </div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
        <p className="mt-1 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
          Open →
        </p>
      </Card>
    </Link>
  );
}
