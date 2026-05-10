import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

// Simple tab-based navigation placeholder
type Tab = "browse" | "upload" | "download" | "open";

// --- Open MCDF Panel ---
type FileEntry = {
  game_paths: string[];
  data: number[];
  hash: string;
};

type MCDFInfo = {
  description: string;
  glamourer_data: string;
  customize_plus_data: string;
  manipulation_data: string;
  files: FileEntry[];
};


function OpenMCDFPanel() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [mcdfInfo, setMcdfInfo] = useState<MCDFInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [expandedFile, setExpandedFile] = useState<number | null>(null);

  const handleOpen = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "MCDF", extensions: ["mcdf"] }],
      });
      if (!selected) return;
      setFilePath(selected as string);
      setLoading(true);
      setError(null);
      const info = await invoke<MCDFInfo>("scan_mcdf", { path: selected });
      setMcdfInfo(info);
    } catch (e) {
      setError(String(e));
      setMcdfInfo(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-200">Open MCDF File</h2>
        <button
          onClick={handleOpen}
          className="px-4 py-2 bg-[#e94560] hover:bg-[#e94560]/80 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Choose File…
        </button>
      </div>

      {filePath && (
        <p className="text-xs text-gray-500 font-mono truncate" title={filePath}>
          {filePath}
        </p>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-2 border-[#e94560] border-t-transparent rounded-full" />
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {mcdfInfo && !loading && (
        <div className="space-y-3">
          {/* Description */}
          {mcdfInfo.description && (
            <div className="bg-[#16213e] rounded-lg p-4">
              <p className="text-sm text-gray-300">{mcdfInfo.description}</p>
            </div>
          )}

          {/* Files list */}
          <div className="bg-[#16213e] rounded-lg overflow-hidden">
            <div className="px-4 py-2 border-b border-[#0f3460] text-xs text-gray-400 uppercase tracking-wider">
              Files ({mcdfInfo.files.length})
            </div>
            <div className="max-h-96 overflow-y-auto">
              {mcdfInfo.files.length === 0 && (
                <p className="text-gray-500 text-sm px-4 py-6 text-center">No files in this archive.</p>
              )}
              {mcdfInfo.files.map((file, i) => (
                <div key={i} className="border-b border-[#0f3460] last:border-b-0">
                  <button
                    className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-[#0f3460]/50 transition-colors"
                    onClick={() => setExpandedFile(expandedFile === i ? null : i)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-gray-500 text-xs w-6 shrink-0">#{i + 1}</span>
                      <div className="min-w-0">
                        {file.game_paths.length > 0 ? (
                          file.game_paths.map((p, pi) => (
                            <div key={pi} className="text-sm text-gray-200 font-mono truncate" title={p}>{p}</div>
                          ))
                        ) : (
                          <span className="text-sm text-gray-500 italic">No path</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-gray-500 tabular-nums">{(file.data.length / 1024).toFixed(1)} KB</span>
                      <span className="text-gray-400 text-sm">{expandedFile === i ? "▾" : "▸"}</span>
                    </div>
                  </button>
                  {expandedFile === i && (
                    <div className="px-4 py-3 bg-[#0a0a1a] border-t border-[#0f3460]">
                      <div className="text-xs text-gray-500 mb-2">SHA256: {file.hash || "—"}</div>
                      <div className="text-xs text-gray-400 font-mono leading-relaxed">
                        <pre className="whitespace-pre-wrap break-all max-h-40 overflow-y-auto">{file.data.length > 0
                          ? "[Raw " + file.data.length + " bytes — preview not implemented yet]"
                          : "[Empty file]"}</pre>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Extra data sections */}
          {(mcdfInfo.glamourer_data || mcdfInfo.customize_plus_data || mcdfInfo.manipulation_data) && (
            <div className="bg-[#16213e] rounded-lg p-4 space-y-2">
              <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">Extra Data</div>
              {mcdfInfo.glamourer_data && (
                <div>
                  <div className="text-xs text-gray-500">Glamourer Data</div>
                  <div className="text-sm text-gray-300 font-mono truncate" title={mcdfInfo.glamourer_data}>{mcdfInfo.glamourer_data}</div>
                </div>
              )}
              {mcdfInfo.customize_plus_data && (
                <div>
                  <div className="text-xs text-gray-500">Customize+ Data</div>
                  <div className="text-sm text-gray-300 font-mono truncate" title={mcdfInfo.customize_plus_data}>{mcdfInfo.customize_plus_data}</div>
                </div>
              )}
              {mcdfInfo.manipulation_data && (
                <div>
                  <div className="text-xs text-gray-500">Manipulation Data</div>
                  <div className="text-sm text-gray-300 font-mono truncate" title={mcdfInfo.manipulation_data}>{mcdfInfo.manipulation_data}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!mcdfInfo && !loading && !error && (
        <div className="bg-[#16213e] rounded-lg p-8 text-center text-gray-500">
          Select an MCDF file to inspect its contents.
        </div>
      )}
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("browse");
  const [appVersion, setAppVersion] = useState<string>("loading...");
  const [userAvatar] = useState<string | null>(null); // Placeholder for Discord OAuth

  useEffect(() => {
    invoke<string>("get_app_version")
      .then(setAppVersion)
      .catch(() => setAppVersion("unknown"));
  }, []);

  return (
    <div className="min-h-screen bg-[#1a1a2e] text-gray-100">
      {/* Header */}
      <header className="bg-[#16213e] border-b border-[#0f3460] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-[#e94560]">MCDF Marketplace</h1>
          <span className="text-xs text-gray-400">v{appVersion}</span>
        </div>
        <div className="flex items-center gap-3">
          {userAvatar ? (
            <img
              src={userAvatar}
              alt="User avatar"
              className="w-8 h-8 rounded-full border-2 border-[#e94560]"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-[#e94560] flex items-center justify-center text-sm font-bold">
              ?
            </div>
          )}
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="bg-[#16213e] px-6 border-b border-[#0f3460]">
        <div className="flex gap-1">
          {(["browse", "upload", "download", "open"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-3 text-sm font-medium capitalize transition-colors ${
                activeTab === tab
                  ? "text-[#e94560] border-b-2 border-[#e94560]"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </nav>

      {/* Main Content */}
      <main className="p-6">
        {activeTab === "browse" && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-200">Browse Characters</h2>
            <p className="text-gray-400 text-sm">Search and filter public character archives.</p>
            <div className="bg-[#16213e] rounded-lg p-8 text-center text-gray-500">
              Browse functionality coming soon...
            </div>
          </div>
        )}

        {activeTab === "upload" && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-200">Upload MCDF</h2>
            <p className="text-gray-400 text-sm">Upload your character files to the vault.</p>
            <div className="bg-[#16213e] rounded-lg p-8 text-center text-gray-500">
              Upload functionality coming soon...
            </div>
          </div>
        )}

        {activeTab === "download" && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-200">Download & Rebuild</h2>
            <p className="text-gray-400 text-sm">Download and reconstruct MCDF files.</p>
            <div className="bg-[#16213e] rounded-lg p-8 text-center text-gray-500">
              Download functionality coming soon...
            </div>
          </div>
        )}

        {activeTab === "open" && (
          <OpenMCDFPanel />
        )}
      </main>
    </div>
  );
}

export default App;