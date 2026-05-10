import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

// Simple tab-based navigation placeholder
type Tab = "browse" | "upload" | "download";

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
          {(["browse", "upload", "download"] as Tab[]).map((tab) => (
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
      </main>
    </div>
  );
}

export default App;