import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import {
  ArrowLeft,
  ArrowRight,
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
  SquareCode,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
  displayMode: string;
  graphicsFix: boolean;
  speedFix: boolean;
  disableMtvu: boolean;
  disableInstantVif1: boolean;
  clutMerge: boolean;
  multitap: string;
  resetOnDiscChange: boolean;
};

type BuildProgress = {
  phase: string;
  percent: number;
};

type BuildResponse = {
  outputPath: string;
};

const sections = ["Game", "Configuration", "Build"];
const configurationCategories = [
  { label: "Graphics", value: "graphics" },
  { label: "Input & Disc", value: "input" },
  { label: "Files", value: "files" },
] as const;
const maxDiscImages = 5;

function OnOffSelect({
  id,
  value,
  onValueChange,
}: {
  id: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <Select
      items={[
        { label: "On", value: "on" },
        { label: "Off", value: "off" },
      ]}
      onValueChange={(next) => next && onValueChange(next === "on")}
      value={value ? "on" : "off"}
    >
      <SelectTrigger className="w-full" id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="on">On</SelectItem>
        <SelectItem value="off">Off</SelectItem>
      </SelectContent>
    </Select>
  );
}

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

function SettingsMenu({
  status,
  onManageEmulators,
}: {
  status: SetupStatus;
  onManageEmulators: () => void;
}) {
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
              onClick={onManageEmulators}
            >
              <span className="grid size-9 shrink-0 place-items-center bg-white/10">
                <Cpu className="size-4 text-primary" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm">Manage emulators</span>
                <span className="mt-1 block text-[11px] text-white/45">
                  Update or reinstall the runtime collection
                </span>
              </span>
            </Menu.Item>
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
  onCancel,
}: {
  status: SetupStatus;
  onComplete: (status: SetupStatus) => void;
  onCancel?: () => void;
}) {
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updating = Boolean(status.version);

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
      const installed = await invoke<SetupStatus>("install_emulators", {
        update: updating,
      });
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
      <header className="ps-topbar flex items-center justify-between px-8">
        <Brand />
        {onCancel && !installing && (
          <Button onClick={onCancel} size="sm" variant="ghost">
            <ArrowLeft />
            Back
          </Button>
        )}
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
            <p className="ps-section-title">{updating ? "Runtime management" : "First launch"}</p>
            <h1 className="mt-3 text-3xl tracking-tight sm:text-4xl">
              {updating ? "Update emulators" : "Set up emulators"}
            </h1>
            <p className="mt-3 max-w-md text-sm leading-6 text-white/60">
              {updating
                ? "Download and reinstall the latest emulator collection."
                : "Install the emulator collection to continue."}
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
              {installing
                ? phaseLabel(progress?.phase ?? "")
                : updating
                  ? "Update library"
                  : "Install library"}
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}

function Workspace({
  status,
  onManageEmulators,
}: {
  status: SetupStatus;
  onManageEmulators: () => void;
}) {
  const defaultRuntime =
    status.emulators.find((emulator) => emulator.name.toLowerCase() === "jak v2") ??
    status.emulators[0];
  const [activeSection, setActiveSection] = useState(0);
  const [configurationCategory, setConfigurationCategory] =
    useState<(typeof configurationCategories)[number]["value"]>("graphics");
  const [discs, setDiscs] = useState<Disc[]>([]);
  const [isInspecting, setIsInspecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRuntimePath, setSelectedRuntimePath] = useState(defaultRuntime.path);
  const [title, setTitle] = useState("");
  const [npTitle, setNpTitle] = useState("");
  const [iconPath, setIconPath] = useState("");
  const [iconPreview, setIconPreview] = useState("");
  const [backgroundPath, setBackgroundPath] = useState("");
  const [backgroundPreview, setBackgroundPreview] = useState("");
  const [artworkError, setArtworkError] = useState<string | null>(null);
  const [discOriginal, setDiscOriginal] = useState("");
  const [discTitleId, setDiscTitleId] = useState("");
  const [discEmulatorId, setDiscEmulatorId] = useState("");
  const [renderMode, setRenderMode] = useState("native");
  const [upscaleMode, setUpscaleMode] = useState("none");
  const [displayMode, setDisplayMode] = useState("full");
  const [graphicsFix, setGraphicsFix] = useState(false);
  const [graphicsFixOverridden, setGraphicsFixOverridden] = useState(false);
  const [speedFix, setSpeedFix] = useState(false);
  const [speedFixOverridden, setSpeedFixOverridden] = useState(false);
  const [disableMtvu, setDisableMtvu] = useState(false);
  const [disableMtvuOverridden, setDisableMtvuOverridden] = useState(false);
  const [disableInstantVif1, setDisableInstantVif1] = useState(false);
  const [disableInstantVif1Overridden, setDisableInstantVif1Overridden] = useState(false);
  const [clutMerge, setClutMerge] = useState(false);
  const [clutMergeOverridden, setClutMergeOverridden] = useState(false);
  const [multitap, setMultitap] = useState("disabled");
  const [resetOnDiscChange, setResetOnDiscChange] = useState(true);
  const [resetOnDiscChangeOverridden, setResetOnDiscChangeOverridden] = useState(false);
  const [customConfigPath, setCustomConfigPath] = useState("");
  const [memoryCardPath, setMemoryCardPath] = useState("");
  const [patchFiles, setPatchFiles] = useState<string[]>([]);
  const [luaFiles, setLuaFiles] = useState<string[]>([]);
  const [remotePlayKeymap, setRemotePlayKeymap] = useState("0");
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
      maxDiscImages - discs.length,
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
      setDiscs((current) => [...current, ...inspected].slice(0, maxDiscImages));
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
      setArtworkError(null);
      try {
        const preview = await invoke<string>("load_image_preview", {
          path: selection,
          aspectWidth: 1,
          aspectHeight: 1,
        });
        setIconPath(selection);
        setIconPreview(preview);
      } catch (reason) {
        setArtworkError(String(reason));
      }
    }
  }

  async function selectBackground() {
    const selection = await open({
      multiple: false,
      title: "Select home screen background",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof selection === "string") {
      setArtworkError(null);
      try {
        const preview = await invoke<string>("load_image_preview", {
          path: selection,
          aspectWidth: 16,
          aspectHeight: 9,
        });
        setBackgroundPath(selection);
        setBackgroundPreview(preview);
      } catch (reason) {
        setArtworkError(String(reason));
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

  async function selectMemoryCard() {
    const selection = await open({
      multiple: false,
      title: "Select formatted 8 MB PS2 memory card",
      filters: [{ name: "PS2 memory cards", extensions: ["ps2", "vm2", "card"] }],
    });
    if (typeof selection === "string") {
      setMemoryCardPath(selection);
    }
  }

  async function selectPatchFiles() {
    const selection = await open({
      multiple: true,
      title: "Select emulator patches",
      filters: [{ name: "Emulator patches", extensions: ["lua", "conf"] }],
    });
    if (!selection) return;
    const selected = Array.isArray(selection) ? selection : [selection];
    setPatchFiles((current) => [...new Set([...current, ...selected])]);
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
      : donorDefaults.rendering.toLowerCase() === "2x2"
        ? "2x2"
        : "donor"
    : null;
  const defaultUpscaleMode = donorDefaults
    ? donorDefaults.upscale.toLowerCase() === "none"
      ? "none"
      : donorDefaults.upscale.toLowerCase() === "edgesmooth"
        ? "edge-smooth"
        : "donor"
    : null;
  const defaultDisplayMode = donorDefaults
    ? ["normal", "full", "4:3", "16:9"].includes(donorDefaults.displayMode.toLowerCase())
      ? donorDefaults.displayMode.toLowerCase()
      : "donor"
    : null;
  const graphicsFixChanged = graphicsFixOverridden;
  const speedFixChanged = speedFixOverridden;
  const disableMtvuChanged = disableMtvuOverridden;
  const disableInstantVif1Changed = disableInstantVif1Overridden;
  const clutMergeChanged = clutMergeOverridden;
  const multitapChanged = Boolean(donorDefaults && multitap !== donorDefaults.multitap);
  const resetOnDiscChangeChanged = resetOnDiscChangeOverridden;
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
  const configurationSummary = [
    {
      label: "Graphics",
      items: [
        ["Rendering", renderMode === "donor" ? "Donor" : renderMode === "native" ? "Native" : "2x2"],
        ["Upscale", upscaleMode === "edge-smooth" ? "EdgeSmooth" : upscaleMode === "donor" ? "Donor" : "None"],
        ["Display", displayMode === "donor" ? "Donor" : displayMode],
        ["Graphics fix", graphicsFix ? "On" : "Off"],
        ["Speed fix", speedFix ? "On" : "Off"],
        ["MTVU", disableMtvu ? "Disabled" : "Enabled"],
        ["VIF1", disableInstantVif1 ? "Deferred" : "Instant"],
        ["CLUT merge", clutMerge ? "On" : "Off"],
      ],
    },
    {
      label: "Input & Disc",
      items: [
        [
          "Multitap",
          multitap === "port1"
            ? "Port 1"
            : multitap === "port2"
              ? "Port 2"
              : multitap === "both"
                ? "Both ports"
                : "Disabled",
        ],
        ["Remote Play", `Layout ${remotePlayKeymap}`],
        ["Disc reset", resetOnDiscChange ? "On" : "Off"],
      ],
    },
    {
      label: "Files",
      items: [
        ["Config", customConfigPath ? "Custom" : "Donor"],
        ["Memory card", memoryCardPath ? "Custom" : "Donor"],
        ["Patch files", String(patchFiles.length)],
        ["Lua files", String(luaFiles.length)],
      ],
    },
  ];
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
      customConfigPath: customConfigPath || null,
    }).then((defaults) => {
      if (cancelled) return;
      setDonorDefaults(defaults);
      const rendering = defaults.rendering.toLowerCase();
      const upscale = defaults.upscale.toLowerCase();
      const display = defaults.displayMode.toLowerCase();
      setRenderMode(rendering === "native" ? "native" : rendering === "2x2" ? "2x2" : "donor");
      setUpscaleMode(
        upscale === "none" ? "none" : upscale === "edgesmooth" ? "edge-smooth" : "donor",
      );
      setDisplayMode(["normal", "full", "4:3", "16:9"].includes(display) ? display : "donor");
      setGraphicsFix(defaults.graphicsFix);
      setSpeedFix(defaults.speedFix);
      setDisableMtvu(defaults.disableMtvu);
      setDisableInstantVif1(defaults.disableInstantVif1);
      setClutMerge(defaults.clutMerge);
      setMultitap(defaults.multitap);
      setResetOnDiscChange(defaults.resetOnDiscChange);
      setGraphicsFixOverridden(false);
      setSpeedFixOverridden(false);
      setDisableMtvuOverridden(false);
      setDisableInstantVif1Overridden(false);
      setClutMergeOverridden(false);
      setResetOnDiscChangeOverridden(false);
    });
    return () => {
      cancelled = true;
    };
  }, [customConfigPath, selectedRuntime]);

  useEffect(() => {
    if (!selectedRuntime) return;
    let cancelled = false;
    setConfigError(null);
    void invoke<string>("preview_emulator_config", {
      request: {
        runtimePath: selectedRuntime.path,
        customConfigPath: customConfigPath || null,
        renderMode: renderMode === defaultRenderMode ? "donor" : renderMode,
        upscaleMode: upscaleMode === defaultUpscaleMode ? "donor" : upscaleMode,
        displayMode: displayMode === defaultDisplayMode ? "donor" : displayMode,
        graphicsFix: graphicsFixChanged ? graphicsFix : null,
        speedFix: speedFixChanged ? speedFix : null,
        disableMtvu: disableMtvuChanged ? disableMtvu : null,
        disableInstantVif1: disableInstantVif1Changed ? disableInstantVif1 : null,
        clutMerge: clutMergeChanged ? clutMerge : null,
        multitap: multitapChanged ? multitap : "donor",
        resetOnDiscChange: resetOnDiscChangeChanged ? resetOnDiscChange : null,
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
    clutMergeOverridden,
    customConfigPath,
    disableInstantVif1,
    disableInstantVif1Overridden,
    disableMtvu,
    disableMtvuOverridden,
    displayMode,
    graphicsFix,
    graphicsFixOverridden,
    multitap,
    renderMode,
    resetOnDiscChange,
    resetOnDiscChangeOverridden,
    selectedRuntime,
    speedFix,
    speedFixOverridden,
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
          backgroundPath: backgroundPath || null,
          outputPath,
          customConfigPath: customConfigPath || null,
          renderMode: renderMode === defaultRenderMode ? "donor" : renderMode,
          upscaleMode: upscaleMode === defaultUpscaleMode ? "donor" : upscaleMode,
          displayMode: displayMode === defaultDisplayMode ? "donor" : displayMode,
          graphicsFix: graphicsFixChanged ? graphicsFix : null,
          speedFix: speedFixChanged ? speedFix : null,
          disableMtvu: disableMtvuChanged ? disableMtvu : null,
          disableInstantVif1: disableInstantVif1Changed ? disableInstantVif1 : null,
          clutMerge: clutMergeChanged ? clutMerge : null,
          multitap: multitapChanged ? multitap : "donor",
          resetOnDiscChange: resetOnDiscChangeChanged ? resetOnDiscChange : null,
          memoryCardPath: memoryCardPath || null,
          patchFiles,
          luaFiles,
          remotePlayKeymap: Number(remotePlayKeymap),
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
    setConfigurationCategory("graphics");
    setDiscs([]);
    setIsInspecting(false);
    setError(null);
    setSelectedRuntimePath(defaultRuntime.path);
    setTitle("");
    setNpTitle("");
    setIconPath("");
    setIconPreview("");
    setBackgroundPath("");
    setBackgroundPreview("");
    setArtworkError(null);
    setDiscOriginal("");
    setDiscTitleId("");
    setDiscEmulatorId("");
    setRenderMode(defaultRenderMode ?? "native");
    setUpscaleMode(defaultUpscaleMode ?? "none");
    setDisplayMode(defaultDisplayMode ?? "full");
    setGraphicsFix(donorDefaults?.graphicsFix ?? false);
    setSpeedFix(donorDefaults?.speedFix ?? false);
    setDisableMtvu(donorDefaults?.disableMtvu ?? false);
    setDisableInstantVif1(donorDefaults?.disableInstantVif1 ?? false);
    setClutMerge(donorDefaults?.clutMerge ?? false);
    setMultitap(donorDefaults?.multitap ?? "disabled");
    setResetOnDiscChange(donorDefaults?.resetOnDiscChange ?? true);
    setGraphicsFixOverridden(false);
    setSpeedFixOverridden(false);
    setDisableMtvuOverridden(false);
    setDisableInstantVif1Overridden(false);
    setClutMergeOverridden(false);
    setResetOnDiscChangeOverridden(false);
    setCustomConfigPath("");
    setMemoryCardPath("");
    setPatchFiles([]);
    setLuaFiles([]);
    setRemotePlayKeymap("0");
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

        <main className="ps-content grid min-h-[calc(100vh-3.375rem)] place-items-center px-5 py-10">
          <section className="w-full max-w-xl text-center">
            {iconPreview ? (
              <img
                alt={`${title} icon`}
                className="mx-auto size-32 object-cover shadow-[0_2rem_6rem_rgba(0,12,55,0.5)] ring-1 ring-white/25"
                src={iconPreview}
              />
            ) : (
              <span className="ps-brand-mark mx-auto">
                <Package className="size-5 text-primary" />
              </span>
            )}
            <h1 className="mt-6 text-3xl font-light tracking-tight sm:text-4xl">
              Your package is ready
            </h1>
            <div className="mt-6 flex flex-col-reverse justify-center gap-2 sm:flex-row">
              <Button onClick={startOver} variant="outline">
                <RotateCcw />
                Start over
              </Button>
              <Button onClick={revealOutput}>
                <FolderOpen />
                Open folder
              </Button>
            </div>
            {revealError && <p className="mt-4 text-sm text-destructive">{revealError}</p>}
          </section>
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
              disabled={building || index > activeSection}
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
          <SettingsMenu onManageEmulators={onManageEmulators} status={status} />
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
                    <p className="mt-2 text-xs text-white/50">
                      {discs.length} of {maxDiscImages} selected
                    </p>
                  </div>
                  {discs.length > 0 && discs.length < maxDiscImages && (
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
                      <strong className="font-semibold text-white/80">Recommended:</strong>{" "}
                      <span className="underline underline-offset-2">Jak v2</span>. For crashes{" "}
                      <span className="underline underline-offset-2">RECVX</span>. For VU issues{" "}
                      <span className="underline underline-offset-2">Rogue v1</span>.
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
                <div className="mb-5 grid items-start gap-7 sm:grid-cols-[minmax(0,1fr)_13rem]">
                  <div>
                    <h2 className="ps-section-title leading-none">Package identity</h2>
                    <p className="mt-1.5 text-xs leading-none text-white/50">
                      Home screen title and artwork.
                    </p>
                    <p className="mt-2 text-xs leading-none text-white/50">
                      <strong className="font-semibold text-white/80">Icon:</strong> 1:1 aspect
                      ratio
                    </p>
                    <p className="mt-1 text-xs leading-none text-white/50">
                      <strong className="font-semibold text-white/80">Background:</strong> 16:9
                      aspect ratio
                    </p>
                  </div>
                  <div className="grid justify-items-start gap-2">
                    <Label>Icon</Label>
                    <Button
                      aria-label="Select home screen icon"
                      className="size-14 min-h-0 shrink-0 overflow-hidden border border-white/20 bg-white/5 p-0 text-white/55 transition-colors hover:bg-white/10 hover:text-white"
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
                        <ImageIcon className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
                <div className="grid gap-7 sm:grid-cols-[minmax(0,1fr)_13rem]">
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
                    <div className="grid gap-4 sm:grid-cols-[13rem_minmax(0,1fr)]">
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
                    <div className="relative">
                      <Label>Background</Label>
                      <Button
                        aria-label="Remove background artwork"
                        aria-hidden={!backgroundPath}
                        className={cn(
                          "absolute top-1/2 right-0 !min-h-6 -translate-y-1/2",
                          !backgroundPath && "invisible",
                        )}
                        disabled={!backgroundPath}
                        onClick={() => {
                          setBackgroundPath("");
                          setBackgroundPreview("");
                        }}
                        size="icon-xs"
                        tabIndex={backgroundPath ? 0 : -1}
                        variant="ghost"
                      >
                        <X />
                      </Button>
                    </div>
                    <Button
                      className="aspect-video h-auto w-full overflow-hidden border border-white/20 bg-white/5 p-0 text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                      onClick={selectBackground}
                      variant="outline"
                    >
                      {backgroundPreview ? (
                        <img
                          alt={`${title || "Game"} background`}
                          className="size-full object-cover"
                          src={backgroundPreview}
                        />
                      ) : (
                        <span className="flex flex-col items-center gap-1 text-[10px]">
                          <ImageIcon className="size-4" />
                          Optional
                        </span>
                      )}
                    </Button>
                  </div>
                </div>
                {artworkError && (
                  <div
                    className="mt-5 flex w-full items-start gap-4 border border-black/40 bg-black/65 px-4 py-3"
                    role="alert"
                  >
                    <p className="min-w-0 flex-1 break-words text-sm text-white/85">
                      {artworkError}
                    </p>
                    <Button
                      aria-label="Dismiss artwork error"
                      className="-mt-1 -mr-2 text-white/60 hover:bg-white/10 hover:text-white"
                      onClick={() => setArtworkError(null)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <X />
                    </Button>
                  </div>
                )}
              </section>
            </div>

            <aside className="ps-panel flex min-h-96 flex-col px-7 pt-4 pb-7">
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
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="ps-panel overflow-hidden">
              <section className="p-2">
                <div
                  aria-label="Configuration categories"
                  className="grid grid-cols-3 gap-1 rounded-md border border-white/10 bg-black/20 p-1"
                  role="tablist"
                >
                  {configurationCategories.map((category) => (
                    <Button
                      aria-controls={
                        category.value === "files"
                          ? "configuration-files-panel"
                          : "configuration-settings-panel"
                      }
                      aria-selected={configurationCategory === category.value}
                      className={cn(
                        "h-9 rounded-sm text-xs text-white/50",
                        configurationCategory === category.value &&
                          "bg-white/10 text-white shadow-inner hover:bg-white/10",
                      )}
                      id={`configuration-${category.value}-tab`}
                      key={category.value}
                      onClick={() => setConfigurationCategory(category.value)}
                      role="tab"
                      variant="ghost"
                    >
                      {category.label}
                    </Button>
                  ))}
                </div>
              </section>

              <section
                aria-labelledby={`configuration-${configurationCategory}-tab`}
                className={cn(
                  "ps-section grid items-start gap-5 sm:grid-cols-2 xl:grid-cols-3",
                  configurationCategory === "files" && "!hidden",
                )}
                id="configuration-settings-panel"
                role="tabpanel"
              >
                <div
                  className={cn("grid gap-2", configurationCategory !== "graphics" && "!hidden")}
                >
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
                  <p className="text-xs text-white/50">Controls the internal rendering resolution.</p>
                  <Select
                    items={[
                      { label: "Preserve donor", value: "donor" },
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
                      <SelectItem value="donor">Preserve donor</SelectItem>
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
                <div
                  className={cn("grid gap-2", configurationCategory !== "graphics" && "!hidden")}
                >
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
                  <p className="text-xs text-white/50">Selects the emulator image-scaling filter.</p>
                  <Select
                    items={[
                      { label: "Preserve donor", value: "donor" },
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
                      <SelectItem value="donor">Preserve donor</SelectItem>
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
                <div
                  className={cn("grid gap-2", configurationCategory !== "graphics" && "!hidden")}
                >
                  <div className="flex h-6 items-center justify-between gap-3">
                    <Label>Display mode</Label>
                    <Button
                      aria-hidden={!defaultDisplayMode || displayMode === defaultDisplayMode}
                      className={cn(
                        "!min-h-6",
                        (!defaultDisplayMode || displayMode === defaultDisplayMode) && "invisible",
                      )}
                      disabled={!defaultDisplayMode || displayMode === defaultDisplayMode}
                      onClick={() => defaultDisplayMode && setDisplayMode(defaultDisplayMode)}
                      size="xs"
                      tabIndex={defaultDisplayMode && displayMode !== defaultDisplayMode ? 0 : -1}
                      variant="ghost"
                    >
                      <RotateCcw />
                      Reset
                    </Button>
                  </div>
                  <p className="text-xs text-white/50">Controls how the game fills the PS4 output.</p>
                  <Select
                    items={[
                      { label: "Preserve donor", value: "donor" },
                      { label: "Normal", value: "normal" },
                      { label: "Full", value: "full" },
                      { label: "4:3", value: "4:3" },
                      { label: "16:9", value: "16:9" },
                    ]}
                    onValueChange={(value) => value && setDisplayMode(value)}
                    value={displayMode}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="donor">Preserve donor</SelectItem>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="full">Full</SelectItem>
                      <SelectItem value="4:3">4:3</SelectItem>
                      <SelectItem value="16:9">16:9</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div
                  className={cn("grid gap-2", configurationCategory !== "input" && "!hidden")}
                >
                  <div className="flex h-6 items-center justify-between gap-3">
                    <Label>Multitap</Label>
                    <Button
                      aria-hidden={!multitapChanged}
                      className={cn("!min-h-6", !multitapChanged && "invisible")}
                      disabled={!multitapChanged}
                      onClick={() => donorDefaults && setMultitap(donorDefaults.multitap)}
                      size="xs"
                      tabIndex={multitapChanged ? 0 : -1}
                      variant="ghost"
                    >
                      <RotateCcw />
                      Reset
                    </Button>
                  </div>
                  <p className="text-xs text-white/50">
                    Connects virtual multitaps for additional controllers.
                  </p>
                  <Select
                    items={[
                      { label: "Disabled", value: "disabled" },
                      { label: "Port 1", value: "port1" },
                      { label: "Port 2", value: "port2" },
                      { label: "Both ports", value: "both" },
                    ]}
                    onValueChange={(value) => value && setMultitap(value)}
                    value={multitap}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="disabled">Disabled</SelectItem>
                      <SelectItem value="port1">Port 1</SelectItem>
                      <SelectItem value="port2">Port 2</SelectItem>
                      <SelectItem value="both">Both ports</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div
                  className={cn(
                    "grid content-start gap-2",
                    configurationCategory !== "input" && "!hidden",
                  )}
                >
                  <div className="flex h-6 items-center">
                    <Label>Vita Remote Play layout</Label>
                  </div>
                  <p className="text-xs text-white/50">
                    Selects the PS Vita Remote Play button mapping.
                  </p>
                  <Select
                    items={Array.from({ length: 8 }, (_, value) => ({
                      label: `Layout ${value}`,
                      value: String(value),
                    }))}
                    onValueChange={(value) => value && setRemotePlayKeymap(value)}
                    value={remotePlayKeymap}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 8 }, (_, value) => (
                        <SelectItem key={value} value={String(value)}>
                          Layout {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div
                  className={cn(
                    "grid content-start gap-2",
                    configurationCategory !== "graphics" && "!hidden",
                  )}
                >
                  <div>
                    <div className="flex h-6 items-center gap-2">
                      <Label htmlFor="graphics-fix">Fix graphics</Label>
                      <Button
                        aria-hidden={!graphicsFixChanged}
                        className={cn("!min-h-6", !graphicsFixChanged && "invisible")}
                        disabled={!graphicsFixChanged}
                        onClick={() => {
                          if (donorDefaults) setGraphicsFix(donorDefaults.graphicsFix);
                          setGraphicsFixOverridden(false);
                        }}
                        size="xs"
                        tabIndex={graphicsFixChanged ? 0 : -1}
                        variant="ghost"
                      >
                        <RotateCcw />
                        Reset
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-white/50">
                      Apply FPU, VU, and COP2 clamp fixes.
                    </p>
                  </div>
                  <OnOffSelect
                    id="graphics-fix"
                    onValueChange={(value) => {
                      setGraphicsFix(value);
                      setGraphicsFixOverridden(true);
                    }}
                    value={graphicsFix}
                  />
                </div>
                <div
                  className={cn(
                    "grid content-start gap-2",
                    configurationCategory !== "graphics" && "!hidden",
                  )}
                >
                  <div>
                    <div className="flex h-6 items-center gap-2">
                      <Label htmlFor="speed-fix">Improve speed</Label>
                      <Button
                        aria-hidden={!speedFixChanged}
                        className={cn("!min-h-6", !speedFixChanged && "invisible")}
                        disabled={!speedFixChanged}
                        onClick={() => {
                          if (donorDefaults) setSpeedFix(donorDefaults.speedFix);
                          setSpeedFixOverridden(false);
                        }}
                        size="xs"
                        tabIndex={speedFixChanged ? 0 : -1}
                        variant="ghost"
                      >
                        <RotateCcw />
                        Reset
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-white/50">
                      Apply VU optimization and cache-policy fixes.
                    </p>
                  </div>
                  <OnOffSelect
                    id="speed-fix"
                    onValueChange={(value) => {
                      setSpeedFix(value);
                      setSpeedFixOverridden(true);
                    }}
                    value={speedFix}
                  />
                </div>
                <div
                  className={cn(
                    "grid content-start gap-2",
                    configurationCategory !== "graphics" && "!hidden",
                  )}
                >
                  <div>
                    <div className="flex h-6 items-center gap-2">
                      <Label htmlFor="disable-mtvu">Disable MTVU</Label>
                      <Button
                        aria-hidden={!disableMtvuChanged}
                        className={cn("!min-h-6", !disableMtvuChanged && "invisible")}
                        disabled={!disableMtvuChanged}
                        onClick={() => {
                          if (donorDefaults) setDisableMtvu(donorDefaults.disableMtvu);
                          setDisableMtvuOverridden(false);
                        }}
                        size="xs"
                        tabIndex={disableMtvuChanged ? 0 : -1}
                        variant="ghost"
                      >
                        <RotateCcw />
                        Reset
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-white/50">
                      Synchronize VU1 for games that need stricter timing.
                    </p>
                  </div>
                  <OnOffSelect
                    id="disable-mtvu"
                    onValueChange={(value) => {
                      setDisableMtvu(value);
                      setDisableMtvuOverridden(true);
                    }}
                    value={disableMtvu}
                  />
                </div>
                <div
                  className={cn(
                    "grid content-start gap-2",
                    configurationCategory !== "graphics" && "!hidden",
                  )}
                >
                  <div>
                    <div className="flex h-6 items-center gap-2">
                      <Label htmlFor="disable-vif1">Disable Instant VIF1 Transfer</Label>
                      <Button
                        aria-hidden={!disableInstantVif1Changed}
                        className={cn("!min-h-6", !disableInstantVif1Changed && "invisible")}
                        disabled={!disableInstantVif1Changed}
                        onClick={() => {
                          if (donorDefaults) {
                            setDisableInstantVif1(donorDefaults.disableInstantVif1);
                          }
                          setDisableInstantVif1Overridden(false);
                        }}
                        size="xs"
                        tabIndex={disableInstantVif1Changed ? 0 : -1}
                        variant="ghost"
                      >
                        <RotateCcw />
                        Reset
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-white/50">
                      Use deferred VIF1 transfers for affected games.
                    </p>
                  </div>
                  <OnOffSelect
                    id="disable-vif1"
                    onValueChange={(value) => {
                      setDisableInstantVif1(value);
                      setDisableInstantVif1Overridden(true);
                    }}
                    value={disableInstantVif1}
                  />
                </div>
                <div
                  className={cn(
                    "grid content-start gap-2",
                    configurationCategory !== "input" && "!hidden",
                  )}
                >
                  <div>
                    <div className="flex h-6 items-center gap-2">
                      <Label htmlFor="reset-disc-change">Reset on disc change</Label>
                      <Button
                        aria-hidden={!resetOnDiscChangeChanged}
                        className={cn("!min-h-6", !resetOnDiscChangeChanged && "invisible")}
                        disabled={!resetOnDiscChangeChanged}
                        onClick={() => {
                          if (donorDefaults) {
                            setResetOnDiscChange(donorDefaults.resetOnDiscChange);
                          }
                          setResetOnDiscChangeOverridden(false);
                        }}
                        size="xs"
                        tabIndex={resetOnDiscChangeChanged ? 0 : -1}
                        variant="ghost"
                      >
                        <RotateCcw />
                        Reset
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-white/50">
                      Restart emulation when switching multidisc games.
                    </p>
                  </div>
                  <OnOffSelect
                    id="reset-disc-change"
                    onValueChange={(value) => {
                      setResetOnDiscChange(value);
                      setResetOnDiscChangeOverridden(true);
                    }}
                    value={resetOnDiscChange}
                  />
                </div>
                <div
                  className={cn(
                    "grid content-start gap-2",
                    configurationCategory !== "graphics" && "!hidden",
                  )}
                >
                  <div>
                    <div className="flex h-6 items-center gap-2">
                      <Label htmlFor="clut-merge">CLUT merge</Label>
                      <Button
                        aria-hidden={!clutMergeChanged}
                        className={cn("!min-h-6", !clutMergeChanged && "invisible")}
                        disabled={!clutMergeChanged}
                        onClick={() => {
                          if (donorDefaults) setClutMerge(donorDefaults.clutMerge);
                          setClutMergeOverridden(false);
                        }}
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
                  <OnOffSelect
                    id="clut-merge"
                    onValueChange={(value) => {
                      setClutMerge(value);
                      setClutMergeOverridden(true);
                    }}
                    value={clutMerge}
                  />
                </div>
              </section>

              <section
                aria-labelledby="configuration-files-tab"
                className={cn("ps-section", configurationCategory !== "files" && "!hidden")}
                id="configuration-files-panel"
                role="tabpanel"
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="ps-section-title">Custom files</h2>
                    <p className="mt-2 text-xs text-white/50">
                      Optional config, patch, memory-card, and Lua payloads.
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button onClick={selectConfig} size="sm" variant="outline">
                      <FileCode />
                      TXT
                    </Button>
                    <Button onClick={selectMemoryCard} size="sm" variant="outline">
                      <Plus />
                      Card
                    </Button>
                    <Button onClick={selectPatchFiles} size="sm" variant="outline">
                      <Plus />
                      Patch
                    </Button>
                    <Button onClick={selectLuaFiles} size="sm" variant="outline">
                      <Plus />
                      Lua
                    </Button>
                  </div>
                </div>

                {(customConfigPath ||
                  memoryCardPath ||
                  patchFiles.length > 0 ||
                  luaFiles.length > 0) && (
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
                    {memoryCardPath && (
                      <div className="ps-tile flex items-center gap-3 p-3">
                        <FileCode className="size-4 text-primary" />
                        <span className="min-w-0 flex-1 truncate text-xs">
                          Memory card: {fileName(memoryCardPath)}
                        </span>
                        <Button
                          aria-label="Remove memory card"
                          onClick={() => setMemoryCardPath("")}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <X />
                        </Button>
                      </div>
                    )}
                    {patchFiles.map((path) => (
                      <div className="ps-tile flex items-center gap-3 p-3" key={path}>
                        <FileCode className="size-4 text-primary" />
                        <span className="min-w-0 flex-1 truncate text-xs">
                          Patch: {fileName(path)}
                        </span>
                        <Button
                          aria-label={`Remove ${fileName(path)}`}
                          onClick={() =>
                            setPatchFiles((current) =>
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

            <aside className="ps-panel flex flex-col p-5">
              <Dialog.Root>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <SlidersHorizontal className="size-4 text-primary" />
                    <h2 className="ps-section-title">Summary</h2>
                  </div>
                  <Dialog.Trigger
                    aria-label="View config"
                    className={buttonVariants({ size: "sm", variant: "ghost" })}
                    disabled={!configPreview}
                    title="View config"
                  >
                    <SquareCode />
                    {configPreview && (
                      <span className="self-center text-[10px] leading-none text-white/40">
                        {configPreview.trim().split("\n").length} lines
                      </span>
                    )}
                  </Dialog.Trigger>
                </div>
              <div className="mt-4 grid gap-4">
                {configurationSummary.map((group) => (
                  <section key={group.label}>
                    <h3 className="text-[10px] font-semibold tracking-wide text-white/40 uppercase">
                      {group.label}
                    </h3>
                    <dl className="mt-1 divide-y divide-white/10 text-xs">
                      {group.items.map(([label, value]) => (
                        <div className="flex justify-between gap-4 py-1.5" key={label}>
                          <dt className="text-white/50">{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ))}
              </div>
                <Dialog.Portal>
                  <Dialog.Backdrop className="fixed inset-0 z-50 bg-[#000a25]/75 backdrop-blur-sm" />
                  <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-5">
                    <Dialog.Popup className="ps-panel flex h-[min(75vh,42rem)] w-full max-w-3xl flex-col p-5 outline-none">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <Dialog.Title className="ps-section-title">
                            Config
                          </Dialog.Title>
                          <Dialog.Description className="mt-2 text-xs text-white/50">
                            Generated config-emu-ps4.txt -{" "}
                            {configPreview.trim().split("\n").length} lines
                          </Dialog.Description>
                        </div>
                        <Dialog.Close
                          aria-label="Close config viewer"
                          className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
                        >
                          <X />
                        </Dialog.Close>
                      </div>
                      <pre className="mt-4 min-h-0 flex-1 overflow-auto rounded-md border border-white/10 bg-black/30 p-4 font-mono text-xs leading-relaxed whitespace-pre text-white/70">
                        {configPreview}
                      </pre>
                    </Dialog.Popup>
                  </Dialog.Viewport>
                </Dialog.Portal>
              </Dialog.Root>
              {configError && <p className="mt-4 text-xs text-destructive">{configError}</p>}

              <div className="mt-auto grid grid-cols-2 gap-2 pt-6">
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
            <section className="relative isolate overflow-hidden p-7 sm:p-8">
              {backgroundPreview && (
                <img
                  alt=""
                  aria-hidden="true"
                  className="absolute inset-0 -z-20 size-full object-cover opacity-[0.45]"
                  src={backgroundPreview}
                />
              )}
              <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(1,18,66,0.92),rgba(1,25,83,0.68)_55%,rgba(1,25,83,0.32))]" />
              <div className="flex items-center gap-5 sm:gap-6">
                {iconPreview ? (
                  <img
                    alt={`${title} icon`}
                    className="size-24 shrink-0 object-cover shadow-[0_1.5rem_4rem_rgba(0,14,60,0.42)] ring-1 ring-white/25 sm:size-28"
                    src={iconPreview}
                  />
                ) : (
                  <div className="grid size-24 shrink-0 place-items-center border border-white/20 bg-white/10 sm:size-28">
                    <Package className="size-8 text-white/50" />
                  </div>
                )}
                <div className="min-w-0">
                  <h1 className="truncate text-3xl font-light tracking-tight sm:text-4xl">
                    {title}
                  </h1>
                  <code className="mt-2 block truncate text-xs text-white/50">{contentId}</code>
                  <dl className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px]">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <dt className="text-white/40">Runtime</dt>
                      <dd className="max-w-48 truncate">{selectedRuntime?.name}</dd>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <dt className="text-white/40">PS2</dt>
                      <dd className="font-mono">{discOriginal}</dd>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <dt className="text-white/40">NP Title</dt>
                      <dd className="font-mono">{npTitle}</dd>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <dt className="text-white/40">Discs</dt>
                      <dd>{discs.length}</dd>
                    </div>
                  </dl>
                </div>
              </div>
            </section>

            {buildError && (
              <p className="break-words border-t border-white/10 px-7 py-4 text-xs text-destructive sm:px-8">
                {buildError}
              </p>
            )}

            <div className="grid border-t border-white/10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:divide-x lg:divide-white/10">
              <section className="ps-section min-w-0">
                <div className="flex items-center gap-2">
                  <SlidersHorizontal className="size-4 text-primary" />
                  <h2 className="ps-section-title">Summary</h2>
                </div>
                <div className="mt-4 grid gap-5 sm:grid-cols-3">
                  {configurationSummary.map((group) => (
                    <section className="min-w-0" key={group.label}>
                      <h3 className="text-[10px] font-semibold tracking-wide text-white/40 uppercase">
                        {group.label}
                      </h3>
                      <dl className="mt-1 divide-y divide-white/10 text-[11px]">
                        {group.items.map(([label, value]) => (
                          <div className="flex justify-between gap-3 py-1.5" key={label}>
                            <dt className="text-white/45">{label}</dt>
                            <dd className="text-right">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </section>
                  ))}
                </div>
              </section>

              <aside className="ps-section flex min-h-0 min-w-0 flex-col">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <SquareCode className="size-4 text-primary" />
                    <h2 className="ps-section-title">Config</h2>
                  </div>
                  <span className="text-[10px] text-white/40">
                    {configPreview.trim().split("\n").length} lines
                  </span>
                </div>
                <pre className="mt-4 min-h-64 flex-1 overflow-auto rounded-md border border-white/10 bg-black/25 p-3 font-mono text-[10px] leading-relaxed whitespace-pre text-white/65">
                  {configPreview}
                </pre>
              </aside>
            </div>

            <footer className="ps-actionbar flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <Button disabled={building} onClick={() => setActiveSection(1)} variant="outline">
                <ArrowLeft />
                Back
              </Button>

              <div className="flex w-full min-w-0 flex-1 items-center gap-4 sm:w-auto">
                {building && (
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex items-center justify-between gap-4">
                      <span className="truncate text-[10px] font-medium">
                        {buildPhaseLabel(buildProgress?.phase ?? "preparing")}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-primary">
                        {buildProgress?.percent ?? 0}%
                      </span>
                    </div>
                    <Progress
                      aria-label="Package build progress"
                      className="install-progress block"
                      value={buildProgress?.percent ?? 0}
                    />
                  </div>
                )}
                <Button
                  className={cn(!building && "ml-auto")}
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
  const [managingEmulators, setManagingEmulators] = useState(false);

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

  if (!status.installed || managingEmulators) {
    return (
      <SetupScreen
        onCancel={status.installed ? () => setManagingEmulators(false) : undefined}
        onComplete={(installed) => {
          setStatus(installed);
          setManagingEmulators(false);
        }}
        status={status}
      />
    );
  }

  return <Workspace onManageEmulators={() => setManagingEmulators(true)} status={status} />;
}

export default App;
