import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  Cpu,
  Disc3,
  FileCode,
  FolderOpen,
  ImageIcon,
  LoaderCircle,
  Package,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
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

type EmulatorDefaults = {
  rendering: string;
  upscale: string;
  universalCompatibility: boolean;
  clutMerge: boolean;
};

type BuildProgress = {
  phase: string;
  percent: number;
};

type BuildResponse = {
  outputPath: string;
};

const sections = ["Game", "Compatibility", "Build"];

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

function buildPhaseLabel(phase: string) {
  switch (phase) {
    case "preparing":
      return "Preparing project";
    case "packaging":
      return "Building package";
    case "validating":
      return "Validating package";
    case "complete":
      return "Package ready";
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
  const defaultRuntime =
    status.emulators.find((emulator) => emulator.name.toLowerCase() === "jak v2") ??
    status.emulators[0];
  const [activeSection, setActiveSection] = useState(0);
  const [discs, setDiscs] = useState<Disc[]>([]);
  const [isInspecting, setIsInspecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRuntimePath, setSelectedRuntimePath] = useState(defaultRuntime.path);
  const [title, setTitle] = useState("");
  const [npTitle, setNpTitle] = useState("");
  const [iconPath, setIconPath] = useState("");
  const [iconPreview, setIconPreview] = useState("");
  const [discOriginal, setDiscOriginal] = useState("");
  const [discTitleId, setDiscTitleId] = useState("");
  const [discEmulatorId, setDiscEmulatorId] = useState("");
  const [renderMode, setRenderMode] = useState("donor");
  const [upscaleMode, setUpscaleMode] = useState("donor");
  const [universalCompatibility, setUniversalCompatibility] = useState(false);
  const [clutMerge, setClutMerge] = useState(false);
  const [customConfigPath, setCustomConfigPath] = useState("");
  const [luaFiles, setLuaFiles] = useState<string[]>([]);
  const [configPreview, setConfigPreview] = useState("");
  const [configError, setConfigError] = useState<string | null>(null);
  const [donorDefaults, setDonorDefaults] = useState<EmulatorDefaults | null>(null);
  const [outputPath, setOutputPath] = useState("");
  const [building, setBuilding] = useState(false);
  const [buildProgress, setBuildProgress] = useState<BuildProgress | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [builtOutput, setBuiltOutput] = useState("");
  const [revealError, setRevealError] = useState<string | null>(null);

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
      if (inspected.length > 0) {
        setTitle(
          (current) =>
            current || fileName(inspected[0].path).replace(/\.(iso|cue)$/i, ""),
        );
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setIsInspecting(false);
    }
  }

  function removeDisc(path: string) {
    setDiscs((current) => current.filter((disc) => disc.path !== path));
  }

  async function selectIcon() {
    const selection = await open({
      multiple: false,
      title: "Select home screen icon",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof selection === "string") {
      try {
        const preview = await invoke<string>("load_image_preview", {
          path: selection,
        });
        setIconPath(selection);
        setIconPreview(preview);
      } catch (reason) {
        setError(String(reason));
      }
    }
  }

  async function selectConfig() {
    const selection = await open({
      multiple: false,
      title: "Select emulator config",
      filters: [{ name: "Emulator config", extensions: ["txt", "conf"] }],
    });
    if (typeof selection === "string") {
      setCustomConfigPath(selection);
    }
  }

  async function selectLuaFiles() {
    const selection = await open({
      multiple: true,
      title: "Select Lua patches",
      filters: [{ name: "Lua patches", extensions: ["lua"] }],
    });
    if (!selection) return;
    const selected = Array.isArray(selection) ? selection : [selection];
    setLuaFiles((current) => [...new Set([...current, ...selected])]);
  }

  async function selectOutput() {
    const selection = await save({
      title: "Save PS4 package",
      defaultPath: `${title.replace(/[\\/:*?"<>|]/g, "-") || "PS2 Game"}.pkg`,
      filters: [{ name: "PS4 package", extensions: ["pkg"] }],
    });
    if (selection) {
      setOutputPath(selection);
      setBuildError(null);
      setBuiltOutput("");
    }
  }

  const primary = discs[0]?.info;
  const selectedRuntime = status.emulators.find(
    (emulator) => emulator.path === selectedRuntimePath,
  );
  const validNpTitle = /^[A-Z]{4}[0-9]{5}$/.test(npTitle);
  const validDiscOriginal = /^[A-Z]{4}_[0-9]{3}\.[0-9]{2}$/.test(discOriginal);
  const validDiscTitleId = /^[A-Z]{4}[0-9]{5}$/.test(discTitleId);
  const validDiscEmulatorId = /^[A-Z]{4}-[0-9]{5}$/.test(discEmulatorId);
  const discDataValid =
    validDiscOriginal && validDiscTitleId && validDiscEmulatorId;
  const discDataChanged = Boolean(
    primary &&
      (discOriginal !== primary.original ||
        discTitleId !== primary.titleId ||
        discEmulatorId !== primary.emulatorId),
  );
  const identityReady =
    title.trim().length > 0 && validNpTitle && iconPath.length > 0;
  const contentId =
    validDiscTitleId && validNpTitle
      ? `UP9000-${npTitle}_00-${discTitleId}0000001`
      : "Pending";
  function resetDiscData() {
    if (!primary) return;
    setDiscOriginal(primary.original);
    setDiscTitleId(primary.titleId);
    setDiscEmulatorId(primary.emulatorId);
  }

  function updateDiscSerial(value: string) {
    const serial = value.toUpperCase();
    setDiscOriginal(serial);
    const match = /^([A-Z]{4})_([0-9]{3})\.([0-9]{2})$/.exec(serial);
    if (match) {
      setDiscTitleId(`${match[1]}${match[2]}${match[3]}`);
      setDiscEmulatorId(`${match[1]}-${match[2]}${match[3]}`);
    }
  }

  useEffect(() => {
    if (!primary) {
      setDiscOriginal("");
      setDiscTitleId("");
      setDiscEmulatorId("");
      return;
    }
    setDiscOriginal(primary.original);
    setDiscTitleId(primary.titleId);
    setDiscEmulatorId(primary.emulatorId);
  }, [primary]);

  useEffect(() => {
    let stopListening: (() => void) | undefined;
    void listen<BuildProgress>("package-build-progress", (event) => {
      setBuildProgress(event.payload);
    }).then((unlisten) => {
      stopListening = unlisten;
    });
    return () => stopListening?.();
  }, []);

  useEffect(() => {
    if (!selectedRuntime) return;
    let cancelled = false;
    void invoke<EmulatorDefaults>("get_emulator_defaults", {
      runtimePath: selectedRuntime.path,
    }).then((defaults) => {
      if (cancelled) return;
      setDonorDefaults(defaults);
      setRenderMode("donor");
      setUpscaleMode("donor");
      setUniversalCompatibility(defaults.universalCompatibility);
      setClutMerge(defaults.clutMerge);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedRuntime]);

  useEffect(() => {
    if (!selectedRuntime) return;
    let cancelled = false;
    setConfigError(null);
    void invoke<string>("preview_emulator_config", {
      request: {
        runtimePath: selectedRuntime.path,
        customConfigPath: customConfigPath || null,
        renderMode,
        upscaleMode,
        universalCompatibility,
        clutMerge,
      },
    })
      .then((preview) => {
        if (!cancelled) setConfigPreview(preview);
      })
      .catch((reason) => {
        if (!cancelled) setConfigError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [
    clutMerge,
    customConfigPath,
    renderMode,
    selectedRuntime,
    universalCompatibility,
    upscaleMode,
  ]);

  async function createPackage() {
    if (
      !selectedRuntime ||
      !primary ||
      !identityReady ||
      !discDataValid ||
      !outputPath
    )
      return;
    setBuilding(true);
    setBuildError(null);
    setBuiltOutput("");
    setBuildProgress({ phase: "preparing", percent: 0 });
    try {
      const result = await invoke<BuildResponse>("build_package", {
        request: {
          images: discs.map((disc) => disc.path),
          discOriginal,
          discTitleId,
          discEmulatorId,
          runtimePath: selectedRuntime.path,
          title,
          npTitle,
          iconPath,
          outputPath,
          customConfigPath: customConfigPath || null,
          renderMode,
          upscaleMode,
          universalCompatibility,
          clutMerge,
          luaFiles,
        },
      });
      setBuiltOutput(result.outputPath);
    } catch (reason) {
      setBuildError(String(reason));
    } finally {
      setBuilding(false);
    }
  }

  async function revealOutput() {
    if (!builtOutput) return;
    setRevealError(null);
    try {
      await invoke("open_containing_folder", { path: builtOutput });
    } catch (reason) {
      setRevealError(String(reason));
    }
  }

  if (builtOutput) {
    return (
      <div className="min-h-screen">
        <header className="flex h-16 items-center justify-between border-b px-7">
          <Brand />
          <Badge variant="outline" className="text-primary">
            <CircleCheck />
            Complete
          </Badge>
        </header>

        <main className="mx-auto w-full max-w-5xl px-8 py-12">
          <div className="flex items-center gap-6">
            {iconPreview ? (
              <img
                alt={`${title} icon`}
                className="size-28 rounded-2xl object-cover shadow-2xl"
                src={iconPreview}
              />
            ) : (
              <div className="grid size-28 place-items-center rounded-2xl bg-muted">
                <Package className="size-8 text-muted-foreground" />
              </div>
            )}
            <div>
              <Badge variant="secondary">Package ready</Badge>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight">{title}</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                The PKG passed validation.
              </p>
            </div>
          </div>

          <div className="mt-10 overflow-hidden rounded-xl border bg-card/20">
            <div className="grid divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
              <section className="p-7">
                <h2 className="text-sm font-medium">Package data</h2>
                <dl className="mt-5 divide-y text-xs">
                  <div className="flex justify-between gap-4 py-3">
                    <dt className="text-muted-foreground">Content ID</dt>
                    <dd className="max-w-72 truncate font-mono">{contentId}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3">
                    <dt className="text-muted-foreground">PS2 serial</dt>
                    <dd className="font-mono">{discOriginal}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3">
                    <dt className="text-muted-foreground">Runtime</dt>
                    <dd>{selectedRuntime?.name}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3">
                    <dt className="text-muted-foreground">Discs</dt>
                    <dd>{discs.length}</dd>
                  </div>
                </dl>
              </section>
              <section className="p-7">
                <h2 className="text-sm font-medium">Compatibility</h2>
                <dl className="mt-5 divide-y text-xs">
                  <div className="flex justify-between gap-4 py-3">
                    <dt className="text-muted-foreground">Rendering</dt>
                    <dd>{renderMode === "donor" ? donorDefaults?.rendering : renderMode}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3">
                    <dt className="text-muted-foreground">Upscale</dt>
                    <dd>{upscaleMode === "donor" ? donorDefaults?.upscale : upscaleMode}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3">
                    <dt className="text-muted-foreground">Universal clamps</dt>
                    <dd>{universalCompatibility ? "On" : "Off"}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3">
                    <dt className="text-muted-foreground">Lua files</dt>
                    <dd>{luaFiles.length}</dd>
                  </div>
                </dl>
              </section>
            </div>
            <div className="flex items-center justify-between gap-6 border-t p-7">
              <code className="min-w-0 truncate text-xs text-muted-foreground">
                {builtOutput}
              </code>
              <Button onClick={revealOutput} variant="outline">
                <FolderOpen />
                Open containing folder
              </Button>
            </div>
          </div>

          {revealError && (
            <p className="mt-4 text-sm text-destructive">{revealError}</p>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="grid h-16 grid-cols-[1fr_auto_1fr] items-center border-b px-7">
        <Brand />
        <nav className="flex items-center gap-1" aria-label="Project sections">
          {sections.map((section, index) => (
            <Button
              className={cn(
                "text-muted-foreground",
                index === activeSection && "bg-accent text-foreground",
              )}
              disabled={index > activeSection}
              key={section}
              onClick={() => setActiveSection(index)}
              size="sm"
              variant="ghost"
            >
              {section}
            </Button>
          ))}
        </nav>
        <span />
      </header>

      <main className="mx-auto w-full max-w-6xl px-8 py-12">
        {activeSection === 0 ? (
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
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-medium">Emulator runtime</h2>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {status.emulators.length} installed in {status.emulatorsDir}
                  </p>
                </div>
                <Cpu className="size-4 shrink-0 text-primary" />
                <Select
                  items={status.emulators.map((emulator) => ({
                    label: emulator.name,
                    value: emulator.path,
                  }))}
                  onValueChange={(value) => value && setSelectedRuntimePath(value)}
                  value={selectedRuntimePath}
                >
                  <SelectTrigger className="w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {status.emulators.map((emulator) => (
                      <SelectItem key={emulator.path} value={emulator.path}>
                        {emulator.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </section>

            <section className="p-7">
              <div className="mb-5">
                <h2 className="text-sm font-medium">Package identity</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Home screen title and artwork.
                </p>
              </div>
              <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_9rem]">
                <div className="grid content-start gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="game-title">Title</Label>
                    <Input
                      id="game-title"
                      maxLength={127}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder="Game title"
                      value={title}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-[11rem_minmax(0,1fr)]">
                    <div className="grid gap-2">
                      <Label htmlFor="np-title">NP title</Label>
                      <Input
                        aria-invalid={Boolean(npTitle) && !validNpTitle}
                        className="font-mono uppercase"
                        id="np-title"
                        maxLength={9}
                        onChange={(event) =>
                          setNpTitle(
                            event.target.value
                              .toUpperCase()
                              .replace(/[^A-Z0-9]/g, "")
                              .slice(0, 9),
                          )
                        }
                        placeholder="GAME00001"
                        value={npTitle}
                      />
                      <p
                        className={cn(
                          "text-xs text-muted-foreground",
                          npTitle && !validNpTitle && "text-destructive",
                          validNpTitle && "text-primary",
                        )}
                      >
                        {validNpTitle
                          ? "Valid NP title"
                          : "Four letters followed by five digits."}
                      </p>
                    </div>
                    <div className="grid content-start gap-2">
                      <Label>Content ID</Label>
                      <Input
                        className="font-mono text-xs"
                        disabled
                        value={contentId}
                      />
                    </div>
                  </div>
                </div>

                <div className="grid content-start gap-2">
                  <Label>Home screen icon</Label>
                  <Button
                    className="aspect-square h-auto w-full overflow-hidden border-dashed bg-transparent p-0 text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                    onClick={selectIcon}
                    variant="outline"
                  >
                    {iconPreview ? (
                      <img
                        alt={`${title || "Game"} icon`}
                        className="size-full object-cover"
                        src={iconPreview}
                      />
                    ) : (
                      <span className="flex flex-col items-center gap-2 text-xs">
                        <ImageIcon className="size-5" />
                        Select image
                      </span>
                    )}
                  </Button>
                </div>
              </div>
            </section>
          </div>

          <aside className="flex min-h-80 flex-col p-7">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Disc data</h2>
              <Button
                disabled={!discDataChanged}
                onClick={resetDiscData}
                size="xs"
                variant="ghost"
              >
                <RotateCcw />
                Reset values
              </Button>
            </div>

            {primary ? (
              <div className="mt-5 grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="disc-serial">Serial</Label>
                  <Input
                    aria-invalid={!validDiscOriginal}
                    className="font-mono uppercase"
                    id="disc-serial"
                    maxLength={11}
                    onChange={(event) => updateDiscSerial(event.target.value)}
                    value={discOriginal}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="disc-emulator-id">Emulator ID</Label>
                  <Input
                    aria-invalid={!validDiscEmulatorId}
                    className="font-mono uppercase"
                    id="disc-emulator-id"
                    maxLength={10}
                    onChange={(event) =>
                      setDiscEmulatorId(event.target.value.toUpperCase())
                    }
                    value={discEmulatorId}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="disc-title-id">Title ID</Label>
                  <Input
                    aria-invalid={!validDiscTitleId}
                    className="font-mono uppercase"
                    id="disc-title-id"
                    maxLength={9}
                    onChange={(event) =>
                      setDiscTitleId(event.target.value.toUpperCase())
                    }
                    value={discTitleId}
                  />
                </div>
                <div className="flex justify-between border-t pt-4 text-xs">
                  <span className="text-muted-foreground">Discs</span>
                  <span className="font-mono">{discs.length}</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
                <Disc3 className="size-5" />
                <p className="text-xs">No disc selected</p>
              </div>
            )}

            <Button
              className="mt-auto w-full"
              disabled={
                !primary || !selectedRuntime || !discDataValid || !identityReady
              }
              onClick={() => setActiveSection(1)}
            >
              Continue
              <ArrowRight />
            </Button>
          </aside>
          </div>
        ) : activeSection === 1 ? (
          <div className="grid overflow-hidden rounded-xl border bg-card/20 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="divide-y lg:border-r">
              <section className="grid gap-5 p-7 sm:grid-cols-2">
                <div className="grid gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label>Rendering</Label>
                    <Badge variant="outline" className="text-[10px] font-normal">
                      Default: {donorDefaults?.rendering ?? "..."}
                    </Badge>
                  </div>
                  <Select
                    items={[
                      { label: "Donor default", value: "donor" },
                      { label: "Native", value: "native" },
                      { label: "2x2", value: "2x2" },
                    ]}
                    onValueChange={(value) => value && setRenderMode(value)}
                    value={renderMode}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="donor">Donor default</SelectItem>
                      <SelectItem value="native">Native</SelectItem>
                      <SelectItem value="2x2">2x2</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label>Upscale</Label>
                    <Badge variant="outline" className="text-[10px] font-normal">
                      Default: {donorDefaults?.upscale ?? "..."}
                    </Badge>
                  </div>
                  <Select
                    items={[
                      { label: "Donor default", value: "donor" },
                      { label: "None", value: "none" },
                      { label: "EdgeSmooth", value: "edge-smooth" },
                    ]}
                    onValueChange={(value) => value && setUpscaleMode(value)}
                    value={upscaleMode}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="donor">Donor default</SelectItem>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="edge-smooth">EdgeSmooth</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </section>

              <section className="divide-y px-7">
                <div className="flex items-center justify-between gap-6 py-5">
                  <div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="universal-compatibility">
                        Universal compatibility
                      </Label>
                      <Badge variant="outline" className="text-[10px] font-normal">
                        Default: {donorDefaults?.universalCompatibility ? "On" : "Off"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Apply FPU, VU, and COP2 clamps.
                    </p>
                  </div>
                  <Switch
                    checked={universalCompatibility}
                    id="universal-compatibility"
                    onCheckedChange={setUniversalCompatibility}
                  />
                </div>
                <div className="flex items-center justify-between gap-6 py-5">
                  <div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="clut-merge">CLUT merge</Label>
                      <Badge variant="outline" className="text-[10px] font-normal">
                        Default: {donorDefaults?.clutMerge ? "On" : "Off"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Enable palette texture merging.
                    </p>
                  </div>
                  <Switch
                    checked={clutMerge}
                    id="clut-merge"
                    onCheckedChange={setClutMerge}
                  />
                </div>
              </section>

              <section className="p-7">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-medium">Custom files</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Optional TXT and Lua overrides.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={selectConfig} size="sm" variant="outline">
                      <FileCode />
                      TXT
                    </Button>
                    <Button onClick={selectLuaFiles} size="sm" variant="outline">
                      <Plus />
                      Lua
                    </Button>
                  </div>
                </div>

                {(customConfigPath || luaFiles.length > 0) && (
                  <div className="mt-5 divide-y border-y">
                    {customConfigPath && (
                      <div className="flex items-center gap-3 py-3">
                        <FileCode className="size-4 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-xs">
                          {fileName(customConfigPath)}
                        </span>
                        <Button
                          aria-label="Remove custom config"
                          onClick={() => setCustomConfigPath("")}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <X />
                        </Button>
                      </div>
                    )}
                    {luaFiles.map((path) => (
                      <div className="flex items-center gap-3 py-3" key={path}>
                        <FileCode className="size-4 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-xs">
                          {fileName(path)}
                        </span>
                        <Button
                          aria-label={`Remove ${fileName(path)}`}
                          onClick={() =>
                            setLuaFiles((current) =>
                              current.filter((candidate) => candidate !== path),
                            )
                          }
                          size="icon-sm"
                          variant="ghost"
                        >
                          <X />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <aside className="flex min-h-96 flex-col p-7">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="size-4 text-primary" />
                <h2 className="text-sm font-medium">Effective settings</h2>
              </div>
              <dl className="mt-5 divide-y text-xs">
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-muted-foreground">Rendering</dt>
                  <dd>{renderMode === "donor" ? "Donor" : renderMode}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-muted-foreground">Upscale</dt>
                  <dd>{upscaleMode === "edge-smooth" ? "EdgeSmooth" : upscaleMode}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-muted-foreground">Config</dt>
                  <dd>{customConfigPath ? "Custom" : "Donor"}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-muted-foreground">Lua files</dt>
                  <dd>{luaFiles.length}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-muted-foreground">Config lines</dt>
                  <dd>{configPreview ? configPreview.trim().split("\n").length : "Pending"}</dd>
                </div>
              </dl>
              {configError && (
                <p className="mt-4 text-xs text-destructive">{configError}</p>
              )}

              <div className="mt-auto grid grid-cols-2 gap-2 pt-8">
                <Button onClick={() => setActiveSection(0)} variant="outline">
                  <ArrowLeft />
                  Back
                </Button>
                <Button
                  disabled={!configPreview || Boolean(configError)}
                  onClick={() => setActiveSection(2)}
                >
                  Continue
                  <ArrowRight />
                </Button>
              </div>
            </aside>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card/20">
            <section className="p-7">
              <h2 className="text-sm font-medium">Build summary</h2>

              <div className="mt-6 flex items-center gap-5">
                {iconPreview ? (
                  <img
                    alt={`${title} icon`}
                    className="size-20 shrink-0 rounded-xl object-cover shadow-lg"
                    src={iconPreview}
                  />
                ) : (
                  <div className="grid size-20 shrink-0 place-items-center rounded-xl bg-muted">
                    <Package className="size-6 text-muted-foreground" />
                  </div>
                )}
                <div className="min-w-0">
                  <h3 className="truncate text-xl font-semibold tracking-tight">{title}</h3>
                  <code className="mt-2 block truncate text-xs text-muted-foreground">
                    {contentId}
                  </code>
                </div>
              </div>

              <dl className="mt-7 grid gap-x-8 gap-y-6 border-t pt-6 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Runtime</dt>
                  <dd className="mt-1.5 truncate">{selectedRuntime?.name}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Discs</dt>
                  <dd className="mt-1.5">{discs.length}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Rendering</dt>
                  <dd className="mt-1.5">
                    {renderMode === "donor" ? donorDefaults?.rendering : renderMode}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Upscale</dt>
                  <dd className="mt-1.5">
                    {upscaleMode === "donor" ? donorDefaults?.upscale : upscaleMode}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Universal clamps</dt>
                  <dd className="mt-1.5">{universalCompatibility ? "On" : "Off"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">CLUT merge</dt>
                  <dd className="mt-1.5">{clutMerge ? "On" : "Off"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Lua files</dt>
                  <dd className="mt-1.5">{luaFiles.length}</dd>
                </div>
              </dl>

              {building && (
                <div className="mt-8 border-t pt-6">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-xs font-medium">
                      {buildPhaseLabel(buildProgress?.phase ?? "preparing")}
                    </span>
                    <span className="font-mono text-xs tabular-nums text-primary">
                      {buildProgress?.percent ?? 0}%
                    </span>
                  </div>
                  <Progress
                    aria-label="Package build progress"
                    className="install-progress block"
                    value={buildProgress?.percent ?? 0}
                  />
                  <p className="mt-3 text-xs text-muted-foreground">
                    Keep mkps4 open until validation completes.
                  </p>
                </div>
              )}

              {builtOutput && (
                <div className="mt-8 flex items-start gap-3 border-t pt-6 text-primary">
                  <CircleCheck className="mt-0.5 size-5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Package ready</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {builtOutput}
                    </p>
                  </div>
                </div>
              )}

              {buildError && (
                <p className="mt-8 border-t pt-6 text-sm text-destructive">{buildError}</p>
              )}
            </section>

            <footer className="flex flex-col gap-4 border-t p-5 sm:flex-row sm:items-center sm:justify-between">
              <Button
                disabled={building}
                onClick={() => setActiveSection(1)}
                variant="outline"
              >
                <ArrowLeft />
                Back
              </Button>

              <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                <Button
                  className="min-w-0 max-w-72"
                  disabled={building}
                  onClick={selectOutput}
                  title={outputPath || undefined}
                  variant="outline"
                >
                  <FolderOpen />
                  <span className="truncate">{outputPath || "Choose output"}</span>
                </Button>
                <Button
                  disabled={!outputPath || building || Boolean(builtOutput)}
                  focusableWhenDisabled
                  onClick={createPackage}
                >
                  {building && <LoaderCircle className="animate-spin" />}
                  {building ? "Building" : "Create PKG"}
                </Button>
              </div>
            </footer>
          </div>
        )}
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
