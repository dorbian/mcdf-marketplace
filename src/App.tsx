import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

type Tab = "marketplace" | "library" | "upload" | "download" | "inspect" | "settings";

type FileEntry = {
  game_paths: string[];
  length: number;
  hash: string;
};

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
  discord_channel_id?: string | null;
  discord_message_id?: string | null;
  discord_attachment_id?: string | null;
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
  parity: VaultChunk[];
  source: {
    server_base_url?: string | null;
    index_url?: string | null;
    online_source_url?: string | null;
    thumbnail_url?: string | null;
  };
};

type ManifestBuildResult = {
  manifest: VaultManifest;
  manifest_path: string;
  cache_dir: string;
};

type RebuildResult = {
  output_path: string;
  bytes_written: number;
  chunks_used: number;
  downloaded_chunks: number;
  verified_blake3: string;
};

type OnlineLocationType = "generic_json_index" | "google_drive_folder";

type OnlineLocation = {
  id: string;
  name: string;
  source_type: OnlineLocationType;
  url: string;
  google_api_key?: string | null;
  enabled: boolean;
};

type OnlineFileRef = {
  name: string;
  url: string;
};

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
  { id: "upload", label: "Prepare Upload" },
  { id: "download", label: "Download / Rebuild" },
  { id: "inspect", label: "Inspect MCDF" },
  { id: "settings", label: "Settings" },
];

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return "—";
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
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-lg border border-red-700 bg-red-950/40 p-4 text-sm text-red-200">{error}</div>;
}

function SuccessBox({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-emerald-700 bg-emerald-950/30 p-4 text-sm text-emerald-200">{children}</div>;
}


function OnlineLibraryPanel() {
  const [locations, setLocations] = useState<OnlineLocation[]>([]);
  const [scanResults, setScanResults] = useState<OnlineLocationScanResult[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [sourceType, setSourceType] = useState<OnlineLocationType>("generic_json_index");
  const [googleApiKey, setGoogleApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [preparingUrl, setPreparingUrl] = useState<string | null>(null);
  const [lastManifest, setLastManifest] = useState<ManifestBuildResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLocations = async () => {
    try {
      const loaded = await invoke<OnlineLocation[]>("list_online_locations");
      setLocations(loaded);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    loadLocations();
  }, []);

  const addLocation = async () => {
    setError(null);
    try {
      const added = await invoke<OnlineLocation>("add_online_location", {
        name,
        url,
        sourceType,
        googleApiKey: googleApiKey.trim() || null,
      });
      setLocations((current) => [...current.filter((item) => item.id !== added.id), added]);
      setName("");
      setUrl("");
      setGoogleApiKey("");
    } catch (e) {
      setError(String(e));
    }
  };

  const removeLocation = async (id: string) => {
    setError(null);
    try {
      const updated = await invoke<OnlineLocation[]>("remove_online_location", { id });
      setLocations(updated);
      setScanResults((current) => current.filter((result) => result.source.id !== id));
    } catch (e) {
      setError(String(e));
    }
  };

  const scanAll = async () => {
    setLoading(true);
    setError(null);
    setLastManifest(null);
    try {
      const results = await invoke<OnlineLocationScanResult[]>("scan_online_locations");
      setScanResults(results);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const prepareForCentral = async (entry: OnlineLibraryEntry) => {
    setPreparingUrl(entry.mcdf_url);
    setError(null);
    setLastManifest(null);
    try {
      const result = await invoke<ManifestBuildResult>("create_manifest_from_online_entry", {
        request: {
          mcdf_url: entry.mcdf_url,
          title: entry.name,
          description: `Imported from ${entry.source_name}`,
          image_url: entry.image_url ?? null,
        },
      });
      setLastManifest(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setPreparingUrl(null);
    }
  };

  const entryCount = scanResults.reduce((total, result) => total + result.entries.length, 0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">Online Library Locations</h2>
        <p className="text-sm text-gray-400">
          Add external locations such as public Google Drive folders or JSON file indexes. These are discovery sources only: they are not chunk storage. Each visible item must have a matching <span className="font-mono text-gray-200">name.mcdf</span> and <span className="font-mono text-gray-200">name.png/jpg/webp</span>.
        </p>
      </div>

      <div className="rounded-xl bg-[#16213e] p-4 space-y-3">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_220px]">
          <label className="block text-sm">
            <span className="mb-1 block text-gray-400">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Artist Drive / Community Drop" className="w-full rounded-lg border border-[#0f3460] bg-[#0a0a1a] px-3 py-2 text-gray-100 outline-none focus:border-[#e94560]" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-gray-400">Location URL</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Google Drive folder URL or index.json URL" className="w-full rounded-lg border border-[#0f3460] bg-[#0a0a1a] px-3 py-2 text-gray-100 outline-none focus:border-[#e94560]" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-gray-400">Type</span>
            <select value={sourceType} onChange={(e) => setSourceType(e.target.value as OnlineLocationType)} className="w-full rounded-lg border border-[#0f3460] bg-[#0a0a1a] px-3 py-2 text-gray-100 outline-none focus:border-[#e94560]">
              <option value="generic_json_index">Generic JSON index</option>
              <option value="google_drive_folder">Google Drive folder</option>
            </select>
          </label>
        </div>
        {sourceType === "google_drive_folder" && (
          <label className="block text-sm">
            <span className="mb-1 block text-gray-400">Google Drive API key</span>
            <input value={googleApiKey} onChange={(e) => setGoogleApiKey(e.target.value)} placeholder="Optional here, or set GOOGLE_DRIVE_API_KEY while testing" className="w-full rounded-lg border border-[#0f3460] bg-[#0a0a1a] px-3 py-2 text-gray-100 outline-none focus:border-[#e94560]" />
            <span className="mt-1 block text-xs text-gray-500">Public Drive folders cannot be listed reliably by scraping. The app uses the official Drive files API for serverless listing.</span>
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          <button disabled={!name.trim() || !url.trim()} onClick={addLocation} className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">Add location</button>
          <button disabled={locations.length === 0 || loading} onClick={scanAll} className="rounded-lg border border-[#0f3460] px-4 py-2 text-sm font-medium text-gray-200 hover:bg-[#0f3460]/50 disabled:cursor-not-allowed disabled:opacity-50">{loading ? "Scanning…" : "Scan online library"}</button>
        </div>
      </div>

      <ErrorBox error={error} />

      {lastManifest && (
        <SuccessBox>
          <div className="font-semibold">Online MCDF prepared for central ingestion</div>
          <div className="mt-2 grid gap-1 font-mono text-xs text-emerald-100/90">
            <div>manifest: {lastManifest.manifest_path}</div>
            <div>archive_id: {lastManifest.manifest.archive_id}</div>
            <div>chunks: {lastManifest.manifest.chunks.length}</div>
            <div>source: {lastManifest.manifest.source.online_source_url || "—"}</div>
            <div>image: {lastManifest.manifest.source.thumbnail_url || "—"}</div>
          </div>
        </SuccessBox>
      )}

      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="rounded-xl bg-[#16213e] p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-gray-100">Locations</div>
            <div className="text-xs text-gray-500">{locations.length}</div>
          </div>
          {locations.length === 0 && <p className="text-sm text-gray-500">No online locations added yet.</p>}
          <div className="space-y-2">
            {locations.map((location) => (
              <div key={location.id} className="rounded-lg border border-[#0f3460] bg-[#0a0a1a] p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-gray-100">{location.name}</div>
                    <div className="text-xs text-gray-500">{location.source_type === "google_drive_folder" ? "Google Drive" : "JSON index"}</div>
                  </div>
                  <button onClick={() => removeLocation(location.id)} className="text-xs text-gray-500 hover:text-red-300">remove</button>
                </div>
                <div className="mt-2 truncate font-mono text-xs text-gray-500" title={location.url}>{location.url}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl bg-[#16213e] p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-gray-100">Discovered entries</div>
                <div className="text-xs text-gray-500">{entryCount} complete MCDF/image pairs</div>
              </div>
            </div>
          </div>

          {scanResults.map((result) => (
            <div key={result.source.id} className="rounded-xl bg-[#16213e] p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-gray-100">{result.source.name}</div>
                  <div className="text-xs text-gray-500">{result.source.source_type === "google_drive_folder" ? "Google Drive" : "JSON index"}</div>
                </div>
                <div className="text-xs text-gray-500">{result.entries.length} pairs</div>
              </div>

              {result.warnings.length > 0 && (
                <div className="mb-3 rounded-lg border border-yellow-700 bg-yellow-950/20 p-3 text-xs text-yellow-100">
                  {result.warnings.map((warning, index) => <div key={index}>{warning}</div>)}
                  {result.orphan_mcdf_files.length > 0 && <div className="mt-1">Unpaired MCDF files: {result.orphan_mcdf_files.map((file) => file.name).join(", ")}</div>}
                  {result.orphan_image_files.length > 0 && <div className="mt-1">Unpaired images: {result.orphan_image_files.map((file) => file.name).join(", ")}</div>}
                </div>
              )}

              {result.entries.length === 0 && <p className="text-sm text-gray-500">No complete pairs found.</p>}
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {result.entries.map((entry) => (
                  <div key={`${entry.source_id}:${entry.mcdf_url}`} className="overflow-hidden rounded-lg border border-[#0f3460] bg-[#0a0a1a]">
                    {entry.image_url ? <img src={entry.image_url} alt={entry.name} className="h-36 w-full object-cover" /> : <div className="flex h-36 items-center justify-center bg-[#101828] text-xs text-gray-600">No image</div>}
                    <div className="space-y-2 p-3">
                      <div className="truncate text-sm font-semibold text-gray-100" title={entry.name}>{entry.name}</div>
                      <div className="truncate font-mono text-xs text-gray-500" title={entry.mcdf_file_name}>{entry.mcdf_file_name}</div>
                      <button disabled={preparingUrl === entry.mcdf_url} onClick={() => prepareForCentral(entry)} className="w-full rounded-lg bg-[#e94560] px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">
                        {preparingUrl === entry.mcdf_url ? "Preparing…" : "Prepare for central system"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MarketplacePanel() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">Marketplace</h2>
        <p className="text-sm text-gray-400">
          The app is now prepared around portable manifests and a local content-addressed chunk cache. A server can add search, auth, moderation, and upload coordination later, but direct manifest downloads do not require it.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl bg-[#16213e] p-4 shadow">
          <div className="text-sm font-semibold text-gray-100">1. Prepare</div>
          <p className="mt-2 text-sm text-gray-400">Create a manifest from an MCDF. Chunks are stored locally by BLAKE3 hash.</p>
        </div>
        <div className="rounded-xl bg-[#16213e] p-4 shadow">
          <div className="text-sm font-semibold text-gray-100">2. Publish later</div>
          <p className="mt-2 text-sm text-gray-400">The manifest is the handoff format for a server, Discord storage worker, or GitHub index.</p>
        </div>
        <div className="rounded-xl bg-[#16213e] p-4 shadow">
          <div className="text-sm font-semibold text-gray-100">3. Rebuild offline-first</div>
          <p className="mt-2 text-sm text-gray-400">Rebuild from local chunks first. Missing chunks can be pulled from direct attachment URLs in the manifest.</p>
        </div>
      </div>
      <div className="rounded-xl bg-[#16213e] p-5">
        <div className="text-xs uppercase tracking-wider text-gray-500">Serverless download path</div>
        <p className="mt-2 text-sm text-gray-300">
          A user only needs a manifest JSON. If all chunks are cached locally, rebuild is fully offline. If a chunk is missing and the manifest contains an <span className="font-mono text-gray-100">attachment_url</span>, the app downloads that chunk directly and verifies its hash before writing the MCDF.
        </p>
      </div>
    </div>
  );
}

function PrepareUploadPanel() {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [result, setResult] = useState<ManifestBuildResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseFile = async () => {
    const selected = await open({ multiple: false, filters: [{ name: "MCDF", extensions: ["mcdf"] }] });
    if (!selected) return;
    setSelectedPath(selected as string);
    setResult(null);
    setError(null);
  };

  const createManifest = async () => {
    if (!selectedPath) return;
    setLoading(true);
    setError(null);
    try {
      const built = await invoke<ManifestBuildResult>("create_local_manifest", {
        path: selectedPath,
        title: title.trim() || null,
        description: description.trim() || null,
        chunkSize: null,
      });
      setResult(built);
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Prepare Upload</h2>
          <p className="text-sm text-gray-400">Create a vault manifest and local BLAKE3 chunk cache from an MCDF.</p>
        </div>
        <button onClick={chooseFile} className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white hover:bg-[#e94560]/80">Choose MCDF…</button>
      </div>

      {selectedPath && <p className="truncate font-mono text-xs text-gray-500" title={selectedPath}>{selectedPath}</p>}

      <div className="rounded-xl bg-[#16213e] p-4 space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-gray-400">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the MCDF filename" className="w-full rounded-lg border border-[#0f3460] bg-[#0a0a1a] px-3 py-2 text-gray-100 outline-none focus:border-[#e94560]" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-gray-400">Description</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Optional marketplace description" className="w-full rounded-lg border border-[#0f3460] bg-[#0a0a1a] px-3 py-2 text-gray-100 outline-none focus:border-[#e94560]" />
        </label>
        <button disabled={!selectedPath || loading} onClick={createManifest} className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">
          {loading ? "Creating manifest…" : "Create Local Manifest"}
        </button>
      </div>

      <ErrorBox error={error} />

      {result && (
        <SuccessBox>
          <div className="font-semibold">Manifest created</div>
          <div className="mt-2 grid gap-1 font-mono text-xs text-emerald-100/90">
            <div>archive_id: {result.manifest.archive_id}</div>
            <div>manifest: {result.manifest_path}</div>
            <div>cache: {result.cache_dir}</div>
            <div>chunks: {result.manifest.chunks.length}</div>
            <div>MCDF: {formatBytes(result.manifest.mcdf_size)} / {shortHash(result.manifest.mcdf_hash_blake3)}</div>
          </div>
        </SuccessBox>
      )}

      {result && (
        <div className="rounded-xl bg-[#16213e] p-4">
          <div className="mb-2 text-xs uppercase tracking-wider text-gray-500">Manifest preview</div>
          <pre className="max-h-80 overflow-auto rounded-lg bg-[#0a0a1a] p-3 text-xs text-gray-300">{JSON.stringify(result.manifest, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function DownloadPanel() {
  const [manifestPath, setManifestPath] = useState<string | null>(null);
  const [manifest, setManifest] = useState<VaultManifest | null>(null);
  const [result, setResult] = useState<RebuildResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseManifest = async () => {
    const selected = await open({ multiple: false, filters: [{ name: "Vault Manifest", extensions: ["json"] }] });
    if (!selected) return;
    setManifestPath(selected as string);
    setResult(null);
    setError(null);
    try {
      const loaded = await invoke<VaultManifest>("read_manifest", { path: selected });
      setManifest(loaded);
    } catch (e) {
      setManifest(null);
      setError(String(e));
    }
  };

  const rebuild = async () => {
    if (!manifestPath || !manifest) return;
    setLoading(true);
    setError(null);
    try {
      const selectedOutput = await save({
        defaultPath: manifest.original_filename || "rebuilt.mcdf",
        filters: [{ name: "MCDF", extensions: ["mcdf"] }],
      });
      if (!selectedOutput) return;
      const rebuilt = await invoke<RebuildResult>("rebuild_from_manifest", {
        manifestPath,
        outputPath: selectedOutput,
      });
      setResult(rebuilt);
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Download / Rebuild</h2>
          <p className="text-sm text-gray-400">Rebuild an MCDF from a vault manifest. Local chunks are used first; missing chunks can download from direct URLs.</p>
        </div>
        <button onClick={chooseManifest} className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white hover:bg-[#e94560]/80">Choose Manifest…</button>
      </div>

      {manifestPath && <p className="truncate font-mono text-xs text-gray-500" title={manifestPath}>{manifestPath}</p>}
      <ErrorBox error={error} />

      {manifest && (
        <div className="rounded-xl bg-[#16213e] p-4 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-lg font-semibold text-gray-100">{manifest.title || manifest.original_filename}</div>
              <div className="text-sm text-gray-400">{manifest.description || "No description"}</div>
            </div>
            <button disabled={loading} onClick={rebuild} className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">
              {loading ? "Rebuilding…" : "Rebuild MCDF…"}
            </button>
          </div>
          <div className="grid gap-3 text-sm md:grid-cols-4">
            <div><div className="text-gray-500">Archive</div><div className="font-mono text-gray-200">{manifest.archive_id}</div></div>
            <div><div className="text-gray-500">Size</div><div className="text-gray-200">{formatBytes(manifest.mcdf_size)}</div></div>
            <div><div className="text-gray-500">Chunks</div><div className="text-gray-200">{manifest.chunks.length}</div></div>
            <div><div className="text-gray-500">Hash</div><div className="font-mono text-gray-200" title={manifest.mcdf_hash_blake3}>{shortHash(manifest.mcdf_hash_blake3)}</div></div>
          </div>
        </div>
      )}

      {result && (
        <SuccessBox>
          <div className="font-semibold">MCDF rebuilt and verified</div>
          <div className="mt-2 grid gap-1 font-mono text-xs text-emerald-100/90">
            <div>output: {result.output_path}</div>
            <div>bytes: {result.bytes_written}</div>
            <div>chunks used: {result.chunks_used}</div>
            <div>downloaded chunks: {result.downloaded_chunks}</div>
            <div>verified BLAKE3: {result.verified_blake3}</div>
          </div>
        </SuccessBox>
      )}
    </div>
  );
}

function InspectMCDFPanel() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [mcdfInfo, setMcdfInfo] = useState<MCDFInfo | null>(null);
  const [files, setFiles] = useState<ExtractedFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<number | null>(null);

  const handleOpen = async () => {
    try {
      const selected = await open({ multiple: false, filters: [{ name: "MCDF", extensions: ["mcdf"] }] });
      if (!selected) return;
      setFilePath(selected as string);
      setLoading(true);
      setError(null);
      const [info, fileInfos] = await Promise.all([
        invoke<MCDFInfo>("scan_mcdf", { path: selected }),
        invoke<ExtractedFileInfo[]>("inspect_mcdf_files", { path: selected }),
      ]);
      setMcdfInfo(info);
      setFiles(fileInfos);
    } catch (e) {
      setError(String(e));
      setMcdfInfo(null);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Inspect MCDF</h2>
          <p className="text-sm text-gray-400">Read metadata and file layout without sending raw file bytes to the UI.</p>
        </div>
        <button onClick={handleOpen} className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white hover:bg-[#e94560]/80">Choose File…</button>
      </div>

      {filePath && <p className="truncate font-mono text-xs text-gray-500" title={filePath}>{filePath}</p>}
      {loading && <div className="flex justify-center py-12"><div className="h-8 w-8 animate-spin rounded-full border-2 border-[#e94560] border-t-transparent" /></div>}
      <ErrorBox error={error} />

      {mcdfInfo && !loading && (
        <div className="space-y-3">
          <div className="rounded-xl bg-[#16213e] p-4">
            <div className="text-xs uppercase tracking-wider text-gray-500">Description</div>
            <p className="mt-2 text-sm text-gray-300">{mcdfInfo.description || "No description in this archive."}</p>
          </div>

          <div className="overflow-hidden rounded-xl bg-[#16213e]">
            <div className="border-b border-[#0f3460] px-4 py-2 text-xs uppercase tracking-wider text-gray-400">Files ({files.length})</div>
            <div className="max-h-96 overflow-y-auto">
              {files.length === 0 && <p className="px-4 py-6 text-center text-sm text-gray-500">No files in this archive.</p>}
              {files.map((file) => (
                <div key={file.index} className="border-b border-[#0f3460] last:border-b-0">
                  <button className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[#0f3460]/50" onClick={() => setExpandedFile(expandedFile === file.index ? null : file.index)}>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-8 shrink-0 text-xs text-gray-500">#{file.index + 1}</span>
                      <div className="min-w-0">
                        {file.game_paths.length > 0 ? file.game_paths.map((p, pi) => <div key={pi} className="truncate font-mono text-sm text-gray-200" title={p}>{p}</div>) : <span className="text-sm italic text-gray-500">No path</span>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-xs tabular-nums text-gray-500">{formatBytes(file.length)}</span>
                      <span className="text-sm text-gray-400">{expandedFile === file.index ? "▾" : "▸"}</span>
                    </div>
                  </button>
                  {expandedFile === file.index && (
                    <div className="space-y-1 border-t border-[#0f3460] bg-[#0a0a1a] px-4 py-3 font-mono text-xs text-gray-400">
                      <div>offset: {file.offset}</div>
                      <div>MCDF file hash: {file.hash || "—"}</div>
                      <div>BLAKE3 payload hash: {file.blake3}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {(mcdfInfo.glamourer_data || mcdfInfo.customize_plus_data || mcdfInfo.manipulation_data) && (
            <details className="rounded-xl bg-[#16213e] p-4">
              <summary className="cursor-pointer text-sm font-semibold text-gray-200">Advanced plugin data</summary>
              <div className="mt-3 space-y-3">
                {mcdfInfo.glamourer_data && <pre className="max-h-40 overflow-auto rounded-lg bg-[#0a0a1a] p-3 text-xs text-gray-400">{mcdfInfo.glamourer_data}</pre>}
                {mcdfInfo.customize_plus_data && <pre className="max-h-40 overflow-auto rounded-lg bg-[#0a0a1a] p-3 text-xs text-gray-400">{mcdfInfo.customize_plus_data}</pre>}
                {mcdfInfo.manipulation_data && <pre className="max-h-40 overflow-auto rounded-lg bg-[#0a0a1a] p-3 text-xs text-gray-400">{mcdfInfo.manipulation_data}</pre>}
              </div>
            </details>
          )}
        </div>
      )}

      {!mcdfInfo && !loading && !error && <div className="rounded-xl bg-[#16213e] p-8 text-center text-gray-500">Select an MCDF file to inspect its contents.</div>}
    </div>
  );
}

function SettingsPanel() {
  const [cacheDir, setCacheDir] = useState("loading…");
  useEffect(() => {
    invoke<string>("get_cache_dir").then(setCacheDir).catch((e) => setCacheDir(String(e)));
  }, []);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">Settings</h2>
        <p className="text-sm text-gray-400">Current local paths and build details.</p>
      </div>
      <div className="rounded-xl bg-[#16213e] p-4">
        <div className="text-xs uppercase tracking-wider text-gray-500">Local cache directory</div>
        <div className="mt-2 break-all font-mono text-sm text-gray-200">{cacheDir}</div>
        <p className="mt-3 text-sm text-gray-400">Override with MCDF_MARKETPLACE_HOME when testing builds or CI behavior.</p>
      </div>
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("marketplace");
  const [appVersion, setAppVersion] = useState<string>("loading…");

  useEffect(() => {
    invoke<string>("get_app_version").then(setAppVersion).catch(() => setAppVersion("unknown"));
  }, []);

  return (
    <div className="min-h-screen bg-[#1a1a2e] text-gray-100">
      <header className="flex items-center justify-between border-b border-[#0f3460] bg-[#16213e] px-6 py-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-[#e94560]">MCDF Marketplace</h1>
          <span className="text-xs text-gray-400">v{appVersion}</span>
        </div>
        <div className="rounded-full bg-[#e94560] px-3 py-1 text-xs font-bold text-white">local-first</div>
      </header>

      <nav className="border-b border-[#0f3460] bg-[#16213e] px-6">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`whitespace-nowrap px-4 py-3 text-sm font-medium transition-colors ${activeTab === tab.id ? "border-b-2 border-[#e94560] text-[#e94560]" : "text-gray-400 hover:text-gray-200"}`}>
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="p-6">
        {activeTab === "marketplace" && <MarketplacePanel />}
        {activeTab === "library" && <OnlineLibraryPanel />}
        {activeTab === "upload" && <PrepareUploadPanel />}
        {activeTab === "download" && <DownloadPanel />}
        {activeTab === "inspect" && <InspectMCDFPanel />}
        {activeTab === "settings" && <SettingsPanel />}
      </main>
    </div>
  );
}

export default App;
