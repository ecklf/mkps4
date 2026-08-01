import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowRight,
  Cpu,
  Disc3,
  LoaderCircle,
  Package,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type DiscInfo = {
  original: string;
  titleId: string;
  emulatorId: string;
};

type Disc = {
  path: string;
  info: DiscInfo;
};

type Emulator = {
  name: string;
  path: string;
};

type SetupStatus = {
  installed: boolean;
  home: string;
  emulatorsDir: string;
  emulators: Emulator[];
};

type InstallProgress = {
  phase: string;
  completed: number;
  total: number | null;
  overallPercent: number;
};

const sections = ["Game", "Identity", "Compatibility", "Review", "Build"];

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function phaseLabel(phase: string) {
  switch (phase) {
    case "preparing":
      return "Preparing";
    case "downloading":
      return "Downloading archive";
    case "combining":
      return "Joining parts";
    case "installing":
      return "Installing files";
    case "complete":
      return "Ready";
    default:
      return "Waiting";
  }
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
        <Package className="size-4" strokeWidth={2.4} />
      </span>
      <strong className="text-sm tracking-tight">mkps4</strong>
    </div>
  );
}

function SetupScreen({
  status,
  onComplete,
}: {
  status: SetupStatus;
  onComplete: (status: SetupStatus) => void;
}) {
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopListening: (() => void) | undefined;
    void listen<InstallProgress>("emulator-install-progress", (event) => {
      setProgress(event.payload);
    }).then((unlisten) => {
      stopListening = unlisten;
    });
    return () => stopListening?.();
  }, []);

  async function install() {
    setError(null);
    setInstalling(true);
    try {
      const installed = await invoke<SetupStatus>("install_emulators");
      onComplete(installed);
    } catch (reason) {
      setError(String(reason));
      setInstalling(false);
    }
  }

  const transferred = progress
    ? progress.total
      ? `${formatBytes(progress.completed)} / ${formatBytes(progress.total)}`
      : formatBytes(progress.completed)
    : "0 MB";

  return (
    <div className="min-h-screen">
      <header className="flex h-16 items-center border-b px-7">
        <Brand />
      </header>

      <main className="mx-auto grid h-[calc(100vh-4rem)] w-full max-w-xl place-items-center overflow-y-auto px-6 py-8">
        <section className="w-full">
          <h1 className="text-4xl font-semibold tracking-tight">Set up emulators</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Install the community runtime collection to continue.
          </p>

          <Separator className="my-8" />

          <div className="rounded-lg border bg-muted/20 p-4">
            <span className="text-xs font-medium text-muted-foreground">
              Install location
            </span>
            <code className="mt-2 block min-w-0 truncate text-xs text-foreground/80">
              {status.emulatorsDir}
            </code>
          </div>

          {installing ? (
            <div className="mt-8">
              <div className="mb-3 flex items-center justify-between gap-6">
                <span className="text-xs font-medium">
                  {phaseLabel(progress?.phase ?? "preparing")}
                </span>
                <span className="font-mono text-xs tabular-nums text-primary">
                  {progress?.overallPercent ?? 0}%
                </span>
              </div>
              <Progress
                aria-label="Emulator installation progress"
                className="install-progress block"
                value={progress?.overallPercent ?? 0}
              />
              <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>{transferred}</span>
                <span>{progress?.total ? "Measured" : "Streaming"}</span>
              </div>
            </div>
          ) : (
            <div className="mt-8 flex justify-between text-xs text-muted-foreground">
              <span>330 MB download</span>
              <span>About 1 GB installed</span>
            </div>
          )}

          {error && <p className="mt-5 text-sm text-destructive">{error}</p>}

          <Button
            className="mt-8 w-full"
            disabled={installing}
            focusableWhenDisabled
            onClick={install}
            size="lg"
          >
            {installing && <LoaderCircle className="animate-spin" />}
            {installing ? phaseLabel(progress?.phase ?? "") : "Install library"}
          </Button>
        </section>
      </main>
    </div>
  );
}

function Workspace({ status }: { status: SetupStatus }) {
  const [discs, setDiscs] = useState<Disc[]>([]);
  const [isInspecting, setIsInspecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function selectDiscs() {
    const selection = await open({
      multiple: true,
      title: "Select PS2 discs",
      filters: [{ name: "PS2 discs", extensions: ["iso", "cue"] }],
    });
    if (!selection) return;

    const selected = (Array.isArray(selection) ? selection : [selection]).slice(
      0,
      7 - discs.length,
    );
    if (selected.length === 0) return;

    setError(null);
    setIsInspecting(true);
    try {
      const inspected: Disc[] = [];
      for (const path of selected) {
        if (discs.some((disc) => disc.path === path)) continue;
        const info = await invoke<DiscInfo>("inspect_disc", { path });
        inspected.push({ path, info });
      }
      setDiscs((current) => [...current, ...inspected].slice(0, 7));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setIsInspecting(false);
    }
  }

  function removeDisc(path: string) {
    setDiscs((current) => current.filter((disc) => disc.path !== path));
  }

  const primary = discs[0]?.info;
  const selectedRuntime =
    status.emulators.find((emulator) => emulator.name.toLowerCase() === "jak v2") ??
    status.emulators[0];

  return (
    <div className="min-h-screen">
      <header className="grid h-16 grid-cols-[1fr_auto_1fr] items-center border-b px-7">
        <Brand />
        <nav className="flex items-center gap-1" aria-label="Project sections">
          {sections.map((section, index) => (
            <Button
              className={cn(
                "text-muted-foreground",
                index === 0 && "bg-accent text-foreground",
              )}
              disabled={index !== 0}
              key={section}
              size="sm"
              variant="ghost"
            >
              {section}
            </Button>
          ))}
        </nav>
        <Badge variant="outline" className="justify-self-end text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary" />
          Local
        </Badge>
      </header>

      <main className="mx-auto w-full max-w-6xl px-8 py-12">
        <div className="mb-8 flex items-end justify-between gap-8">
          <div>
            <Badge variant="secondary">New project</Badge>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">
              Build a PS2 package
            </h1>
          </div>
          <p className="max-w-xs text-right text-sm text-muted-foreground">
            Add game media and choose a runtime.
          </p>
        </div>

        <div className="grid overflow-hidden rounded-xl border bg-card/20 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="divide-y lg:border-r">
            <section className="p-7">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-medium">Game discs</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {discs.length} of 7 selected
                  </p>
                </div>
                {discs.length > 0 && discs.length < 7 && (
                  <Button
                    disabled={isInspecting}
                    onClick={selectDiscs}
                    size="sm"
                    variant="outline"
                  >
                    <Plus />
                    Add disc
                  </Button>
                )}
              </div>

              {discs.length === 0 ? (
                <Button
                  className="h-36 w-full flex-col gap-3 border-dashed bg-transparent text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                  disabled={isInspecting}
                  onClick={selectDiscs}
                  variant="outline"
                >
                  {isInspecting ? (
                    <LoaderCircle className="size-6 animate-spin" />
                  ) : (
                    <Disc3 className="size-6" />
                  )}
                  <span>{isInspecting ? "Inspecting" : "Select ISO or CUE"}</span>
                </Button>
              ) : (
                <div className="divide-y border-y">
                  {discs.map((disc) => (
                    <div className="flex items-center gap-3 py-3" key={disc.path}>
                      <Disc3 className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{fileName(disc.path)}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {disc.path}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-primary">
                        Ready
                      </Badge>
                      <Button
                        aria-label={`Remove ${fileName(disc.path)}`}
                        onClick={() => removeDisc(disc.path)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <X />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
            </section>

            <section className="p-7">
              <div className="mb-5">
                <h2 className="text-sm font-medium">Emulator runtime</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {status.emulators.length} installed
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Cpu className="size-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{selectedRuntime.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {selectedRuntime.path}
                  </p>
                </div>
                <Button disabled size="sm" variant="outline">
                  Change
                </Button>
              </div>
            </section>
          </div>

          <aside className="flex min-h-80 flex-col p-7">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Disc data</h2>
              <span
                className={cn(
                  "size-2 rounded-full bg-muted",
                  primary && "bg-primary shadow-[0_0_12px_var(--primary)]",
                )}
              />
            </div>

            {primary ? (
              <dl className="mt-5 divide-y text-xs">
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-muted-foreground">Serial</dt>
                  <dd className="font-mono">{primary.original}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-muted-foreground">Emulator ID</dt>
                  <dd className="font-mono">{primary.emulatorId}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-muted-foreground">Title ID</dt>
                  <dd className="font-mono">{primary.titleId}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-muted-foreground">Discs</dt>
                  <dd className="font-mono">{discs.length}</dd>
                </div>
              </dl>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
                <Disc3 className="size-5" />
                <p className="text-xs">No disc selected</p>
              </div>
            )}

            <Button className="mt-auto w-full" disabled>
              Continue
              <ArrowRight />
            </Button>
          </aside>
        </div>
      </main>
    </div>
  );
}

function App() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<SetupStatus>("get_setup_status")
      .then(setStatus)
      .catch((reason) => setError(String(reason)));
  }, []);

  if (error) {
    return (
      <div className="grid min-h-screen place-content-center gap-3 text-center">
        <Package className="mx-auto size-7 text-destructive" />
        <strong className="text-sm">Setup failed</strong>
        <p className="max-w-md text-xs text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="grid min-h-screen place-content-center gap-3 text-center text-muted-foreground">
        <LoaderCircle className="mx-auto size-6 animate-spin" />
        <span className="text-xs">Loading</span>
      </div>
    );
  }

  if (!status.installed) {
    return <SetupScreen onComplete={setStatus} status={status} />;
  }

  return <Workspace status={status} />;
}

export default App;
