import { useEffect, useMemo, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

type Tab = "marketplace" | "library" | "prepare" | "inspect" | "settings";
type OperationKind = "upload" | "download" | "scan" | "build";
type OperationStatus = "running" | "done" | "failed";

type Operation = {
  id: string;
  kind: OperationKind;
  label: string;
  status: OperationStatus;
  startedAt: number;
  endedAt?: number;
  bytesDone?: number;
  bytesTotal?: number;
  message?: string;
};

type FileEntry = { game_paths: string[]; length: number; hash: string };
type MCDFInfo = {
  description: string;
  glamourer_data: string;
  customize_plus_data: string;
  manipulation_data: string;
  files: FileEntry[];
};
type ExtractedFileInfo = {
  index: number;
  game_paths: string[];
  length: number;
  hash: string;
  offset: number;
  blake3: string;
};
type VaultChunk = {
  index: number;
  hash_blake3: string;
  size: number;
  offset: number;
  local_path?: string | null;
  attachment_url?: string | null;
};
type ComponentCentralStatus = "unknown" | "present" | "missing" | "queued" | "external_only";
type ManifestMcdfFile = {
  index: number;
  game_paths: string[];
  length: number;
  mcdf_hash: string;
  payload_offset: number;
  payload_blake3: string;
  central_status: ComponentCentralStatus;
  central_blob_url?: string | null;
  notes: string[];
};
type VaultManifest = {
  schema_version: number;
  archive_id: string;
  title: string;
  description: string;
  original_filename: string;
  mcdf_hash_blake3: string;
  mcdf_size: number;
  chunk_size: number;
  chunks: VaultChunk[];
  mcdf_files: ManifestMcdfFile[];
  parity: VaultChunk[];
  source: {
    server_base_url?: string | null;
    index_url?: string | null;
    online_source_url?: string | null;
    thumbnail_url?: string | null;
  };
};
type ManifestBuildResult = { manifest: VaultManifest; manifest_path: string; cache_dir: string };
type RebuildResult = {
  output_path: string;
  bytes_written: number;
  chunks_used: number;
  downloaded_chunks: number;
  verified_blake3: string;
};
type ComponentAvailability = {
  index: number;
  game_paths: string[];
  length: number;
  mcdf_hash: string;
  payload_blake3: string;
  central_status: ComponentCentralStatus;
  online_status: string;
  notes: string[];
};
type ManifestStatus = {
  archive_id: string;
  chunks: Array<{ index: number; hash_blake3: string; size: number; cached: boolean; online_available: boolean; status: string }>;
  files: ComponentAvailability[];
};
type OnlineLocationType = "generic_json_index" | "google_drive_folder";
type OnlineLocation = { id: string; name: string; source_type: OnlineLocationType; url: string; google_api_key?: string | null; enabled: boolean };
type OnlineFileRef = { name: string; url: string };
type OnlineLibraryEntry = {
  source_id: string;
  source_name: string;
  provider: string;
  name: string;
  mcdf_file_name: string;
  mcdf_url: string;
  image_file_name?: string | null;
  image_url?: string | null;
  can_prepare_for_central: boolean;
};
type OnlineLocationScanResult = {
  source: OnlineLocation;
  entries: OnlineLibraryEntry[];
  orphan_mcdf_files: OnlineFileRef[];
  orphan_image_files: OnlineFileRef[];
  warnings: string[];
};

type FileLike = ExtractedFileInfo | ComponentAvailability | ManifestMcdfFile;

type PanelProps = {
  addOperation: (op: Omit<Operation, "id" | "startedAt" | "status">) => string;
  finishOperation: (id: string, patch: Partial<Operation>) => void;
};

const navSections: Array<{ title: string; items: Array<{ id: Tab; label: string; icon: string; hint: string }> }> = [
  {
    title: "Browse",
    items: [
      { id: "marketplace", label: "Vault Browser", icon: "✦", hint: "Manifests and rebuilds" },
      { id: "library", label: "Online Libraries", icon: "⌁", hint: "Drive and index sources" },
    ],
  },
  {
    title: "Build",
    items: [
      { id: "prepare", label: "Prepare MCDF", icon: "◇", hint: "Extract then package" },
      { id: "inspect", label: "Inspect Bundle", icon: "◎", hint: "Read compiled contents" },
    ],
  },
  {
    title: "System",
    items: [{ id: "settings", label: "Settings", icon: "⚙", hint: "Cache and build info" }],
  },
];

function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function shortHash(value?: string | null): string {
  if (!value) return "—";
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-8)}`;
}
function statusLabel(status?: string | null): string {
  return (status || "local_only").replace(/_/g, " ");
}
function filePrimaryPath(file: FileLike): string {
  return file.game_paths?.[0] || "unknown path";
}
function fileBlake3(file: FileLike): string {
  if ("payload_blake3" in file) return file.payload_blake3;
  return file.blake3;
}
function fileMcdfHash(file: FileLike): string {
  if ("mcdf_hash" in file) return file.mcdf_hash;
  return file.hash;
}
function fileOffset(file: FileLike): number | undefined {
  if ("payload_offset" in file) return file.payload_offset;
  if ("offset" in file) return file.offset;
  return undefined;
}
function fileStatus(file: FileLike): string {
  if ("online_status" in file) return file.online_status;
  if ("central_status" in file) return file.central_status;
  return "local_only";
}
function fileNotes(file: FileLike): string[] {
  return "notes" in file ? file.notes : [];
}
function inferComponentKind(file: Pick<FileLike, "game_paths">): string {
  const joined = file.game_paths.join(" ").toLowerCase();
  if (joined.includes("animation") || joined.endsWith(".pap") || joined.endsWith(".tmb")) return "Animation";
  if (joined.endsWith(".tex") || joined.endsWith(".atex") || joined.includes("/texture/")) return "Texture";
  if (joined.endsWith(".mtrl") || joined.includes("/material/")) return "Material";
  if (joined.endsWith(".mdl") || joined.includes("/model/")) return "Model";
  if (joined.endsWith(".sklb") || joined.includes("skeleton")) return "Skeleton";
  if (joined.includes("tail")) return "Tail / Feature";
  if (joined.includes("hair")) return "Hair";
  if (joined.includes("face") || joined.includes("head")) return "Face";
  return "Other";
}
function groupedFiles(files: FileLike[]): Array<{ kind: string; files: FileLike[]; bytes: number; online: number; missing: number }> {
  const map = new Map<string, FileLike[]>();
  files.forEach((file) => {
    const kind = inferComponentKind(file);
    map.set(kind, [...(map.get(kind) ?? []), file]);
  });
  return Array.from(map.entries())
    .map(([kind, list]) => ({
      kind,
      files: list,
      bytes: list.reduce((sum, file) => sum + file.length, 0),
      online: list.filter((file) => ["present", "cached", "online_available", "external_only"].includes(fileStatus(file))).length,
      missing: list.filter((file) => ["missing", "chunk_missing"].includes(fileStatus(file))).length,
    }))
    .sort((a, b) => b.files.length - a.files.length);
}
function statusClass(status: string): string {
  if (["present", "cached", "online_available", "external_only", "local_only"].includes(status)) return "status-good";
  if (["queued", "unknown"].includes(status)) return "status-warn";
  if (["missing", "chunk_missing"].includes(status)) return "status-bad";
  return "status-neutral";
}

function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="alert alert-error">{error}</div> : null;
}
function SuccessBox({ children }: { children: ReactNode }) {
  return <div className="alert alert-success">{children}</div>;
}
function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`glass-panel ${className}`}>{children}</section>;
}
function PrimaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = "", ...rest } = props;
  return <button {...rest} className={`btn-primary ${className}`} />;
}
function GhostButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = "", ...rest } = props;
  return <button {...rest} className={`btn-ghost ${className}`} />;
}
function Field(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return <input {...rest} className={`field ${className}`} />;
}
function SelectField(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", ...rest } = props;
  return <select {...rest} className={`field ${className}`} />;
}

function ActivityIndicator({ operations }: { operations: Operation[] }) {
  const active = operations.filter((op) => op.status === "running");
  const done = operations.filter((op) => op.status === "done").length;
  const failed = operations.filter((op) => op.status === "failed").length;
  const recent = operations.slice(0, 8);
  const totalSpeed = active.reduce((sum, op) => {
    const elapsed = (Date.now() - op.startedAt) / 1000;
    return op.bytesDone && elapsed > 0 ? sum + op.bytesDone / elapsed : sum;
  }, 0);
  return (
    <details className="activity">
      <summary className="activity-summary">
        <span className={active.length > 0 ? "pulse-dot" : "idle-dot"} />
        <span>{active.length > 0 ? `${active.length} active` : "transfers"}</span>
        <span className="activity-speed">{active.length > 0 ? formatBytes(totalSpeed) + "/s" : `${done} done`}</span>
      </summary>
      <div className="activity-popover">
        <div className="activity-head">
          <span>Uploads / downloads</span>
          <span>{failed > 0 ? `${failed} failed` : "healthy"}</span>
        </div>
        {recent.length === 0 ? <div className="empty-small">No operations yet.</div> : recent.map((op) => {
          const elapsed = ((op.endedAt ?? Date.now()) - op.startedAt) / 1000;
          const speed = op.bytesDone && elapsed > 0 ? `${formatBytes(op.bytesDone / elapsed)}/s` : "—";
          return (
            <div key={op.id} className="activity-row">
              <div className="activity-row-title">
                <span>{op.label}</span>
                <span className={`status-pill ${statusClass(op.status)}`}>{op.status}</span>
              </div>
              <div className="activity-row-meta">
                <span>{op.kind}</span>
                <span>{formatBytes(op.bytesDone)} {op.bytesTotal ? `/ ${formatBytes(op.bytesTotal)}` : ""} · {speed}</span>
              </div>
              {op.message && <div className="activity-message">{op.message}</div>}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function HeroPreview({ title, subtitle, imageUrl }: { title: string; subtitle: string; imageUrl?: string | null }) {
  return (
    <Panel className="hero-preview">
      <div className="preview-stage">
        {imageUrl ? <img src={imageUrl} alt={title} /> : <div className="preview-silhouette">✧</div>}
        <div className="preview-ring" />
      </div>
      <div className="preview-strip">
        {Array.from({ length: 5 }).map((_, index) => <div key={index} className="preview-thumb">{index === 0 ? "◇" : ""}</div>)}
      </div>
      <div className="preview-caption">
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
      </div>
    </Panel>
  );
}

function ComponentSummary({ files }: { files: FileLike[] }) {
  const groups = groupedFiles(files);
  const totalBytes = files.reduce((sum, file) => sum + file.length, 0);
  return (
    <Panel>
      <div className="panel-title-row">
        <div>
          <div className="eyebrow">Component stack</div>
          <h2>Bundle contents</h2>
        </div>
        <span className="status-pill status-neutral">{files.length} files</span>
      </div>
      <div className="summary-metrics">
        <div><strong>{groups.length}</strong><span>groups</span></div>
        <div><strong>{formatBytes(totalBytes)}</strong><span>payload</span></div>
        <div><strong>{files.filter((f) => fileStatus(f) !== "missing").length}</strong><span>available/local</span></div>
      </div>
      <div className="component-grid">
        {groups.length === 0 && <div className="empty-small">No extracted files yet.</div>}
        {groups.map((group) => (
          <div key={group.kind} className="component-card">
            <div className="component-icon">{group.kind.slice(0, 1)}</div>
            <div>
              <div className="component-name">{group.kind}</div>
              <div className="component-meta">{group.files.length} files · {formatBytes(group.bytes)}</div>
              {group.missing > 0 && <div className="component-warning">{group.missing} missing</div>}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ComponentTable({ files, title = "Internal MCDF files" }: { files: FileLike[]; title?: string }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <Panel className="component-table-panel">
      <div className="panel-title-row">
        <div>
          <div className="eyebrow">Extracted package details</div>
          <h2>{title}</h2>
        </div>
        <span className="status-pill status-neutral">{files.length} entries</span>
      </div>
      <div className="component-table">
        {files.length === 0 && <p className="empty-small">No internal files found.</p>}
        {files.map((file) => {
          const status = fileStatus(file);
          const primaryPath = filePrimaryPath(file);
          return (
            <div key={file.index} className="file-row">
              <button className="file-row-main" onClick={() => setExpanded(expanded === file.index ? null : file.index)}>
                <span className="file-index">#{file.index + 1}</span>
                <span className="file-kind">{inferComponentKind(file)}</span>
                <span className="file-path" title={primaryPath}>{primaryPath}</span>
                <span className={`status-pill ${statusClass(status)}`}>{statusLabel(status)}</span>
                <span className="file-size">{formatBytes(file.length)}</span>
                <span className="file-expand">{expanded === file.index ? "▾" : "▸"}</span>
              </button>
              {expanded === file.index && (
                <div className="file-row-details">
                  {file.game_paths.slice(1).map((path, index) => <div key={index}>also: {path}</div>)}
                  {fileOffset(file) !== undefined && <div>payload offset: {fileOffset(file)}</div>}
                  <div>MCDF file hash: {fileMcdfHash(file) || "—"}</div>
                  <div>BLAKE3 payload hash: {fileBlake3(file)}</div>
                  {"central_status" in file && <div>central status: {file.central_status}</div>}
                  {fileNotes(file).map((note, index) => <div key={index}>note: {note}</div>)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function MarketplacePanel({ addOperation, finishOperation }: PanelProps) {
  const [manifestPath, setManifestPath] = useState<string | null>(null);
  const [manifest, setManifest] = useState<VaultManifest | null>(null);
  const [manifestStatus, setManifestStatus] = useState<ManifestStatus | null>(null);
  const [rebuildResult, setRebuildResult] = useState<RebuildResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chooseManifest = async () => {
    const selected = await open({ multiple: false, filters: [{ name: "Vault Manifest", extensions: ["json"] }] });
    if (!selected) return;
    setError(null);
    setRebuildResult(null);
    try {
      const [loaded, status] = await Promise.all([
        invoke<VaultManifest>("read_manifest", { path: selected }),
        invoke<ManifestStatus>("inspect_manifest_status", { path: selected }),
      ]);
      setManifestPath(selected as string);
      setManifest(loaded);
      setManifestStatus(status);
    } catch (e) {
      setManifest(null);
      setManifestStatus(null);
      setError(String(e));
    }
  };

  const rebuild = async () => {
    if (!manifestPath || !manifest) return;
    const selectedOutput = await save({ defaultPath: manifest.original_filename || "rebuilt.mcdf", filters: [{ name: "MCDF", extensions: ["mcdf"] }] });
    if (!selectedOutput) return;
    const opId = addOperation({ kind: "download", label: `Rebuild ${manifest.original_filename}`, bytesTotal: manifest.mcdf_size });
    setError(null);
    try {
      const rebuilt = await invoke<RebuildResult>("rebuild_from_manifest", { manifestPath, outputPath: selectedOutput });
      setRebuildResult(rebuilt);
      finishOperation(opId, { status: "done", bytesDone: rebuilt.bytes_written, message: rebuilt.output_path });
      const status = await invoke<ManifestStatus>("inspect_manifest_status", { path: manifestPath });
      setManifestStatus(status);
    } catch (e) {
      finishOperation(opId, { status: "failed", message: String(e) });
      setError(String(e));
    }
  };

  const files = manifestStatus?.files ?? manifest?.mcdf_files ?? [];
  const cachedChunks = manifestStatus?.chunks.filter((chunk) => chunk.cached).length ?? 0;
  const onlineChunks = manifestStatus?.chunks.filter((chunk) => chunk.online_available).length ?? 0;

  return (
    <div className="screen-grid">
      <HeroPreview title={manifest?.title || "MCDF Vault"} subtitle={manifest ? manifest.original_filename : "Open a manifest to inspect files and rebuild"} imageUrl={manifest?.source?.thumbnail_url} />
      <div className="main-stack">
        <Panel className="hero-copy">
          <div className="eyebrow">Local-first vault browser</div>
          <h1>Inspect the compiled package before rebuilding it.</h1>
          <p>MCDF bundles are treated as compiled archives. The app tracks the original archive chunks and every internal file so you can see what is cached, online, missing, or only available from an external library.</p>
          <div className="hero-actions">
            <PrimaryButton onClick={chooseManifest}>Open manifest / rebuild…</PrimaryButton>
            {manifest && <GhostButton onClick={rebuild}>Rebuild MCDF…</GhostButton>}
          </div>
        </Panel>
        <ErrorBox error={error} />
        {manifest && (
          <Panel>
            <div className="panel-title-row">
              <div>
                <div className="eyebrow">Selected archive</div>
                <h2>{manifest.title || manifest.original_filename}</h2>
                <p>{manifest.description || "No description provided."}</p>
              </div>
              <span className="status-pill status-good">ready</span>
            </div>
            <div className="stat-grid">
              <div><span>Archive</span><strong>{manifest.archive_id}</strong></div>
              <div><span>Size</span><strong>{formatBytes(manifest.mcdf_size)}</strong></div>
              <div><span>Chunks</span><strong>{cachedChunks}/{manifest.chunks.length} cached · {onlineChunks} online</strong></div>
              <div><span>Files</span><strong>{files.length}</strong></div>
              <div><span>Hash</span><strong title={manifest.mcdf_hash_blake3}>{shortHash(manifest.mcdf_hash_blake3)}</strong></div>
            </div>
          </Panel>
        )}
        {rebuildResult && <SuccessBox><div className="font-semibold">MCDF rebuilt and verified</div><div className="mt-2 font-mono text-xs">{rebuildResult.output_path}</div></SuccessBox>}
      </div>
      <aside className="right-stack">
        <ComponentSummary files={files} />
      </aside>
      <div className="wide-area">{files.length > 0 && <ComponentTable files={files} title="Internal files and online status" />}</div>
    </div>
  );
}

function PreparePanel({ addOperation, finishOperation }: PanelProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [info, setInfo] = useState<MCDFInfo | null>(null);
  const [files, setFiles] = useState<ExtractedFileInfo[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [result, setResult] = useState<ManifestBuildResult | null>(null);
  const [status, setStatus] = useState<ManifestStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseFile = async () => {
    const selected = await open({ multiple: false, filters: [{ name: "MCDF", extensions: ["mcdf"] }] });
    if (!selected) return;
    const opId = addOperation({ kind: "scan", label: "Extract MCDF components" });
    setLoading(true);
    setError(null);
    setResult(null);
    setStatus(null);
    try {
      const [mcdf, fileInfos] = await Promise.all([
        invoke<MCDFInfo>("scan_mcdf", { path: selected }),
        invoke<ExtractedFileInfo[]>("inspect_mcdf_files", { path: selected }),
      ]);
      setSelectedPath(selected as string);
      setInfo(mcdf);
      setFiles(fileInfos);
      setDescription((current) => current || mcdf.description || "");
      finishOperation(opId, { status: "done", bytesDone: fileInfos.reduce((sum, file) => sum + file.length, 0), message: `${fileInfos.length} files found` });
    } catch (e) {
      setInfo(null);
      setFiles([]);
      finishOperation(opId, { status: "failed", message: String(e) });
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const createManifest = async () => {
    if (!selectedPath) return;
    const opId = addOperation({ kind: "upload", label: "Prepare local manifest", bytesTotal: files.reduce((sum, file) => sum + file.length, 0) });
    setLoading(true);
    setError(null);
    try {
      const built = await invoke<ManifestBuildResult>("create_local_manifest", { path: selectedPath, title: title.trim() || null, description: description.trim() || null, chunkSize: null });
      setResult(built);
      const manifestStatus = await invoke<ManifestStatus>("inspect_manifest_status", { path: built.manifest_path });
      setStatus(manifestStatus);
      finishOperation(opId, { status: "done", bytesDone: built.manifest.mcdf_size, message: built.manifest_path });
    } catch (e) {
      finishOperation(opId, { status: "failed", message: String(e) });
      setError(String(e));
      setResult(null);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="screen-grid">
      <HeroPreview title={title || "Prepare MCDF"} subtitle={selectedPath ? selectedPath.split(/[\\/]/).pop() || selectedPath : "Choose a compiled bundle"} />
      <div className="main-stack">
        <Panel className="hero-copy">
          <div className="eyebrow">Extract first</div>
          <h1>Turn a compiled MCDF into visible components.</h1>
          <p>The package is inspected before chunking. The manifest records the internal files, their offsets, hashes, component groups, and future central status.</p>
          <div className="hero-actions"><PrimaryButton onClick={chooseFile}>Choose MCDF…</PrimaryButton></div>
        </Panel>
        {selectedPath && <div className="path-chip" title={selectedPath}>{selectedPath}</div>}
        {loading && <div className="loader" />}
        <ErrorBox error={error} />
        {info && (
          <Panel>
            <div className="panel-title-row">
              <div>
                <div className="eyebrow">Package metadata</div>
                <h2>{info.description ? "Description found" : "No description in archive"}</h2>
                <p>{info.description || "Add a marketplace title and description before preparing the local manifest."}</p>
              </div>
              <span className="status-pill status-good">{files.length} files</span>
            </div>
            <div className="form-grid">
              <Field value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Marketplace title, defaults to filename" />
              <Field value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Marketplace description" />
            </div>
            <div className="hero-actions"><PrimaryButton disabled={loading || !selectedPath} onClick={createManifest}>Create manifest + local chunks</PrimaryButton></div>
          </Panel>
        )}
        {result && <SuccessBox><div className="font-semibold">Manifest created after extraction</div><div className="mt-2 grid gap-1 font-mono text-xs"><div>{result.manifest_path}</div><div>components: {result.manifest.mcdf_files.length}</div><div>cache: {result.cache_dir}</div></div></SuccessBox>}
      </div>
      <aside className="right-stack"><ComponentSummary files={status?.files ?? files} /></aside>
      <div className="wide-area">{files.length > 0 && <ComponentTable files={status?.files ?? files} title="Extracted internal files" />}</div>
    </div>
  );
}

function OnlineLibraryPanel({ addOperation, finishOperation }: PanelProps) {
  const [locations, setLocations] = useState<OnlineLocation[]>([]);
  const [scanResults, setScanResults] = useState<OnlineLocationScanResult[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [sourceType, setSourceType] = useState<OnlineLocationType>("generic_json_index");
  const [googleApiKey, setGoogleApiKey] = useState("");
  const [lastManifest, setLastManifest] = useState<ManifestBuildResult | null>(null);
  const [lastStatus, setLastStatus] = useState<ManifestStatus | null>(null);
  const [lastPreview, setLastPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { invoke<OnlineLocation[]>("list_online_locations").then(setLocations).catch((e) => setError(String(e))); }, []);

  const addLocation = async () => {
    setError(null);
    try {
      const added = await invoke<OnlineLocation>("add_online_location", { name, url, sourceType, googleApiKey: googleApiKey.trim() || null });
      setLocations((current) => [...current.filter((item) => item.id !== added.id), added]);
      setName("");
      setUrl("");
      setGoogleApiKey("");
    } catch (e) {
      setError(String(e));
    }
  };
  const removeLocation = async (id: string) => {
    try {
      setLocations(await invoke<OnlineLocation[]>("remove_online_location", { id }));
      setScanResults((r) => r.filter((x) => x.source.id !== id));
    } catch (e) {
      setError(String(e));
    }
  };
  const scanAll = async () => {
    const opId = addOperation({ kind: "scan", label: "Scan online locations" });
    setLoading(true);
    setError(null);
    setLastManifest(null);
    setLastStatus(null);
    try {
      const results = await invoke<OnlineLocationScanResult[]>("scan_online_locations");
      setScanResults(results);
      finishOperation(opId, { status: "done", message: `${results.reduce((n, r) => n + r.entries.length, 0)} entries` });
    } catch (e) {
      finishOperation(opId, { status: "failed", message: String(e) });
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  const prepareForCentral = async (entry: OnlineLibraryEntry) => {
    const opId = addOperation({ kind: "download", label: `Download and inspect ${entry.mcdf_file_name}` });
    setError(null);
    setLastManifest(null);
    setLastStatus(null);
    setLastPreview(entry.image_url ?? null);
    try {
      const result = await invoke<ManifestBuildResult>("create_manifest_from_online_entry", { request: { mcdf_url: entry.mcdf_url, title: entry.name, description: `Imported from ${entry.source_name}`, image_url: entry.image_url ?? null } });
      setLastManifest(result);
      const status = await invoke<ManifestStatus>("inspect_manifest_status", { path: result.manifest_path });
      setLastStatus(status);
      finishOperation(opId, { status: "done", bytesDone: result.manifest.mcdf_size, message: `${result.manifest.mcdf_files.length} internal files` });
    } catch (e) {
      finishOperation(opId, { status: "failed", message: String(e) });
      setError(String(e));
    }
  };

  const entryCount = scanResults.reduce((total, result) => total + result.entries.length, 0);
  return (
    <div className="screen-grid">
      <HeroPreview title={lastManifest?.manifest.title || "Online Libraries"} subtitle={entryCount > 0 ? `${entryCount} paired MCDF/image entries` : "Add Drive folders or JSON indexes"} imageUrl={lastPreview} />
      <div className="main-stack">
        <Panel className="hero-copy">
          <div className="eyebrow">External discovery</div>
          <h1>Use online folders as libraries, not storage backends.</h1>
          <p>Online locations are scanned for matching <span className="inline-code">name.mcdf</span> and <span className="inline-code">name.png/jpg/webp</span> pairs. Selecting one downloads the MCDF, extracts it, and prepares a local manifest for the central vault.</p>
        </Panel>
        <Panel>
          <div className="form-grid library-form">
            <Field value={name} onChange={(e) => setName(e.target.value)} placeholder="Library name" />
            <Field value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Google Drive folder URL or index.json URL" />
            <SelectField value={sourceType} onChange={(e) => setSourceType(e.target.value as OnlineLocationType)}>
              <option value="generic_json_index">Generic JSON index</option>
              <option value="google_drive_folder">Google Drive folder</option>
            </SelectField>
          </div>
          {sourceType === "google_drive_folder" && <Field value={googleApiKey} onChange={(e) => setGoogleApiKey(e.target.value)} placeholder="Google Drive API key" />}
          <div className="hero-actions">
            <PrimaryButton disabled={!name.trim() || !url.trim()} onClick={addLocation}>Add location</PrimaryButton>
            <GhostButton disabled={locations.length === 0 || loading} onClick={scanAll}>{loading ? "Scanning…" : "Scan online library"}</GhostButton>
          </div>
        </Panel>
        <ErrorBox error={error} />
        {locations.length > 0 && (
          <Panel>
            <div className="panel-title-row"><div><div className="eyebrow">Sources</div><h2>Configured locations</h2></div><span className="status-pill status-neutral">{locations.length}</span></div>
            <div className="source-list">
              {locations.map((location) => (
                <div key={location.id} className="source-row">
                  <div><strong>{location.name}</strong><span>{location.source_type.replace(/_/g, " ")}</span><code>{location.url}</code></div>
                  <button onClick={() => removeLocation(location.id)}>remove</button>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
      <aside className="right-stack"><ComponentSummary files={lastStatus?.files ?? []} /></aside>
      <div className="wide-area">
        {scanResults.map((result) => (
          <Panel key={result.source.id}>
            <div className="panel-title-row">
              <div><div className="eyebrow">{result.source.name}</div><h2>{result.entries.length} complete pairs</h2></div>
              <span className="status-pill status-warn">{result.warnings.length} warnings</span>
            </div>
            {result.warnings.map((w, i) => <div key={i} className="alert alert-warn">{w}</div>)}
            <div className="mod-card-grid">
              {result.entries.map((entry) => (
                <article key={`${entry.source_id}-${entry.mcdf_url}`} className="mod-card">
                  <div className="mod-image">{entry.image_url ? <img src={entry.image_url} alt={entry.name} /> : <span>◇</span>}</div>
                  <div className="mod-body">
                    <strong>{entry.name}</strong>
                    <span>{entry.provider} · {entry.mcdf_file_name}</span>
                    <PrimaryButton onClick={() => prepareForCentral(entry)}>Download, extract, prepare</PrimaryButton>
                  </div>
                </article>
              ))}
            </div>
          </Panel>
        ))}
        {lastManifest && <SuccessBox><div className="font-semibold">Online MCDF downloaded and extracted</div><div className="mt-2 font-mono text-xs">{lastManifest.manifest_path}</div></SuccessBox>}
        {lastStatus && <ComponentTable files={lastStatus.files} title="Online MCDF internal files and status" />}
      </div>
    </div>
  );
}

function InspectPanel() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [info, setInfo] = useState<MCDFInfo | null>(null);
  const [files, setFiles] = useState<ExtractedFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleOpen = async () => {
    const selected = await open({ multiple: false, filters: [{ name: "MCDF", extensions: ["mcdf"] }] });
    if (!selected) return;
    setFilePath(selected as string);
    setLoading(true);
    setError(null);
    try {
      const [mcdf, fileInfos] = await Promise.all([
        invoke<MCDFInfo>("scan_mcdf", { path: selected }),
        invoke<ExtractedFileInfo[]>("inspect_mcdf_files", { path: selected }),
      ]);
      setInfo(mcdf);
      setFiles(fileInfos);
    } catch (e) {
      setInfo(null);
      setFiles([]);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="screen-grid">
      <HeroPreview title="Inspect Bundle" subtitle={filePath ? filePath.split(/[\\/]/).pop() || filePath : "Read MCDF internals only"} />
      <div className="main-stack">
        <Panel className="hero-copy">
          <div className="eyebrow">Compiled package reader</div>
          <h1>See the files inside an MCDF without preparing upload.</h1>
          <p>This view extracts metadata and payload file records only. It does not create local chunks or central manifests.</p>
          <div className="hero-actions"><PrimaryButton onClick={handleOpen}>Choose File…</PrimaryButton></div>
        </Panel>
        {filePath && <div className="path-chip" title={filePath}>{filePath}</div>}
        {loading && <div className="loader" />}
        <ErrorBox error={error} />
        {info && !loading && <Panel><div className="eyebrow">Description</div><p>{info.description || "No description in this archive."}</p></Panel>}
      </div>
      <aside className="right-stack"><ComponentSummary files={files} /></aside>
      <div className="wide-area">{files.length > 0 ? <ComponentTable files={files} title="Extracted internal files" /> : !loading && !error && <Panel><p className="empty-small">Select an MCDF file to inspect its compiled contents.</p></Panel>}</div>
    </div>
  );
}

function SettingsPanel() {
  const [cacheDir, setCacheDir] = useState("loading…");
  useEffect(() => { invoke<string>("get_cache_dir").then(setCacheDir).catch((e) => setCacheDir(String(e))); }, []);
  return (
    <div className="settings-screen">
      <Panel className="hero-copy">
        <div className="eyebrow">Local settings</div>
        <h1>Cache and build details</h1>
        <p>The browser stays local-first. Server endpoints are optional; direct manifest rebuilds still work when chunks are cached or have direct URLs.</p>
      </Panel>
      <Panel>
        <div className="eyebrow">Local cache directory</div>
        <div className="path-block">{cacheDir}</div>
        <p>Override with <span className="inline-code">MCDF_MARKETPLACE_HOME</span> when testing builds or CI behavior.</p>
      </Panel>
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("marketplace");
  const [appVersion, setAppVersion] = useState("loading…");
  const [operations, setOperations] = useState<Operation[]>([]);
  useEffect(() => { invoke<string>("get_app_version").then(setAppVersion).catch(() => setAppVersion("unknown")); }, []);
  const addOperation = (op: Omit<Operation, "id" | "startedAt" | "status">) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setOperations((current) => [{ ...op, id, startedAt: Date.now(), status: "running" }, ...current]);
    return id;
  };
  const finishOperation = (id: string, patch: Partial<Operation>) => {
    setOperations((current) => current.map((op) => op.id === id ? { ...op, ...patch, endedAt: Date.now() } : op));
  };
  const panelProps = useMemo(() => ({ addOperation, finishOperation }), []);
  const activeLabel = navSections.flatMap((section) => section.items).find((item) => item.id === activeTab)?.label ?? "MCDF Browser";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">✧</div>
          <div><strong>MCDF Browser</strong><span>Shape your fantasy. Look how you feel.</span></div>
        </div>
        <nav className="side-nav">
          {navSections.map((section) => (
            <div key={section.title} className="nav-section">
              <div className="nav-title">{section.title}</div>
              {section.items.map((item) => (
                <button key={item.id} onClick={() => setActiveTab(item.id)} className={activeTab === item.id ? "nav-item active" : "nav-item"}>
                  <span className="nav-icon">{item.icon}</span>
                  <span><strong>{item.label}</strong><small>{item.hint}</small></span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="profile-card">
          <span>Active profile</span>
          <strong>Local Vault</strong>
          <small>v{appVersion}</small>
        </div>
      </aside>
      <div className="content-shell">
        <header className="topbar">
          <div>
            <span className="eyebrow">{activeLabel}</span>
            <h1>Component-aware MCDF library</h1>
          </div>
          <div className="topbar-actions">
            <ActivityIndicator operations={operations} />
            <span className="mode-pill">local-first</span>
          </div>
        </header>
        <main className="content-area">
          {activeTab === "marketplace" && <MarketplacePanel {...panelProps} />}
          {activeTab === "library" && <OnlineLibraryPanel {...panelProps} />}
          {activeTab === "prepare" && <PreparePanel {...panelProps} />}
          {activeTab === "inspect" && <InspectPanel />}
          {activeTab === "settings" && <SettingsPanel />}
        </main>
      </div>
    </div>
  );
}

export default App;
