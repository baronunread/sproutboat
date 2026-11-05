import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "../src/components/button";
import { CopyId } from "../src/components/copy-id";
import { InlineConfirm } from "../src/components/inline-confirm";
import { deployToast, toast } from "../src/components/toast";
import type { DeployToast } from "../src/components/toast";
import { CheckIcon, CopyIcon } from "../src/lib/icons";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const NAME = "field-notes v48";

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-fg-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const logDialog = () =>
  toast.add({ title: "Build log", description: "Opens the build log dialog in the app.", tone: "neutral" });

/** The deploy scenarios share one toast, like one deploy: a new run morphs the same toast (a failed one included). */
function useDeploy() {
  const run = useRef(0);
  const current = useRef<DeployToast | null>(null);

  async function start(mode: "ok" | "fallback" | "failed") {
    const id = ++run.current;
    const d =
      current.current && current.current.id && toast.has(current.current.id)
        ? current.current
        : (current.current = deployToast({
            name: NAME,
            onViewLog: logDialog,
            onRetry: () => void start("ok"),
            meta: { project: "field-notes" },
          }));
    d.queued();
    await sleep(1400);
    if (id !== run.current) return;
    d.building();
    for (let i = 1; i <= 6; i++) {
      await sleep(mode === "ok" ? 600 : 500);
      if (id !== run.current) return;
      d.progress(0.16 + (0.44 * i) / 6);
    }
    if (mode === "fallback") return d.fallback("No standalone build for crypto-bind");
    if (mode === "failed") return d.failed("TS2304 in routes/index.ts");
    d.canary();
    await sleep(2400);
    if (id !== run.current) return;
    d.live();
  }
  return start;
}

const rate = { tone: "warning", title: "Rate limited on /api/search", description: "429 from search-api" } as const;

async function spam() {
  for (let i = 0; i < 5; i++) {
    toast.add({ ...rate, meta: { project: "search-api", kind: "ratelimit" } });
    await sleep(140);
  }
}

function rollBack() {
  toast.undo({
    title: "Rolled back to v47",
    description: "field-notes · production",
    confirmTitle: "Undone. v48 is live again",
    onUndo: () => undefined,
    meta: { project: "field-notes", kind: "rollback" },
  });
}

function mixed() {
  const items = [
    { tone: "info", title: "Teammate invited", description: "sam@fieldnotes.dev" },
    { tone: "success", title: "Domain verified", description: "notes.fieldnotes.dev" },
    { tone: "warning", title: "billing-hooks v12 on supervisor", description: "Slower cold start" },
    { tone: "info", title: "Secret rotated", description: "STRIPE_WEBHOOK" },
    { tone: "success", title: "Deployed search-api v30", description: "Canary passed" },
  ] as const;
  items.forEach((item, i) => setTimeout(() => toast.add(item), i * 280));
}

/** Every toast scenario from the toast POC, plus the inline confirmations. */
export function ToastLab() {
  const start = useDeploy();
  const [saving, setSaving] = useState(false);
  return (
    <>
      <Group label="Deploy: one toast morphs Queued, Building, Canary, Live. The progress line shows only while in flight.">
        <Button onClick={() => void start("ok")}>Deploy</Button>
        <Button onClick={() => void start("fallback")}>Fallback (amber)</Button>
        <Button onClick={() => void start("failed")}>Failed (red, Retry)</Button>
      </Group>
      <Group label="Merging and Undo">
        <Button onClick={() => void spam()}>Spam ×5</Button>
        <Button onClick={rollBack}>Roll back with Undo</Button>
        <span className="text-sm text-fg-muted">Icon-only Undo. ⌘Z or Ctrl Z undoes the newest.</span>
        <Button onClick={mixed}>Mixed</Button>
        <Button variant="ghost" onClick={() => toast.close()}>
          Clear toasts
        </Button>
      </Group>
      <Group label="One per tone">
        <Button
          onClick={() =>
            toast.add({ title: "Deployment ready", description: "v12 is live on all regions.", tone: "success" })
          }
        >
          Success
        </Button>
        <Button
          onClick={() =>
            toast.add({
              title: "Fell back to supervisor",
              description: "sproutd refused to load v12; it runs on the supervisor.",
              tone: "warning",
            })
          }
        >
          Warning
        </Button>
        <Button
          onClick={() =>
            toast.add({ title: "Build failed", description: "Fix the error and deploy again.", tone: "danger" })
          }
        >
          Danger
        </Button>
        <Button
          onClick={() => toast.add({ title: "Building v13", description: "Step 2 of 4.", tone: "info", busy: true })}
        >
          Info
        </Button>
        <Button onClick={() => toast.add({ title: "Copied to clipboard", tone: "neutral" })}>Neutral</Button>
      </Group>
      <Group label="Inline confirms (not toasts): a bubble above the control, an icon swap, a slot beside the button">
        <CopyId value="dpl_8f3k2n9x" label="Copy deployment ID" />
        <InlineConfirm message="Copied" announce="URL copied">
          {({ confirm, active }) => (
            <Button size="sm" onClick={confirm} className="gap-1.5">
              <span className="inline-grid size-4 *:col-start-1 *:row-start-1 *:transition-[opacity,scale] *:duration-300 *:ease-out">
                <CopyIcon className={active ? "scale-(--sb-scale-icon) opacity-0" : ""} />
                <CheckIcon className={active ? "text-brand-fg" : "scale-(--sb-scale-icon) opacity-0"} />
              </span>
              Copy URL
            </Button>
          )}
        </InlineConfirm>
        <InlineConfirm message="Saved" appearance="inline" duration={1800}>
          {({ confirm }) => (
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              onClick={() => {
                setSaving(true);
                setTimeout(() => {
                  setSaving(false);
                  confirm();
                }, 550);
              }}
            >
              Save changes
            </Button>
          )}
        </InlineConfirm>
      </Group>
    </>
  );
}
