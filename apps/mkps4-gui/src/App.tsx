import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Menu } from "@base-ui/react/menu";
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
  Power,
  RotateCcw,
  Settings,
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
  version: string | null;
  lastUpdated: string | null;
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
      <span className="ps-brand-mark">
        <Disc3 className="size-4" strokeWidth={1.5} />
      </span>
      <strong className="text-sm font-medium tracking-[0.08em]">mkps4</strong>
    </div>
  );
}

function PsBackdrop() {
  return (
    <div aria-hidden="true" className="ps-backdrop">
      <span className="ps-shape ps-shape-circle" />
      <span className="ps-shape ps-shape-square" />
      <span className="ps-shape ps-shape-cross" />
    </div>
  );
}

function SettingsMenu({ status }: { status: SetupStatus }) {
  const [error, setError] = useState<string | null>(null);
  const updated = status.lastUpdated ? new Date(status.lastUpdated).toLocaleString() : "Unknown";

  async function openEmulatorFolder() {
    setError(null);
    try {
      await invoke("open_folder", { path: status.emulatorsDir });
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            aria-label="Open settings"
            className="!min-h-0 size-7 border border-white/10 bg-white/5 p-0 hover:bg-white/10"
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <Settings className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" className="z-50" side="bottom" sideOffset={10}>
          <Menu.Popup className="w-80 origin-top-right border border-white/20 bg-[#06276f]/95 p-2 text-white shadow-[0_2rem_5rem_rgba(0,10,45,0.5)] outline-none backdrop-blur-2xl data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95">
            <div className="px-3 pt-2 pb-3">
              <p className="ps-section-title">Settings</p>
              <p className="mt-2 text-xs text-white/45">
                {status.emulators.length} runtimes installed
              </p>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-white/10 pt-3 text-[11px]">
                <dt className="text-white/40">Version</dt>
                <dd className="truncate text-right text-white/75">{status.version ?? "Unknown"}</dd>
                <dt className="text-white/40">Last updated</dt>
                <dd
                  className="truncate text-right text-white/75"
                  title={status.lastUpdated ?? undefined}
                >
                  {updated}
                </dd>
              </dl>
            </div>
            <Menu.Item
              className="flex cursor-default items-center gap-3 border border-transparent px-3 py-3 outline-none data-highlighted:border-white/20 data-highlighted:bg-white/10"
              onClick={() => void openEmulatorFolder()}
            >
              <span className="grid size-9 shrink-0 place-items-center bg-white/10">
                <FolderOpen className="size-4 text-primary" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm">Open emulator folder</span>
                <span className="mt-1 block truncate text-[11px] text-white/45">
                  {status.emulatorsDir}
                </span>
              </span>
            </Menu.Item>
            {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
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
    <div className="ps-shell min-h-screen">
      <PsBackdrop />
      <header className="ps-topbar flex items-center px-8">
        <Brand />
      </header>

      <main className="ps-content mx-auto grid min-h-[calc(100vh-3.375rem)] w-full max-w-5xl place-items-center px-6 py-10">
        <section className="ps-panel grid w-full overflow-hidden lg:grid-cols-[0.8fr_1.2fr]">
          <div className="relative grid min-h-72 place-items-center overflow-hidden border-b border-white/10 p-10 lg:border-r lg:border-b-0">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,rgba(103,211,255,0.28),transparent_42%)]" />
            <div className="relative text-center">
              <span className="mx-auto grid size-36 place-items-center border border-white/25 bg-white/10 shadow-[0_2rem_5rem_rgba(0,18,70,0.4)] backdrop-blur-xl">
                <Cpu className="size-14 text-white/90" strokeWidth={1.1} />
              </span>
            </div>
          </div>

          <div className="p-8 sm:p-10">
            <p className="ps-section-title">First launch</p>
            <h1 className="mt-3 text-3xl tracking-tight sm:text-4xl">Set up emulators</h1>
            <p className="mt-3 max-w-md text-sm leading-6 text-white/60">
              Install the emulator collection to continue.
            </p>

            <div className="mt-8 border border-white/20 bg-white/5 px-4 pt-3 pb-4">
              <span className="ps-section-title">Install location</span>
              <code className="mt-2 block min-w-0 truncate text-xs text-white/75">
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
                <div className="mt-3 flex items-center justify-between text-xs text-white/50">
                  <span>{transferred}</span>
                  <span>{progress?.total ? "Measured" : "Streaming"}</span>
                </div>
              </div>
            ) : (
              <div className="mt-8 flex justify-between text-xs text-white/50">
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
          </div>
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
  const [renderMode, setRenderMode] = useState("native");
  const [upscaleMode, setUpscaleMode] = useState("none");
  const [universalCompatibility, setUniversalCompatibility] = useState(false);
  const [clutMerge, setClutMerge] = useState(false);
  const [customConfigPath, setCustomConfigPath] = useState("");
  const [luaFiles, setLuaFiles] = useState<string[]>([]);
  const [configPreview, setConfigPreview] = useState("");
  const [configError, setConfigError] = useState<string | null>(null);
  const [donorDefaults, setDonorDefaults] = useState<EmulatorDefaults | null>(null);
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
        setTitle((current) => current || fileName(inspected[0].path).replace(/\.(iso|cue)$/i, ""));
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
      setBuildError(null);
      setBuiltOutput("");
    }
    return selection;
  }

  const primary = discs[0]?.info;
  const selectedRuntime = status.emulators.find(
    (emulator) => emulator.path === selectedRuntimePath,
  );
  const defaultRenderMode = donorDefaults
    ? donorDefaults.rendering.toLowerCase() === "native"
      ? "native"
      : "2x2"
    : null;
  const defaultUpscaleMode = donorDefaults
    ? donorDefaults.upscale.toLowerCase() === "none"
      ? "none"
      : "edge-smooth"
    : null;
  const universalCompatibilityChanged = Boolean(
    donorDefaults && universalCompatibility !== donorDefaults.universalCompatibility,
  );
  const clutMergeChanged = Boolean(donorDefaults && clutMerge !== donorDefaults.clutMerge);
  const validNpTitle = /^[A-Z]{4}[0-9]{5}$/.test(npTitle);
  const validDiscOriginal = /^[A-Z]{4}_[0-9]{3}\.[0-9]{2}$/.test(discOriginal);
  const validDiscTitleId = /^[A-Z]{4}[0-9]{5}$/.test(discTitleId);
  const validDiscEmulatorId = /^[A-Z]{4}-[0-9]{5}$/.test(discEmulatorId);
  const discDataValid = validDiscOriginal && validDiscTitleId && validDiscEmulatorId;
  const discDataChanged = Boolean(
    primary &&
    (discOriginal !== primary.original ||
      discTitleId !== primary.titleId ||
      discEmulatorId !== primary.emulatorId),
  );
  const identityReady = title.trim().length > 0 && validNpTitle && iconPath.length > 0;
  const contentId =
    validDiscTitleId && validNpTitle ? `UP9000-${npTitle}_00-${discTitleId}0000001` : "Pending";
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
      setRenderMode(defaults.rendering.toLowerCase() === "native" ? "native" : "2x2");
      setUpscaleMode(defaults.upscale.toLowerCase() === "none" ? "none" : "edge-smooth");
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

  async function createPackage(outputPath: string) {
    if (!selectedRuntime || !primary || !identityReady || !discDataValid) return;
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

  async function selectOutputAndCreatePackage() {
    const outputPath = await selectOutput();
    if (outputPath) {
      await createPackage(outputPath);
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

  function startOver() {
    setActiveSection(0);
    setDiscs([]);
    setIsInspecting(false);
    setError(null);
    setSelectedRuntimePath(defaultRuntime.path);
    setTitle("");
    setNpTitle("");
    setIconPath("");
    setIconPreview("");
    setDiscOriginal("");
    setDiscTitleId("");
    setDiscEmulatorId("");
    setRenderMode(defaultRenderMode ?? "native");
    setUpscaleMode(defaultUpscaleMode ?? "none");
    setUniversalCompatibility(donorDefaults?.universalCompatibility ?? false);
    setClutMerge(donorDefaults?.clutMerge ?? false);
    setCustomConfigPath("");
    setLuaFiles([]);
    setConfigError(null);
    setBuilding(false);
    setBuildProgress(null);
    setBuildError(null);
    setRevealError(null);
    setBuiltOutput("");
  }

  if (builtOutput) {
    return (
      <div className="ps-shell min-h-screen">
        <PsBackdrop />
        <header className="ps-topbar flex items-center justify-between px-8">
          <Brand />
          <Button
            className="border border-white/10 bg-white/5 hover:bg-white/10"
            onClick={() => void getCurrentWindow().close()}
            size="sm"
            variant="ghost"
          >
            <Power />
            Exit
          </Button>
        </header>

        <main className="ps-content mx-auto w-full max-w-6xl px-6 pt-8 pb-10 sm:px-8">
          <div className="flex flex-col items-start gap-7 sm:flex-row sm:items-center">
            {iconPreview ? (
              <img
                alt={`${title} icon`}
                className="size-40 object-cover shadow-[0_2rem_6rem_rgba(0,12,55,0.5)] ring-1 ring-white/25"
                src={iconPreview}
              />
            ) : (
              <div className="grid size-40 place-items-center border border-white/20 bg-white/10">
                <Package className="size-10 text-white/60" />
              </div>
            )}
            <div>
              <p className="ps-section-title text-primary">Package ready</p>
              <h1 className="mt-3 text-4xl font-light tracking-tight sm:text-5xl">{title}</h1>
              <p className="mt-3 text-sm text-white/55">The PKG passed validation.</p>
            </div>
          </div>

          <div className="ps-panel mt-10 overflow-hidden">
            <div className="grid divide-y divide-white/10 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
              <section className="ps-section">
                <h2 className="ps-section-title">Package data</h2>
                <dl className="mt-5 divide-y divide-white/10 text-xs">
                  <div className="flex justify-between gap-4 py-3.5">
                    <dt className="text-white/50">Content ID</dt>
                    <dd className="max-w-72 truncate font-mono">{contentId}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3.5">
                    <dt className="text-white/50">PS2 serial</dt>
                    <dd className="font-mono">{discOriginal}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3.5">
                    <dt className="text-white/50">Runtime</dt>
                    <dd>{selectedRuntime?.name}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3.5">
                    <dt className="text-white/50">Discs</dt>
                    <dd>{discs.length}</dd>
                  </div>
                </dl>
              </section>
              <section className="ps-section">
                <h2 className="ps-section-title">Compatibility</h2>
                <dl className="mt-5 divide-y divide-white/10 text-xs">
                  <div className="flex justify-between gap-4 py-3.5">
                    <dt className="text-white/50">Rendering</dt>
                    <dd>{renderMode === "donor" ? donorDefaults?.rendering : renderMode}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3.5">
                    <dt className="text-white/50">Upscale</dt>
                    <dd>{upscaleMode === "donor" ? donorDefaults?.upscale : upscaleMode}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3.5">
                    <dt className="text-white/50">Universal clamps</dt>
                    <dd>{universalCompatibility ? "On" : "Off"}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-3.5">
                    <dt className="text-white/50">Lua files</dt>
                    <dd>{luaFiles.length}</dd>
                  </div>
                </dl>
              </section>
            </div>
            <div className="ps-actionbar flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <code className="min-w-0 truncate text-xs text-white/50">{builtOutput}</code>
              <div className="flex gap-2">
                <Button onClick={startOver} variant="outline">
                  <RotateCcw />
                  Start over
                </Button>
                <Button
                  className="border-white/25 bg-white/10"
                  onClick={revealOutput}
                  variant="outline"
                >
                  <FolderOpen />
                  Open containing folder
                </Button>
              </div>
            </div>
          </div>

          {revealError && <p className="mt-4 text-sm text-destructive">{revealError}</p>}
        </main>
      </div>
    );
  }

  return (
    <div className="ps-shell min-h-screen">
      <PsBackdrop />
      <header className="ps-topbar grid grid-cols-[1fr_auto_1fr] items-center px-8 max-[800px]:grid-cols-1 max-[800px]:px-5">
        <div className="max-[800px]:py-2">
          <Brand />
        </div>
        <nav className="flex items-center" aria-label="Project sections">
          {sections.map((section, index) => (
            <Button
              className={cn("ps-nav-button gap-2 bg-transparent hover:bg-white/5")}
              aria-current={index === activeSection ? "step" : undefined}
              data-active={index === activeSection}
              disabled={index > activeSection}
              key={section}
              onClick={() => setActiveSection(index)}
              size="sm"
              variant="ghost"
            >
              {index === 0 ? <Disc3 /> : index === 1 ? <SlidersHorizontal /> : <Package />}
              {section}
            </Button>
          ))}
        </nav>
        <div className="flex justify-end max-[800px]:absolute max-[800px]:top-3 max-[800px]:right-5">
          <SettingsMenu status={status} />
        </div>
      </header>

      <main className="ps-content mx-auto w-full max-w-7xl px-5 pt-6 pb-8 sm:px-8 sm:pt-8 sm:pb-10">
        {activeSection === 0 ? (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="ps-panel divide-y divide-white/10 overflow-hidden">
              <section className="ps-section">
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <h2 className="ps-section-title">Game discs</h2>
                    <p className="mt-2 text-xs text-white/50">{discs.length} of 7 selected</p>
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
                    className="h-[74px] w-full flex-col gap-1.5 border border-white/20 bg-white/5 text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                    disabled={isInspecting}
                    onClick={selectDiscs}
                    variant="outline"
                  >
                    {isInspecting ? (
                      <LoaderCircle className="size-5 animate-spin" />
                    ) : (
                      <Disc3 className="size-5" />
                    )}
                    <span>{isInspecting ? "Inspecting" : "Select ISO or CUE"}</span>
                  </Button>
                ) : (
                  <div className="grid gap-3">
                    {discs.map((disc) => (
                      <div className="ps-tile flex min-w-0 items-center gap-3 p-4" key={disc.path}>
                        <span className="grid size-10 shrink-0 place-items-center bg-white/10">
                          <Disc3 className="size-5 text-primary" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{fileName(disc.path)}</p>
                          <p className="mt-1 truncate text-[11px] text-white/45">{disc.path}</p>
                        </div>
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

                {error && (
                  <div
                    className="mt-4 flex w-full items-start gap-4 border border-black/40 bg-black/65 px-4 py-3 shadow-[0_1rem_3rem_rgba(0,0,0,0.2)]"
                    role="alert"
                  >
                    <p className="min-w-0 flex-1 break-words text-sm text-white/85">{error}</p>
                    <Button
                      aria-label="Dismiss disc error"
                      className="-mt-1 -mr-2 text-white/60 hover:bg-white/10 hover:text-white"
                      onClick={() => setError(null)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <X />
                    </Button>
                  </div>
                )}
              </section>

              <section className="ps-section">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="ps-section-title">Emulator runtime</h2>
                    <p className="mt-2 text-xs text-white/50">
                      Recommended: <strong className="font-semibold text-white/80">Jak v2</strong>{" "}
                      or <strong className="font-semibold text-white/80">Rogue v1</strong>
                    </p>
                  </div>
                  <Cpu className="size-5 shrink-0 text-primary" />
                  <Select
                    items={status.emulators.map((emulator) => ({
                      label: emulator.name,
                      value: emulator.path,
                    }))}
                    onValueChange={(value) => value && setSelectedRuntimePath(value)}
                    value={selectedRuntimePath}
                  >
                    <SelectTrigger className="w-72 max-w-full">
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

              <section className="ps-section">
                <div className="mb-5">
                  <h2 className="ps-section-title">Package identity</h2>
                  <p className="mt-2 text-xs text-white/50">Home screen title and artwork.</p>
                </div>
                <div className="grid gap-7 sm:grid-cols-[minmax(0,1fr)_10rem]">
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
                  <div className="grid gap-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
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
                            "text-xs text-white/45",
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
                        <Input className="font-mono text-xs" disabled value={contentId} />
                      </div>
                    </div>
                  </div>

                  <div className="grid content-start gap-2">
                    <Label>Home screen icon</Label>
                    <Button
                      className="aspect-square h-auto w-full overflow-hidden border border-white/20 bg-white/5 p-0 text-white/55 transition-colors hover:bg-white/10 hover:text-white"
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

            <aside className="ps-panel flex min-h-96 flex-col p-6">
              <div className="flex items-center justify-between">
                <h2 className="ps-section-title">Disc data</h2>
              <Button
                aria-hidden={!discDataChanged}
                className={cn(!discDataChanged && "invisible")}
                disabled={!discDataChanged}
                onClick={resetDiscData}
                size="xs"
                tabIndex={discDataChanged ? 0 : -1}
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
                      onChange={(event) => setDiscEmulatorId(event.target.value.toUpperCase())}
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
                      onChange={(event) => setDiscTitleId(event.target.value.toUpperCase())}
                      value={discTitleId}
                    />
                  </div>
                  <div className="flex justify-between border-t border-white/10 pt-4 text-xs">
                    <span className="text-white/50">Discs</span>
                    <span className="font-mono">{discs.length}</span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-white/45">
                  <Disc3 className="size-5" />
                  <p className="text-xs">No disc selected</p>
                </div>
              )}

              <Button
                className="mt-auto w-full"
                disabled={!primary || !selectedRuntime || !discDataValid || !identityReady}
                onClick={() => setActiveSection(1)}
              >
                Continue
                <ArrowRight />
              </Button>
            </aside>
          </div>
        ) : activeSection === 1 ? (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="ps-panel divide-y divide-white/10 overflow-hidden">
              <section className="ps-section grid gap-5 sm:grid-cols-2">
                <div className="grid gap-2">
                  <div className="flex h-6 items-center justify-between gap-3">
                    <Label>Rendering</Label>
                    <Button
                      aria-hidden={!defaultRenderMode || renderMode === defaultRenderMode}
                      className={cn(
                        "!min-h-6",
                        (!defaultRenderMode || renderMode === defaultRenderMode) && "invisible",
                      )}
                      disabled={!defaultRenderMode || renderMode === defaultRenderMode}
                      onClick={() => defaultRenderMode && setRenderMode(defaultRenderMode)}
                      size="xs"
                      tabIndex={defaultRenderMode && renderMode !== defaultRenderMode ? 0 : -1}
                      variant="ghost"
                    >
                      <RotateCcw />
                      Reset
                    </Button>
                  </div>
                  <Select
                    items={[
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
                      <SelectItem value="native">
                        Native
                        {defaultRenderMode === "native" && (
                          <Badge className="ml-auto text-[9px] font-normal" variant="outline">
                            Default
                          </Badge>
                        )}
                      </SelectItem>
                      <SelectItem value="2x2">
                        2x2
                        {defaultRenderMode === "2x2" && (
                          <Badge className="ml-auto text-[9px] font-normal" variant="outline">
                            Default
                          </Badge>
                        )}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <div className="flex h-6 items-center justify-between gap-3">
                    <Label>Upscale</Label>
                    <Button
                      aria-hidden={!defaultUpscaleMode || upscaleMode === defaultUpscaleMode}
                      className={cn(
                        "!min-h-6",
                        (!defaultUpscaleMode || upscaleMode === defaultUpscaleMode) && "invisible",
                      )}
                      disabled={!defaultUpscaleMode || upscaleMode === defaultUpscaleMode}
                      onClick={() => defaultUpscaleMode && setUpscaleMode(defaultUpscaleMode)}
                      size="xs"
                      tabIndex={defaultUpscaleMode && upscaleMode !== defaultUpscaleMode ? 0 : -1}
                      variant="ghost"
                    >
                      <RotateCcw />
                      Reset
                    </Button>
                  </div>
                  <Select
                    items={[
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
                      <SelectItem value="none">
                        None
                        {defaultUpscaleMode === "none" && (
                          <Badge className="ml-auto text-[9px] font-normal" variant="outline">
                            Default
                          </Badge>
                        )}
                      </SelectItem>
                      <SelectItem value="edge-smooth">
                        EdgeSmooth
                        {defaultUpscaleMode === "edge-smooth" && (
                          <Badge className="ml-auto text-[9px] font-normal" variant="outline">
                            Default
                          </Badge>
                        )}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </section>

              <section className="divide-y divide-white/10 px-7">
                <div className="flex items-center justify-between gap-6 py-5">
                  <div>
                    <div className="flex h-6 items-center gap-2">
                      <Label htmlFor="universal-compatibility">Universal compatibility</Label>
                      <Button
                        aria-hidden={!universalCompatibilityChanged}
                        className={cn(
                          "!min-h-6",
                          !universalCompatibilityChanged && "invisible",
                        )}
                        disabled={!universalCompatibilityChanged}
                        onClick={() =>
                          donorDefaults &&
                          setUniversalCompatibility(donorDefaults.universalCompatibility)
                        }
                        size="xs"
                        tabIndex={universalCompatibilityChanged ? 0 : -1}
                        variant="ghost"
                      >
                        <RotateCcw />
                        Reset
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-white/50">Apply FPU, VU, and COP2 clamps.</p>
                  </div>
                  <Switch
                    checked={universalCompatibility}
                    id="universal-compatibility"
                    onCheckedChange={setUniversalCompatibility}
                  />
                </div>
                <div className="flex items-center justify-between gap-6 py-5">
                  <div>
                    <div className="flex h-6 items-center gap-2">
                      <Label htmlFor="clut-merge">CLUT merge</Label>
                      <Button
                        aria-hidden={!clutMergeChanged}
                        className={cn("!min-h-6", !clutMergeChanged && "invisible")}
                        disabled={!clutMergeChanged}
                        onClick={() => donorDefaults && setClutMerge(donorDefaults.clutMerge)}
                        size="xs"
                        tabIndex={clutMergeChanged ? 0 : -1}
                        variant="ghost"
                      >
                        <RotateCcw />
                        Reset
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-white/50">Enable palette texture merging.</p>
                  </div>
                  <Switch checked={clutMerge} id="clut-merge" onCheckedChange={setClutMerge} />
                </div>
              </section>

              <section className="ps-section">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="ps-section-title">Custom files</h2>
                    <p className="mt-2 text-xs text-white/50">Optional TXT and Lua overrides.</p>
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
                  <div className="mt-5 grid gap-2">
                    {customConfigPath && (
                      <div className="ps-tile flex items-center gap-3 p-3">
                        <FileCode className="size-4 text-primary" />
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
                      <div className="ps-tile flex items-center gap-3 p-3" key={path}>
                        <FileCode className="size-4 text-primary" />
                        <span className="min-w-0 flex-1 truncate text-xs">{fileName(path)}</span>
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

            <aside className="ps-panel flex min-h-96 flex-col p-6">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="size-4 text-primary" />
                <h2 className="ps-section-title">Effective settings</h2>
              </div>
              <dl className="mt-5 divide-y divide-white/10 text-xs">
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-white/50">Rendering</dt>
                  <dd>{renderMode === "donor" ? "Donor" : renderMode}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-white/50">Upscale</dt>
                  <dd>{upscaleMode === "edge-smooth" ? "EdgeSmooth" : upscaleMode}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-white/50">Config</dt>
                  <dd>{customConfigPath ? "Custom" : "Donor"}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-white/50">Lua files</dt>
                  <dd>{luaFiles.length}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-white/50">Config lines</dt>
                  <dd>{configPreview ? configPreview.trim().split("\n").length : "Pending"}</dd>
                </div>
              </dl>
              {configError && <p className="mt-4 text-xs text-destructive">{configError}</p>}

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
          <div className="ps-panel overflow-hidden">
            <section className="ps-section">
              <h2 className="ps-section-title">Build summary</h2>

              <div className="mt-7 flex items-center gap-6">
                {iconPreview ? (
                  <img
                    alt={`${title} icon`}
                    className="size-28 shrink-0 object-cover shadow-[0_1.5rem_4rem_rgba(0,14,60,0.42)] ring-1 ring-white/25"
                    src={iconPreview}
                  />
                ) : (
                  <div className="grid size-28 shrink-0 place-items-center border border-white/20 bg-white/10">
                    <Package className="size-8 text-white/50" />
                  </div>
                )}
                <div className="min-w-0">
                  <h3 className="truncate text-3xl font-light tracking-tight">{title}</h3>
                  <code className="mt-3 block truncate text-xs text-white/50">{contentId}</code>
                </div>
              </div>

              <dl className="ps-info-grid mt-8 grid gap-x-8 gap-y-7 border-t border-white/10 pt-7 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-white/50">Runtime</dt>
                  <dd className="mt-1.5 truncate">{selectedRuntime?.name}</dd>
                </div>
                <div>
                  <dt className="text-white/50">Discs</dt>
                  <dd className="mt-1.5">{discs.length}</dd>
                </div>
                <div>
                  <dt className="text-white/50">Rendering</dt>
                  <dd className="mt-1.5">
                    {renderMode === "donor" ? donorDefaults?.rendering : renderMode}
                  </dd>
                </div>
                <div>
                  <dt className="text-white/50">Upscale</dt>
                  <dd className="mt-1.5">
                    {upscaleMode === "donor" ? donorDefaults?.upscale : upscaleMode}
                  </dd>
                </div>
                <div>
                  <dt className="text-white/50">Universal clamps</dt>
                  <dd className="mt-1.5">{universalCompatibility ? "On" : "Off"}</dd>
                </div>
                <div>
                  <dt className="text-white/50">CLUT merge</dt>
                  <dd className="mt-1.5">{clutMerge ? "On" : "Off"}</dd>
                </div>
                <div>
                  <dt className="text-white/50">Lua files</dt>
                  <dd className="mt-1.5">{luaFiles.length}</dd>
                </div>
              </dl>

              {building && (
                <div className="mt-8 border-t border-white/10 pt-6">
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
                  <p className="mt-3 text-xs text-white/50">
                    Keep mkps4 open until validation completes.
                  </p>
                </div>
              )}

              {builtOutput && (
                <div className="mt-8 flex items-start gap-3 border-t border-white/10 pt-6 text-primary">
                  <CircleCheck className="mt-0.5 size-5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Package ready</p>
                    <p className="mt-1 truncate text-xs text-white/50">{builtOutput}</p>
                  </div>
                </div>
              )}

              {buildError && (
                <p className="mt-8 break-words border-t border-white/10 pt-6 text-sm text-destructive">
                  {buildError}
                </p>
              )}
            </section>

            <footer className="ps-actionbar flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <Button disabled={building} onClick={() => setActiveSection(1)} variant="outline">
                <ArrowLeft />
                Back
              </Button>

              <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                <Button
                  disabled={building || Boolean(builtOutput)}
                  focusableWhenDisabled
                  onClick={selectOutputAndCreatePackage}
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
      <div className="ps-shell grid min-h-screen place-content-center gap-3 px-6 text-center">
        <PsBackdrop />
        <span className="ps-brand-mark mx-auto mb-3">
          <Package className="size-5 text-destructive" />
        </span>
        <strong className="text-lg font-light">Setup failed</strong>
        <p className="max-w-md break-words text-xs text-white/55">{error}</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="ps-shell grid min-h-screen place-content-center gap-4 text-center text-white/60">
        <PsBackdrop />
        <LoaderCircle className="mx-auto size-7 animate-spin text-primary" />
        <span className="text-[10px] tracking-[0.2em]">LOADING</span>
      </div>
    );
  }

  if (!status.installed) {
    return <SetupScreen onComplete={setStatus} status={status} />;
  }

  return <Workspace status={status} />;
}

export default App;
