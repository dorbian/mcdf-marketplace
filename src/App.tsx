import { useEffect, useMemo, useState } from "react";
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

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "marketplace", label: "Marketplace" },
  { id: "library", label: "Online Library" },
  { id: "prepare", label: "Prepare MCDF" },
  { id: "inspect", label: "Inspect MCDF" },
  { id: "settings", label: "Settings" },
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
function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}
function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="rounded-lg border border-red-700 bg-red-950/40 p-4 text-sm text-red-200">{error}</div> : null;
}
function SuccessBox({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-emerald-700 bg-emerald-950/30 p-4 text-sm text-emerald-200">{children}</div>;
}

function ActivityIndicator({ operations }: { operations: Operation[] }) {
  const active = operations.filter((op) => op.status === "running");
  const recent = operations.slice(0, 6);
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-[#0f3460] bg-[#0a0a1a] px-3 py-1 text-xs text-gray-200 hover:bg-[#0f3460]/50">
        <span>{active.length > 0 ? "●" : "○"}</span>
        <span>{active.length > 0 ? `${active.length} active` : "transfers"}</span>
      </summary>
      <div className="absolute right-0 z-10 mt-2 w-96 rounded-xl border border-[#0f3460] bg-[#0a0a1a] p-3 shadow-xl">
        <div className="mb-2 text-xs uppercase tracking-wider text-gray-500">Uploads / downloads</div>
        {recent.length === 0 ? <div className="text-sm text-gray-500">No operations yet.</div> : recent.map((op) => {
          const elapsed = ((op.endedAt ?? Date.now()) - op.startedAt) / 1000;
          const speed = op.bytesDone && elapsed > 0 ? `${formatBytes(op.bytesDone / elapsed)}/s` : "—";
          return (
            <div key={op.id} className="border-t border-[#0f3460] py-2 first:border-t-0">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-gray-200">{op.label}</span>
                <span className={op.status === "failed" ? "text-red-300" : op.status === "done" ? "text-emerald-300" : "text-yellow-300"}>{op.status}</span>
              </div>
              <div className="mt-1 flex justify-between text-xs text-gray-500">
                <span>{op.kind}</span>
                <span>{formatBytes(op.bytesDone)} {op.bytesTotal ? `/ ${formatBytes(op.bytesTotal)}` : ""} · {speed}</span>
              </div>
              {op.message && <div className="mt-1 truncate text-xs text-gray-400">{op.message}</div>}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function ComponentTable({ files, title = "Internal MCDF files" }: { files: Array<ExtractedFileInfo | ComponentAvailability | ManifestMcdfFile>; title?: string }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <div className="overflow-hidden rounded-xl bg-[#16213e]">
      <div className="border-b border-[#0f3460] px-4 py-2 text-xs uppercase tracking-wider text-gray-400">{title} ({files.length})</div>
      <div className="max-h-[32rem] overflow-y-auto">
        {files.length === 0 && <p className="px-4 py-6 text-center text-sm text-gray-500">No internal files found.</p>}
        {files.map((file) => {
          const payloadHash = "payload_blake3" in file ? file.payload_blake3 : file.blake3;
          const mcdfHash = "mcdf_hash" in file ? file.mcdf_hash : file.hash;
          const length = file.length;
          const onlineStatus = "online_status" in file ? file.online_status : "local_only";
          const notes = "notes" in file ? file.notes : [];
          return (
            <div key={file.index} className="border-b border-[#0f3460] last:border-b-0">
              <button className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[#0f3460]/50" onClick={() => setExpanded(expanded === file.index ? null : file.index)}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="w-8 shrink-0 text-xs text-gray-500">#{file.index + 1}</span>
                  <div className="min-w-0">
                    {file.game_paths.length > 0 ? file.game_paths.map((p, pi) => <div key={pi} className="truncate font-mono text-sm text-gray-200" title={p}>{p}</div>) : <span className="text-sm italic text-gray-500">No path</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="rounded-full border border-[#0f3460] px-2 py-0.5 text-xs text-gray-300">{statusLabel(onlineStatus)}</span>
                  <span className="text-xs tabular-nums text-gray-500">{formatBytes(length)}</span>
                  <span className="text-sm text-gray-400">{expanded === file.index ? "▾" : "▸"}</span>
                </div>
              </button>
              {expanded === file.index && (
                <div className="space-y-1 border-t border-[#0f3460] bg-[#0a0a1a] px-4 py-3 font-mono text-xs text-gray-400">
                  {"payload_offset" in file && <div>payload offset: {file.payload_offset}</div>}
                  {"offset" in file && <div>payload offset: {file.offset}</div>}
                  <div>MCDF file hash: {mcdfHash || "—"}</div>
                  <div>BLAKE3 payload hash: {payloadHash}</div>
                  {"central_status" in file && <div>central status: {file.central_status}</div>}
                  {notes.map((note, index) => <div key={index}>note: {note}</div>)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MarketplacePanel({ addOperation, finishOperation }: { addOperation: (op: Omit<Operation, "id" | "startedAt" | "status">) => string; finishOperation: (id: string, patch: Partial<Operation>) => void }) {
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

  const cachedChunks = manifestStatus?.chunks.filter((chunk) => chunk.cached).length ?? 0;
  const onlineChunks = manifestStatus?.chunks.filter((chunk) => chunk.online_available).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl bg-[#16213e] p-5 lg:col-span-2">
          <div className="text-xs uppercase tracking-wider text-gray-500">Local-first marketplace</div>
          <h2 className="mt-2 text-2xl font-bold text-gray-100">MCDF packages are inspected before upload or rebuild.</h2>
          <p className="mt-3 text-sm leading-6 text-gray-300">An MCDF is a compiled package. The app now extracts the package metadata first, records every internal file/component in the manifest, then chunks the compiled MCDF for transport. The download/rebuild path is an action, not a main menu area.</p>
        </div>
        <div className="rounded-xl bg-[#16213e] p-5">
          <div className="text-xs uppercase tracking-wider text-gray-500">Actions</div>
          <button onClick={chooseManifest} className="mt-3 w-full rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white hover:bg-[#e94560]/80">Open manifest / rebuild…</button>
          <p className="mt-3 text-xs text-gray-500">Works without a server when the manifest contains direct chunk URLs or the chunks are already cached locally.</p>
        </div>
      </div>

      <ErrorBox error={error} />

      {manifest && (
        <div className="space-y-4">
          <div className="rounded-xl bg-[#16213e] p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-lg font-semibold text-gray-100">{manifest.title || manifest.original_filename}</div>
                <div className="text-sm text-gray-400">{manifest.description || "No description"}</div>
              </div>
              <button onClick={rebuild} className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white hover:bg-[#e94560]/80">Rebuild MCDF…</button>
            </div>
            <div className="mt-4 grid gap-3 text-sm md:grid-cols-5">
              <div><div className="text-gray-500">Archive</div><div className="font-mono text-gray-200">{manifest.archive_id}</div></div>
              <div><div className="text-gray-500">Size</div><div>{formatBytes(manifest.mcdf_size)}</div></div>
              <div><div className="text-gray-500">Chunks</div><div>{cachedChunks}/{manifest.chunks.length} cached · {onlineChunks} online</div></div>
              <div><div className="text-gray-500">Internal files</div><div>{manifest.mcdf_files?.length ?? 0}</div></div>
              <div><div className="text-gray-500">Hash</div><div className="font-mono" title={manifest.mcdf_hash_blake3}>{shortHash(manifest.mcdf_hash_blake3)}</div></div>
            </div>
          </div>
          {manifestStatus ? <ComponentTable files={manifestStatus.files} title="Internal files and online status" /> : <ComponentTable files={manifest.mcdf_files ?? []} />}
        </div>
      )}

      {rebuildResult && <SuccessBox><div className="font-semibold">MCDF rebuilt and verified</div><div className="mt-2 font-mono text-xs">{rebuildResult.output_path}</div></SuccessBox>}
    </div>
  );
}

function PreparePanel({ addOperation, finishOperation }: { addOperation: (op: Omit<Operation, "id" | "startedAt" | "status">) => string; finishOperation: (id: string, patch: Partial<Operation>) => void }) {
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
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Prepare MCDF</h2>
          <p className="text-sm text-gray-400">The MCDF is extracted first so the manifest knows every internal file/component before chunking the compiled package.</p>
        </div>
        <button onClick={chooseFile} className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white hover:bg-[#e94560]/80">Choose MCDF…</button>
      </div>
      {selectedPath && <p className="truncate font-mono text-xs text-gray-500" title={selectedPath}>{selectedPath}</p>}
      {loading && <div className="flex justify-center py-6"><div className="h-8 w-8 animate-spin rounded-full border-2 border-[#e94560] border-t-transparent" /></div>}
      <ErrorBox error={error} />
      {info && (
        <div className="rounded-xl bg-[#16213e] p-4 space-y-3">
          <div className="text-xs uppercase tracking-wider text-gray-500">Extracted package</div>
          <p className="text-sm text-gray-300">{info.description || "No description in this archive."}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Marketplace title, defaults to filename" className="rounded-lg border border-[#0f3460] bg-[#0a0a1a] px-3 py-2 text-sm text-gray-100 outline-none focus:border-[#e94560]" />
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Marketplace description" className="rounded-lg border border-[#0f3460] bg-[#0a0a1a] px-3 py-2 text-sm text-gray-100 outline-none focus:border-[#e94560]" />
          </div>
          <button disabled={loading || !selectedPath} onClick={createManifest} className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">Create manifest + local chunks</button>
        </div>
      )}
      {files.length > 0 && <ComponentTable files={files} title="Extracted internal files" />}
      {result && <SuccessBox><div className="font-semibold">Manifest created after extraction</div><div className="mt-2 grid gap-1 font-mono text-xs"><div>{result.manifest_path}</div><div>components: {result.manifest.mcdf_files.length}</div><div>chunks: {result.manifest.chunks.length}</div></div></SuccessBox>}
      {status && <ComponentTable files={status.files} title="Component online/cache status" />}
    </div>
  );
}

function OnlineLibraryPanel({ addOperation, finishOperation }: { addOperation: (op: Omit<Operation, "id" | "startedAt" | "status">) => string; finishOperation: (id: string, patch: Partial<Operation>) => void }) {
  const [locations, setLocations] = useState<OnlineLocation[]>([]);
  const [scanResults, setScanResults] = useState<OnlineLocationScanResult[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [sourceType, setSourceType] = useState<OnlineLocationType>("generic_json_index");
  const [googleApiKey, setGoogleApiKey] = useState("");
  const [lastManifest, setLastManifest] = useState<ManifestBuildResult | null>(null);
  const [lastStatus, setLastStatus] = useState<ManifestStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { invoke<OnlineLocation[]>("list_online_locations").then(setLocations).catch((e) => setError(String(e))); }, []);

  const addLocation = async () => {
    setError(null);
    try {
      const added = await invoke<OnlineLocation>("add_online_location", { name, url, sourceType, googleApiKey: googleApiKey.trim() || null });
      setLocations((current) => [...current.filter((item) => item.id !== added.id), added]);
      setName(""); setUrl(""); setGoogleApiKey("");
    } catch (e) { setError(String(e)); }
  };
  const removeLocation = async (id: string) => {
    try { setLocations(await invoke<OnlineLocation[]>("remove_online_location", { id })); setScanResults((r) => r.filter((x) => x.source.id !== id)); }
    catch (e) { setError(String(e)); }
  };
  const scanAll = async () => {
    const opId = addOperation({ kind: "scan", label: "Scan online locations" });
    setLoading(true); setError(null); setLastManifest(null); setLastStatus(null);
    try {
      const results = await invoke<OnlineLocationScanResult[]>("scan_online_locations");
      setScanResults(results);
      finishOperation(opId, { status: "done", message: `${results.reduce((n, r) => n + r.entries.length, 0)} entries` });
    } catch (e) { finishOperation(opId, { status: "failed", message: String(e) }); setError(String(e)); }
    finally { setLoading(false); }
  };
  const prepareForCentral = async (entry: OnlineLibraryEntry) => {
    const opId = addOperation({ kind: "download", label: `Download and inspect ${entry.mcdf_file_name}` });
    setError(null); setLastManifest(null); setLastStatus(null);
    try {
      const result = await invoke<ManifestBuildResult>("create_manifest_from_online_entry", { request: { mcdf_url: entry.mcdf_url, title: entry.name, description: `Imported from ${entry.source_name}`, image_url: entry.image_url ?? null } });
      setLastManifest(result);
      const status = await invoke<ManifestStatus>("inspect_manifest_status", { path: result.manifest_path });
      setLastStatus(status);
      finishOperation(opId, { status: "done", bytesDone: result.manifest.mcdf_size, message: `${result.manifest.mcdf_files.length} internal files` });
    } catch (e) { finishOperation(opId, { status: "failed", message: String(e) }); setError(String(e)); }
  };

  const entryCount = scanResults.reduce((total, result) => total + result.entries.length, 0);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">Online Library Locations</h2>
        <p className="text-sm text-gray-400">External locations are discovery sources only. Files should be paired as <span className="font-mono text-gray-200">name.mcdf</span> plus <span className="font-mono text-gray-200">name.png/jpg/webp</span>. When selected, the MCDF is downloaded, extracted, and checked before central ingestion.</p>
      </div>
      <div className="rounded-xl bg-[#16213e] p-4 space-y-3">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_220px]">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Library name" className="rounded-lg border border-[#0f3460] bg-[#0a0a1a] px-3 py-2 text-gray-100 outline-none focus:border-[#e94560]" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Google Drive folder URL or index.json URL" className="rounded-lg border border-[#0f3460] bg-[#0a0a1a] px-3 py-2 text-gray-100 outline-none focus:border-[#e94560]" />
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value as OnlineLocationType)} className="rounded-lg border border-[#0f3460] bg-[#0a0a1a] px-3 py-2 text-gray-100 outline-none focus:border-[#e94560]"><option value="generic_json_index">Generic JSON index</option><option value="google_drive_folder">Google Drive folder</option></select>
        </div>
        {sourceType === "google_drive_folder" && <input value={googleApiKey} onChange={(e) => setGoogleApiKey(e.target.value)} placeholder="Google Drive API key" className="w-full rounded-lg border border-[#0f3460] bg-[#0a0a1a] px-3 py-2 text-gray-100 outline-none focus:border-[#e94560]" />}
        <div className="flex flex-wrap gap-2">
          <button disabled={!name.trim() || !url.trim()} onClick={addLocation} className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">Add location</button>
          <button disabled={locations.length === 0 || loading} onClick={scanAll} className="rounded-lg border border-[#0f3460] px-4 py-2 text-sm font-medium text-gray-200 hover:bg-[#0f3460]/50 disabled:cursor-not-allowed disabled:opacity-50">{loading ? "Scanning…" : "Scan online library"}</button>
        </div>
      </div>
      <ErrorBox error={error} />
      {locations.length > 0 && <div className="rounded-xl bg-[#16213e] p-4"><div className="mb-2 text-xs uppercase tracking-wider text-gray-500">Configured locations</div>{locations.map((location) => <div key={location.id} className="flex items-center justify-between border-t border-[#0f3460] py-2 first:border-t-0"><div><div className="text-sm text-gray-100">{location.name}</div><div className="truncate font-mono text-xs text-gray-500">{location.url}</div></div><button onClick={() => removeLocation(location.id)} className="text-xs text-red-300 hover:text-red-200">remove</button></div>)}</div>}
      {scanResults.length > 0 && <div className="text-sm text-gray-400">Found {entryCount} complete MCDF/image pairs.</div>}
      {scanResults.map((result) => <div key={result.source.id} className="space-y-3 rounded-xl bg-[#16213e] p-4"><div className="flex items-center justify-between"><div><div className="font-semibold text-gray-100">{result.source.name}</div><div className="text-xs text-gray-500">{result.entries.length} entries · {result.warnings.length} warnings</div></div></div>{result.warnings.map((w, i) => <div key={i} className="rounded bg-yellow-950/40 p-2 text-xs text-yellow-200">{w}</div>)}<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{result.entries.map((entry) => <div key={`${entry.source_id}-${entry.mcdf_url}`} className="overflow-hidden rounded-lg border border-[#0f3460] bg-[#0a0a1a]">{entry.image_url && <img src={entry.image_url} alt={entry.name} className="h-40 w-full object-cover" />}<div className="space-y-2 p-3"><div className="font-semibold text-gray-100">{entry.name}</div><div className="font-mono text-xs text-gray-500">{entry.mcdf_file_name}</div><button onClick={() => prepareForCentral(entry)} className="w-full rounded-lg bg-[#e94560] px-3 py-2 text-sm font-medium text-white hover:bg-[#e94560]/80">Download, extract, prepare</button></div></div>)}</div></div>)}
      {lastManifest && <SuccessBox><div className="font-semibold">Online MCDF downloaded and extracted</div><div className="mt-2 font-mono text-xs">{lastManifest.manifest_path}</div></SuccessBox>}
      {lastStatus && <ComponentTable files={lastStatus.files} title="Online MCDF internal files and status" />}
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
    setFilePath(selected as string); setLoading(true); setError(null);
    try {
      const [mcdf, fileInfos] = await Promise.all([invoke<MCDFInfo>("scan_mcdf", { path: selected }), invoke<ExtractedFileInfo[]>("inspect_mcdf_files", { path: selected })]);
      setInfo(mcdf); setFiles(fileInfos);
    } catch (e) { setInfo(null); setFiles([]); setError(String(e)); }
    finally { setLoading(false); }
  };
  return <div className="space-y-4"><div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold text-gray-100">Inspect MCDF</h2><p className="text-sm text-gray-400">Extract package metadata and internal file details without creating a vault manifest.</p></div><button onClick={handleOpen} className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white hover:bg-[#e94560]/80">Choose File…</button></div>{filePath && <p className="truncate font-mono text-xs text-gray-500" title={filePath}>{filePath}</p>}{loading && <div className="flex justify-center py-12"><div className="h-8 w-8 animate-spin rounded-full border-2 border-[#e94560] border-t-transparent" /></div>}<ErrorBox error={error} />{info && !loading && <><div className="rounded-xl bg-[#16213e] p-4"><div className="text-xs uppercase tracking-wider text-gray-500">Description</div><p className="mt-2 text-sm text-gray-300">{info.description || "No description in this archive."}</p></div><ComponentTable files={files} title="Extracted internal files" /></>}{!info && !loading && !error && <div className="rounded-xl bg-[#16213e] p-8 text-center text-gray-500">Select an MCDF file to inspect its compiled contents.</div>}</div>;
}

function SettingsPanel() {
  const [cacheDir, setCacheDir] = useState("loading…");
  useEffect(() => { invoke<string>("get_cache_dir").then(setCacheDir).catch((e) => setCacheDir(String(e))); }, []);
  return <div className="space-y-4"><div><h2 className="text-lg font-semibold text-gray-100">Settings</h2><p className="text-sm text-gray-400">Current local paths and build details.</p></div><div className="rounded-xl bg-[#16213e] p-4"><div className="text-xs uppercase tracking-wider text-gray-500">Local cache directory</div><div className="mt-2 break-all font-mono text-sm text-gray-200">{cacheDir}</div><p className="mt-3 text-sm text-gray-400">Override with MCDF_MARKETPLACE_HOME when testing builds or CI behavior.</p></div></div>;
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
  return (
    <div className="min-h-screen bg-[#1a1a2e] text-gray-100">
      <header className="flex items-center justify-between border-b border-[#0f3460] bg-[#16213e] px-6 py-4">
        <div className="flex items-center gap-3"><h1 className="text-xl font-bold text-[#e94560]">MCDF Marketplace</h1><span className="text-xs text-gray-400">v{appVersion}</span></div>
        <div className="flex items-center gap-3"><ActivityIndicator operations={operations} /><div className="rounded-full bg-[#e94560] px-3 py-1 text-xs font-bold text-white">local-first</div></div>
      </header>
      <nav className="border-b border-[#0f3460] bg-[#16213e] px-6"><div className="flex gap-1 overflow-x-auto">{tabs.map((tab) => <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`whitespace-nowrap px-4 py-3 text-sm font-medium transition-colors ${activeTab === tab.id ? "border-b-2 border-[#e94560] text-[#e94560]" : "text-gray-400 hover:text-gray-200"}`}>{tab.label}</button>)}</div></nav>
      <main className="p-6">
        {activeTab === "marketplace" && <MarketplacePanel {...panelProps} />}
        {activeTab === "library" && <OnlineLibraryPanel {...panelProps} />}
        {activeTab === "prepare" && <PreparePanel {...panelProps} />}
        {activeTab === "inspect" && <InspectPanel />}
        {activeTab === "settings" && <SettingsPanel />}
      </main>
    </div>
  );
}

export default App;
